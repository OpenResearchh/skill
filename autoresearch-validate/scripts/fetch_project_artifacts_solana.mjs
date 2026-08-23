#!/usr/bin/env node
// Fetch the protocol and benchmark harness a project was published with.
//
// A verifier scores a submission against the project's own harness, never
// against a copy carried inside the submission. Under the git-primary artifact
// model that harness is the tree at the project's pinned commit: git is already
// content-addressed, so fetching the commit by its id and having git accept it
// fixes the bytes, and the recorded tree hash is the independent SHA-256
// commitment on top of that. `protocol.json` is additionally checked against
// the SHA-256 the chain stores for it.
//
// The Irys path is kept for projects published before the migration. It is
// selected only when no git reference is available, and the tar guard below
// still applies to it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";
import { materialize, remoteUrlFor } from "./git_artifacts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DEPLOYMENT = path.join(
  VALIDATE_DIR,
  "contracts",
  "solana-open-research",
  "deployment.json",
);
const DEFAULT_CREATE_SCRIPTS = path.resolve(
  SCRIPT_DIR,
  "..",
  "..",
  "autoresearch-create",
  "scripts",
);
const DEFAULT_DEVNET_GATEWAY = "https://devnet.irys.xyz";
const DEFAULT_MAINNET_GATEWAY = "https://gateway.irys.xyz";
const DEFAULT_PROTOCOL_SUBPATH = ".autoresearch/publish/protocol.json";

function usage() {
  console.log(`Usage:
  node scripts/fetch_project_artifacts_solana.mjs \\
    --project-id 0 \\
    --output-dir /tmp/arah-review/project-0

Options:
  --idl <path>             Anchor IDL. Defaults to bundled contracts/solana-open-research/open_research.json.
  --cluster <name>         devnet, testnet, localnet, mainnet-beta. Defaults to devnet.
  --rpc-url <url>          Override Solana RPC URL.
  --program-id <pubkey>    Override OpenResearch program id.
  --artifact-mode <mode>   git, irys, or auto (default). auto uses git when the project pins a commit.
  --repo-url <url>         Project remote. Defaults to ARAH_PROJECT_REPO, else meta.repo.cloneUrl in protocol.json.
  --commit <sha>           Project pinned commit override (full 40-char sha).
  --tree-hash <hex>        Expected canonical tree hash override.
  --protocol-subpath <p>   Path to protocol.json inside the tree. Defaults to ARAH_PROTOCOL_SUBPATH.
  --fetch-depth <n>        Shallow fetch depth. Defaults to 1.
  --gateway-url <url>      Irys gateway override.
  --extract-benchmark      Extract benchmark.tar into <output-dir>/harness (irys mode only).
  --skip-existing          Reuse existing downloads after hash verification.
`);
}

function parseArgs(argv) {
  const options = {};
  const boolKeys = new Set(["help", "extractBenchmark", "skipExisting"]);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) throw new Error(`unexpected argument: ${raw}`);
    const key = raw.slice(2).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
    if (boolKeys.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${raw} requires a value`);
    options[key] = value;
    i += 1;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveBundledIdlPath(options) {
  if (options.idl) return path.resolve(options.idl);
  const deployment = readJson(DEFAULT_DEPLOYMENT);
  return path.resolve(
    path.dirname(DEFAULT_DEPLOYMENT),
    deployment.programs.OpenResearch.idl,
  );
}

async function loadSolanaLib() {
  const scriptsDir = path.resolve(
    process.env.AUTORESEARCH_CREATE_SCRIPTS || DEFAULT_CREATE_SCRIPTS,
  );
  return import(pathToFileURL(path.join(scriptsDir, "solana_open_research.mjs")));
}

function readonlyWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey,
    signTransaction: async () => {
      throw new Error("read-only wallet cannot sign");
    },
    signAllTransactions: async () => {
      throw new Error("read-only wallet cannot sign");
    },
  };
}

function gatewayFor(options, cluster) {
  if (options.gatewayUrl) return String(options.gatewayUrl).replace(/\/+$/, "");
  const normalized = String(cluster || "").toLowerCase();
  return normalized === "mainnet" || normalized === "mainnet-beta"
    ? DEFAULT_MAINNET_GATEWAY
    : DEFAULT_DEVNET_GATEWAY;
}

function sha256Bytes32(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return `0x${h.digest("hex")}`;
}

async function downloadById({ gatewayUrl, id, hash, name, filePath, skipExisting }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const uri = `${gatewayUrl}/${id}`;
  if (!skipExisting || !fs.existsSync(filePath)) {
    console.log(`[Irys] downloading ${name}: ${uri}`);
    const res = await fetch(uri, { headers: { "user-agent": "autoresearch-validate" } });
    if (!res.ok) throw new Error(`Irys download failed for ${name} (${res.status})`);
    fs.writeFileSync(filePath, new Uint8Array(await res.arrayBuffer()));
  }
  const actual = sha256Bytes32(filePath);
  if (actual !== hash) {
    throw new Error(`${name} SHA-256 mismatch: downloaded ${actual} != expected ${hash}`);
  }
  return {
    id,
    gatewayUri: uri,
    sha256Bytes32: actual,
    path: path.resolve(filePath),
    sizeBytes: fs.statSync(filePath).size,
  };
}

// Security control for the Irys fallback: a tar member may name an absolute or
// parent-relative path, or be a symlink or device node, and extraction would
// then write outside the harness directory on the verifier host. Inspect every
// entry and copy file/dir members ourselves — never hand the archive to `tar -xf`.
export function extractSafeTarArchive(tarPath, destDir) {
  const code = String.raw`
import os
import sys
import tarfile

tar_path, dest = sys.argv[1], os.path.abspath(sys.argv[2])
os.makedirs(dest, exist_ok=True)

def bad_path(name):
    if not name:
        return True
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) >= 2 and normalized[1] == ":"):
        return True
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    return any(part == ".." for part in parts)

def safe_join(root, name):
    target = os.path.abspath(os.path.join(root, name))
    if target != root and not target.startswith(root + os.sep):
        raise SystemExit(f"unsafe tar path: {name}")
    return target

try:
    with tarfile.open(tar_path, "r:*") as archive:
        members = []
        for member in archive.getmembers():
            if bad_path(member.name):
                raise SystemExit(f"unsafe tar path: {member.name}")
            if member.linkname and bad_path(member.linkname):
                raise SystemExit(f"unsafe tar link: {member.linkname}")
            if not (member.isfile() or member.isdir()):
                raise SystemExit(f"unsupported tar entry type: {member.name}")
            safe_join(dest, member.name)
            members.append(member)
        for member in members:
            target = safe_join(dest, member.name)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = archive.extractfile(member)
            if src is None:
                raise SystemExit(f"cannot read tar member: {member.name}")
            with src, open(target, "wb") as out:
                out.write(src.read())
except (tarfile.TarError, OSError) as exc:
    raise SystemExit(f"cannot extract tar archive: {exc}")
`;
  const result = spawnSync("python3", ["-c", code, tarPath, destDir], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const raw = result.stderr;
    const detail = (Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "")).trim();
    throw new Error(`unsafe benchmark.tar: ${detail || `python exited ${result.status}`}`);
  }
}

/** Hex for a byte array field, or null when the field is absent or all zero. */
function bytesToHex(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase().replace(/^0x/, "");
    return /^[0-9a-f]+$/.test(text) && /[^0]/.test(text) ? text : null;
  }
  if (typeof value !== "object") return null;
  const bytes = Array.from(value, (b) => Number(b) & 0xff);
  if (!bytes.length || bytes.every((b) => b === 0)) return null;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read a git reference off an account, tolerating both a nested GitRef struct
 * and the flat `<prefix>Commit` / `<prefix>TreeHash` / `<prefix>Repo` layout.
 * Returns null on accounts that predate the git-primary model.
 */
function gitRefFromAccount(account, prefixes) {
  for (const prefix of prefixes) {
    const nested = account?.[prefix];
    if (nested && typeof nested === "object" && typeof nested.commit !== "undefined") {
      const commit = bytesToHex(nested.commit);
      if (commit) {
        return {
          commit,
          treeHash: bytesToHex(nested.treeHash ?? nested.tree_hash),
          repoDigest: bytesToHex(nested.repo),
        };
      }
    }
    const commit = bytesToHex(account?.[`${prefix}Commit`]);
    if (commit) {
      return {
        commit,
        treeHash: bytesToHex(account?.[`${prefix}TreeHash`]),
        repoDigest: bytesToHex(account?.[`${prefix}Repo`]),
      };
    }
  }
  return null;
}

/** Split a git remote into host/owner/repo for the `sha256("host/owner/repo")` commitment. */
function parseRepoRef(url) {
  const value = String(url || "").trim().replace(/\/+$/, "");
  let host = "";
  let rest = "";
  let match;
  if ((match = /^https?:\/\/([^/]+)\/(.+)$/.exec(value))) {
    [, host, rest] = match;
  } else if ((match = /^ssh:\/\/([^/]+)\/(.+)$/.exec(value))) {
    [, host, rest] = match;
  } else if ((match = /^[^@/]+@([^:]+):(.+)$/.exec(value))) {
    [, host, rest] = match;
  } else {
    throw new Error(`cannot parse git remote '${url}'`);
  }
  host = host.replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
  const parts = rest.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`git remote '${url}' has no owner/name`);
  const repo = parts.pop();
  const owner = parts.join("/");
  return { host, owner, repo, canonical: `${host}/${owner}/${repo}` };
}

function repoDigestOf(canonical) {
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Find the remote to fetch the project from.
 *
 * The chain stores only `sha256("host/owner/repo")`, so a URL has to come from
 * somewhere else. Preference order is operator config, then the project's own
 * `protocol.json` — which is hash-pinned on-chain, so reading the clone URL out
 * of it is not the miner's choice.
 */
async function resolveRemote({ options, solana, project, gatewayUrl, outputDir, skipExisting }) {
  const explicit = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (explicit) return { remote: String(explicit).trim(), from: "config", protocol: null };

  let protocolFile = null;
  try {
    protocolFile = await downloadById({
      gatewayUrl,
      id: solana.bytes32ToIrysId(project.protocolIrysId, "protocolIrysId"),
      hash: solana.bytes32ToHex(project.protocolHash, "protocolHash"),
      name: "protocol.json",
      filePath: path.join(outputDir, "protocol.json"),
      skipExisting,
    });
  } catch (err) {
    throw new Error(
      `no project remote: pass --repo-url or set ARAH_PROJECT_REPO (protocol lookup failed: ${err.message})`,
    );
  }
  const protocol = readJson(protocolFile.path);
  const repo = protocol?.meta?.repo || {};
  const remote =
    repo.cloneUrl ||
    (repo.owner && repo.name ? remoteUrlFor({ owner: repo.owner, repo: repo.name }) : null);
  if (!remote) {
    throw new Error("no project remote: pass --repo-url or set ARAH_PROJECT_REPO");
  }
  return { remote: String(remote).trim(), from: "protocol.meta.repo", protocol: protocolFile };
}

/** Locate protocol.json inside the checked-out tree and pin it to the on-chain hash. */
function protocolFromTree({ sourceDir, options, expectedHash }) {
  const subpath = options.protocolSubpath || process.env.ARAH_PROTOCOL_SUBPATH || DEFAULT_PROTOCOL_SUBPATH;
  const candidates = [subpath, DEFAULT_PROTOCOL_SUBPATH, "protocol.json"];
  const seen = new Set();
  const found = [];
  for (const rel of candidates) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const full = path.join(sourceDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      found.push({ rel, path: full, sha256Bytes32: sha256Bytes32(full) });
    }
  }
  if (!found.length) {
    throw new Error(`protocol.json not found in the project tree (looked at ${candidates.join(", ")})`);
  }
  if (expectedHash) {
    const match = found.find((entry) => entry.sha256Bytes32 === expectedHash);
    if (!match) {
      throw new Error(
        `protocol.json SHA-256 mismatch: tree has ${found[0].sha256Bytes32} at ${found[0].rel}, chain records ${expectedHash}`,
      );
    }
    return { ...match, hashVerified: true };
  }
  return { ...found[0], hashVerified: false };
}

async function resolveGitArtifacts({ project, options, outputDir, remoteInfo }) {
  const onChain = gitRefFromAccount(project, ["baseline", "repoSnapshot", "benchmark", "harness"]);
  const commit = String(options.commit || process.env.ARAH_PROJECT_COMMIT || onChain?.commit || "").toLowerCase();
  if (!commit || !remoteInfo?.remote) return null;

  const ref = parseRepoRef(remoteInfo.remote);
  const digest = repoDigestOf(ref.canonical);
  if (onChain?.repoDigest && onChain.repoDigest !== digest) {
    throw new Error(
      `repo mismatch: remote '${remoteInfo.remote}' hashes to ${digest} but the project commits to ${onChain.repoDigest}`,
    );
  }

  const expectedTreeHash = options.treeHash || onChain?.treeHash || null;
  const sourceDir = path.join(outputDir, "source");
  const depth = Number(options.fetchDepth || "1");
  const result = materialize({
    dir: sourceDir,
    remote: remoteInfo.remote,
    commit,
    treeHash: expectedTreeHash,
    depth: Number.isFinite(depth) && depth > 0 ? depth : 1,
  });
  if (!expectedTreeHash) {
    console.error(
      `[git] project carries no tree hash; recorded observed hash ${result.treeHash} without verifying it`,
    );
  }
  return {
    remote: remoteInfo.remote,
    remoteFrom: remoteInfo.from,
    repo: { host: ref.host, owner: ref.owner, name: ref.repo },
    canonicalRepo: ref.canonical,
    repoDigest: digest,
    commit: result.commit,
    treeHash: result.treeHash,
    treeHashVerified: Boolean(expectedTreeHash),
    sourceDir: path.resolve(sourceDir),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (options.projectId === undefined) throw new Error("--project-id is required");
  if (!options.outputDir) throw new Error("--output-dir is required");
  const mode = String(options.artifactMode || "auto").toLowerCase();
  if (!["auto", "git", "irys"].includes(mode)) {
    throw new Error("--artifact-mode must be auto, git, or irys");
  }

  const solana = await loadSolanaLib();
  const config = solana.resolveSolanaConfig(options);
  const program = solana.getOpenResearchProgram({
    wallet: readonlyWallet(),
    idl: readJson(resolveBundledIdlPath(options)),
    rpcUrl: config.rpcUrl,
    programId: config.programId,
  });
  const pdas = solana.createOpenResearchPdas(config.programId);
  const projectPda = pdas.project(options.projectId);
  const project = await program.account.project.fetch(projectPda);

  const gatewayUrl = gatewayFor(options, config.cluster);
  const outputDir = path.resolve(options.outputDir);
  const skipExisting = Boolean(options.skipExisting);

  const wantsGit =
    mode === "git" ||
    (mode === "auto" &&
      Boolean(
        options.commit ||
          process.env.ARAH_PROJECT_COMMIT ||
          gitRefFromAccount(project, ["baseline", "repoSnapshot", "benchmark", "harness"]),
      ));

  let remoteInfo = null;
  let git = null;
  if (wantsGit) {
    remoteInfo = await resolveRemote({
      options,
      solana,
      project,
      gatewayUrl,
      outputDir,
      skipExisting,
    });
    git = await resolveGitArtifacts({ project, options, outputDir, remoteInfo });
  }
  if (mode === "git" && !git) {
    throw new Error(
      "--artifact-mode git requires a pinned commit (on-chain, --commit, or ARAH_PROJECT_COMMIT)",
    );
  }

  let artifacts;
  let harnessDir;
  let protocolPath;
  if (git) {
    console.log(`[git] ${git.canonicalRepo} @ ${git.commit} (tree ${git.treeHash})`);
    let expectedProtocolHash = null;
    try {
      expectedProtocolHash = solana.bytes32ToHex(project.protocolHash, "protocolHash");
    } catch {
      expectedProtocolHash = null;
    }
    if (expectedProtocolHash && /^0x0+$/.test(expectedProtocolHash)) expectedProtocolHash = null;
    const protocol = protocolFromTree({
      sourceDir: git.sourceDir,
      options,
      expectedHash: expectedProtocolHash,
    });
    artifacts = {
      protocol: {
        source: "git",
        subpath: protocol.rel,
        sha256Bytes32: protocol.sha256Bytes32,
        hashVerified: protocol.hashVerified,
        path: protocol.path,
      },
      benchmark: {
        source: "git",
        remote: git.remote,
        commit: git.commit,
        treeHash: git.treeHash,
        treeHashVerified: git.treeHashVerified,
        path: git.sourceDir,
      },
    };
    // The harness is the tree at the pinned commit; restore_trusted_harness.py
    // copies the protocol-immutable paths out of it into the submitted tree.
    harnessDir = git.sourceDir;
    protocolPath = protocol.path;
  } else {
    artifacts = {
      protocol: await downloadById({
        gatewayUrl,
        id: solana.bytes32ToIrysId(project.protocolIrysId, "protocolIrysId"),
        hash: solana.bytes32ToHex(project.protocolHash, "protocolHash"),
        name: "protocol.json",
        filePath: path.join(outputDir, "protocol.json"),
        skipExisting,
      }),
      benchmark: await downloadById({
        gatewayUrl,
        id: solana.bytes32ToIrysId(project.benchmarkIrysId, "benchmarkIrysId"),
        hash: solana.bytes32ToHex(project.benchmarkHash, "benchmarkHash"),
        name: "benchmark.tar",
        filePath: path.join(outputDir, "benchmark.tar"),
        skipExisting,
      }),
    };
    harnessDir = null;
    protocolPath = artifacts.protocol.path;
    if (options.extractBenchmark) {
      harnessDir = path.join(outputDir, "harness");
      fs.mkdirSync(harnessDir, { recursive: true });
      extractSafeTarArchive(artifacts.benchmark.path, harnessDir);
    }
  }

  const record = {
    schemaVersion: "2",
    source: "solana",
    artifactSource: git ? "git" : "irys",
    cluster: config.cluster,
    programId: config.programId.toBase58(),
    projectId: String(options.projectId),
    projectPda: projectPda.toBase58(),
    gatewayUrl,
    artifacts,
    git,
    harnessDir,
    protocolPath,
    currentBestAggregateScore: project.currentBestAggregateScore?.toString?.() ?? null,
    baselineAggregateScore: project.baselineAggregateScore?.toString?.() ?? null,
  };
  const recordPath = path.join(outputDir, "project_artifacts_solana.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(recordPath);
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`fetch project artifacts failed: ${err.message}`);
      process.exit(1);
    },
  );
}
