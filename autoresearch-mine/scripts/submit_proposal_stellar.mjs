#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createClient,
  formatCommitId,
  gitRef,
  parseArgs,
  parseCommitId,
  parseI128,
  projectGitRef,
  requireAddress,
  resolveDeployment,
  secretFromEnv,
  unwrapResult,
  utcNow,
  writeJson,
} from "../../autoresearch-create/scripts/stellar_open_research.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOOL_FLAGS = new Set(["help", "dryRun", "yes"]);

function usage() {
  console.log(`Usage:
  node scripts/submit_proposal_stellar.mjs \\
    --project-id 1 \\
    --repo-hash <sha256 host/owner/repo> \\
    --head-commit <sha> \\
    --tree-hash <sha256> \\
    --base-commit <sha> \\
    --clone-url <url> \\
    --claimed-score 12345 \\
    --stake 1 \\
    --miner <STELLAR_G_ADDRESS> \\
    --reward-recipient <STELLAR_G_ADDRESS> \\
    --dry-run

Live submit requires --yes and a miner secret via --secret-key or ARAH_STELLAR_MINER_SECRET_KEY.
`);
}

function buildInput(options) {
  const claimedScore =
    options.claimedScore !== undefined
      ? parseI128(options.claimedScore, "claimed score")
      : parseClaimedMetric(options);
  return {
    project_id: BigInt(options.projectId),
    candidate: gitRef({
      repoHash: options.repoHash,
      commit: options.headCommit,
      treeHash: options.treeHash,
    }),
    clone_url: String(options.cloneUrl || ""),
    base_commit: parseCommitId(options.baseCommit),
    claimed_score: claimedScore,
    stake: parseI128(options.stake, "stake"),
    reward_recipient: requireAddress(options.rewardRecipient, "reward recipient"),
  };
}

function parseClaimedMetric(options) {
  if (options.claimedMetric === undefined) {
    throw new Error("--claimed-score or --claimed-metric is required");
  }
  const scale = BigInt(options.metricScale || process.env.ARAH_METRIC_SCALE || 1_000_000);
  const direction = options.direction;
  if (direction !== "minimize" && direction !== "maximize") {
    throw new Error("--direction minimize|maximize is required with --claimed-metric");
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(options.claimedMetric).trim());
  if (!match) throw new Error("claimed metric must be a decimal number");
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] || "";
  const den = 10n ** BigInt(fraction.length);
  const num = (whole * den + BigInt(fraction || "0")) * sign * scale;
  if (num % den !== 0n) throw new Error("claimed metric cannot be represented exactly at this scale");
  const scaled = num / den;
  return direction === "minimize" ? -scaled : scaled;
}

function writePlan({ options, network, input, dryRun, result = null }) {
  const output = {
    schemaVersion: "1",
    chain: "stellar",
    dryRun,
    utc_timestamp: utcNow(),
    network: network.network,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    contractId: network.contractId,
    miner: options.miner,
    input: {
      project_id: input.project_id.toString(),
      repo_hash: options.repoHash,
      head_commit: options.headCommit,
      tree_hash: options.treeHash,
      base_commit: options.baseCommit,
      clone_url: input.clone_url,
      claimed_score: input.claimed_score.toString(),
      stake: input.stake.toString(),
      reward_recipient: input.reward_recipient,
    },
    result,
  };
  const outPath = path.resolve(options.output || path.join(process.cwd(), "submission_stellar.json"));
  writeJson(outPath, output);
  return outPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help || !options.projectId) {
    usage();
    return 0;
  }
  options.miner = requireAddress(options.miner || process.env.ARAH_STELLAR_MINER, "miner");
  const network = resolveDeployment(options);
  const input = buildInput(options);
  const dryRun = options.dryRun || !options.yes;

  if (dryRun) {
    console.log(writePlan({ options, network, input, dryRun: true }));
    return 0;
  }

  const secretKey = secretFromEnv(options, "miner");
  if (!secretKey) throw new Error("live submit requires --secret-key or ARAH_STELLAR_MINER_SECRET_KEY");
  const client = await createClient(
    {
      contractId: network.contractId,
      rpcUrl: network.rpcUrl,
      networkPassphrase: network.networkPassphrase,
    },
    { publicKey: options.miner, secretKey },
  );
  const projectTx = await client.get_project({ project_id: BigInt(options.projectId) });
  const project = unwrapResult(projectTx, "get_project");
  const incumbent = projectGitRef(project);
  const incumbentCommit = formatCommitId(incumbent.gitRef.commit);
  if (incumbentCommit.toLowerCase() !== String(options.baseCommit).toLowerCase()) {
    throw new Error(
      `base commit ${options.baseCommit} is stale; current contract incumbent is ${incumbentCommit}`,
    );
  }
  if (
    options.protocolEpoch !== undefined &&
    Number(options.protocolEpoch) !== Number(project.protocol_epoch)
  ) {
    throw new Error(
      `protocol epoch ${options.protocolEpoch} is stale; current contract epoch is ${project.protocol_epoch}`,
    );
  }
  const tx = await client.submit({ miner: options.miner, input });
  const proposalId = unwrapResult(tx, "submit");
  const sendResult = await tx.signAndSend();
  console.log(
    writePlan({
      options,
      network,
      input,
      dryRun: false,
      result: {
        proposalId: proposalId.toString(),
        sendResult,
      },
    }),
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stellar submit failed: ${err.message}`);
    process.exit(1);
  },
);
