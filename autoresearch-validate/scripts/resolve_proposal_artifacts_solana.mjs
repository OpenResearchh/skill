#!/usr/bin/env node
// Materialize the tree a proposal is asking to be judged.
//
// Under the git-primary artifact model a proposal points at a commit in the
// project's repository rather than at an uploaded tarball. Git is already
// content-addressed, so fetching the commit by its id and having git accept it
// is itself the integrity check; the tree hash recorded with the proposal is
// the independent SHA-256 commitment on top of that.
//
// The Irys path is kept as a fallback so projects published before the
// migration stay verifiable. It is selected only when no git reference is
// available.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";
import { canonicalRepo, materialize, remoteUrlFor } from "./git_artifacts.mjs";

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

function usage() {
  console.log(`Usage:
  node scripts/resolve_proposal_artifacts_solana.mjs \\
    --proposal-id 0 \\
    --output-dir /tmp/arah-review/proposal-0

Options:
  --idl <path>             Anchor IDL. Defaults to bundled contracts/solana-open-research/open_research.json.
  --cluster <name>         devnet, testnet, localnet, mainnet-beta. Defaults to devnet.
  --rpc-url <url>          Override Solana RPC URL.
  --program-id <pubkey>    Override OpenResearch program id.
  --artifact-mode <mode>   git, irys, or auto (default). auto uses git when the proposal carries a commit.
  --repo-url <url>         Remote to fetch the candidate commit from. Defaults to ARAH_PROJECT_REPO.
  --commit <sha>           Candidate commit override (full 40-char sha).
  --tree-hash <hex>        Expected canonical tree hash override.
  --fetch-depth <n>        Shallow fetch depth for the candidate commit. Defaults to 1.
  --gateway-url <url>      Irys gateway override (irys mode).
  --extract-code           Extract code.tar into <output-dir>/extract (irys mode; git mode always checks out).
  --skip-existing          Reuse existing downloads after hash verification.
`);
}

function parseArgs(argv) {
  const options = {};
  const boolKeys = new Set(["help", "extractCode", "skipExisting"]);
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

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", text: true });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed`);
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
 *
 * The deployed program predates the git-primary model, so this returns null on
 * today's accounts and the caller falls back to Irys or to explicit overrides.
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
          field: prefix,
        };
      }
    }
    const commit = bytesToHex(account?.[`${prefix}Commit`]);
    if (commit) {
      return {
        commit,
        treeHash: bytesToHex(account?.[`${prefix}TreeHash`]),
        repoDigest: bytesToHex(account?.[`${prefix}Repo`]),
        field: `${prefix}Commit`,
      };
    }
  }
  return null;
}

/**
 * Split a git remote into host/owner/repo.
 *
 * The chain commits to `sha256("host/owner/repo")`, which is a commitment and
 * not a location, so the operator supplies the URL and the digest is what
 * proves the two refer to the same repository.
 */
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
  // Canonical form comes from the shared implementation so this agrees with
  // the authoring and mining skills byte for byte.
  return { host, owner, repo, canonical: canonicalRepo(`https://${host}/${owner}/${repo}`) };
}

function repoDigestOf(canonical) {
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function resolveRemote(options) {
  const explicit = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (explicit) return String(explicit).trim();
  if (options.repoOwner && options.repoName) {
    return remoteUrlFor({
      host: options.repoHost || "github.com",
      owner: options.repoOwner,
      repo: options.repoName,
    });
  }
  return null;
}

async function resolveGitArtifacts({ proposal, options, outputDir }) {
  const onChain = gitRefFromAccount(proposal, ["candidate", "code", "head"]);
  const commit = String(options.commit || onChain?.commit || "").toLowerCase();
  const remote = resolveRemote(options);
  if (!commit || !remote) return null;

  const ref = parseRepoRef(remote);
  const digest = repoDigestOf(ref.canonical);
  if (onChain?.repoDigest && onChain.repoDigest !== digest) {
    throw new Error(
      `repo mismatch: remote '${remote}' hashes to ${digest} but the proposal commits to ${onChain.repoDigest}`,
    );
  }

  const expectedTreeHash = options.treeHash || onChain?.treeHash || null;
  const sourceDir = path.join(outputDir, "source");
  const depth = Number(options.fetchDepth || "1");
  const result = materialize({
    dir: sourceDir,
    remote,
    commit,
    treeHash: expectedTreeHash,
    depth: Number.isFinite(depth) && depth > 0 ? depth : 1,
  });
  if (!expectedTreeHash) {
    console.error(
      `[git] proposal carries no tree hash; recorded observed hash ${result.treeHash} without verifying it`,
    );
  }
  return {
    remote,
    repo: { host: ref.host, owner: ref.owner, name: ref.repo },
    canonicalRepo: ref.canonical,
    repoDigest: digest,
    commit: result.commit,
    treeHash: result.treeHash,
    treeHashVerified: Boolean(expectedTreeHash),
    sourceDir: path.resolve(sourceDir),
  };
}

/**
 * Download the miner's own benchmark log when one was recorded.
 *
 * It is evidence, not an input: the verifier re-runs the harness itself. In git
 * mode a project may not upload one at all, so a missing or unfetchable log is
 * reported rather than treated as a resolve failure.
 */
async function optionalBenchmarkLog({ solana, proposal, gatewayUrl, outputDir, skipExisting }) {
  try {
    return await downloadById({
      gatewayUrl,
      id: solana.bytes32ToIrysId(proposal.benchmarkLogIrysId, "benchmarkLogIrysId"),
      hash: solana.bytes32ToHex(proposal.benchmarkLogHash, "benchmarkLogHash"),
      name: "benchmarkLog",
      filePath: path.join(outputDir, "benchmark.log"),
      skipExisting,
    });
  } catch (err) {
    console.error(`[Irys] miner benchmark log unavailable: ${err.message}`);
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (!options.proposalId) throw new Error("--proposal-id is required");
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
  const proposalPda = pdas.proposal(options.proposalId);
  const proposal = await program.account.proposal.fetch(proposalPda);
  const outputDir = path.resolve(options.outputDir);
  const gatewayUrl = gatewayFor(options, config.cluster);
  const skipExisting = Boolean(options.skipExisting);

  const git = mode === "irys" ? null : await resolveGitArtifacts({ proposal, options, outputDir });
  if (mode === "git" && !git) {
    throw new Error(
      "--artifact-mode git requires a candidate commit (on-chain or --commit) and a remote (--repo-url or ARAH_PROJECT_REPO)",
    );
  }

  let artifacts;
  let extractRoot;
  if (git) {
    console.log(`[git] ${git.canonicalRepo} @ ${git.commit} (tree ${git.treeHash})`);
    artifacts = {
      code: {
        source: "git",
        remote: git.remote,
        commit: git.commit,
        treeHash: git.treeHash,
        treeHashVerified: git.treeHashVerified,
        path: git.sourceDir,
      },
      benchmarkLog: await optionalBenchmarkLog({
        solana,
        proposal,
        gatewayUrl,
        outputDir,
        skipExisting,
      }),
    };
    extractRoot = git.sourceDir;
  } else {
    artifacts = {
      code: await downloadById({
        gatewayUrl,
        id: solana.bytes32ToIrysId(proposal.codeIrysId, "codeIrysId"),
        hash: solana.bytes32ToHex(proposal.codeHash, "codeHash"),
        name: "code",
        filePath: path.join(outputDir, "code.tar"),
        skipExisting,
      }),
      benchmarkLog: await downloadById({
        gatewayUrl,
        id: solana.bytes32ToIrysId(proposal.benchmarkLogIrysId, "benchmarkLogIrysId"),
        hash: solana.bytes32ToHex(proposal.benchmarkLogHash, "benchmarkLogHash"),
        name: "benchmarkLog",
        filePath: path.join(outputDir, "benchmark.log"),
        skipExisting,
      }),
    };
    extractRoot = null;
    if (options.extractCode) {
      extractRoot = path.join(outputDir, "extract");
      fs.mkdirSync(extractRoot, { recursive: true });
      run("tar", ["-xf", artifacts.code.path, "-C", extractRoot]);
    }
  }

  const record = {
    schemaVersion: "2",
    source: "solana",
    artifactSource: git ? "git" : "irys",
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    programId: config.programId.toBase58(),
    proposalId: String(options.proposalId),
    proposalPda: proposalPda.toBase58(),
    projectId: proposal.projectId.toString(),
    miner: proposal.miner.toBase58(),
    rewardRecipient: proposal.rewardRecipient.toBase58(),
    claimedAggregateScore: proposal.claimedAggregateScore.toString(),
    artifacts,
    git,
    extractRoot,
  };
  const recordPath = path.join(outputDir, "proposal_artifacts_solana.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  console.log(recordPath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`resolve failed: ${err.message}`);
    process.exit(1);
  },
);
