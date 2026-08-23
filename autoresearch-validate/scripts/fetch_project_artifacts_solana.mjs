#!/usr/bin/env node
// Fetch the protocol and benchmark harness a project was published with.
//
// A verifier scores a submission against the project's own harness, never
// against a copy carried inside the submission. These artifacts are addressed
// by the Irys ids recorded in the on-chain Project account and verified
// against the SHA-256 hashes stored alongside them, so the bytes used to judge
// a proposal are fixed by the chain rather than by the miner.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";

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
  node scripts/fetch_project_artifacts_solana.mjs \\
    --project-id 0 \\
    --output-dir /tmp/arah-review/project-0

Options:
  --idl <path>             Anchor IDL. Defaults to bundled contracts/solana-open-research/open_research.json.
  --cluster <name>         devnet, testnet, localnet, mainnet-beta. Defaults to devnet.
  --rpc-url <url>          Override Solana RPC URL.
  --program-id <pubkey>    Override OpenResearch program id.
  --gateway-url <url>      Irys gateway override.
  --extract-benchmark      Extract benchmark.tar into <output-dir>/harness.
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

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", text: true });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed`);
  }
}

function assertSafeTarArchive(tarPath) {
  const code = String.raw`
import os
import sys
import tarfile

tar_path = sys.argv[1]

def bad_path(name):
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or normalized == "":
        return True
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    return any(part == ".." for part in parts)

try:
    with tarfile.open(tar_path, "r:*") as archive:
        for member in archive.getmembers():
            if bad_path(member.name):
                raise SystemExit(f"unsafe tar path: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise SystemExit(f"unsupported tar entry type: {member.name}")
except (tarfile.TarError, OSError) as exc:
    raise SystemExit(f"cannot inspect tar archive: {exc}")
`;
  const result = spawnSync("python3", ["-c", code, tarPath], {
    stdio: ["ignore", "ignore", "pipe"],
    text: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new Error(`unsafe benchmark.tar: ${detail || `python exited ${result.status}`}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (options.projectId === undefined) throw new Error("--project-id is required");
  if (!options.outputDir) throw new Error("--output-dir is required");

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

  const artifacts = {
    protocol: await downloadById({
      gatewayUrl,
      id: solana.bytes32ToIrysId(project.protocolIrysId, "protocolIrysId"),
      hash: solana.bytes32ToHex(project.protocolHash, "protocolHash"),
      name: "protocol.json",
      filePath: path.join(outputDir, "protocol.json"),
      skipExisting: Boolean(options.skipExisting),
    }),
    benchmark: await downloadById({
      gatewayUrl,
      id: solana.bytes32ToIrysId(project.benchmarkIrysId, "benchmarkIrysId"),
      hash: solana.bytes32ToHex(project.benchmarkHash, "benchmarkHash"),
      name: "benchmark.tar",
      filePath: path.join(outputDir, "benchmark.tar"),
      skipExisting: Boolean(options.skipExisting),
    }),
  };

  let harnessDir = null;
  if (options.extractBenchmark) {
    harnessDir = path.join(outputDir, "harness");
    fs.mkdirSync(harnessDir, { recursive: true });
    assertSafeTarArchive(artifacts.benchmark.path);
    run("tar", ["-xf", artifacts.benchmark.path, "-C", harnessDir]);
  }

  const record = {
    schemaVersion: "1",
    source: "solana",
    cluster: config.cluster,
    programId: config.programId.toBase58(),
    projectId: String(options.projectId),
    projectPda: projectPda.toBase58(),
    gatewayUrl,
    artifacts,
    harnessDir,
    protocolPath: artifacts.protocol.path,
    currentBestAggregateScore: project.currentBestAggregateScore?.toString?.() ?? null,
    baselineAggregateScore: project.baselineAggregateScore?.toString?.() ?? null,
  };
  const recordPath = path.join(outputDir, "project_artifacts_solana.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(recordPath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`fetch project artifacts failed: ${err.message}`);
    process.exit(1);
  },
);
