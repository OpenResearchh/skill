#!/usr/bin/env node
// Unattended Stellar verifier loop.
//
// Claim first, then fetch the candidate GitRef, restore the project's baseline
// harness, rerun the benchmark, and settle against the live incumbent. GitHub
// merge happens only after approve, via approveMergeAndRecord.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  approveMergeAndRecord,
  call,
  createClient,
  directionFromTag,
  formatCommitId,
  incumbentScore,
  isSufficient,
  readIncumbentScore,
  unwrapOption,
  jsonReplacer,
  loadDeployment,
  loadSecretKeyFile,
  parseArgs,
  parseCommitId,
  proposalStatus,
  readJson,
  scaleMetric,
  send,
  unwrapContract,
} from "./stellar_open_research.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_DIR = path.resolve(SCRIPT_DIR, "..");

function usage() {
  console.log(`Usage:
  node scripts/run_validate_loop_stellar.mjs \\
    --project-id 1 \\
    --secret-key-file ~/.config/stellar/verifier.secret \\
    --repo-url https://github.com/owner/repo.git \\
    --yes

Options:
  --once                   Process at most one proposal, then exit.
  --poll-seconds <n>       Poll delay. Defaults to 30.
  --work-dir <path>        Review workspace. Defaults to .autoresearch/validate-stellar.
  --record-root <path>     Where reviews.jsonl is written.
  --github-token-file <p>  Merge credential. Prefer this over GITHUB_TOKEN.
  --no-merge               Settle on-chain only.
  --dry-run                Print plans; do not send transactions.
`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function runRequired(cmd, args, opts = {}) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    const detail = opts.capture ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`${cmd} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

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

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function lastJsonPath(stdout) {
  const lines = String(stdout || "").trim().split(/\n/);
  return lines[lines.length - 1];
}

function evidenceFile(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(payload, jsonReplacer, 2)}\n`);
  return file;
}

function appendReviewRecord({ recordRoot, row }) {
  const dir = path.join(recordRoot, ".autoresearch", "verify");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "reviews.jsonl"), `${JSON.stringify(row, jsonReplacer)}\n`);
}

function mergeApproved({ proposalId, commit, options }) {
  if (options.noMerge) return { attempted: false, reason: "merge_disabled" };
  const repoUrl = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (!repoUrl || !commit) return { attempted: false, reason: "no_git_candidate" };
  const args = [
    path.join(SCRIPT_DIR, "merge_approved_proposal.mjs"),
    "--proposal-id",
    String(proposalId),
    "--repo-url",
    repoUrl,
    "--commit",
    commit,
  ];
  if (options.githubTokenFile) args.push("--token-file", options.githubTokenFile);
  if (options.dryRun) args.push("--dry-run");
  else args.push("--yes");
  const result = run("node", args, { capture: true });
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  const start = text.indexOf("{");
  const parsed = start >= 0 ? JSON.parse(text.slice(start)) : {};
  if (result.status === 0) return { attempted: true, merged: true, ...parsed };
  return {
    attempted: true,
    merged: false,
    reason: parsed.reason || "approved_but_unmerged",
    mergedCommit: parsed.mergedCommit || null,
    detail: text.trim(),
  };
}

async function settleAction(client, { action, verifier, proposalId, verifiedScore, reasonCode }) {
  let assembled;
  if (action === "claim-review") {
    assembled = await client.claim_review({ verifier, proposal_id: proposalId });
  } else if (action === "reject") {
    assembled = await client.reject({
      verifier,
      proposal_id: proposalId,
      reason_code: reasonCode || "rejected",
    });
  } else if (action === "release-review") {
    assembled = await client.release_review({ verifier, proposal_id: proposalId });
  } else if (action === "expire") {
    assembled = await client.expire({ proposal_id: proposalId });
  } else {
    throw new Error(`unsupported settle action ${action}`);
  }
  unwrapContract(assembled.result);
  const sent = await send(assembled);
  return sent?.hash || sent?.txHash || null;
}

async function verifyClaimedProposal({
  client,
  verifier,
  proposalId,
  proposal,
  project,
  options,
}) {
  const proposalDir = path.join(options.workDir, `proposal-${proposalId}`);
  fs.mkdirSync(proposalDir, { recursive: true });
  const reviewId = `stellar-p${proposalId}-${Date.now()}`;
  const txs = [];
  const repoArgs = options.repoUrl ? ["--repo-url", options.repoUrl] : [];

  let resolved;
  try {
    const resolve = runRequired("node", [
      path.join(SCRIPT_DIR, "resolve_proposal_artifacts_stellar.mjs"),
      "--proposal-id",
      String(proposalId),
      "--output-dir",
      proposalDir,
      ...repoArgs,
    ], { capture: true });
    resolved = readJson(lastJsonPath(resolve.stdout));
  } catch (err) {
    return {
      result: "skipped",
      reason: "artifact_resolve_failed",
      stdoutLog: "",
      verifiedScore: "",
      error: err.message,
      txs,
    };
  }
  const extractRoot = resolved.extractRoot;
  const candidateCommit = resolved.candidateCommit || resolved.git?.commit;

  const trustedDir = path.join(proposalDir, "trusted");
  const fetchTrusted = runRequired("node", [
    path.join(SCRIPT_DIR, "fetch_project_artifacts_stellar.mjs"),
    "--project-id",
    String(proposal.project_id),
    "--output-dir",
    trustedDir,
    ...repoArgs,
  ], { capture: true });
  const trusted = readJson(lastJsonPath(fetchTrusted.stdout));
  const protocolPath = trusted.protocolPath;
  const protocol = readJson(protocolPath);
  const direction = directionFromTag(
    project.direction || protocol?.measurement?.primaryMetric?.direction,
  );

  runRequired("bash", [path.join(SCRIPT_DIR, "init_verify_workspace.sh"), extractRoot]);

  const restore = run("python3", [
    path.join(SCRIPT_DIR, "restore_trusted_harness.py"),
    "--protocol",
    protocolPath,
    "--trusted-root",
    trusted.harnessDir,
    "--expect-commit",
    formatCommitId(project.baseline.commit),
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
    if (!options.dryRun) {
      const hash = await settleAction(client, {
        action: "reject",
        verifier,
        proposalId,
        reasonCode: "harness_tampered",
      });
      if (hash) txs.push(hash);
    }
    return { result: "rejected", reason: "harness_tampered", stdoutLog: ev, verifiedScore: "", error: restore.stderr, txs };
  }
  if (restore.status !== 0) {
    if (!options.dryRun) {
      const hash = await settleAction(client, { action: "release-review", verifier, proposalId });
      if (hash) txs.push(hash);
    }
    return { result: "released", reason: "harness_restore_failed", stdoutLog: "", verifiedScore: "", error: restore.stderr, txs };
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
    if (!options.dryRun) {
      const hash = await settleAction(client, {
        action: "reject",
        verifier,
        proposalId,
        reasonCode: "static_gate",
      });
      if (hash) txs.push(hash);
    }
    return { result: "rejected", reason: "static_gate_failed", stdoutLog: ev, verifiedScore: "", error: gates.stderr, txs };
  }

  const runTrial = run("bash", [
    path.join(SCRIPT_DIR, "run_verify_trial.sh"),
    protocolPath,
    extractRoot,
    reviewId,
  ], { cwd: extractRoot, capture: true, env: untrustedEnv() });
  const samplesPath = path.join(extractRoot, ".autoresearch", "verify", "runs", reviewId, "samples.json");
  if (runTrial.status !== 0) {
    if (!options.dryRun) {
      const hash = await settleAction(client, { action: "release-review", verifier, proposalId });
      if (hash) txs.push(hash);
    }
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
    if (!options.dryRun) {
      const hash = await settleAction(client, { action: "release-review", verifier, proposalId });
      if (hash) txs.push(hash);
    }
    return { result: "released", reason: "metric_parse_failed", stdoutLog: samplesPath, verifiedScore: "", error: err.message, txs };
  }

  const liveProject = await call(client, "get_project", { project_id: proposal.project_id });
  const bips = Number(liveProject.min_improvement_bips);
  const incumbent = await readIncumbentScore(client, proposal.project_id, liveProject);
  const verifiedScore = scaleMetric(String(samples.aggregate), BigInt(liveProject.metric_scale), direction);
  let threshold;
  try {
    threshold = await call(client, "improvement_threshold", { project_id: proposal.project_id });
  } catch {
    threshold = null;
  }

  if (!isSufficient(verifiedScore, incumbent, bips)) {
    const ev = evidenceFile(proposalDir, "no-improvement-reject.json", {
      reason: "no_improvement",
      metric: samples.aggregate,
      direction,
      minImprovementBips: bips,
      claimedScore: proposal.claimed_score.toString(),
      verifiedScore: verifiedScore.toString(),
      incumbentScore: incumbent.toString(),
      requiredScore: threshold !== null ? threshold.toString() : null,
    });
    if (!options.dryRun) {
      const hash = await settleAction(client, {
        action: "reject",
        verifier,
        proposalId,
        reasonCode: "no_improvement",
      });
      if (hash) txs.push(hash);
    }
    return { result: "rejected", reason: "no_improvement", stdoutLog: ev, verifiedScore: verifiedScore.toString(), error: "", txs };
  }

  let merge = { attempted: false };
  if (options.dryRun) {
    return {
      result: "approved",
      reason: "ok",
      stdoutLog: samplesPath,
      verifiedScore: verifiedScore.toString(),
      error: "",
      txs,
      candidateCommit,
      merge: { attempted: false, reason: "dry_run" },
    };
  }

  const result = await approveMergeAndRecord(
    client,
    { verifier, proposal_id: proposalId, verified_score: verifiedScore },
    async () => {
      merge = mergeApproved({ proposalId, commit: candidateCommit, options });
      if (!merge.mergedCommit) throw new Error(merge.reason || "unmerged");
      return parseCommitId(merge.mergedCommit);
    },
  );
  if (result.approval?.hash) txs.push(result.approval.hash);
  if (result.record?.hash) txs.push(result.record.hash);
  return {
    result: "approved",
    reason: result.status,
    stdoutLog: samplesPath,
    verifiedScore: verifiedScore.toString(),
    error: result.error ? String(result.error.message || result.error) : "",
    txs,
    candidateCommit,
    merge: {
      attempted: true,
      status: result.status,
      mergedCommit: merge.mergedCommit || (result.mergedCommit ? formatCommitId(result.mergedCommit) : null),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    boolKeys: ["help", "once", "yes", "dryRun", "noMerge"],
  });
  if (options.help || !options.projectId) {
    usage();
    return options.help ? 0 : 1;
  }
  if (!options.secretKeyFile && !options.identity) {
    throw new Error("pass --secret-key-file (or --identity)");
  }
  options.secretKeyFile = path.resolve(options.secretKeyFile || options.identity);
  options.workDir = path.resolve(options.workDir || path.join(process.cwd(), ".autoresearch", "validate-stellar"));
  options.recordRoot = path.resolve(options.recordRoot || VALIDATE_DIR);
  options.pollSeconds = Number(options.pollSeconds || "30");
  if (options.githubTokenFile) options.githubTokenFile = path.resolve(options.githubTokenFile);
  if (!options.repoUrl) options.repoUrl = process.env.ARAH_PROJECT_REPO;
  if (!options.repoUrl) throw new Error("pass --repo-url or set ARAH_PROJECT_REPO");

  const hasMergeCredential = Boolean(
    options.githubTokenFile ||
      process.env.ARAH_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN,
  );
  if (!options.noMerge && !hasMergeCredential) {
    console.error(
      "no GitHub credential found; approved proposals will be settled on-chain and left unmerged",
    );
  }

  fs.mkdirSync(options.workDir, { recursive: true });
  const deployment = loadDeployment(options.deploymentJson);
  const loaded = loadSecretKeyFile(options.secretKeyFile);
  const { client } = createClient({
    deployment,
    publicKey: loaded.publicKey,
    keypair: loaded.keypair,
  });
  const projectId = BigInt(options.projectId);
  const project = await call(client, "get_project", { project_id: projectId });
  const isVerifier = await call(client, "is_verifier", { verifier: loaded.publicKey });
  console.log(
    JSON.stringify(
      {
        chain: "stellar",
        projectId: projectId.toString(),
        contractId: deployment.openResearchContractId,
        verifier: loaded.publicKey,
        isVerifier,
        frozen: project.frozen,
        incumbentScore: incumbentScore(project).toString(),
        token: project.token,
        merge: {
          enabled: !options.noMerge && hasMergeCredential,
          repoUrl: options.repoUrl,
        },
      },
      jsonReplacer,
      2,
    ),
  );
  if (!isVerifier) {
    console.error(
      `not registered as verifier; stopping with no settlement sent. ` +
        `add_verifier is admin-only and this skill does not call it — ` +
        `ask the contract admin to allowlist ${loaded.publicKey} on-chain.`,
    );
    return 2;
  }
  if (!options.dryRun && !options.yes) {
    throw new Error("refusing to run live Stellar validator without --yes");
  }

  const handled = new Set();
  while (true) {
    const openIds = await call(client, "get_open_proposals", { project_id: projectId });
    let processedOne = false;
    for (const id of openIds) {
      const proposalId = BigInt(id);
      const key = proposalId.toString();
      if (handled.has(key)) continue;
      const proposal = await call(client, "get_proposal", { proposal_id: proposalId });
      if (BigInt(proposal.project_id) !== projectId) continue;
      if (BigInt(proposal.stake) <= 0n) continue;
      const status = proposalStatus(proposal);
      const reviewer = unwrapOption(proposal.reviewer);
      const ours = reviewer === loaded.publicKey;

      if (status === "submitted") {
        if (options.dryRun) {
          console.log(JSON.stringify({ dryRun: true, wouldClaim: key }));
          handled.add(key);
          continue;
        }
        try {
          const hash = await settleAction(client, {
            action: "claim-review",
            verifier: loaded.publicKey,
            proposalId,
          });
          if (hash) console.error(`claimed proposal ${key}: ${hash}`);
        } catch (err) {
          console.error(`claim-review failed for proposal ${key}: ${err.message}`);
          handled.add(key);
          continue;
        }
      } else if (!(status === "claimed" && ours)) {
        continue;
      }

      const liveProject = await call(client, "get_project", { project_id: projectId });
      const claimed = await call(client, "get_proposal", { proposal_id: proposalId });
      let outcome;
      try {
        outcome = await verifyClaimedProposal({
          client,
          verifier: loaded.publicKey,
          proposalId,
          proposal: claimed,
          project: liveProject,
          options,
        });
      } catch (err) {
        if (String(err.message || err).includes("ReviewLockExpired")) {
          try {
            const hash = await settleAction(client, { action: "expire", verifier: loaded.publicKey, proposalId });
            outcome = { result: "expired", reason: "review_lock_expired", stdoutLog: "", verifiedScore: "", error: err.message, txs: hash ? [hash] : [] };
          } catch (expireErr) {
            outcome = { result: "skipped", reason: "review_lock_expired", stdoutLog: "", verifiedScore: "", error: expireErr.message, txs: [] };
          }
        } else {
          throw err;
        }
      }

      appendReviewRecord({
        recordRoot: options.recordRoot,
        row: {
          schemaVersion: "1",
          review_id: `stellar-p${key}-${Date.now()}`,
          utc_timestamp: utcNow(),
          proposal_id: Number(key),
          project_id: Number(projectId),
          chain: "stellar",
          result: outcome.result,
          reason_code: outcome.reason,
          claimed_aggregate_score: claimed.claimed_score.toString(),
          verified_aggregate_score: outcome.verifiedScore,
          stdout_log_path: outcome.stdoutLog,
          transaction_hashes: outcome.txs,
          candidate_commit: outcome.candidateCommit || "",
          merged_commit: outcome.merge?.mergedCommit || null,
          merge_status: outcome.merge?.status || outcome.merge?.reason || "",
          error: outcome.error || "",
        },
      });
      console.log(JSON.stringify({ proposalId: key, outcome }, jsonReplacer, 2));
      handled.add(key);
      processedOne = true;
      if (options.once) return 0;
    }
    if (options.once) return processedOne ? 0 : 0;
    await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1000));
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
