#!/usr/bin/env node
// Publish a project to the Stellar OpenResearch contract.
//
// Git is the artifact store. The contract records a GitRef (repo identity,
// commit, canonical tree hash) and the SHA-256 of protocol.json. Nothing is
// uploaded. Tree hashing and scoring use the vendored Stellar client so the
// bytes match the on-chain contract.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startLocalStellarWalletPublish } from "./local_stellar_wallet_publish.mjs";
import {
  DEFAULT_METRIC_SCALE,
  NATIVE_XLM_TESTNET,
  assertAllowedRemote,
  createClient,
  directionArg,
  directionFromTag,
  findProtocolInCommit,
  gitOut,
  gitRefFromCheckout,
  gitRefJson,
  jsonReplacer,
  loadDeployment,
  loadSecretKeyFile,
  parseArgs,
  protocolHashFromFile,
  readJson,
  scaleMetric,
  send,
  unwrapContract,
  writeChainConfig,
} from "./stellar_open_research.mjs";
import { git } from "./git_artifacts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/publish_project_stellar.mjs \\
    --protocol-json ./out/protocol.json \\
    --repo-root ./my-project \\
    --baseline-metric 2.5 \\
    --minimum-stake 10000000 \\
    --yes

Options:
  --repo-url <url>              Canonical remote. Defaults to origin, then protocol meta.repo.cloneUrl.
  --baseline-commit <ref>       Commit to pin. Defaults to HEAD.
  --baseline-aggregate-score    Already-scaled i128. Alternative to --baseline-metric.
  --metric-scale <n>            Decimal scale. Defaults to protocol or ${DEFAULT_METRIC_SCALE}.
  --direction minimize|maximize Defaults to protocol measurement.primaryMetric.direction.
  --min-improvement-bips <n>    Defaults to protocol measurement.minScoreImprovementBips or 100.
  --token <contract id>         SEP-41 token. Defaults to native testnet XLM.
  --minimum-stake <i128>        Positive token amount in base units (stroops for XLM).
  --reward-per-approval <i128>  Nonnegative. Defaults to 0.
  --reward-pool-funding <i128>  Nonnegative. Transferred from the creator. Defaults to 0.
  --secret-key-file <path>      Headless signer. Opt in explicitly; never a seed phrase.
  --allow-unpushed-baseline     Publish a commit this skill could not find on the remote.
  --dry-run                     Write the plan; do not submit.
  --yes                         Required for live submit.
`);
}

function gitRoot(start) {
  const result = git(start, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (result.status !== 0) return null;
  return (result.stdout || "").trim();
}

function resolveRepoRoot(options, protocolJson) {
  if (options.repoRoot) return path.resolve(options.repoRoot);
  const fromProtocol = gitRoot(path.dirname(protocolJson));
  if (fromProtocol) return fromProtocol;
  const fromCwd = gitRoot(process.cwd());
  if (fromCwd) return fromCwd;
  throw new Error("pass --repo-root; could not find a git checkout");
}

function resolveRepoUrl({ options, repoRoot, protocol }) {
  if (options.repoUrl) return assertAllowedRemote(options.repoUrl);
  const origin = git(repoRoot, ["remote", "get-url", "origin"], { allowFail: true });
  if (origin.status === 0 && origin.stdout.trim()) {
    return assertAllowedRemote(origin.stdout.trim());
  }
  const cloneUrl = protocol?.meta?.repo?.cloneUrl;
  if (cloneUrl) return assertAllowedRemote(cloneUrl);
  throw new Error("pass --repo-url; origin and protocol.json meta.repo.cloneUrl are missing");
}

function resolveCommit(repoRoot, ref) {
  return gitOut(repoRoot, ["rev-parse", "--verify", `${ref || "HEAD"}^{commit}`]);
}

function commitIsPublished(repoRoot, remoteUrl, commit) {
  const listing = git(repoRoot, ["ls-remote", remoteUrl], { allowFail: true });
  if (listing.status !== 0) return false;
  return listing.stdout.split("\n").some((line) => line.split("\t")[0].trim() === commit);
}

function outputDirFor(protocolJson) {
  return path.dirname(path.resolve(protocolJson));
}

async function buildPlan(options) {
  const protocolJson = path.resolve(options.protocolJson);
  if (!fs.existsSync(protocolJson)) {
    throw new Error("--protocol-json must point to an existing protocol.json");
  }
  const protocol = readJson(protocolJson);
  const repoRoot = resolveRepoRoot(options, protocolJson);
  const repository = resolveRepoUrl({ options, repoRoot, protocol });
  const baselineCommit = resolveCommit(repoRoot, options.baselineCommit);
  const published = commitIsPublished(repoRoot, repository, baselineCommit);
  if (!published && !options.allowUnpushedBaseline) {
    throw new Error(
      [
        `baseline commit ${baselineCommit} was not found on ${repository}.`,
        "Miners and verifiers fetch the project by commit id, so an unpushed baseline is unusable.",
        "Push the branch containing it, then re-run. To publish anyway: --allow-unpushed-baseline",
      ].join("\n"),
    );
  }

  const dirty = gitOut(repoRoot, ["status", "--porcelain"]);
  if (dirty) {
    console.warn(
      `[warning] ${repoRoot} has uncommitted changes; the published project pins ${baselineCommit}, not the working tree.`,
    );
  }

  const inCommit = await findProtocolInCommit(repoRoot, baselineCommit, [
    path.relative(repoRoot, protocolJson),
  ]);
  const fileHash = await protocolHashFromFile(protocolJson);
  if (!inCommit) {
    throw new Error(
      "protocol.json is not in the pinned commit. Commit the approved protocol into the repository before publishing so miners and verifiers can hash the same bytes.",
    );
  }
  if (inCommit.hash !== fileHash.hash) {
    throw new Error(
      `protocol.json at ${inCommit.rel} in ${baselineCommit} hashes to ${inCommit.hash}, but --protocol-json hashes to ${fileHash.hash}. Publish the committed bytes.`,
    );
  }

  const direction = directionFromTag(
    options.direction || protocol?.measurement?.primaryMetric?.direction,
  );
  const metricScale = Number(
    options.metricScale ||
      protocol?.measurement?.metricScale ||
      process.env.ARAH_METRIC_SCALE ||
      DEFAULT_METRIC_SCALE,
  );
  const minImprovementBips = Number(
    options.minImprovementBips ??
      protocol?.measurement?.minScoreImprovementBips ??
      100,
  );
  if (!Number.isInteger(minImprovementBips) || minImprovementBips < 0 || minImprovementBips > 10_000) {
    throw new Error("--min-improvement-bips must be an integer 0..10000");
  }

  let baselineScore;
  if (options.baselineAggregateScore !== undefined) {
    baselineScore = BigInt(options.baselineAggregateScore);
  } else if (options.baselineMetric !== undefined) {
    baselineScore = scaleMetric(String(options.baselineMetric), BigInt(metricScale), direction);
  } else {
    throw new Error("pass --baseline-metric or --baseline-aggregate-score");
  }

  const minimumStake = BigInt(options.minimumStake || "0");
  if (minimumStake <= 0n) throw new Error("--minimum-stake must be a positive integer");
  const rewardPerApproval = BigInt(options.rewardPerApproval || "0");
  const rewardPoolFunding = BigInt(options.rewardPoolFunding || "0");
  if (rewardPerApproval < 0n || rewardPoolFunding < 0n) {
    throw new Error("reward amounts must be nonnegative");
  }

  const gitRef = await gitRefFromCheckout({
    repoRoot,
    commit: baselineCommit,
    repository,
  });

  const deployment = loadDeployment(options.deploymentJson);
  const token = options.token || deployment.nativeTokenContractId || NATIVE_XLM_TESTNET;

  const input = {
    protocol_hash: Buffer.from(inCommit.hash, "hex"),
    baseline: gitRef,
    baseline_score: baselineScore,
    direction: directionArg(direction),
    min_improvement_bips: minImprovementBips,
    metric_scale: metricScale,
    token,
    minimum_stake: minimumStake,
    reward_per_approval: rewardPerApproval,
    reward_pool_funding: rewardPoolFunding,
  };

  return {
    artifactModel: "git",
    chain: "stellar",
    network: deployment.network,
    contractId: deployment.openResearchContractId,
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: deployment.networkPassphrase,
    repository,
    repoRoot,
    protocolJson,
    protocolRel: inCommit.rel,
    protocolHash: inCommit.hash,
    baselineCommit,
    gitRef: gitRefJson(gitRef),
    direction,
    metricScale,
    minImprovementBips,
    baselineScore: baselineScore.toString(),
    token,
    minimumStake: minimumStake.toString(),
    rewardPerApproval: rewardPerApproval.toString(),
    rewardPoolFunding: rewardPoolFunding.toString(),
    commitPublished: published,
    workingTreeClean: !dirty,
    input,
    deployment,
  };
}

function writeOutputs(plan, extra = {}) {
  const outDir = outputDirFor(plan.protocolJson);
  const planPath = path.join(outDir, extra.live ? "publish_stellar.json" : "publish_stellar_plan.json");
  const storagePath = path.join(outDir, "storage_git.json");
  const storage = {
    artifactModel: "git",
    chain: "stellar",
    note:
      "Nothing is uploaded. The code is in git; the contract records repo, commit, and the Stellar canonical tree hash.",
    repository: plan.repository,
    baselineCommit: plan.baselineCommit,
    gitRef: plan.gitRef,
    protocolHash: plan.protocolHash,
    protocolRel: plan.protocolRel,
    contractId: plan.contractId,
    network: plan.network,
    treeHashAlgorithm: "stellar-client hashCanonicalTree (mode SP path NUL length NUL blob NUL)",
    repoIdentity: "stellar-client normalizeRepositoryIdentity (host lowercased, owner/repo case preserved)",
  };
  fs.writeFileSync(planPath, `${JSON.stringify({ ...plan, input: undefined, ...extra }, jsonReplacer, 2)}\n`);
  fs.writeFileSync(storagePath, `${JSON.stringify(storage, jsonReplacer, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "chain.json"), `${JSON.stringify({ chain: "stellar" }, null, 2)}\n`);
  writeChainConfig(plan.repoRoot, "stellar");
  return { planPath, storagePath };
}

async function submitWithSigner(plan, { publicKey, signTransaction, keypair }) {
  const { client } = createClient({
    deployment: plan.deployment,
    publicKey,
    signTransaction,
    keypair,
  });
  const assembled = await client.create_project({
    creator: publicKey,
    input: plan.input,
  });
  const projectId = unwrapContract(assembled.result);
  const sent = await send(assembled);
  return {
    projectId: projectId.toString(),
    hash: sent?.hash || sent?.txHash || null,
    creator: publicKey,
    sent,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv, {
    boolKeys: ["help", "yes", "dryRun", "allowUnpushedBaseline"],
  });
  if (options.help || argv.length === 0) {
    usage();
    return 0;
  }
  if (!options.protocolJson) throw new Error("--protocol-json is required");

  const plan = await buildPlan(options);
  if (options.dryRun) {
    const { planPath, storagePath } = writeOutputs(plan, { dryRun: true });
    console.log(JSON.stringify({ dryRun: true, planPath, storagePath, plan: { ...plan, input: undefined } }, jsonReplacer, 2));
    return 0;
  }
  if (!options.yes) {
    throw new Error("refusing to submit Stellar transaction without --yes (pass --dry-run to write the plan only)");
  }

  let result;
  if (options.secretKeyFile) {
    const loaded = loadSecretKeyFile(options.secretKeyFile);
    result = await submitWithSigner(plan, {
      publicKey: loaded.publicKey,
      keypair: loaded.keypair,
    });
  } else {
    result = await startLocalStellarWalletPublish({
      networkPassphrase: plan.networkPassphrase,
      summary: {
        contractId: plan.contractId,
        network: plan.network,
        repository: plan.repository,
        baselineCommit: plan.baselineCommit,
        protocolHash: plan.protocolHash,
        baselineScore: plan.baselineScore,
        direction: plan.direction,
        token: plan.token,
        minimumStake: plan.minimumStake,
        rewardPerApproval: plan.rewardPerApproval,
        rewardPoolFunding: plan.rewardPoolFunding,
      },
      buildAndSend: (publicKey, signTransaction) =>
        submitWithSigner(plan, { publicKey, signTransaction }),
    });
  }

  const { planPath, storagePath } = writeOutputs(plan, {
    live: true,
    projectId: result.projectId,
    transactionHash: result.hash,
    creator: result.creator || result.publicKey,
  });
  console.log(
    JSON.stringify(
      {
        chain: "stellar",
        projectId: result.projectId,
        transactionHash: result.hash,
        creator: result.creator || result.publicKey,
        contractId: plan.contractId,
        planPath,
        storagePath,
      },
      jsonReplacer,
      2,
    ),
  );
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
