#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MINE_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DEPLOYMENT = path.join(
  MINE_DIR,
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

function usage() {
  console.log(`Usage:
  node scripts/bootstrap_from_solana.mjs \\
    --project-id 0 \\
    --output-dir /tmp/arah-solana-project \\
    --unpack-repo

Options:
  --idl <path>             Anchor IDL. Defaults to bundled contracts/solana-open-research/open_research.json.
  --cluster <name>         devnet, testnet, localnet, mainnet-beta. Defaults to devnet.
  --rpc-url <url>          Override Solana RPC URL.
  --program-id <pubkey>    Override OpenResearch program id.
  --gateway-url <url>      Irys gateway override.
  --network <devnet|mainnet>
  --repo-root <path>       Where --unpack-repo extracts repo-snapshot.tar.
  --unpack-repo            Extract repo snapshot and initialize .autoresearch/mine.
  --skip-existing          Reuse existing downloads after hash verification.
  --from-baseline          Start from the project's original snapshot instead of
                           the current best code. Use only to reproduce the baseline.
`);
}

function parseArgs(argv) {
  const options = {};
  const boolKeys = new Set(["help", "unpackRepo", "skipExisting", "fromBaseline"]);
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

// An all-zero bytes32 is how the program represents "unset". A project with no
// approved proposal yet has zeroed currentBestCode* fields.
function isZeroBytes32(value) {
  if (!value) return true;
  const bytes = Array.from(value);
  return bytes.length === 0 || bytes.every((b) => Number(b) === 0);
}

function aggregateScoreToMetric(score, direction, scale) {
  // Aggregate score negates for minimize so that "greater is better" holds
  // on-chain; undo that here to recover the human-readable metric.
  return Number(direction === "minimize" ? -score : score) / scale;
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

// Seed the miner's frontier from the on-chain Project account so the loop
// compares candidates against what the network has actually accepted, rather
// than against a hand-edited placeholder.
function writeNetworkState({ repoRoot, protocolPath, project, projectId, config, codeOrigin }) {
  let protocol;
  try {
    protocol = readJson(protocolPath);
  } catch {
    console.error("protocol.json unreadable; leaving network_state.json untouched");
    return;
  }
  const primary = protocol?.measurement?.primaryMetric;
  const direction = primary?.direction;
  if (direction !== "minimize" && direction !== "maximize") {
    console.error("protocol has no usable primaryMetric.direction; leaving network_state.json untouched");
    return;
  }

  const scale = Number(process.env.ARAH_METRIC_SCALE || 1_000_000);
  const scoreText = codeOrigin === "currentBestCode"
    ? project.currentBestAggregateScore?.toString?.()
    : project.baselineAggregateScore?.toString?.();
  const score = scoreText === undefined || scoreText === null ? null : BigInt(scoreText);
  const best = score === null ? null : aggregateScoreToMetric(score, direction, scale);

  const state = {
    schemaVersion: "1",
    source: "solana",
    protocolBundleId: protocol?.meta?.protocolBundleId || `solana:project:${projectId}`,
    project_id: Number(projectId),
    cluster: config.cluster,
    program_id: config.programId.toBase58(),
    network_best_metric: best,
    aggregate_score_int256: score?.toString?.() ?? "0",
    metric_scale: scale,
    metric_name: primary?.name || "primary",
    direction,
    code_origin: codeOrigin,
    min_score_improvement_bips: Number(
      protocol?.measurement?.minScoreImprovementBips ?? 100,
    ),
    updated_at: new Date().toISOString(),
  };
  const statePath = path.join(repoRoot, ".autoresearch", "mine", "network_state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  console.error(`network_state.json synced (best=${best ?? "none"} ${state.metric_name})`);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    text: true,
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(`${cmd} ${args.join(" ")} failed${stderr}`);
  }
  return result.stdout || "";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (!options.projectId) throw new Error("--project-id is required");
  if (!options.outputDir) throw new Error("--output-dir is required");

  const solana = await loadSolanaLib();
  const idlPath = resolveBundledIdlPath(options);
  const config = solana.resolveSolanaConfig(options);
  const program = solana.getOpenResearchProgram({
    wallet: readonlyWallet(),
    idl: readJson(idlPath),
    rpcUrl: config.rpcUrl,
    programId: config.programId,
  });
  const pdas = solana.createOpenResearchPdas(config.programId);
  const projectPda = pdas.project(options.projectId);
  const project = await program.account.project.fetch(projectPda);

  // Start from the best code the network has accepted so far, not from the
  // project's genesis snapshot. Every approved proposal advances
  // currentBestCode* on-chain; bootstrapping from it is what makes the work
  // compound, so miner N+1 builds on miner N instead of rediscovering the
  // same ground. Genesis projects have this field zeroed and fall back to the
  // original snapshot, as does --from-baseline for reproducing the baseline.
  const hasCurrentBest =
    !options.fromBaseline && !isZeroBytes32(project.currentBestCodeIrysId);
  const codeSource = hasCurrentBest
    ? {
        origin: "currentBestCode",
        hash: solana.bytes32ToHex(project.currentBestCodeHash, "currentBestCodeHash"),
        irysId: solana.bytes32ToIrysId(
          project.currentBestCodeIrysId,
          "currentBestCodeIrysId",
        ),
      }
    : {
        origin: "repoSnapshot",
        hash: solana.bytes32ToHex(project.repoSnapshotHash, "repoSnapshotHash"),
        irysId: solana.bytes32ToIrysId(project.repoSnapshotIrysId, "repoSnapshotIrysId"),
      };
  console.error(
    codeSource.origin === "currentBestCode"
      ? `starting from current best code (score ${project.currentBestAggregateScore})`
      : "starting from the project's original snapshot",
  );

  const artifacts = {
    protocol: {
      hash: solana.bytes32ToHex(project.protocolHash, "protocolHash"),
      irysId: solana.bytes32ToIrysId(project.protocolIrysId, "protocolIrysId"),
    },
    repoSnapshot: {
      hash: codeSource.hash,
      irysId: codeSource.irysId,
      origin: codeSource.origin,
    },
    benchmark: {
      hash: solana.bytes32ToHex(project.benchmarkHash, "benchmarkHash"),
      irysId: solana.bytes32ToIrysId(project.benchmarkIrysId, "benchmarkIrysId"),
    },
    baselineMetrics: {
      hash: solana.bytes32ToHex(project.baselineMetricsHash, "baselineMetricsHash"),
      irysId: solana.bytes32ToIrysId(
        project.baselineMetricsIrysId,
        "baselineMetricsIrysId",
      ),
    },
  };

  const outputDir = path.resolve(options.outputDir);
  const artifactsDir = path.join(outputDir, "artifacts");
  fs.mkdirSync(outputDir, { recursive: true });

  const downloadArgs = [
    path.join(SCRIPT_DIR, "download_irys_artifacts.mjs"),
    "--output-dir",
    artifactsDir,
    "--protocol-hash",
    artifacts.protocol.hash,
    "--protocol-irys-id",
    artifacts.protocol.irysId,
    "--repo-snapshot-hash",
    artifacts.repoSnapshot.hash,
    "--repo-snapshot-irys-id",
    artifacts.repoSnapshot.irysId,
    "--benchmark-hash",
    artifacts.benchmark.hash,
    "--benchmark-irys-id",
    artifacts.benchmark.irysId,
    "--baseline-metrics-hash",
    artifacts.baselineMetrics.hash,
    "--baseline-metrics-irys-id",
    artifacts.baselineMetrics.irysId,
  ];
  if (options.gatewayUrl) downloadArgs.push("--gateway-url", options.gatewayUrl);
  if (options.network) downloadArgs.push("--network", options.network);
  if (options.skipExisting) downloadArgs.push("--skip-existing");
  run("node", downloadArgs);

  let repoRoot = null;
  if (options.unpackRepo) {
    repoRoot = path.resolve(options.repoRoot || path.join(outputDir, "repo"));
    fs.mkdirSync(repoRoot, { recursive: true });
    run("tar", ["-xf", path.join(artifactsDir, "repo-snapshot.tar"), "-C", repoRoot]);
    run("bash", [path.join(SCRIPT_DIR, "init_mine_workspace.sh"), repoRoot]);
    writeNetworkState({
      repoRoot,
      protocolPath: path.join(artifactsDir, "protocol.json"),
      project,
      projectId: options.projectId,
      config,
      codeOrigin: codeSource.origin,
    });
  }

  const record = {
    schemaVersion: "1",
    source: "solana",
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    programId: config.programId.toBase58(),
    projectId: String(options.projectId),
    projectPda: projectPda.toBase58(),
    artifacts,
    artifactsDir,
    protocolJson: path.join(artifactsDir, "protocol.json"),
    repoRoot,
    codeOrigin: codeSource.origin,
    currentBestAggregateScore: project.currentBestAggregateScore?.toString?.() ?? null,
  };
  const recordPath = path.join(outputDir, "bootstrap_solana.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  console.log(recordPath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`bootstrap failed: ${err.message}`);
    process.exit(1);
  },
);
