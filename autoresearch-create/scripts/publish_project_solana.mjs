#!/usr/bin/env node
// Publish a project to the Solana OpenResearch program.
//
// Two artifact models live here on purpose:
//
//   git-primary (default) — the project is published as a reference to code
//   that already exists in git: the repo identity, a pinned baseline commit,
//   and an independent SHA-256 commitment to the tree at that commit. Nothing
//   is uploaded, because git is already content-addressed and already
//   replicated to everyone who clones the project. It targets the git-ref
//   create_project, which is not deployed yet.
//
//   irys (--upload-artifacts-to-irys) — the legacy four-tarball model that the
//   currently deployed program still expects. Kept because it is the only mode
//   that can settle today.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  bigintReplacer,
  buildCreateProjectInputs,
  buildPublishArtifactPaths,
  decimalMetricToScaledInt,
  hashFileBytes32,
  normalizePath,
  parseArgs,
  parseInt256,
  parseUint256,
  readJson,
} from "./publish_project_0g_lib.mjs";
import {
  applyIrysArtifactIds,
  applyIrysArtifactHashes,
  buildIrysBrowserUploadPlan,
  mergeIrysUploadReceipts,
  prepareIrysStorageArtifacts,
  resolveIrysNetwork,
} from "./irys_storage.mjs";
import { assertAllowedRemote, git, canonicalRepo,
  remoteUrlFor, treeHash } from "./git_artifacts.mjs";
import {
  createAnchorWallet,
  createOpenResearchPdas,
  createProjectAccounts,
  createProjectInstructionArgs,
  getOpenResearchProgram,
  hex32ToBytes,
  i64Bn,
  publicKeyFrom,
  readSolanaKeypair,
  resolveSolanaConfig,
  stringifyPublicKeys,
  summarizeSolanaCreateProject,
  u64BigInt,
  u64Bn,
} from "./solana_open_research.mjs";
import { startLocalSolanaWalletPublish } from "./local_solana_wallet_publish.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_SOLANA_DEPLOYMENT = path.join(
  SKILL_DIR,
  "contracts",
  "solana-open-research",
  "deployment.json",
);

function resolveBundledIdlPath() {
  try {
    const deployment = readJson(DEFAULT_SOLANA_DEPLOYMENT);
    const idlField = deployment?.programs?.OpenResearch?.idl;
    if (!idlField) return null;
    return path.resolve(path.dirname(DEFAULT_SOLANA_DEPLOYMENT), idlField);
  } catch {
    return null;
  }
}

function usage() {
  console.log(`Usage (git-primary, the default):
  node scripts/publish_project_solana.mjs \\
    --protocol-json ./out/protocol.json \\
    --repo-root ./my-project \\
    --baseline-aggregate-score 12345 \\
    --token-name "My Research Token" \\
    --token-symbol MRT \\
    --base-price 100000 \\
    --slope 1000 \\
    --miner-pool-cap 21000000 \\
    --yes

Usage (legacy Irys artifact upload):
  node scripts/publish_project_solana.mjs \\
    --protocol-json ./out/protocol.json \\
    --repo-snapshot-file ./repo-snapshot.tar \\
    --benchmark-file ./benchmark.tar \\
    --baseline-metrics-file ./out/baseline_run.log \\
    --baseline-aggregate-score 12345 \\
    --token-name "My Research Token" --token-symbol MRT \\
    --base-price 100000 --slope 1000 --miner-pool-cap 21000000 \\
    --upload-artifacts-to-irys \\
    --yes

Which mode targets which contract:
  git-primary (default)  -> the git-ref create_project, whose args include
                            repo, baseline_commit and tree_hash. NOT YET
                            DEPLOYED. This mode inspects the Anchor IDL: if the
                            program does not declare those fields it writes the
                            publish plan and stops instead of settling.
  --upload-artifacts-to-irys -> the currently deployed create_project, whose
                            args are the four artifact hashes plus their Irys
                            ids. This is the only mode that can settle today.

Git-primary options:
  --repo-root <path>       Local checkout the baseline was measured in.
                           Defaults to the git root of --protocol-json, then cwd.
  --repo-url <url>         Canonical remote. Defaults to the checkout's origin,
                           then protocol.json meta.repo.cloneUrl.
  --baseline-commit <ref>  Commit to pin. Defaults to HEAD of --repo-root.
  --tree-hash <hex>        Expected canonical tree hash; verified, not trusted.
  --allow-unpushed-baseline
                           Publish a commit this skill could not find on the
                           remote. Miners cannot fetch it until you push.

Bootstrap (one-time after a fresh program deployment):
  node scripts/publish_project_solana.mjs --initialize-only --yes

Default live submit:
  Opens a localhost browser page; pick your Solana wallet extension
  (Phantom, Solflare, Backpack, or any Wallet Standard wallet) and
  approve the createProject transaction. No private key on disk.

Filesystem keypair fallback:
  add --keypair ~/.config/solana/id.json to sign without a browser.

Notes:
  - Bundled full Anchor IDL is at contracts/solana-open-research/open_research.json.
    Override with --idl only when testing another build.
  - git-primary uploads nothing: the code is already in git, which is
    content-addressed and replicated. The chain records repo (sha256 of
    "host/owner/repo"), baseline_commit, tree_hash and protocol_hash, and the
    plan is written to storage_git.json.
  - tree_hash is SHA-1 hardening, not a transport check. Git already proves the
    commit; the second SHA-256 commitment means a SHA-1 collision alone is not
    enough to swap the code the project points at.
  - Irys mode: on devnet/testnet it uses Irys devnet, on mainnet-beta Irys
    mainnet. Override with --irys-network devnet|mainnet. The four on-chain
    hash fields are SHA-256 of the raw artifact bytes; Irys ids and gateway
    URLs are recorded in storage_irys.json.
  - Pass --allow-skip-storage (Irys mode only) if you intentionally want to
    publish hashes without uploading the files.
  - Pass --initialize-only to bootstrap the OpenResearch GlobalConfig PDA on a
    fresh program deployment. Opens the same browser wallet flow and submits
    the initialize instruction instead of createProject. Skips protocol/
    artifact preparation. Requires the authority wallet that deployed the
    program.
  - --dry-run defaults --project-id to 0 if not supplied.
  - RPC defaults to devnet. Override with --cluster, --rpc-url, or env vars:
    NEXT_PUBLIC_SOLANA_CLUSTER, NEXT_PUBLIC_SOLANA_RPC_URL,
    NEXT_PUBLIC_OPEN_RESEARCH_PROGRAM_ID.
`);
}

// Boolean flags this adapter adds on top of the shared parser. parseArgs treats
// any unknown --flag as taking a value, so they are stripped out first.
const LOCAL_BOOL_FLAGS = new Set(["--allow-unpushed-baseline", "--git-primary"]);

function camelCase(value) {
  return String(value).replace(/[-_]([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

export function parseSolanaArgs(argv) {
  const local = {};
  const rest = [];
  for (const arg of argv) {
    if (LOCAL_BOOL_FLAGS.has(arg)) {
      local[camelCase(arg.slice(2))] = true;
      continue;
    }
    rest.push(arg);
  }
  return { ...parseArgs(rest), ...local };
}

// ---------------------------------------------------------------------------
// Git-primary artifact model
// ---------------------------------------------------------------------------

// Owner may contain slashes (nested groups on some hosts), so it is matched
// lazily and the repo name is whatever follows the last slash.
const GIT_URL_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)\/([^/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)\/([^/]+?)(?:\.git)?\/?$/,
  /^[^@\s/]+@([^:]+):(.+)\/([^/]+?)(?:\.git)?\/?$/,
];

export function parseRepoUrl(url) {
  const value = String(url || "").trim();
  for (const pattern of GIT_URL_PATTERNS) {
    const match = value.match(pattern);
    if (!match) continue;
    const host = match[1].toLowerCase().replace(/:\d+$/, "");
    const owner = match[2].replace(/^\/+|\/+$/g, "");
    const name = match[3];
    if (host && owner && name) return { host, owner, name };
  }
  throw new Error(`could not read host/owner/repo out of remote '${value}'`);
}

/**
 * The on-chain repo identity: sha256("host/owner/repo").
 *
 * Lower-cased before hashing. Git hosts treat the owner/repo path as
 * case-insensitive, so a researcher who publishes `Owner/Repo` and a verifier
 * who clones `owner/repo` must land on the same commitment or every proposal
 * against that project fails for a reason neither of them can see.
 */
export function repoCommitment({ host, owner, name }) {
  // Delegates to the shared implementation so the researcher, the miner, and
  // the verifier cannot drift apart on what a project's identity is.
  const canonical = canonicalRepo(`https://${host}/${owner}/${name}`);
  return {
    host,
    owner,
    name,
    canonical,
    repoId: `0x${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    remoteUrl: remoteUrlFor({ host, owner, repo: name }),
  };
}

function gitOut(dir, args) {
  const result = git(dir, args, { allowFail: true });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

function resolveRepoRoot(options, protocolJsonPath) {
  const explicit = options.repoRoot ? path.resolve(options.repoRoot) : null;
  if (explicit) {
    const root = gitOut(explicit, ["rev-parse", "--show-toplevel"]);
    if (!root) throw new Error(`--repo-root is not a git repository: ${explicit}`);
    return root;
  }
  for (const candidate of [path.dirname(protocolJsonPath), process.cwd()]) {
    const root = gitOut(candidate, ["rev-parse", "--show-toplevel"]);
    if (root) return root;
  }
  throw new Error(
    "could not find a git checkout to publish; pass --repo-root <path to the checkout the baseline ran in>",
  );
}

function resolveRepoIdentity({ options, repoRoot, protocol }) {
  const remote =
    options.repoUrl ||
    gitOut(repoRoot, ["remote", "get-url", "origin"]) ||
    protocol?.meta?.repo?.cloneUrl;
  if (!remote) {
    throw new Error(
      "no repo remote available; pass --repo-url https://<host>/<owner>/<repo>",
    );
  }
  // A project nobody can fetch is not published. Reject unauthenticated or
  // command-executing transports before they reach the chain.
  assertAllowedRemote(remote);
  return repoCommitment(parseRepoUrl(remote));
}

function resolveBaselineCommit(repoRoot, options) {
  const ref = options.baselineCommit || "HEAD";
  const commit = gitOut(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!commit) throw new Error(`could not resolve '${ref}' to a commit in ${repoRoot}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`resolved commit is not a 40-character sha: ${commit}`);
  }
  return commit;
}

/**
 * Confirm the baseline commit is reachable from the remote.
 *
 * A commit that only exists on the researcher's laptop looks identical on-chain
 * to one that does not, and the failure only surfaces later when a miner cannot
 * clone the project. Checked locally first so an offline publish still works.
 */
function checkCommitPublished({ repoRoot, remoteUrl, commit, allowUnpushed }) {
  const tracked = gitOut(repoRoot, ["branch", "-r", "--contains", commit]);
  if (tracked) return "remote-tracking-branch";
  const listed = gitOut(repoRoot, ["ls-remote", remoteUrl]);
  if (listed && listed.includes(commit)) return "ls-remote";
  if (allowUnpushed) {
    console.warn(
      `[warning] could not confirm ${commit} is on ${remoteUrl}; miners cannot fetch it until you push.`,
    );
    return "unverified";
  }
  throw new Error(
    [
      `baseline commit ${commit} was not found on ${remoteUrl}.`,
      "Miners and verifiers fetch the project by commit id, so an unpushed baseline is unusable.",
      "",
      "Push the branch containing it, then re-run. To publish anyway:",
      "  --allow-unpushed-baseline",
    ].join("\n"),
  );
}

function buildGitArtifacts({ options, outputDir }) {
  const protocolJson = normalizePath(process.cwd(), options.protocolJson);
  if (!protocolJson || !fs.existsSync(protocolJson)) {
    throw new Error("--protocol-json must point to an existing protocol.json");
  }
  const protocol = readJson(protocolJson);
  const repoRoot = resolveRepoRoot(options, protocolJson);
  const repo = resolveRepoIdentity({ options, repoRoot, protocol });
  const baselineCommit = resolveBaselineCommit(repoRoot, options);
  const commitSource = checkCommitPublished({
    repoRoot,
    remoteUrl: repo.remoteUrl,
    commit: baselineCommit,
    allowUnpushed: Boolean(options.allowUnpushedBaseline),
  });

  const computedTreeHash = treeHash(repoRoot, baselineCommit);
  if (options.treeHash) {
    const expected = String(options.treeHash).toLowerCase().replace(/^0x/, "");
    if (expected !== computedTreeHash) {
      throw new Error(
        `--tree-hash ${expected} does not match the tree at ${baselineCommit} (${computedTreeHash})`,
      );
    }
  }

  const dirty = gitOut(repoRoot, ["status", "--porcelain"]);
  if (dirty) {
    console.warn(
      `[warning] ${repoRoot} has uncommitted changes; the published project pins ${baselineCommit}, not your working tree.`,
    );
  }

  return {
    repoRoot,
    protocolJson,
    // The consensus margin lives in the protocol the hash commits to; carried
    // here so a contract that stores it on-chain cannot disagree with the file.
    minImprovementBips: protocol?.measurement?.minScoreImprovementBips ?? 100,
    protocolHash: hashFileBytes32(protocolJson),
    repo,
    baselineCommit,
    treeHash: `0x${computedTreeHash}`,
    hashAlgo: 0,
    commitSource,
    workingTreeClean: !dirty,
  };
}

function buildGitCreateProjectInputs({ options, gitArtifacts }) {
  const baselineAggregateScore =
    options.baselineAggregateScore !== undefined
      ? parseInt256(options.baselineAggregateScore, "baselineAggregateScore")
      : decimalMetricToScaledInt(options.baselineMetric, options.metricScale);

  const tokenName = String(options.tokenName || "").trim();
  const tokenSymbol = String(options.tokenSymbol || "").trim();
  if (!tokenName) throw new Error("--token-name is required");
  if (!tokenSymbol) throw new Error("--token-symbol is required");

  return {
    protocolHash: gitArtifacts.protocolHash,
    repo: gitArtifacts.repo.repoId,
    baselineCommit: gitArtifacts.baselineCommit,
    treeHash: gitArtifacts.treeHash,
    hashAlgo: gitArtifacts.hashAlgo,
    baselineAggregateScore,
    minImprovementBips: gitArtifacts.minImprovementBips,
    metricScale: options.metricScale ? parseUint256(options.metricScale, "metricScale") : 1000000n,
    tokenName,
    tokenSymbol,
    basePrice: parseUint256(options.basePrice, "basePrice"),
    slope: parseUint256(options.slope, "slope"),
    minerPoolCap: parseUint256(options.minerPoolCap, "minerPoolCap"),
  };
}

const GIT_REF_ARG_FIELDS = ["repo", "baseline_commit", "tree_hash"];

/** Field names the deployed create_project actually declares, or null. */
export function createProjectArgFields(idl) {
  const instruction = idl?.instructions?.find((entry) =>
    ["create_project", "createProject"].includes(entry?.name),
  );
  if (!instruction) return null;
  const args = instruction.args || [];
  const wrapper = args.length === 1 ? args[0]?.type?.defined : null;
  const typeName = typeof wrapper === "string" ? wrapper : wrapper?.name;
  if (!typeName) return args.map((arg) => arg.name);
  const defined = idl?.types?.find((entry) => entry?.name === typeName);
  return defined?.type?.fields?.map((field) => field.name) || null;
}

export function idlSupportsGitPrimary(idl) {
  const fields = createProjectArgFields(idl);
  return Boolean(fields && GIT_REF_ARG_FIELDS.every((field) => fields.includes(field)));
}

function hex20ToBytes(value, label = "commit") {
  const text = String(value).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{40}$/.test(text)) {
    throw new Error(`${label} must be a 20-byte git commit sha`);
  }
  return Array.from(Buffer.from(text, "hex"));
}

/**
 * Encode git-primary args against whatever the IDL declares.
 *
 * The git-ref create_project is not deployed, so its exact field list is not
 * settled. Encoding by IDL field name means a shipped contract works without a
 * skill release, and a field this skill cannot supply fails loudly here instead
 * of being silently zero-filled on-chain.
 */
export function gitCreateProjectInstructionArgs(inputs, idl) {
  const fields = createProjectArgFields(idl);
  if (!fields) throw new Error("IDL does not declare a create_project instruction");

  const available = {
    protocolHash: hex32ToBytes(inputs.protocolHash, "protocolHash"),
    repo: hex32ToBytes(inputs.repo, "repo"),
    baselineCommit: hex20ToBytes(inputs.baselineCommit, "baselineCommit"),
    treeHash: hex32ToBytes(inputs.treeHash, "treeHash"),
    hashAlgo: Number(inputs.hashAlgo || 0),
    baselineAggregateScore: i64Bn(inputs.baselineAggregateScore, "baselineAggregateScore"),
    minImprovementBips: Number(inputs.minImprovementBips),
    metricScale: u64Bn(inputs.metricScale, "metricScale"),
    tokenName: inputs.tokenName,
    tokenSymbol: inputs.tokenSymbol,
    basePrice: u64Bn(inputs.basePrice, "basePrice"),
    slope: u64Bn(inputs.slope, "slope"),
    minerPoolCap: u64Bn(inputs.minerPoolCap, "minerPoolCap"),
  };

  const args = {};
  const unsupported = [];
  for (const field of fields) {
    const key = camelCase(field);
    if (key in available) args[key] = available[key];
    else unsupported.push(field);
  }
  if (unsupported.length) {
    throw new Error(
      `create_project declares fields this skill does not supply: ${unsupported.join(", ")}`,
    );
  }
  return args;
}

function summarizeGitCreateProject({ inputs, args, creator, projectId, config }) {
  return stringifyPublicKeys({
    network: config.cluster,
    rpcUrl: config.rpcUrl,
    programId: config.programId,
    method: "open_research.createProject",
    artifactModel: "git-primary",
    projectId: u64BigInt(projectId, "project id").toString(),
    args: args || inputs,
    accounts: createProjectAccounts({
      creator,
      projectId,
      programId: config.programId,
    }),
  });
}

function writeGitStorageManifest({ outputDir, gitArtifacts }) {
  const manifest = {
    artifactModel: "git-primary",
    note:
      "Nothing is uploaded. The code is in git, which is content-addressed and replicated; the chain records the repo identity, the pinned commit, and an independent SHA-256 tree commitment.",
    repo: {
      host: gitArtifacts.repo.host,
      owner: gitArtifacts.repo.owner,
      name: gitArtifacts.repo.name,
      canonical: gitArtifacts.repo.canonical,
      remoteUrl: gitArtifacts.repo.remoteUrl,
      repoId: gitArtifacts.repo.repoId,
      repoIdPreimage: 'sha256("<host>/<owner>/<repo>", lower-cased)',
    },
    baselineCommit: gitArtifacts.baselineCommit,
    hashAlgo: gitArtifacts.hashAlgo,
    treeHash: gitArtifacts.treeHash,
    treeHashAlgorithm: "openresearch/tree/v1 (scripts/tree_hash.py)",
    protocolHash: gitArtifacts.protocolHash,
    protocolJson: gitArtifacts.protocolJson,
    repoRoot: gitArtifacts.repoRoot,
    commitFoundVia: gitArtifacts.commitSource,
    workingTreeClean: gitArtifacts.workingTreeClean,
    materialize: `git fetch ${gitArtifacts.repo.remoteUrl} ${gitArtifacts.baselineCommit} && git checkout --detach ${gitArtifacts.baselineCommit}`,
    verifyTreeHash: `python3 scripts/tree_hash.py --repo-root <checkout> --commit ${gitArtifacts.baselineCommit} --verify ${gitArtifacts.treeHash}`,
  };
  const manifestPath = path.join(outputDir, "storage_git.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, bigintReplacer, 2) + "\n");
  console.log(`Git artifact manifest written: ${manifestPath}`);
  return manifestPath;
}

function gitContractGapError(idlPath) {
  return new Error(
    [
      "git-primary publish prepared, but the program at this address still expects the",
      "legacy artifact fields (protocol/repo_snapshot/benchmark/baseline_metrics + Irys ids).",
      `IDL: ${idlPath}`,
      "",
      "The plan was written next to the protocol bundle. Either:",
      "  - deploy the git-ref create_project and re-run, or",
      "  - publish against the deployed program with --upload-artifacts-to-irys.",
    ].join("\n"),
  );
}

async function runInitializeOnly({ options, live, useBrowserWallet, idlPath }) {
  if (!live) {
    throw new Error("--initialize-only does not support --dry-run; the bootstrap step is live-only");
  }
  if (options.uploadArtifactsToIrys || options.uploadArtifactsTo0g) {
    console.warn("[warning] artifact upload flags are ignored with --initialize-only");
  }

  const solanaConfig = resolveSolanaConfig(options);
  const pdas = createOpenResearchPdas(solanaConfig.programId);
  const configPda = pdas.config();
  const connection = new Connection(solanaConfig.rpcUrl, "confirmed");
  const existing = await connection.getAccountInfo(configPda, "confirmed");
  if (existing) {
    console.log(
      `OpenResearch GlobalConfig already initialized at ${configPda.toBase58()} on ${solanaConfig.cluster}. Nothing to do.`,
    );
    return 0;
  }

  const outputDir = path.resolve(
    options.outputDir ||
      (options.protocolJson ? path.dirname(path.resolve(options.protocolJson)) : process.cwd()),
  );
  fs.mkdirSync(outputDir, { recursive: true });

  const keypair = options.keypair
    ? Keypair.fromSecretKey(readSolanaKeypair(path.resolve(options.keypair)))
    : null;

  let walletSession = null;
  if (useBrowserWallet) {
    walletSession = await startLocalSolanaWalletPublish({
      cluster: solanaConfig.cluster,
      rpcUrl: solanaConfig.rpcUrl,
      programId: solanaConfig.programId.toBase58(),
      flow: "register-only",
      open: !options.noOpen,
    });
    console.log(
      "\nOpen this local wallet signing page in a browser with the program authority's Solana wallet:\n",
    );
    console.log(walletSession.url);
    console.log(
      "\nConnect your wallet there to approve the OpenResearch initialize transaction.\n",
    );
  }

  let authority;
  if (useBrowserWallet) {
    console.log("Waiting for wallet connection in the browser…");
    const connected = await walletSession.waitForAccount();
    authority = new PublicKey(connected);
    console.log(`Connected wallet: ${authority.toBase58()}`);
  } else {
    authority = options.creator
      ? publicKeyFrom(options.creator, "creator")
      : keypair?.publicKey;
    if (!authority) {
      throw new Error("--creator is required when --keypair is not supplied");
    }
  }

  const idl = readJson(idlPath);
  const wallet = keypair
    ? createAnchorWallet(keypair)
    : readonlyAnchorWallet(authority);
  const program = getOpenResearchProgram({
    wallet,
    idl,
    rpcUrl: solanaConfig.rpcUrl,
    programId: solanaConfig.programId,
  });

  const summary = stringifyPublicKeys({
    network: solanaConfig.cluster,
    rpcUrl: solanaConfig.rpcUrl,
    programId: solanaConfig.programId,
    method: "open_research.initialize",
    authority,
    accounts: {
      authority,
      config: configPda,
      systemProgram: SystemProgram.programId,
    },
  });
  console.log("\nSolana OpenResearch initialize plan\n");
  console.log(JSON.stringify(summary, bigintReplacer, 2));
  walletSession?.setSummary(summary);

  let signature;
  if (useBrowserWallet) {
    walletSession.setStepStatus("register", "active");
    const instruction = await program.methods
      .initialize()
      .accounts({
        authority,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    walletSession.setInstructionPlan({
      programId: instruction.programId.toBase58(),
      keys: instruction.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: !!k.isSigner,
        isWritable: !!k.isWritable,
      })),
      data: Buffer.from(instruction.data).toString("base64"),
    });

    console.log("\nWaiting for browser wallet approval and signature…\n");
    const result = await walletSession.result;
    signature = result.signature;
    console.log(`Solana transaction signature: ${signature}`);

    console.log("Confirming transaction…");
    const status = await program.provider.connection.confirmTransaction(
      signature,
      "confirmed",
    );
    if (status.value.err) {
      const message = `transaction failed: ${JSON.stringify(status.value.err)}`;
      walletSession.setStepStatus("register", "error", message);
      throw new Error(message);
    }
  } else {
    signature = await program.methods
      .initialize()
      .accounts({
        authority,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const record = {
    cluster: solanaConfig.cluster,
    rpcUrl: solanaConfig.rpcUrl,
    programId: solanaConfig.programId.toBase58(),
    signature,
    instruction: "initialize",
    authority: authority.toBase58(),
    accounts: stringifyPublicKeys({
      authority,
      config: configPda,
      systemProgram: SystemProgram.programId,
    }),
    signedBy: keypair ? "keypair" : "browserWallet",
  };
  const recordPath = path.join(outputDir, "initialize_solana.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, bigintReplacer, 2) + "\n");
  console.log(`Initialize record written: ${recordPath}`);
  console.log(`Solana transaction signature: ${signature}`);

  walletSession?.setComplete({
    signature,
    cluster: solanaConfig.cluster,
    title: "Program initialized",
    description:
      "GlobalConfig is now live on Solana. You can return to the CLI and run the project publish.",
  });
  await walletSession?.close({ delayMs: 5000 });
  return 0;
}

async function assertGlobalConfigExists(solanaConfig) {
  const pdas = createOpenResearchPdas(solanaConfig.programId);
  const configPda = pdas.config();
  const connection = new Connection(solanaConfig.rpcUrl, "confirmed");
  let info;
  try {
    info = await connection.getAccountInfo(configPda, "confirmed");
  } catch (err) {
    throw new Error(
      `failed to read OpenResearch GlobalConfig at ${configPda.toBase58()} on ${solanaConfig.cluster}: ${err.message}`,
    );
  }
  if (info) return;
  throw new Error(
    [
      `OpenResearch GlobalConfig PDA ${configPda.toBase58()} does not exist on ${solanaConfig.cluster}.`,
      `The program at ${solanaConfig.programId.toBase58()} has not been initialized yet.`,
      "",
      "Bootstrap it once with the program's authority wallet:",
      "  node scripts/publish_project_solana.mjs --initialize-only --yes",
      "",
      "Then re-run this command to register the project.",
    ].join("\n"),
  );
}

function readonlyAnchorWallet(publicKey) {
  return {
    publicKey: publicKeyFrom(publicKey, "creator"),
    signTransaction: async () => {
      throw new Error("read-only wallet cannot sign");
    },
    signAllTransactions: async () => {
      throw new Error("read-only wallet cannot sign");
    },
  };
}

async function main() {
  const options = parseSolanaArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const live = !options.dryRun;
  if (live && !options.yes) {
    throw new Error("refusing to submit Solana transaction without --yes");
  }
  if (options.uploadArtifactsTo0g) {
    console.warn(
      "[warning] --upload-artifacts-to-0g is deprecated for Solana publishes; using Irys instead.",
    );
  }
  // Git-primary is the default; uploading is now the opt-in.
  const artifactModel =
    options.uploadArtifactsToIrys || options.uploadArtifactsTo0g ? "irys" : "git";
  if (artifactModel === "irys" && options.gitPrimary) {
    throw new Error(
      "--git-primary and --upload-artifacts-to-irys select different artifact models; pass only one",
    );
  }
  if (artifactModel === "git" && options.allowSkipStorage) {
    console.warn(
      "[warning] --allow-skip-storage only applies to the Irys artifact model; git-primary uploads nothing.",
    );
  }
  const useBrowserWallet = live && !options.keypair;
  const idlPath = options.idl
    ? path.resolve(options.idl)
    : resolveBundledIdlPath();
  if (live && !idlPath) {
    throw new Error(
      "no Anchor IDL available: pass --idl, or restore the bundled IDL at contracts/solana-open-research/open_research.json",
    );
  }
  if (live && idlPath && !fs.existsSync(idlPath)) {
    throw new Error(`Anchor IDL not found at ${idlPath}`);
  }

  if (options.initializeOnly) {
    return runInitializeOnly({ options, live, useBrowserWallet, idlPath });
  }
  if (!options.protocolJson) {
    throw new Error("--protocol-json is required");
  }
  if (!live && !options.projectId && options.projectId !== 0) {
    options.projectId = "0";
    console.log(
      "[dry-run] no --project-id supplied; defaulting to 0 for the publish plan",
    );
  }

  const outputDir = path.resolve(
    options.outputDir || path.dirname(path.resolve(options.protocolJson)),
  );
  fs.mkdirSync(outputDir, { recursive: true });

  const idl = idlPath && fs.existsSync(idlPath) ? readJson(idlPath) : null;
  const gitPrimarySupported = idl ? idlSupportsGitPrimary(idl) : null;

  // Git artifacts are derived from a local checkout, so build them before any
  // network call: a bad --repo-root or an unpushed baseline should fail here,
  // not after the user has opened a wallet.
  let gitArtifacts = null;
  if (artifactModel === "git") {
    gitArtifacts = buildGitArtifacts({ options, outputDir });
    console.log("\nGit-primary artifacts\n");
    console.log(
      JSON.stringify(
        {
          repo: gitArtifacts.repo.canonical,
          repoId: gitArtifacts.repo.repoId,
          remoteUrl: gitArtifacts.repo.remoteUrl,
          baselineCommit: gitArtifacts.baselineCommit,
          treeHash: gitArtifacts.treeHash,
          protocolHash: gitArtifacts.protocolHash,
        },
        bigintReplacer,
        2,
      ),
    );
    writeGitStorageManifest({ outputDir, gitArtifacts });

    // This work is ahead of the contract. Stop before anything is signed rather
    // than encoding git fields the program will not read.
    if (gitPrimarySupported === false) {
      if (live) throw gitContractGapError(idlPath);
      console.warn(
        "[dry-run] the bundled IDL has no repo/baseline_commit/tree_hash fields; this plan cannot be submitted to the deployed program yet.",
      );
    }
  }

  const solanaConfig = resolveSolanaConfig(options);
  if (live) {
    await assertGlobalConfigExists(solanaConfig);
  }
  const irysNetwork = resolveIrysNetwork({
    cluster: solanaConfig.cluster,
    irysNetwork: options.irysNetwork,
  });
  const useIrysStorage = artifactModel === "irys" && !options.allowSkipStorage;
  if (live && options.keypair && useIrysStorage) {
    throw new Error(
      "live Irys uploads require the browser wallet flow. Omit --keypair, or pass --allow-skip-storage if you intentionally want no artifact upload.",
    );
  }

  let storageArtifacts = null;
  let inputOptions = options;
  let irysUploadPlan = null;
  if (useIrysStorage) {
    const artifactPaths = buildPublishArtifactPaths(options);
    storageArtifacts = prepareIrysStorageArtifacts({
      artifactPaths,
      network: irysNetwork,
    });
    irysUploadPlan = buildIrysBrowserUploadPlan({
      storageArtifacts,
      network: irysNetwork,
    });
    inputOptions = applyIrysArtifactHashes(options, storageArtifacts);
    if (!live) {
      writeIrysStorageManifest({
        outputDir,
        network: irysNetwork,
        storageArtifacts,
        uploaded: false,
      });
    }
  }

  let walletSession = null;
  if (useBrowserWallet) {
    walletSession = await startLocalSolanaWalletPublish({
      cluster: solanaConfig.cluster,
      rpcUrl: solanaConfig.rpcUrl,
      programId: solanaConfig.programId.toBase58(),
      storageArtifacts,
      irysUploadPlan,
      artifactFiles: storageArtifacts,
      flow: useIrysStorage ? "irys-register" : "register-only",
      open: !options.noOpen,
    });
    console.log(
      "\nOpen this local wallet signing page in a browser with your Solana wallet extension:\n",
    );
    console.log(walletSession.url);
    console.log(
      useIrysStorage
        ? "\nConnect your wallet there to upload artifacts to Irys and approve the createProject transaction.\n"
        : "\nConnect your wallet there to approve the createProject transaction.\n",
    );
  }

  let inputs =
    artifactModel === "git"
      ? buildGitCreateProjectInputs({ options, gitArtifacts })
      : buildCreateProjectInputs(inputOptions);
  const instructionArgsFor = (current) =>
    artifactModel === "git"
      ? gitCreateProjectInstructionArgs(current, idl)
      : createProjectInstructionArgs(current);
  const keypair = options.keypair
    ? Keypair.fromSecretKey(readSolanaKeypair(path.resolve(options.keypair)))
    : null;

  let creator;
  if (useBrowserWallet) {
    console.log("Waiting for wallet connection in the browser…");
    const connected = await walletSession.waitForAccount();
    creator = new PublicKey(connected);
    if (options.creator && String(options.creator) !== creator.toBase58()) {
      throw new Error(
        `--creator ${options.creator} does not match the connected wallet ${creator.toBase58()}`,
      );
    }
    console.log(`Connected wallet: ${creator.toBase58()}`);
  } else {
    creator = options.creator
      ? publicKeyFrom(options.creator, "creator")
      : keypair?.publicKey;
    if (!creator) {
      throw new Error("--creator is required when --keypair is not supplied");
    }
    if (
      keypair &&
      options.creator &&
      keypair.publicKey.toBase58() !== String(options.creator)
    ) {
      throw new Error("--creator does not match --keypair public key");
    }
  }

  let projectId = options.projectId ? u64BigInt(options.projectId, "project id") : null;
  let program = null;
  if (live) {
    const wallet = keypair
      ? createAnchorWallet(keypair)
      : readonlyAnchorWallet(creator);
    program = getOpenResearchProgram({
      wallet,
      idl,
      rpcUrl: solanaConfig.rpcUrl,
      programId: solanaConfig.programId,
    });
    if (projectId === null) {
      const pdas = createOpenResearchPdas(solanaConfig.programId);
      const config = await program.account.globalConfig.fetch(pdas.config());
      projectId = u64BigInt(config.nextProjectId.toString(), "nextProjectId");
    }
  }

  let summary =
    artifactModel === "git"
      ? summarizeGitCreateProject({
          inputs,
          // Only encode against the IDL when it actually has the git fields;
          // otherwise the plan still has to be printable so the researcher can
          // see what would be published once the contract ships.
          args: gitPrimarySupported ? instructionArgsFor(inputs) : null,
          creator,
          projectId,
          config: solanaConfig,
        })
      : summarizeSolanaCreateProject({
          inputs,
          creator,
          projectId,
          config: solanaConfig,
        });
  console.log("\nSolana OpenResearch publish plan\n");
  console.log(JSON.stringify(summary, bigintReplacer, 2));
  if (storageArtifacts) {
    console.log("\nIrys storage artifacts\n");
    console.log(JSON.stringify(storageArtifacts, bigintReplacer, 2));
  }
  walletSession?.setSummary(summary);

  if (!live) {
    const planPath = path.join(outputDir, "publish_solana_plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          artifactModel,
          contractSupportsGitPrimary: gitPrimarySupported,
          solana: summary,
          gitArtifacts,
          storageArtifacts,
          irysUploadPlan,
        },
        bigintReplacer,
        2,
      ) + "\n",
    );
    console.log(`Solana publish plan written: ${planPath}`);
    return 0;
  }

  let signature;
  if (useBrowserWallet) {
    if (useIrysStorage) {
      console.log("\nWaiting for browser Irys uploads…\n");
      const irysResult = await walletSession.waitForIrysUploads();
      storageArtifacts = mergeIrysUploadReceipts({
        storageArtifacts,
        uploadResult: irysResult,
        network: irysNetwork,
      });
      inputOptions = applyIrysArtifactIds(inputOptions, storageArtifacts);
      inputs = buildCreateProjectInputs(inputOptions);
      summary = summarizeSolanaCreateProject({
        inputs,
        creator,
        projectId,
        config: solanaConfig,
      });
      console.log("\nSolana OpenResearch publish plan with Irys ids\n");
      console.log(JSON.stringify(summary, bigintReplacer, 2));
      writeIrysStorageManifest({
        outputDir,
        network: irysNetwork,
        storageArtifacts,
        uploaded: true,
      });
      walletSession.setStorageArtifacts(storageArtifacts);
      walletSession.setSummary(summary);
    }
    walletSession.setStepStatus("register", "active");
    const instruction = await program.methods
      .createProject(instructionArgsFor(inputs))
      .accounts(
        createProjectAccounts({
          creator,
          projectId,
          programId: solanaConfig.programId,
        }),
      )
      .instruction();
    walletSession.setInstructionPlan({
      programId: instruction.programId.toBase58(),
      keys: instruction.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: !!k.isSigner,
        isWritable: !!k.isWritable,
      })),
      data: Buffer.from(instruction.data).toString("base64"),
    });

    console.log("\nWaiting for browser wallet approval and signature…\n");
    const result = await walletSession.result;
    signature = result.signature;
    console.log(`Solana transaction signature: ${signature}`);

    console.log("Confirming transaction…");
    const status = await program.provider.connection.confirmTransaction(
      signature,
      "confirmed",
    );
    if (status.value.err) {
      const message = `transaction failed: ${JSON.stringify(status.value.err)}`;
      walletSession.setStepStatus("register", "error", message);
      throw new Error(message);
    }
  } else {
    signature = await program.methods
      .createProject(instructionArgsFor(inputs))
      .accounts(
        createProjectAccounts({
          creator,
          projectId,
          programId: solanaConfig.programId,
        }),
      )
      .rpc();
  }

  const record = {
    cluster: solanaConfig.cluster,
    rpcUrl: solanaConfig.rpcUrl,
    programId: solanaConfig.programId.toBase58(),
    signature,
    projectId: projectId.toString(),
    creator: creator.toBase58(),
    accounts: summary.accounts,
    args: stringifyPublicKeys(summary.args),
    artifactModel,
    gitArtifacts,
    storageArtifacts,
    signedBy: keypair ? "keypair" : "browserWallet",
    storageLayer:
      artifactModel === "git" ? "git" : storageArtifacts ? "Irys" : "none",
  };
  const recordPath = path.join(outputDir, "publish_solana.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, bigintReplacer, 2) + "\n");
  console.log(`Publish record written: ${recordPath}`);
  console.log(`Solana transaction signature: ${signature}`);

  walletSession?.setComplete({
    signature,
    projectId: projectId.toString(),
    cluster: solanaConfig.cluster,
  });
  await walletSession?.close({ delayMs: 5000 });
  return 0;
}

function writeIrysStorageManifest({ outputDir, network, storageArtifacts, uploaded }) {
  const manifest = {
    storageNetwork: "Irys",
    irysNetwork: network.name,
    gatewayUrl: network.gatewayUrl,
    permanence: network.permanence,
    uploaded,
    artifacts: storageArtifacts,
    note: "Solana project hash fields use sha256Bytes32 values computed from the raw artifact bytes. Irys ids and gateway URIs are retrieval metadata.",
  };
  const manifestPath = path.join(outputDir, "storage_irys.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, bigintReplacer, 2) + "\n");
  console.log(`Irys storage manifest written: ${manifestPath}`);
}

// Run only when invoked as a script, so the helpers above can be imported
// (and tested) without a publish attempt starting as a side effect.
const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`publish failed: ${err.message}`);
      process.exit(1);
    },
  );
}
