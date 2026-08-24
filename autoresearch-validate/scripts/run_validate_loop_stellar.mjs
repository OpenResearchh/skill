#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertRepoMatches,
  bufferHex,
  createClient,
  directionText,
  formatCommitId,
  improvementThreshold,
  isSufficient,
  parseArgs,
  parseCommitId,
  projectSummary,
  requireAddress,
  resolveDeployment,
  scaleMetric,
  unwrapResult,
  utcNow,
  verifyStellarTreeHash,
  writeJson,
} from "../../autoresearch-create/scripts/stellar_open_research.mjs";
import { assertAllowedRemote, fetchCommit } from "./git_artifacts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_DIR = path.resolve(SCRIPT_DIR, "..");
const BOOL_FLAGS = new Set(["help", "dryRun", "once", "yes", "noMerge"]);

function usage() {
  console.log(`Usage:
  node scripts/run_validate_loop_stellar.mjs \\
    --project-id 1 \\
    --verifier <STELLAR_G_ADDRESS> \\
    --yes

Options:
  --once                 Process at most one proposal.
  --poll-seconds <n>     Poll delay for endless mode. Defaults to 30.
  --work-dir <path>      Review workspace. Defaults to .autoresearch/validate-stellar.
  --record-root <path>   Where .autoresearch/verify/reviews.jsonl is written.
  --repo-url <url>       Override the project clone_url.
  --github-token-file    GitHub token for post-approve merge.
  --no-merge             Settle on-chain only.
  --dry-run              Verify locally and write records without transactions.
  --max-proposals <n>    Cap proposals processed in one run.
`);
}

function run(command, args, { cwd, capture = true, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function runRequired(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function txLabel(label, sent) {
  if (sent?.hash) return `${label}:${sent.hash}`;
  if (sent?.id) return `${label}:${sent.id}`;
  return `${label}:${String(sent)}`;
}

function untrustedEnv() {
  const env = { ...process.env };
  for (const key of [
    "ARAH_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_PAT",
  ]) {
    delete env[key];
  }
  return env;
}

function statusTag(status) {
  return status?.tag || String(status || "");
}

function proposalGitSummary(proposal) {
  return {
    repo: bufferHex(proposal.candidate.repo),
    commit: formatCommitId(proposal.candidate.commit),
    tree_hash: bufferHex(proposal.candidate.tree_hash),
    clone_url: proposal.clone_url,
    base_commit: formatCommitId(proposal.base_commit),
  };
}

function projectIncumbent(project) {
  const ref = project.current_best?.present ? project.current_best.value : project.baseline;
  return {
    repo: bufferHex(ref.repo),
    commit: formatCommitId(ref.commit),
    tree_hash: bufferHex(ref.tree_hash),
    clone_url: project.clone_url,
    score: project.current_best?.present ? BigInt(project.current_best_score) : BigInt(project.baseline_score),
  };
}

function findProtocol(repoRoot) {
  for (const candidate of [
    "protocol.json",
    path.join(".autoresearch", "protocol.json"),
    path.join("autoresearch", "protocol.json"),
  ]) {
    const full = path.join(repoRoot, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function evidenceFile(dir, name, payload) {
  const file = path.join(dir, name);
  writeJson(file, payload);
  return file;
}

function materializeStellarGit({ dir, remote, commit, treeHash }) {
  fetchCommit({ dir, remote: assertAllowedRemote(remote), commit });
  verifyStellarTreeHash({ repoRoot: dir, commit, expected: treeHash });
  return { dir, commit, treeHash };
}

function appendReviewRecord({ recordRoot, row }) {
  const recordFile = path.join(recordRoot, ".autoresearch", "verify", "reviews.jsonl");
  const tmp = path.join(os.tmpdir(), `arah-review-${process.pid}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  writeJson(tmp, row);
  runRequired("python3", [
    path.join(SCRIPT_DIR, "append_review_record.py"),
    "--record-file",
    recordFile,
    "--json-file",
    tmp,
  ]);
  return recordFile;
}

function mergeApproved({ proposalId, git, options }) {
  if (options.noMerge) return { attempted: false, reason: "disabled" };
  const repoUrl = options.repoUrl || process.env.ARAH_PROJECT_REPO || git.clone_url;
  if (!repoUrl) return { attempted: false, reason: "no_project_repo" };
  const args = [
    path.join(SCRIPT_DIR, "merge_approved_proposal.mjs"),
    "--proposal-id",
    String(proposalId),
    "--repo-url",
    repoUrl,
    "--commit",
    git.commit,
  ];
  if (options.githubTokenFile) args.push("--token-file", options.githubTokenFile);
  if (options.dryRun) args.push("--dry-run");
  else args.push("--yes");
  const result = run("node", args, { capture: true });
  if (result.status !== 0) {
    return {
      attempted: true,
      merged: false,
      reason: "merge_step_failed",
      detail: result.stderr || result.stdout,
    };
  }
  return { attempted: true, ...safeJson(result.stdout) };
}

async function signAndSend(tx, options, label, txs) {
  const sent = await tx.signAndSend();
  txs.push(txLabel(label, sent));
  return sent;
}

async function settle(client, action, args, options, txs) {
  if (options.dryRun) {
    txs.push(`dry-run:${action}`);
    return null;
  }
  if (action === "claim-review") {
    const tx = await client.claim_review(args);
    unwrapResult(tx, "claim_review");
    return signAndSend(tx, options, "claim_review", txs);
  }
  if (action === "approve") {
    const tx = await client.approve(args);
    unwrapResult(tx, "approve");
    return signAndSend(tx, options, "approve", txs);
  }
  if (action === "reject") {
    const tx = await client.reject(args);
    unwrapResult(tx, "reject");
    return signAndSend(tx, options, "reject", txs);
  }
  if (action === "release-review") {
    const tx = await client.release_review(args);
    unwrapResult(tx, "release_review");
    return signAndSend(tx, options, "release_review", txs);
  }
  if (action === "record-merge") {
    const tx = await client.record_merge(args);
    unwrapResult(tx, "record_merge");
    return signAndSend(tx, options, "record_merge", txs);
  }
  throw new Error(`unknown Stellar settlement action: ${action}`);
}

async function release(client, proposalId, verifier, options, txs, reason, error = "") {
  await settle(
    client,
    "release-review",
    { verifier, proposal_id: BigInt(proposalId) },
    options,
    txs,
  );
  return { result: "released", reason, verifiedScore: "", stdoutLog: "", error, txs };
}

async function reject(client, proposalId, verifier, reasonCode, options, txs, error = "") {
  await settle(
    client,
    "reject",
    { verifier, proposal_id: BigInt(proposalId), reason_code: reasonCode },
    options,
    txs,
  );
  return { result: "rejected", reason: reasonCode, verifiedScore: "", stdoutLog: "", error, txs };
}

async function verifyProposal({ client, project, proposal, proposalId, verifier, options }) {
  const txs = [];
  const proposalDir = path.join(options.workDir, `proposal-${proposalId}`);
  const candidateDir = path.join(proposalDir, "candidate");
  const trustedDir = path.join(proposalDir, "trusted");
  fs.mkdirSync(proposalDir, { recursive: true });

  const candidate = proposalGitSummary(proposal);
  const incumbent = projectIncumbent(project);
  if (candidate.base_commit.toLowerCase() !== incumbent.commit.toLowerCase()) {
    return reject(client, proposalId, verifier, "stale_base_commit", options, txs);
  }

  await settle(
    client,
    "claim-review",
    { verifier, proposal_id: BigInt(proposalId) },
    options,
    txs,
  );

  try {
    assertRepoMatches(candidate.clone_url, candidate.repo);
    assertRepoMatches(options.repoUrl || incumbent.clone_url, incumbent.repo);
    materializeStellarGit({
      dir: candidateDir,
      remote: candidate.clone_url,
      commit: candidate.commit,
      treeHash: candidate.tree_hash,
    });
    materializeStellarGit({
      dir: trustedDir,
      remote: options.repoUrl || incumbent.clone_url,
      commit: incumbent.commit,
      treeHash: incumbent.tree_hash,
    });
  } catch (err) {
    return release(client, proposalId, verifier, options, txs, "git_materialize_failed", err.message);
  }

  const protocolPath = findProtocol(trustedDir);
  if (!protocolPath) {
    return release(client, proposalId, verifier, options, txs, "trusted_protocol_missing");
  }
  const protocol = readJson(protocolPath);
  const direction = directionText(project.direction);
  const reviewId = `stellar-p${proposalId}-${Date.now()}`;
  runRequired("bash", [path.join(SCRIPT_DIR, "init_verify_workspace.sh"), candidateDir]);

  const restore = run("python3", [
    path.join(SCRIPT_DIR, "restore_trusted_harness.py"),
    "--protocol",
    protocolPath,
    "--trusted-root",
    trustedDir,
    "--expect-commit",
    incumbent.commit,
    "--repo-root",
    candidateDir,
    "--report",
    path.join(proposalDir, "harness-restore.json"),
  ], { capture: true });
  if (restore.status === 3) {
    evidenceFile(proposalDir, "harness-tamper-reject.json", {
      reason: "harness_tampered",
      stdout: restore.stdout,
      stderr: restore.stderr,
    });
    return reject(client, proposalId, verifier, "harness_tampered", options, txs, restore.stderr || restore.stdout);
  }
  if (restore.status !== 0) {
    return release(client, proposalId, verifier, options, txs, "harness_restore_failed", restore.stderr || restore.stdout);
  }

  const gates = run("python3", [
    path.join(SCRIPT_DIR, "verify_static_gates.py"),
    "--protocol",
    protocolPath,
    "--repo-root",
    candidateDir,
  ], { capture: true });
  if (gates.status !== 0) {
    evidenceFile(proposalDir, "static-gate-reject.json", {
      reason: "static_gate_failed",
      stdout: gates.stdout,
      stderr: gates.stderr,
    });
    return reject(client, proposalId, verifier, "static_gate_failed", options, txs, gates.stderr || gates.stdout);
  }

  const runTrial = run("bash", [
    path.join(SCRIPT_DIR, "run_verify_trial.sh"),
    protocolPath,
    candidateDir,
    reviewId,
  ], { cwd: candidateDir, capture: true, env: untrustedEnv() });
  const samplesPath = path.join(candidateDir, ".autoresearch", "verify", "runs", reviewId, "samples.json");
  if (runTrial.status !== 0) {
    return release(
      client,
      proposalId,
      verifier,
      options,
      txs,
      runTrial.status === 4 ? "measurement_too_noisy" : "harness_failed",
      runTrial.stderr || runTrial.stdout,
    );
  }

  let samples;
  try {
    samples = readJson(samplesPath);
  } catch (err) {
    return release(client, proposalId, verifier, options, txs, "metric_parse_failed", err.message);
  }
  const metricText = String(samples.aggregate);
  const verifiedScore = scaleMetric(metricText, Number(project.metric_scale), direction);
  const bips = Number(project.min_improvement_bips);
  const threshold = improvementThreshold(incumbent.score, bips);
  if (isSufficient(verifiedScore, incumbent.score, bips)) {
    await settle(
      client,
      "approve",
      { verifier, proposal_id: BigInt(proposalId), verified_score: verifiedScore },
      options,
      txs,
    );
    const merge = mergeApproved({ proposalId, git: candidate, options });
    if (!options.dryRun && merge?.mergedCommit) {
      await settle(
        client,
        "record-merge",
        {
          verifier,
          proposal_id: BigInt(proposalId),
          merged_commit: parseCommitId(merge.mergedCommit),
        },
        options,
        txs,
      );
    }
    return {
      result: "approved",
      reason: "ok",
      verifiedScore: verifiedScore.toString(),
      stdoutLog: samplesPath,
      error: "",
      txs,
      candidateCommit: candidate.commit,
      merge,
    };
  }

  evidenceFile(proposalDir, "no-improvement-reject.json", {
    reason: "no_improvement",
    metric: metricText,
    direction,
    claimedAggregateScore: proposal.claimed_score.toString(),
    verifiedAggregateScore: verifiedScore.toString(),
    currentBestAggregateScore: incumbent.score.toString(),
    requiredAggregateScore: threshold.toString(),
    samples: samples.samples,
    cv: samples.cv,
  });
  const rejected = await reject(client, proposalId, verifier, "no_improvement", options, txs);
  return {
    ...rejected,
    verifiedScore: verifiedScore.toString(),
    stdoutLog: samplesPath,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help || !options.projectId) {
    usage();
    return 0;
  }
  options.workDir = path.resolve(options.workDir || path.join(process.cwd(), ".autoresearch", "validate-stellar"));
  options.recordRoot = path.resolve(options.recordRoot || VALIDATE_DIR);
  options.pollSeconds = Number(options.pollSeconds || "30");
  options.maxProposals = Number(options.maxProposals || process.env.VALIDATE_MAX_PROPOSALS || "50");
  options.dryRun = Boolean(options.dryRun || !options.yes);
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 1) {
    throw new Error("--poll-seconds must be >= 1");
  }
  if (!Number.isInteger(options.maxProposals) || options.maxProposals < 1) {
    throw new Error("--max-proposals must be a positive integer");
  }
  fs.mkdirSync(options.workDir, { recursive: true });

  const verifier = requireAddress(options.verifier || process.env.ARAH_STELLAR_VERIFIER, "verifier");
  const network = resolveDeployment(options);
  const secretKey =
    options.dryRun ? null : options.secretKey || process.env.ARAH_STELLAR_VERIFIER_SECRET_KEY;
  if (!options.dryRun && !secretKey) {
    throw new Error("live validation requires --secret-key or ARAH_STELLAR_VERIFIER_SECRET_KEY");
  }
  const client = await createClient({
    contractId: network.contractId,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
  }, { publicKey: verifier, secretKey });
  const projectTx = await client.get_project({ project_id: BigInt(options.projectId) });
  const project = unwrapResult(projectTx, "get_project");
  const verifierTx = await client.is_verifier({ verifier });
  if (!Boolean(verifierTx.result)) {
    throw new Error(`${verifier} is not an active Stellar verifier`);
  }
  writeJson(options.output || ".autoresearch/validate-stellar-preflight.json", {
    schemaVersion: "1",
    chain: "stellar",
    network: network.network,
    contractId: network.contractId,
    project: projectSummary(project),
    verifier: { address: verifier, active: true },
    dryRun: options.dryRun,
  });

  let handled = 0;
  while (handled < options.maxProposals) {
    const openTx = await client.get_open_proposals({ project_id: BigInt(options.projectId) });
    const open = unwrapResult(openTx, "get_open_proposals");
    if (!open.length) break;
    for (const rawProposalId of open) {
      if (handled >= options.maxProposals) break;
      const proposalId = Number(rawProposalId);
      const proposalTx = await client.get_proposal({ proposal_id: BigInt(proposalId) });
      const proposal = unwrapResult(proposalTx, "get_proposal");
      if (statusTag(proposal.status) !== "Submitted") continue;
      const outcome = await verifyProposal({
        client,
        project,
        proposal,
        proposalId,
        verifier,
        options,
      });
      const row = {
        schemaVersion: "1",
        review_id: `stellar-p${proposalId}-${Date.now()}`,
        utc_timestamp: utcNow(),
        proposal_id: proposalId,
        project_id: Number(options.projectId),
        result: outcome.result,
        reason_code: outcome.reason,
        code_hash: proposalGitSummary(proposal).tree_hash,
        benchmark_log_hash_ok: true,
        protocol_hash_ok: null,
        claimed_aggregate_score: proposal.claimed_score.toString(),
        verified_aggregate_score: outcome.verifiedScore || "",
        stdout_log_path: outcome.stdoutLog || "",
        transaction_hashes: outcome.txs || [],
        error: outcome.error || "",
      };
      appendReviewRecord({ recordRoot: options.recordRoot, row });
      handled += 1;
      if (options.once) return 0;
    }
    if (options.once || options.dryRun) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1000));
  }
  console.log(`stellar validate loop processed ${handled} proposal(s)`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stellar validate loop failed: ${err.message}`);
    process.exit(1);
  },
);
