#!/usr/bin/env node
// Bootstrap a mining workspace from a published Solana project.
//
// Two artifact models, chosen from what the project record actually carries:
//
//   git   - the record names a commit. The commits are the artifact, so the
//           working tree is a real checkout of the project's history rather
//           than an unpacked snapshot. Miner commits then build on that
//           history instead of on a tarball with no ancestry.
//   irys  - the record names storage ids. The original model, kept as the
//           fallback so every project published so far still bootstraps.
//
// The git path needs a plaintext clone URL from the caller: the chain stores
// sha256("host/owner/repo"), which cannot be reversed into a URL. When the
// record carries that commitment the supplied URL is checked against it, so
// passing a URL is a convenience, not a trust decision.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";
import { assertAllowedRemote, git, materialize, repoIdentity } from "./git_artifacts.mjs";

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
  --repo-root <path>       Where --unpack-repo prepares the working tree.
  --unpack-repo            Prepare the working tree and initialize .autoresearch/mine.
  --skip-existing          Reuse existing downloads after hash verification.
  --from-baseline          Start from the project's original code instead of the
                           current best. Use only to reproduce the baseline.

Git-artifact options (used when the project record names a commit):
  --git-mode <auto|on|off> auto (default) uses git when the record carries a
                           commit and falls back to stored artifacts otherwise.
  --repo-url <url>         Clone URL for the project repo. https or ssh only.
                           Checked against the record's repo commitment.
  --protocol-file <path>   protocol.json to use instead of the copy in the repo.
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

function bytesToHex(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const hex = value.replace(/^0x/, "").toLowerCase();
    return /^[0-9a-f]+$/.test(hex) ? hex : null;
  }
  const bytes = Array.from(value);
  if (bytes.length === 0 || bytes.every((b) => Number(b) === 0)) return null;
  return bytes.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}

// The account layout for git artifacts is not deployed yet, so read it
// tolerantly: any of these spellings counts, and a missing or all-zero field
// simply means "this project predates git artifacts" rather than an error.
function firstField(record, names) {
  for (const name of names) {
    if (record?.[name] !== undefined && record?.[name] !== null) return record[name];
  }
  return null;
}

/**
 * Read a GitRef off the project account, or null when the record has none.
 *
 * `fromBaseline` selects the project's original commit; otherwise the current
 * best is preferred so miner N+1 builds on miner N's accepted work instead of
 * rediscovering it.
 */
function resolveGitRef(project, { fromBaseline = false } = {}) {
  const baseline = {
    origin: "repoSnapshot",
    commit: bytesToHex(
      firstField(project, ["repoCommit", "baselineCommit", "repoSnapshotCommit"]),
    ),
    treeHash: bytesToHex(
      firstField(project, ["repoTreeHash", "baselineTreeHash", "repoSnapshotTreeHash"]),
    ),
  };
  const best = {
    origin: "currentBestCode",
    commit: bytesToHex(
      firstField(project, ["currentBestCommit", "currentBestCodeCommit"]),
    ),
    treeHash: bytesToHex(
      firstField(project, ["currentBestTreeHash", "currentBestCodeTreeHash"]),
    ),
  };
  const chosen = !fromBaseline && best.commit ? best : baseline;
  if (!chosen.commit) return null;
  if (!/^[0-9a-f]{40}$/.test(chosen.commit)) {
    throw new Error(`project record has an unusable commit id: ${chosen.commit}`);
  }
  return chosen;
}

// Canonical repo identity: sha256("host/owner/repo"), host-agnostic and
// independent of transport or a trailing .git. Must match the Python side in
// submit_trial_proposal.py byte for byte.
function repoCommitment(remoteUrl) {
  // Shared implementation: project identity must be byte-identical across the
  // authoring, mining, and verification skills or nothing ever matches.
  const { canonical, repoId } = repoIdentity(remoteUrl);
  return { canonical, hash: repoId };
}

const PROTOCOL_CANDIDATES = [
  "protocol.json",
  path.join(".autoresearch", "protocol.json"),
  path.join("autoresearch", "protocol.json"),
];

function findProtocolInRepo(repoRoot) {
  for (const candidate of PROTOCOL_CANDIDATES) {
    const full = path.join(repoRoot, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
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

/**
 * Prepare the working tree from git when the project record names a commit.
 *
 * Nothing is downloaded here. The repo is fetched at the recorded commit, the
 * canonical tree hash is verified against the record when it carries one, and
 * the commit is stamped into `refs/openresearch/base` so a later
 * submit_trial_proposal.py run knows what this candidate branched from without
 * having to guess.
 */
function prepareRepoFromGit({ options, gitRef, outputDir }) {
  const remoteUrl = assertAllowedRemote(
    options.repoUrl ||
      process.env.ARAH_REPO_URL ||
      (options.protocolFile
        ? readJson(path.resolve(options.protocolFile))?.meta?.repo?.cloneUrl
        : null) ||
      "",
  );
  const identity = repoCommitment(remoteUrl);

  // sha256("host/owner/repo") is one-way, so the URL has to come from the
  // caller. When the record carries the commitment, the URL is still verified
  // against it, so a wrong or substituted repo is caught here.
  const recordedRepoHash = bytesToHex(
    firstField(options.projectRecord || {}, ["repo", "repoHash", "repoId"]),
  );
  if (recordedRepoHash && recordedRepoHash !== identity.hash) {
    throw new Error(
      `--repo-url ${identity.canonical} does not match the project's repo commitment ` +
        `(${recordedRepoHash})`,
    );
  }

  const repoRoot = path.resolve(options.repoRoot || path.join(outputDir, "repo"));
  const result = materialize({
    dir: repoRoot,
    remote: remoteUrl,
    commit: gitRef.commit,
    treeHash: gitRef.treeHash || undefined,
  });

  // Private ref namespace: records the starting point without adding a branch
  // the miner has to reason about.
  git(repoRoot, ["update-ref", "refs/openresearch/base", gitRef.commit]);

  return { repoRoot, remoteUrl, identity, treeHash: result.treeHash };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  if (!options.projectId) throw new Error("--project-id is required");
  if (!options.outputDir) throw new Error("--output-dir is required");

  const gitMode = String(options.gitMode || "auto").toLowerCase();
  if (!["auto", "on", "off"].includes(gitMode)) {
    throw new Error("--git-mode must be auto, on, or off");
  }

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

  const outputDir = path.resolve(options.outputDir);
  const artifactsDir = path.join(outputDir, "artifacts");
  fs.mkdirSync(outputDir, { recursive: true });

  const gitRef =
    gitMode === "off"
      ? null
      : resolveGitRef(project, { fromBaseline: Boolean(options.fromBaseline) });
  if (gitMode === "on" && !gitRef) {
    throw new Error(
      "--git-mode on, but this project record carries no commit; it predates " +
        "git artifacts. Use --git-mode off or auto.",
    );
  }

  if (gitRef) {
    console.error(
      gitRef.origin === "currentBestCode"
        ? `starting from current best commit ${gitRef.commit} (score ${project.currentBestAggregateScore})`
        : `starting from the project's original commit ${gitRef.commit}`,
    );

    let repoRoot = null;
    let protocolJson = options.protocolFile ? path.resolve(options.protocolFile) : null;
    let gitDetail = null;
    if (options.unpackRepo) {
      gitDetail = prepareRepoFromGit({
        options: { ...options, projectRecord: project },
        gitRef,
        outputDir,
      });
      repoRoot = gitDetail.repoRoot;
      // Under the git model protocol.json travels with the code, so prefer the
      // copy in the tree the proposal actually commits to.
      protocolJson = protocolJson || findProtocolInRepo(repoRoot);
      if (!protocolJson) {
        throw new Error(
          "protocol.json not found in the repo at that commit; pass --protocol-file",
        );
      }
      run("bash", [path.join(SCRIPT_DIR, "init_mine_workspace.sh"), repoRoot]);
      writeNetworkState({
        repoRoot,
        protocolPath: protocolJson,
        project,
        projectId: options.projectId,
        config,
        codeOrigin: gitRef.origin,
      });
    }

    const gitRecord = {
      schemaVersion: "1",
      source: "solana",
      artifactModel: "git",
      cluster: config.cluster,
      rpcUrl: config.rpcUrl,
      programId: config.programId.toBase58(),
      projectId: String(options.projectId),
      projectPda: projectPda.toBase58(),
      git: {
        repo: gitDetail?.identity?.canonical ?? null,
        repoHash: gitDetail?.identity?.hash ?? null,
        remoteUrl: gitDetail?.remoteUrl ?? null,
        commit: gitRef.commit,
        treeHash: gitDetail?.treeHash ?? gitRef.treeHash ?? null,
      },
      // No artifactsDir: git mode downloads nothing, so pointing at a
      // directory that was never created would only mislead the next reader.
      protocolJson,
      repoRoot,
      codeOrigin: gitRef.origin,
      currentBestAggregateScore: project.currentBestAggregateScore?.toString?.() ?? null,
    };
    const gitRecordPath = path.join(outputDir, "bootstrap_solana.json");
    fs.writeFileSync(gitRecordPath, JSON.stringify(gitRecord, null, 2) + "\n");
    console.log(gitRecordPath);
    return 0;
  }

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
    artifactModel: "irys",
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
