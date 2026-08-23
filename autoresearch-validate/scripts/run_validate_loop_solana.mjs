#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

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
const PENDING_STATUS = "pending";
const SCALE = 1_000_000n;

function usage() {
  console.log(`Usage:
  node scripts/run_validate_loop_solana.mjs \\
    --token-address <PROJECT_MINT> \\
    --keypair ~/.config/solana/id.json \\
    --yes

Options:
  --project-id <id>        Use project id directly instead of --token-address.
  --once                   Process at most one successful proposal, then exit.
  --poll-seconds <n>       Poll delay for endless mode. Defaults to 30.
  --work-dir <path>        Review workspace. Defaults to .autoresearch/validate-solana.
  --record-root <path>     Where .autoresearch/verify/reviews.jsonl is written. Defaults to validate skill root.
  --cluster <name>         devnet, testnet, localnet, mainnet-beta. Defaults to devnet.
  --rpc-url <url>          Override Solana RPC URL.
  --program-id <pubkey>    Override OpenResearch program id.
  --repo-url <url>         Project git remote. Defaults to ARAH_PROJECT_REPO, else the protocol's meta.repo.
  --artifact-mode <mode>   git, irys, or auto (default) for both project and proposal artifacts.
  --github-token-file <p>  File holding the GitHub token used to merge approved proposals.
  --no-merge               Settle on-chain only; do not merge approved proposals on GitHub.
  --dry-run                Print plans and do not send transactions or upload.
`);
}

function parseArgs(argv) {
  const options = {};
  const boolKeys = new Set(["help", "once", "yes", "dryRun", "noMerge"]);
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

async function loadSolanaLib() {
  const scriptsDir = path.resolve(
    process.env.AUTORESEARCH_CREATE_SCRIPTS || DEFAULT_CREATE_SCRIPTS,
  );
  return import(pathToFileURL(path.join(scriptsDir, "solana_open_research.mjs")));
}

function resolveBundledIdlPath(options) {
  if (options.idl) return path.resolve(options.idl);
  const deployment = readJson(DEFAULT_DEPLOYMENT);
  return path.resolve(
    path.dirname(DEFAULT_DEPLOYMENT),
    deployment.programs.OpenResearch.idl,
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

// Environment for anything that executes miner-supplied code.
//
// This process holds a GitHub token with write access to the project repo, and
// it also runs the submission's own build and benchmark. Those two facts must
// never meet: a token reachable from inside the sandbox turns "run untrusted
// code" into "hand the repository to whoever wrote it". The token is used only
// by the merge step, which talks to the REST API and never spawns the harness.
function untrustedEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(ARAH_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_PAT)$/.test(key)) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function runRequired(cmd, args, opts = {}) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    const detail = opts.capture ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`${cmd} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function assertSolanaCli(keypairPath) {
  const version = run("solana", ["--version"], { capture: true });
  if (version.status !== 0) {
    throw new Error(
      "Solana CLI is required. Install it with: curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash",
    );
  }
  const address = runRequired("solana", ["address", "-k", keypairPath], {
    capture: true,
  }).stdout.trim();
  const balance = run("solana", ["balance", address], { capture: true });
  if (balance.status !== 0) {
    throw new Error(`unable to read Solana balance for ${address}: ${balance.stderr.trim()}`);
  }
  return { version: version.stdout.trim(), address, balance: balance.stdout.trim() };
}

function readonlyWallet(publicKey) {
  return {
    publicKey,
    signTransaction: async () => {
      throw new Error("read-only wallet cannot sign");
    },
    signAllTransactions: async () => {
      throw new Error("read-only wallet cannot sign");
    },
  };
}

function statusName(status) {
  if (typeof status === "string") return status.toLowerCase();
  if (status && typeof status === "object") {
    const keys = Object.keys(status);
    if (keys.length === 1) return keys[0].toLowerCase();
  }
  return String(status).toLowerCase();
}

function isZeroBytes32(value) {
  if (!value) return true;
  const bytes = Array.from(value);
  return bytes.length === 0 || bytes.every((b) => Number(b) === 0);
}

function nonzeroDigest(value) {
  if (!value) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase().replace(/^0x/, "");
    return /^[0-9a-f]+$/.test(text) && /[1-9a-f]/.test(text);
  }
  return !isZeroBytes32(value);
}

export function hasCurrentBestCode(project) {
  if (!isZeroBytes32(project.currentBestCodeIrysId)) return true;
  const nested = project.currentBest || project.currentBestCode;
  if (nested && typeof nested === "object" && nonzeroDigest(nested.commit)) return true;
  return nonzeroDigest(project.currentBestCommit) || nonzeroDigest(project.currentBestCodeCommit);
}

export function incumbentAggregateScore(project) {
  const score = hasCurrentBestCode(project)
    ? project.currentBestAggregateScore
    : project.baselineAggregateScore;
  if (score === undefined || score === null) {
    throw new Error("project has no usable incumbent aggregate score");
  }
  return BigInt(score.toString());
}

function decimalMetricToScaledInt(text, scale = SCALE) {
  const s0 = String(text).trim();
  const negative = s0.startsWith("-");
  const s = negative ? s0.slice(1) : s0;
  let value;
  if (s.includes(".")) {
    const [wholeRaw, fracRaw] = s.split(".", 2);
    const whole = wholeRaw || "0";
    const frac = fracRaw || "";
    const den = 10n ** BigInt(frac.length);
    const num = (BigInt(whole) * den + BigInt(frac || "0")) * scale;
    if (num % den !== 0n) {
      throw new Error("metric cannot be represented exactly at aggregate scale");
    }
    value = num / den;
  } else {
    value = BigInt(s) * scale;
  }
  return negative ? -value : value;
}

function metricToAggregateScore(metricText, direction) {
  const raw = decimalMetricToScaledInt(metricText);
  return direction === "minimize" ? -raw : raw;
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function appendReviewRecord({ recordRoot, row }) {
  const verifyRoot = path.join(recordRoot, ".autoresearch", "verify");
  fs.mkdirSync(verifyRoot, { recursive: true });
  const tmp = path.join(os.tmpdir(), `arah-review-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify(row, null, 2)}\n`);
  try {
    runRequired("python3", [
      path.join(SCRIPT_DIR, "append_review_record.py"),
      "--record-file",
      path.join(verifyRoot, "reviews.jsonl"),
      "--json-file",
      tmp,
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function resolveProject({ solana, program, config, options }) {
  const pdas = solana.createOpenResearchPdas(config.programId);
  if (options.projectId !== undefined) {
    const project = await program.account.project.fetch(pdas.project(options.projectId));
    return { projectId: String(options.projectId), project };
  }
  if (!options.tokenAddress) throw new Error("--token-address or --project-id is required");
  const targetMint = new PublicKey(options.tokenAddress).toBase58();
  const globalConfig = await program.account.globalConfig.fetch(pdas.config());
  const nextProjectId = BigInt(globalConfig.nextProjectId.toString());
  for (let id = 0n; id < nextProjectId; id += 1n) {
    const project = await program.account.project.fetch(pdas.project(id.toString()));
    if (project.mint.toBase58() === targetMint) {
      return { projectId: id.toString(), project };
    }
  }
  throw new Error(`no project found for token/mint ${targetMint}`);
}

async function checkVerifier({ connection, solana, config, verifier }) {
  const pdas = solana.createOpenResearchPdas(config.programId);
  const verifierPda = pdas.verifier(verifier);
  const info = await connection.getAccountInfo(verifierPda, "confirmed");
  return { verifierPda: verifierPda.toBase58(), isVerifier: Boolean(info) };
}

function projectSummary({ config, projectId, project, verifierInfo, cliInfo }) {
  return {
    chain: "solana",
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    programId: config.programId.toBase58(),
    projectId,
    tokenMint: project.mint.toBase58(),
    tokenName: project.tokenName,
    tokenSymbol: project.tokenSymbol,
    baselineAggregateScore: project.baselineAggregateScore.toString(),
    currentBestAggregateScore: project.currentBestAggregateScore.toString(),
    currentBestMiner: project.currentBestMiner.toBase58(),
    verifier: cliInfo.address,
    verifierPda: verifierInfo.verifierPda,
    isVerifier: verifierInfo.isVerifier,
    solanaCli: cliInfo.version,
    balance: cliInfo.balance,
  };
}

async function claimProposal({ proposalId, options }) {
  const args = [
    path.join(SCRIPT_DIR, "settle_proposal_solana.mjs"),
    "--action",
    "claim-review",
    "--proposal-id",
    proposalId,
    "--keypair",
    options.keypair,
  ];
  if (options.dryRun) args.push("--dry-run");
  else args.push("--yes");
  return run("node", args, { capture: true });
}

async function settle({ action, proposalId, metricsFile, metricsIrysId, verifiedScore, options }) {
  const args = [
    path.join(SCRIPT_DIR, "settle_proposal_solana.mjs"),
    "--action",
    action,
    "--proposal-id",
    proposalId,
    "--keypair",
    options.keypair,
  ];
  if (action === "approve") {
    args.push("--verified-score-int256", verifiedScore);
  }
  if (metricsFile) args.push("--metrics-log-file", metricsFile);
  if (metricsIrysId) args.push("--metrics-irys-id", metricsIrysId);
  if (options.dryRun) args.push("--dry-run");
  else args.push("--yes");
  return run("node", args, { capture: true });
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  return JSON.parse(text.slice(start));
}

function uploadIrys({ file, role, options }) {
  const args = [
    path.join(SCRIPT_DIR, "upload_irys_file_solana.mjs"),
    "--file",
    file,
    "--keypair",
    options.keypair,
    "--artifact-role",
    role,
  ];
  for (const key of ["cluster", "rpcUrl", "irysNetwork"]) {
    if (options[key]) {
      args.push(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, options[key]);
    }
  }
  if (options.dryRun) args.push("--dry-run");
  const result = runRequired("node", args, { capture: true });
  return parseJsonOutput(result.stdout);
}

// Metric value a candidate must reach to count as an improvement over the
// score the network already holds. The margin is relative to the incumbent's
// magnitude, so it reads the same for a metric of 2.5 and one of 250000.
function improvementThreshold(bestScore, bips) {
  if (bips <= 0) return bestScore;
  const magnitude = bestScore < 0n ? -bestScore : bestScore;
  const margin = (magnitude * BigInt(bips)) / 10000n;
  // Aggregate score is oriented so that greater is always better on-chain.
  return bestScore + margin;
}

/**
 * Merge an approved proposal into the project repo.
 *
 * Runs only after the on-chain approve has landed. Settlement is already final
 * at this point, so every failure here — conflict, moved head, a project repo
 * the verifier cannot write to — is reported as approved-but-unmerged and does
 * not change the outcome. `merge_approved_proposal.mjs` exits 3 for exactly
 * that case, which is why a non-zero status is not treated as an error.
 */
function mergeApproved({ proposalId, git, options }) {
  if (options.noMerge) return { attempted: false, reason: "merge_disabled" };
  if (!git?.commit) return { attempted: false, reason: "no_git_candidate" };
  const repoUrl = options.repoUrl || git.remote || process.env.ARAH_PROJECT_REPO;
  if (!repoUrl) return { attempted: false, reason: "no_project_repo" };

  const args = [
    path.join(SCRIPT_DIR, "merge_approved_proposal.mjs"),
    "--proposal-id",
    proposalId,
    "--repo-url",
    repoUrl,
    "--commit",
    git.commit,
  ];
  if (options.githubTokenFile) args.push("--token-file", options.githubTokenFile);
  if (options.dryRun) args.push("--dry-run");
  else args.push("--yes");

  const result = run("node", args, { capture: true });
  const parsed = parseJsonOutput(result.stdout);
  if (!parsed) {
    return {
      attempted: true,
      merged: false,
      reason: "merge_step_failed",
      detail: (result.stderr || result.stdout || "").trim(),
    };
  }
  return { attempted: true, ...parsed };
}

function evidenceFile(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

async function verifyClaimedProposal({ solana, config, proposalId, proposal, project, options }) {
  const proposalDir = path.join(options.workDir, `proposal-${proposalId}`);
  fs.mkdirSync(proposalDir, { recursive: true });
  const reviewId = `solana-p${proposalId}-${Date.now()}`;
  const txs = [];

  // Git is the artifact store: the proposal points at a commit in the project
  // repo, and fetching that commit by its id — plus the canonical tree hash —
  // is the integrity check. The Irys path stays reachable for projects
  // published before the migration; `--artifact-mode auto` picks per project.
  const gitArgs = [
    ...(options.artifactMode ? ["--artifact-mode", options.artifactMode] : []),
    ...(options.repoUrl ? ["--repo-url", options.repoUrl] : []),
  ];
  const resolve = runRequired("node", [
    path.join(SCRIPT_DIR, "resolve_proposal_artifacts_solana.mjs"),
    "--proposal-id",
    proposalId,
    "--output-dir",
    proposalDir,
    "--extract-code",
    ...gitArgs,
    ...(options.cluster ? ["--cluster", options.cluster] : []),
    ...(options.rpcUrl ? ["--rpc-url", options.rpcUrl] : []),
    ...(options.programId ? ["--program-id", options.programId] : []),
  ], { capture: true });
  const resolvePath = resolve.stdout.trim().split(/\n/).pop();
  const resolved = readJson(resolvePath);
  const extractRoot = resolved.extractRoot;

  // Score against the project's own protocol and harness, taken from the
  // project's pinned commit and hash-verified. Reading either from the
  // submission would let whoever wrote the submission decide how it is judged.
  const trustedDir = path.join(proposalDir, "trusted");
  const fetchTrusted = runRequired("node", [
    path.join(SCRIPT_DIR, "fetch_project_artifacts_solana.mjs"),
    "--project-id",
    proposal.projectId.toString(),
    "--output-dir",
    trustedDir,
    "--extract-benchmark",
    "--skip-existing",
    ...gitArgs,
    ...(options.cluster ? ["--cluster", options.cluster] : []),
    ...(options.rpcUrl ? ["--rpc-url", options.rpcUrl] : []),
    ...(options.programId ? ["--program-id", options.programId] : []),
  ], { capture: true });
  const trusted = readJson(fetchTrusted.stdout.trim().split(/\n/).pop());
  const protocolPath = trusted.protocolPath;
  const protocol = readJson(protocolPath);
  const direction = protocol?.measurement?.primaryMetric?.direction;
  if (direction !== "minimize" && direction !== "maximize") {
    throw new Error("protocol measurement.primaryMetric.direction must be minimize or maximize");
  }

  runRequired("bash", [path.join(SCRIPT_DIR, "init_verify_workspace.sh"), extractRoot]);

  // Overwrite every immutable harness path in the submitted tree with the
  // project's copy. Divergence on one of those paths is tampering.
  const restore = run("python3", [
    path.join(SCRIPT_DIR, "restore_trusted_harness.py"),
    "--protocol",
    protocolPath,
    "--trusted-root",
    trusted.harnessDir,
    ...(trusted.git?.commit ? ["--expect-commit", trusted.git.commit] : []),
    "--repo-root",
    extractRoot,
    "--report",
    path.join(proposalDir, "harness-restore.json"),
  ], { capture: true });
  if (restore.status === 3) {
    const ev = evidenceFile(proposalDir, "harness-tamper-reject.json", {
      reason: "harness_tampered",
      stdout: restore.stdout,
      stderr: restore.stderr,
    });
    const uploaded = uploadIrys({ file: ev, role: "verifierRejectEvidence", options });
    const reject = await settle({
      action: "reject",
      proposalId,
      metricsFile: ev,
      metricsIrysId: uploaded.id,
      options,
    });
    const rejectOut = parseJsonOutput(reject.stdout);
    if (rejectOut?.signature) txs.push(rejectOut.signature);
    return {
      result: "rejected",
      reason: "harness_tampered",
      stdoutLog: "",
      verifiedScore: "",
      error: restore.stderr || restore.stdout,
      txs,
    };
  }
  if (restore.status !== 0) {
    const release = await settle({ action: "release-review", proposalId, options });
    const releaseOut = parseJsonOutput(release.stdout);
    if (releaseOut?.signature) txs.push(releaseOut.signature);
    return {
      result: "released",
      reason: "harness_restore_failed",
      stdoutLog: "",
      verifiedScore: "",
      error: restore.stderr || restore.stdout,
      txs,
    };
  }
  const gates = run("python3", [
    path.join(SCRIPT_DIR, "verify_static_gates.py"),
    "--protocol",
    protocolPath,
    "--repo-root",
    extractRoot,
  ], { capture: true });
  if (gates.status !== 0) {
    const ev = evidenceFile(proposalDir, "static-gate-reject.json", {
      reason: "static_gate_failed",
      stdout: gates.stdout,
      stderr: gates.stderr,
    });
    const uploaded = uploadIrys({ file: ev, role: "verifierRejectEvidence", options });
    const reject = await settle({
      action: "reject",
      proposalId,
      metricsFile: ev,
      metricsIrysId: uploaded.id,
      options,
    });
    const rejectOut = parseJsonOutput(reject.stdout);
    if (rejectOut?.signature) txs.push(rejectOut.signature);
    return {
      result: "rejected",
      reason: "static_gate_failed",
      stdoutLog: "",
      verifiedScore: "",
      error: gates.stderr || gates.stdout,
      txs,
    };
  }

  // The harness executes the submission. Strip the merge credential from its
  // environment first — this is the one process that holds both.
  const runTrial = run("bash", [
    path.join(SCRIPT_DIR, "run_verify_trial.sh"),
    protocolPath,
    extractRoot,
    reviewId,
  ], { cwd: extractRoot, capture: true, env: untrustedEnv() });
  const samplesPath = path.join(extractRoot, ".autoresearch", "verify", "runs", reviewId, "samples.json");
  // Exit 4 means the sample was too dispersed to score. That is a property of
  // this host, not evidence against the miner, so release rather than reject.
  if (runTrial.status !== 0) {
    const release = await settle({ action: "release-review", proposalId, options });
    const releaseOut = parseJsonOutput(release.stdout);
    if (releaseOut?.signature) txs.push(releaseOut.signature);
    return {
      result: "released",
      reason: runTrial.status === 4 ? "measurement_too_noisy" : "harness_failed",
      stdoutLog: samplesPath,
      verifiedScore: "",
      error: runTrial.stderr || runTrial.stdout,
      txs,
    };
  }

  let samples;
  try {
    samples = readJson(samplesPath);
  } catch (err) {
    const release = await settle({ action: "release-review", proposalId, options });
    const releaseOut = parseJsonOutput(release.stdout);
    if (releaseOut?.signature) txs.push(releaseOut.signature);
    return {
      result: "released",
      reason: "metric_parse_failed",
      stdoutLog: samplesPath,
      verifiedScore: "",
      error: err.message,
      txs,
    };
  }

  // Settle on the verifier's own measurement against the score the network
  // already holds. The miner's claimed score is recorded but never gates the
  // outcome: comparing the two would reject honest work whenever the verifier's
  // host differs from the miner's, and a claim the verifier cannot reproduce is
  // worth nothing regardless of what it says.
  const metricText = String(samples.aggregate);
  const verifiedScore = metricToAggregateScore(metricText, direction);
  const claimedScore = BigInt(proposal.claimedAggregateScore.toString());
  const bestScore = incumbentAggregateScore(project);
  const bips = Number(protocol?.measurement?.minScoreImprovementBips ?? 100);
  const threshold = improvementThreshold(bestScore, bips);
  const improved = bips <= 0 ? verifiedScore > bestScore : verifiedScore >= threshold;

  if (improved) {
    const uploaded = uploadIrys({ file: samplesPath, role: "verifierMetrics", options });
    const approve = await settle({
      action: "approve",
      proposalId,
      metricsFile: samplesPath,
      metricsIrysId: uploaded.id,
      verifiedScore: verifiedScore.toString(),
      options,
    });
    const approveOut = parseJsonOutput(approve.stdout);
    if (approveOut?.signature) txs.push(approveOut.signature);
    // Same allowlist, two powers: the address that just approved on-chain is
    // the address that merges the work. The merge cannot change the outcome.
    const merge = mergeApproved({ proposalId, git: resolved.git, options });
    return {
      result: "approved",
      reason: "ok",
      stdoutLog: samplesPath,
      verifiedScore: verifiedScore.toString(),
      error: "",
      txs,
      candidateCommit: resolved.git?.commit || "",
      merge,
    };
  }

  const ev = evidenceFile(proposalDir, "no-improvement-reject.json", {
    reason: "no_improvement",
    metric: metricText,
    direction,
    samples: samples.samples,
    cv: samples.cv,
    minScoreImprovementBips: bips,
    claimedAggregateScore: claimedScore.toString(),
    verifiedAggregateScore: verifiedScore.toString(),
    currentBestAggregateScore: bestScore.toString(),
    requiredAggregateScore: threshold.toString(),
  });
  const uploaded = uploadIrys({ file: ev, role: "verifierRejectEvidence", options });
  const reject = await settle({
    action: "reject",
    proposalId,
    metricsFile: ev,
    metricsIrysId: uploaded.id,
    options,
  });
  const rejectOut = parseJsonOutput(reject.stdout);
  if (rejectOut?.signature) txs.push(rejectOut.signature);
  return {
    result: "rejected",
    reason: "no_improvement",
    stdoutLog: samplesPath,
    verifiedScore: verifiedScore.toString(),
    error: "",
    txs,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  options.keypair = path.resolve(options.keypair || path.join(os.homedir(), ".config", "solana", "id.json"));
  options.workDir = path.resolve(options.workDir || path.join(process.cwd(), ".autoresearch", "validate-solana"));
  options.recordRoot = path.resolve(options.recordRoot || VALIDATE_DIR);
  options.pollSeconds = Number(options.pollSeconds || "30");
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 1) {
    throw new Error("--poll-seconds must be >= 1");
  }
  if (options.githubTokenFile) options.githubTokenFile = path.resolve(options.githubTokenFile);
  // The merge credential is optional; without it the loop still settles
  // on-chain and reports every approval as approved-but-unmerged.
  const hasMergeCredential = Boolean(
    options.githubTokenFile ||
      process.env.ARAH_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
  if (!options.noMerge && !hasMergeCredential) {
    console.error(
      "no GitHub credential found; approved proposals will be settled on-chain and left unmerged " +
        "(pass --github-token-file or --no-merge to make that explicit)",
    );
  }
  fs.mkdirSync(options.workDir, { recursive: true });
  const cliInfo = assertSolanaCli(options.keypair);
  const solana = await loadSolanaLib();
  const keypair = Keypair.fromSecretKey(solana.readSolanaKeypair(options.keypair));
  if (keypair.publicKey.toBase58() !== cliInfo.address) {
    throw new Error(`keypair public key ${keypair.publicKey.toBase58()} does not match solana CLI address ${cliInfo.address}`);
  }

  const idl = readJson(resolveBundledIdlPath(options));
  const config = solana.resolveSolanaConfig(options);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const program = solana.getOpenResearchProgram({
    wallet: readonlyWallet(keypair.publicKey),
    idl,
    rpcUrl: config.rpcUrl,
    programId: config.programId,
  });
  const { projectId, project } = await resolveProject({ solana, program, config, options });
  const verifierInfo = await checkVerifier({
    connection,
    solana,
    config,
    verifier: keypair.publicKey,
  });
  const summary = projectSummary({ config, projectId, project, verifierInfo, cliInfo });
  console.log(JSON.stringify({
    project: summary,
    merge: {
      // One allowlist, two powers: this same verifier address is the merge
      // authority for the project repo.
      enabled: !options.noMerge && hasMergeCredential,
      repoUrl: options.repoUrl || process.env.ARAH_PROJECT_REPO || null,
      credential: options.githubTokenFile ? "token-file" : hasMergeCredential ? "environment" : null,
    },
  }, null, 2));
  if (!verifierInfo.isVerifier) {
    console.error("validator wallet is not registered as verifier; stopping without transactions");
    return 2;
  }
  if (!options.dryRun && !options.yes) {
    throw new Error("refusing to run live Solana validator without --yes after project confirmation");
  }
  if (options.dryRun) {
    console.log("dry-run: project and verifier checks passed; no transactions will be sent");
  }

  const pdas = solana.createOpenResearchPdas(config.programId);
  const handled = new Set();
  while (true) {
    const globalConfig = await program.account.globalConfig.fetch(pdas.config());
    const nextProposalId = BigInt(globalConfig.nextProposalId.toString());
    let processedOne = false;
    for (let id = 0n; id < nextProposalId; id += 1n) {
      const proposalId = id.toString();
      if (handled.has(proposalId)) continue;
      let proposal;
      try {
        proposal = await program.account.proposal.fetch(pdas.proposal(proposalId));
      } catch {
        continue;
      }
      if (proposal.projectId.toString() !== projectId) continue;
      if (BigInt(proposal.stake.toString()) <= 0n) continue;
      if (statusName(proposal.status) !== PENDING_STATUS) continue;

      const claim = await claimProposal({ proposalId, options });
      if (claim.status !== 0) {
        console.error(`claim-review failed for proposal ${proposalId}: ${(claim.stderr || claim.stdout).trim()}`);
        handled.add(proposalId);
        continue;
      }
      const claimOut = parseJsonOutput(claim.stdout);
      const txs = [];
      if (claimOut?.signature) txs.push(claimOut.signature);

      // Re-read the project each time: an approval by another verifier may
      // have advanced the best score since this proposal was submitted, and
      // the bar a candidate must clear is the current one, not a stale one.
      const project = await program.account.project.fetch(pdas.project(projectId));

      const outcome = await verifyClaimedProposal({
        solana,
        config,
        proposalId,
        proposal,
        project,
        options,
      });
      appendReviewRecord({
        recordRoot: options.recordRoot,
        row: {
          schemaVersion: "1",
          review_id: `solana-p${proposalId}-${Date.now()}`,
          utc_timestamp: utcNow(),
          proposal_id: Number(proposalId),
          project_id: Number(projectId),
          result: outcome.result,
          reason_code: outcome.reason,
          code_hash: solana.bytes32ToHex(proposal.codeHash, "codeHash"),
          benchmark_log_hash_ok: true,
          protocol_hash_ok: null,
          claimed_aggregate_score: proposal.claimedAggregateScore.toString(),
          verified_aggregate_score: outcome.verifiedScore,
          stdout_log_path: outcome.stdoutLog,
          transaction_hashes: txs.concat(outcome.txs),
          candidate_commit: outcome.candidateCommit || "",
          // record_merge takes this; null means approved-but-unmerged, which
          // is a normal terminal state, not a settlement failure.
          merged_commit: outcome.merge?.mergedCommit || null,
          merge_status: outcome.merge?.reason || (outcome.merge?.merged ? "merged" : ""),
          error: outcome.error || "",
        },
      });
      console.log(JSON.stringify({ proposalId, outcome }, null, 2));
      handled.add(proposalId);
      processedOne = true;
      if (options.once) return 0;
    }
    if (options.once) return processedOne ? 0 : 0;
    await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1000));
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`solana validate loop failed: ${err.message}`);
      process.exit(1);
    },
  );
}
