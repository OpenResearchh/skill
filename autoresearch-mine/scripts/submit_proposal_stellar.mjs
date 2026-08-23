#!/usr/bin/env node
// Submit a candidate GitRef to the Stellar OpenResearch contract.
//
// The commits are the artifact. This script builds the candidate GitRef with
// the vendored Stellar client, derives base_commit from the live incumbent,
// and escrows stake in `submit`.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  call,
  createClient,
  directionFromTag,
  formatCommitId,
  gitOut,
  gitRefFromCheckout,
  gitRefJson,
  incumbentCommit,
  jsonReplacer,
  loadDeployment,
  loadSecretKeyFile,
  parseArgs,
  parseCommitId,
  scaleMetric,
  send,
  unwrapContract,
} from "./stellar_open_research.mjs";
import { assertAllowedRemote } from "./git_artifacts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/submit_proposal_stellar.mjs \\
    --project-id 1 \\
    --repo-root /path/to/repo \\
    --claimed-metric 2.41 \\
    --reward-recipient G... \\
    --secret-key-file ~/.config/stellar/arah-mine.secret \\
    --yes

Options:
  --head-commit <ref>     Candidate commit. Defaults to HEAD.
  --base-commit <sha>     Must match the live incumbent; default is to read it on-chain.
  --repo-url <url>        Repository identity used for the GitRef. Defaults to origin.
  --stake <i128>          Defaults to the project's minimum_stake.
  --metric-scale <n>      Defaults to the on-chain project scale.
  --dry-run               Simulate and print the plan; do not submit.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    boolKeys: ["help", "yes", "dryRun"],
  });
  if (options.help || !options.projectId) {
    usage();
    return options.help ? 0 : 1;
  }
  if (!options.repoRoot) throw new Error("--repo-root is required");
  if (!options.rewardRecipient) throw new Error("--reward-recipient is required");
  if (!options.claimedMetric && options.claimedScore === undefined) {
    throw new Error("pass --claimed-metric or --claimed-score");
  }
  if (!options.dryRun && !options.yes) {
    throw new Error("refusing to submit Stellar transaction without --yes");
  }
  if (!options.dryRun && !options.secretKeyFile) {
    throw new Error("live submit requires --secret-key-file");
  }

  const repoRoot = path.resolve(options.repoRoot);
  const head = gitOut(repoRoot, ["rev-parse", "--verify", `${options.headCommit || "HEAD"}^{commit}`]);
  const dirty = gitOut(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    throw new Error("repo has uncommitted tracked changes; commit the winning trial before submitting");
  }

  const remote =
    options.repoUrl ||
    gitOut(repoRoot, ["remote", "get-url", "origin"]);
  assertAllowedRemote(remote);

  const deployment = loadDeployment(options.deploymentJson);
  const loaded = options.secretKeyFile ? loadSecretKeyFile(options.secretKeyFile) : null;
  const publicKey = loaded?.publicKey || options.miner;
  if (!publicKey) throw new Error("pass --secret-key-file or --miner (dry-run public key)");

  const { client } = createClient({
    deployment,
    publicKey,
    keypair: loaded?.keypair,
  });
  const projectId = BigInt(options.projectId);
  const project = await call(client, "get_project", { project_id: projectId });
  if (project.frozen) throw new Error("project is frozen; submit is disabled");

  const liveBase = formatCommitId(incumbentCommit(project));
  const baseCommit = options.baseCommit
    ? gitOut(repoRoot, ["rev-parse", "--verify", `${options.baseCommit}^{commit}`])
    : liveBase;
  if (baseCommit !== liveBase) {
    throw new Error(
      `base_commit ${baseCommit} does not match the live incumbent ${liveBase}; refresh the project before submit`,
    );
  }

  const candidate = await gitRefFromCheckout({
    repoRoot,
    commit: head,
    repository: remote,
  });
  const direction = directionFromTag(project.direction);
  const scale = BigInt(options.metricScale || project.metric_scale);
  const claimedScore =
    options.claimedScore !== undefined
      ? BigInt(options.claimedScore)
      : scaleMetric(String(options.claimedMetric), scale, direction);
  const stake = BigInt(options.stake || project.minimum_stake);
  if (stake < BigInt(project.minimum_stake)) {
    throw new Error(`stake ${stake} is below project minimum ${project.minimum_stake}`);
  }

  const input = {
    project_id: projectId,
    candidate,
    base_commit: parseCommitId(baseCommit),
    claimed_score: claimedScore,
    stake,
    reward_recipient: options.rewardRecipient,
  };

  const plan = {
    chain: "stellar",
    contractId: deployment.openResearchContractId,
    projectId: projectId.toString(),
    miner: publicKey,
    rewardRecipient: options.rewardRecipient,
    candidate: gitRefJson(candidate),
    baseCommit,
    claimedScore: claimedScore.toString(),
    stake: stake.toString(),
    dryRun: Boolean(options.dryRun),
  };

  if (options.dryRun) {
    await call(client, "get_project", { project_id: projectId });
    console.log(JSON.stringify(plan, jsonReplacer, 2));
    return 0;
  }

  const assembled = await client.submit({ miner: publicKey, input });
  const proposalId = unwrapContract(assembled.result);
  const sent = await send(assembled);
  const out = {
    ...plan,
    proposalId: proposalId.toString(),
    transactionHash: sent?.hash || sent?.txHash || null,
  };
  console.log(JSON.stringify(out, jsonReplacer, 2));
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
