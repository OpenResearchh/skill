#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  bufferHex,
  createClient,
  directionTag,
  gitRef,
  hashFile,
  hashFileHex,
  parseArgs,
  parseI128,
  parseU32,
  readJson,
  repoCommitment,
  requireAddress,
  requireContractId,
  resolveDeployment,
  scaleMetric,
  secretFromEnv,
  stellarTreeHash,
  unwrapResult,
  utcNow,
  writeJson,
} from "./stellar_open_research.mjs";
import { assertAllowedRemote, git } from "./git_artifacts.mjs";
import { startLocalStellarWalletPublish } from "./local_stellar_wallet_publish.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOOL_FLAGS = new Set([
  "help",
  "dryRun",
  "yes",
  "allowUnpushedBaseline",
  "gitPrimary",
  "headless",
  "noOpen",
]);

function usage() {
  console.log(`Usage:
  node scripts/publish_project_stellar.mjs \\
    --protocol-json ./out/protocol.json \\
    --repo-root ./my-project \\
    --baseline-aggregate-score 12345 \\
    --token <SEP41_CONTRACT_ID> \\
    --minimum-stake 1 \\
    --reward-per-approval 1 \\
    --reward-pool-funding 10 \\
    --creator <STELLAR_G_ADDRESS> \\
    --dry-run

Options:
  --repo-url <url>              Canonical clone URL. Defaults to origin, then protocol meta.repo.cloneUrl.
  --baseline-commit <ref>       Commit to pin. Defaults to HEAD of --repo-root.
  --tree-hash <hex>             Expected tree hash; verified against the checkout.
  --metric-scale <n>            Contract metric scale. Defaults to protocol or ARAH_METRIC_SCALE or 1000000.
  --min-improvement-bips <n>    Defaults to protocol measurement.minScoreImprovementBips or 100.
  --baseline-metric <decimal>   Human metric, scaled and direction-adjusted. Alternative to --baseline-aggregate-score.
  --contract-id <id>            Override OpenResearch contract id.
  --rpc-url <url>               Override Stellar RPC URL.
  --network-passphrase <text>   Override Stellar network passphrase.
  --deployment-json <path>      Deployment metadata. Defaults to smart-contracts/deployments/mainnet.json.
  --headless                    Use --secret-key/env signer instead of the browser wallet flow.
  --secret-key <S...>           Headless creator signer secret. Env fallback: ARAH_STELLAR_CREATOR_SECRET_KEY.
  --no-open                     Print the browser wallet URL without opening it automatically.
  --yes                         Send the create_project transaction. Without --yes this is a dry-run plan.
`);
}

function gitOut(repoRoot, args, { allowFail = false } = {}) {
  const result = git(repoRoot, args, { capture: true, allowFail });
  return (result.stdout || "").trim();
}

function resolveRepoRoot(options, protocolJson) {
  if (options.repoRoot) return path.resolve(options.repoRoot);
  const protocolDir = path.dirname(path.resolve(protocolJson));
  for (const candidate of [protocolDir, process.cwd()]) {
    const root = gitOut(candidate, ["rev-parse", "--show-toplevel"], { allowFail: true });
    if (root) return root;
  }
  throw new Error("could not find a git checkout to publish; pass --repo-root");
}

function resolveRemote(options, repoRoot, protocol) {
  const remote =
    options.repoUrl ||
    gitOut(repoRoot, ["remote", "get-url", "origin"], { allowFail: true }) ||
    protocol?.meta?.repo?.cloneUrl;
  if (!remote) throw new Error("could not resolve repo URL; pass --repo-url");
  return assertAllowedRemote(remote);
}

function resolveCommit(repoRoot, ref = "HEAD") {
  const commit = gitOut(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`not a full SHA-1 commit: ${commit}`);
  return commit;
}

function checkCommitPublished({ repoRoot, remoteUrl, commit, allowUnpushed }) {
  const listing = gitOut(repoRoot, ["ls-remote", remoteUrl], { allowFail: true });
  if (listing.split(/\r?\n/).some((line) => line.split(/\s+/, 1)[0] === commit)) return "remote";
  if (allowUnpushed) return "unverified";
  throw new Error(
    `baseline commit ${commit} was not found on ${remoteUrl}; push it or pass --allow-unpushed-baseline`,
  );
}

function buildPlan(options) {
  const protocolJson = path.resolve(options.protocolJson || "");
  if (!fs.existsSync(protocolJson)) throw new Error("--protocol-json must point to protocol.json");
  const protocol = readJson(protocolJson);
  const repoRoot = resolveRepoRoot(options, protocolJson);
  const remoteUrl = resolveRemote(options, repoRoot, protocol);
  const baselineCommit = resolveCommit(repoRoot, options.baselineCommit || "HEAD");
  const commitSource = checkCommitPublished({
    repoRoot,
    remoteUrl,
    commit: baselineCommit,
    allowUnpushed: Boolean(options.allowUnpushedBaseline),
  });
  const computedTreeHash = stellarTreeHash(repoRoot, baselineCommit);
  const expectedTree = options.treeHash && String(options.treeHash).replace(/^0x/, "").toLowerCase();
  if (expectedTree && expectedTree !== computedTreeHash) {
    throw new Error(`--tree-hash ${expectedTree} does not match ${baselineCommit} (${computedTreeHash})`);
  }

  const primary = protocol?.measurement?.primaryMetric || {};
  const direction = primary.direction;
  if (direction !== "minimize" && direction !== "maximize") {
    throw new Error("protocol measurement.primaryMetric.direction must be minimize or maximize");
  }
  const metricScale = parseU32(
    options.metricScale || protocol?.measurement?.metricScale || process.env.ARAH_METRIC_SCALE || 1_000_000,
    "metric scale",
  );
  const baselineScore =
    options.baselineAggregateScore !== undefined
      ? parseI128(options.baselineAggregateScore, "baseline aggregate score")
      : scaleMetric(options.baselineMetric, metricScale, direction);
  const minImprovementBips = parseU32(
    options.minImprovementBips ?? protocol?.measurement?.minScoreImprovementBips ?? 100,
    "min improvement bips",
  );
  if (minImprovementBips > 10_000) {
    throw new Error("min improvement bips must be <= 10000");
  }
  const token = requireContractId(options.token || process.env.ARAH_STELLAR_STAKE_TOKEN, "token");
  const rawCreator = options.creator || process.env.ARAH_STELLAR_CREATOR;
  const creator = rawCreator ? requireAddress(rawCreator, "creator") : null;
  const minimumStake = parseI128(options.minimumStake ?? process.env.ARAH_STAKE ?? "1", "minimum stake");
  const rewardPerApproval = parseI128(
    options.rewardPerApproval ?? process.env.ARAH_REWARD_PER_APPROVAL ?? "1",
    "reward per approval",
  );
  const rewardPoolFunding = parseI128(
    options.rewardPoolFunding ?? process.env.ARAH_REWARD_POOL_FUNDING ?? rewardPerApproval.toString(),
    "reward pool funding",
  );
  const repo = repoCommitment(remoteUrl);
  const protocolHash = hashFile(protocolJson);
  const treeHashHex = computedTreeHash;

  return {
    protocolJson,
    protocol,
    repoRoot,
    remoteUrl,
    repo,
    baselineCommit,
    treeHashHex,
    commitSource,
    metricScale,
    direction,
    minImprovementBips,
    baselineScore,
    token,
    creator,
    minimumStake,
    rewardPerApproval,
    rewardPoolFunding,
    protocolHash,
    input: {
      protocol_hash: protocolHash,
      baseline: gitRef({
        repoHash: repo.repoId,
        commit: baselineCommit,
        treeHash: treeHashHex,
      }),
      clone_url: remoteUrl,
      baseline_score: baselineScore,
      direction: directionTag(direction),
      min_improvement_bips: minImprovementBips,
      metric_scale: metricScale,
      token,
      minimum_stake: minimumStake,
      reward_per_approval: rewardPerApproval,
      reward_pool_funding: rewardPoolFunding,
    },
  };
}

function publishSummary(plan, network) {
  return {
    chain: "stellar",
    network: network.network,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    contractId: network.contractId,
    creator: plan.creator || "(browser wallet after connection)",
    protocolJson: plan.protocolJson,
    repo: plan.repo.canonical,
    baselineCommit: plan.baselineCommit,
    treeHash: plan.treeHashHex,
    baselineScore: plan.baselineScore.toString(),
    token: plan.token,
    minimumStake: plan.minimumStake.toString(),
    rewardPerApproval: plan.rewardPerApproval.toString(),
    rewardPoolFunding: plan.rewardPoolFunding.toString(),
  };
}

function writeManifests({ plan, network, outputDir, dryRun, publishResult = null, signedBy = null }) {
  const gitManifest = {
    schemaVersion: "2",
    artifactModel: "git",
    settlementLayer: "stellar",
    repo: {
      canonical: plan.repo.canonical,
      remoteUrl: plan.remoteUrl,
      repoId: plan.repo.repoId,
      repoIdPreimage: 'sha256("host/owner/repo", host lower-cased)',
    },
    baselineCommit: plan.baselineCommit,
    treeHash: `0x${plan.treeHashHex}`,
    treeHashAlgorithm: "openresearch/stellar-gitref/v3 (smart-contracts/packages/client/src/git.ts)",
    protocolHash: `0x${bufferHex(plan.protocolHash)}`,
    protocolJson: plan.protocolJson,
    repoRoot: plan.repoRoot,
    commitFoundVia: plan.commitSource,
    materialize: `git fetch ${plan.remoteUrl} ${plan.baselineCommit} && git checkout --detach ${plan.baselineCommit}`,
  };
  const gitPath = path.join(outputDir, "storage_git.json");
  writeJson(gitPath, gitManifest);

  const publish = {
    schemaVersion: "1",
    chain: "stellar",
    dryRun,
    utc_timestamp: utcNow(),
    network: network.network,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    contractId: network.contractId,
    deploymentJson: network.deploymentPath,
    creator: plan.creator,
    signedBy,
    args: {
      protocol_hash: `0x${hashFileHex(plan.protocolJson)}`,
      baseline: {
        repo: plan.repo.repoId,
        commit: plan.baselineCommit,
        tree_hash: plan.treeHashHex,
      },
      clone_url: plan.remoteUrl,
      baseline_score: plan.baselineScore.toString(),
      direction: plan.direction,
      metric_scale: plan.metricScale,
      min_improvement_bips: plan.minImprovementBips,
      token: plan.token,
      minimum_stake: plan.minimumStake.toString(),
      reward_per_approval: plan.rewardPerApproval.toString(),
      reward_pool_funding: plan.rewardPoolFunding.toString(),
    },
    result: publishResult,
  };
  const publishPath = path.join(outputDir, "publish_stellar.json");
  writeJson(publishPath, publish);
  return { gitPath, publishPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help || !options.protocolJson) {
    usage();
    return 0;
  }
  const plan = buildPlan(options);
  const network = resolveDeployment(options);
  const outputDir = path.dirname(plan.protocolJson);
  const dryRun = options.dryRun || !options.yes;

  if (dryRun) {
    const paths = writeManifests({ plan, network, outputDir, dryRun: true });
    console.log(paths.publishPath);
    return 0;
  }

  const useHeadless = Boolean(options.headless || options.secretKey);
  let walletSession = null;
  let signedBy = "secretKey";
  try {
    if (!useHeadless) {
      walletSession = await startLocalStellarWalletPublish({
        network: network.network,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        contractId: network.contractId,
        summary: publishSummary(plan, network),
        open: !options.noOpen,
      });
      console.log("\nOpen this local wallet signing page in a browser with Freighter or a compatible Stellar wallet:\n");
      console.log(walletSession.url);
      console.log("\nConnect your wallet there to approve the OpenResearch create_project transaction.\n");
      const connected = await walletSession.waitForAccount();
      if (plan.creator && plan.creator !== connected) {
        throw new Error(`--creator ${plan.creator} does not match the connected wallet ${connected}`);
      }
      plan.creator = connected;
      walletSession.setSummary(publishSummary(plan, network));
      signedBy = "browserWallet";
    }

    let client;
    if (useHeadless) {
      const secretKey = secretFromEnv(options, "creator");
      if (!secretKey) {
        throw new Error("headless live publish requires --secret-key or ARAH_STELLAR_CREATOR_SECRET_KEY");
      }
      if (!plan.creator) throw new Error("headless live publish requires --creator or ARAH_STELLAR_CREATOR");
      client = await createClient(
        {
          contractId: network.contractId,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        },
        { publicKey: plan.creator, secretKey },
      );
    } else {
      client = await createClient(
        {
          contractId: network.contractId,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        },
        {
          publicKey: plan.creator,
          signTransaction: (xdr, signOptions) =>
            walletSession.signTransaction(xdr, { ...signOptions, address: plan.creator }),
        },
      );
    }
    const tx = await client.create_project({ creator: plan.creator, input: plan.input });
    const projectId = unwrapResult(tx, "create_project");
    const sendResult = await tx.signAndSend();
    const paths = writeManifests({
      plan,
      network,
      outputDir,
      dryRun: false,
      signedBy,
      publishResult: {
        projectId: projectId.toString(),
        sendResult,
      },
    });
    walletSession?.setComplete({ publishPath: paths.publishPath });
    console.log(paths.publishPath);
  } finally {
    await walletSession?.close({ delayMs: 1000 });
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stellar publish failed: ${err.message}`);
    process.exit(1);
  },
);
