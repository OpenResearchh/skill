#!/usr/bin/env node
// Shared Stellar OpenResearch helpers for create / mine / validate.
//
// Canonical hashing and scoring come from the vendored
// @openresearch/stellar-client. Do not substitute tree_hash.py or the
// lower-cased repo-identity helper when talking to this contract — those
// formats are for the undeployed Solana git-primary path and will not
// match on-chain GitRef bytes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  contractErrorName,
  createGitRef,
  formatCommitId,
  generated,
  hashProtocol,
  hashRepositoryIdentity,
  improvementThreshold,
  isSufficient,
  networks,
  normalizeRepositoryIdentity,
  OpenResearchContractError,
  parseCommitId,
  scaleMetric,
  serializeCanonicalTree,
  hashCanonicalTree,
} from "../vendor/openresearch-stellar-client/index.js";
import { assertAllowedRemote, fetchCommit } from "./git_artifacts.mjs";
export { assertAllowedRemote, fetchCommit };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_DEPLOYMENT = path.join(
  SKILL_DIR,
  "contracts",
  "stellar-open-research",
  "deployment.json",
);

export const NATIVE_XLM_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const STROOPS_PER_XLM = 10_000_000n;
export const DEFAULT_METRIC_SCALE = 1_000_000;
export const GITHUB_PLATFORM = 0;

export const PROTOCOL_CANDIDATES = [
  path.join(".autoresearch", "publish", "protocol.json"),
  path.join(".autoresearch", "create", "protocol.json"),
  "protocol.json",
];

export {
  contractErrorName,
  createGitRef,
  formatCommitId,
  generated,
  hashProtocol,
  hashRepositoryIdentity,
  improvementThreshold,
  isSufficient,
  networks,
  normalizeRepositoryIdentity,
  OpenResearchContractError,
  parseCommitId,
  scaleMetric,
  serializeCanonicalTree,
  hashCanonicalTree,
};

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return value;
}

export function parseArgs(argv, { boolKeys = [] } = {}) {
  const options = {};
  const bool = new Set(boolKeys);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) throw new Error(`unexpected argument: ${raw}`);
    const key = raw.slice(2).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
    if (bool.has(key)) {
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

export function loadDeployment(filePath = process.env.ARAH_STELLAR_DEPLOYMENT_JSON || DEFAULT_DEPLOYMENT) {
  const deployment = readJson(filePath);
  return {
    ...deployment,
    network: process.env.ARAH_STELLAR_NETWORK || deployment.network || "testnet",
    rpcUrl: process.env.ARAH_STELLAR_RPC_URL || deployment.rpcUrl,
    horizonUrl: process.env.ARAH_STELLAR_HORIZON_URL || deployment.horizonUrl,
    networkPassphrase:
      process.env.ARAH_STELLAR_NETWORK_PASSPHRASE || deployment.networkPassphrase,
    openResearchContractId:
      process.env.ARAH_STELLAR_CONTRACT_ID || deployment.openResearchContractId,
    nativeTokenContractId:
      process.env.ARAH_STELLAR_TOKEN ||
      deployment.nativeTokenContractId ||
      NATIVE_XLM_TESTNET,
  };
}

export function networkFromDeployment(deployment) {
  return {
    contractId: deployment.openResearchContractId,
    networkPassphrase: deployment.networkPassphrase,
    rpcUrl: deployment.rpcUrl,
  };
}

export function loadSecretKeyFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`secret key file not found: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, "utf8").trim().split(/\s+/)[0];
  if (!text || text.startsWith("{")) {
    throw new Error(
      `${resolved} must contain a Stellar secret key (S...), not a seed phrase or JSON wallet`,
    );
  }
  const keypair = Keypair.fromSecret(text);
  return { keypair, publicKey: keypair.publicKey(), file: resolved };
}

export function generateIdentity() {
  const keypair = Keypair.random();
  return { keypair, publicKey: keypair.publicKey(), secret: keypair.secret() };
}

export function writeSecretKeyFile(filePath, secret) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(resolved, 0o600);
  } catch {
    // Windows has no POSIX modes.
  }
  return resolved;
}

export function signTransactionWithKeypair(keypair, networkPassphrase) {
  return async (xdr, opts = {}) => {
    const passphrase = opts.networkPassphrase || networkPassphrase;
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(keypair);
    return tx.toXDR();
  };
}

export function createClient({
  deployment,
  publicKey,
  signTransaction,
  keypair,
} = {}) {
  const config = deployment || loadDeployment();
  const network = networkFromDeployment(config);
  let signer = signTransaction;
  let address = publicKey;
  if (keypair) {
    address = address || keypair.publicKey();
    signer = signer || signTransactionWithKeypair(keypair, network.networkPassphrase);
  }
  if (!address) {
    address = Keypair.random().publicKey();
  }
  return {
    client: new generated.Client({
      ...network,
      publicKey: address,
      ...(signer ? { signTransaction: signer } : {}),
    }),
    publicKey: address,
    deployment: config,
    network,
  };
}

export function createReadonlyClient(deployment) {
  return createClient({ deployment }).client;
}

export function unwrapContract(result) {
  if (result && typeof result === "object" && typeof result.unwrap === "function") {
    if (typeof result.isErr === "function" && result.isErr()) {
      const err = result.unwrapErr();
      const message = err?.message || String(err);
      const entry = Object.entries(
        // Keep names next to the vendor table so a new error code is obvious.
        {
          1: "InvalidConfig",
          2: "NotAdmin",
          3: "NotVerifier",
          4: "VerifierAlreadyExists",
          5: "VerifierNotFound",
          6: "IdentityNotFound",
          7: "InvalidHandle",
          8: "InvalidPlatform",
          100: "ProjectNotFound",
          101: "ProposalNotFound",
          102: "InvalidGitRef",
          103: "InvalidProtocolHash",
          104: "InvalidMetricScale",
          106: "InvalidImprovementBips",
          108: "InvalidAmount",
          109: "ArithmeticOverflow",
          110: "ProjectFrozen",
          111: "ProjectAlreadyFrozen",
          112: "ProtocolEpochMismatch",
          113: "NotProjectCreator",
          200: "StakeTooLow",
          201: "QueueFull",
          202: "BaseCommitMismatch",
          203: "InvalidStatus",
          204: "NotClaimOwner",
          205: "ReviewLockActive",
          206: "ProposalCannotExpire",
          208: "InsufficientImprovement",
          209: "ReviewLockExpired",
          210: "MergeAlreadyRecorded",
        },
      ).find(([, name]) => message.includes(name));
      throw new OpenResearchContractError(
        entry ? Number(entry[0]) : -1,
        message,
      );
    }
    return result.unwrap();
  }
  return result;
}

export async function simulate(client, method, args = {}) {
  const assembled = Object.keys(args).length
    ? await client[method](args)
    : await client[method]();
  assembled.result = unwrapContract(assembled.result);
  return assembled;
}

export async function call(client, method, args = {}) {
  const assembled = await simulate(client, method, args);
  return assembled.result;
}

export async function send(assembled) {
  const sent = await assembled.signAndSend();
  return sent;
}

/**
 * Approve first, then best-effort merge + record_merge.
 *
 * The vendored helper calls `result.isErr()` directly, which throws when a
 * simulated `Result<void>` has already been unwrapped to `undefined`. Always
 * go through unwrapContract so a successful approve cannot be lost to that.
 */
export async function approveMergeAndRecord(client, args, merge, options) {
  const approvalTx = await client.approve(args, options);
  unwrapContract(approvalTx.result);
  const approval = await send(approvalTx);
  let mergedCommit;
  try {
    const merged = await merge(args.proposal_id);
    mergedCommit = typeof merged === "string" ? parseCommitId(merged) : merged;
  } catch (error) {
    return { status: "approved-but-unmerged", approval, error };
  }
  try {
    const recordTx = await client.record_merge(
      {
        verifier: args.verifier,
        proposal_id: args.proposal_id,
        merged_commit: mergedCommit,
      },
      options,
    );
    unwrapContract(recordTx.result);
    const record = await send(recordTx);
    return { status: "merged-and-recorded", approval, mergedCommit, record };
  } catch (error) {
    return { status: "approved-but-unrecorded", approval, mergedCommit, error };
  }
}

/** Decode a Soroban Option, including Some/None tag wrappers. */
export function unwrapOption(value) {
  if (value == null) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.length ? value[0] : null;
  if ("tag" in value) {
    const tag = String(value.tag);
    if (tag === "None" || tag === "none") return null;
    if (Array.isArray(value.values) && value.values.length) return value.values[0];
  }
  return value;
}

export async function readIncumbentScore(client, projectId, project) {
  try {
    return BigInt(await call(client, "incumbent_score", { project_id: projectId }));
  } catch {
    return incumbentScore(project);
  }
}

export function directionFromTag(direction) {
  const tag = direction?.tag || direction;
  if (tag === "Minimize" || tag === "minimize") return "minimize";
  if (tag === "Maximize" || tag === "maximize") return "maximize";
  throw new Error(`unknown direction: ${JSON.stringify(direction)}`);
}

export function directionArg(direction) {
  const normalized = directionFromTag(direction);
  return normalized === "minimize"
    ? { tag: "Minimize", values: undefined }
    : { tag: "Maximize", values: undefined };
}

export function proposalStatus(proposal) {
  const tag = proposal?.status?.tag || proposal?.status;
  return String(tag || "").toLowerCase();
}

export function hexBuffer(value) {
  if (!value) return null;
  if (typeof value === "string") return value.replace(/^0x/, "").toLowerCase();
  return Buffer.from(value).toString("hex");
}

export function gitRefJson(gitRef) {
  if (!gitRef) return null;
  return {
    repo: hexBuffer(gitRef.repo),
    commit: formatCommitId(gitRef.commit),
    commitAlgo: gitRef.commit?.tag === "Sha256" ? "sha256" : "sha1",
    treeHash: hexBuffer(gitRef.tree_hash),
  };
}

export function slotGitRef(slot) {
  if (!slot || !slot.present) return null;
  return slot.value;
}

export function incumbentGitRef(project) {
  return slotGitRef(project.current_best) || project.baseline;
}

export function incumbentScore(project) {
  return slotGitRef(project.current_best)
    ? BigInt(project.current_best_score)
    : BigInt(project.baseline_score);
}

export function incumbentCommit(project) {
  return incumbentGitRef(project).commit;
}

export function scoreToMetric(score, scale, direction) {
  const oriented = BigInt(score);
  const raw = directionFromTag(direction) === "minimize" ? -oriented : oriented;
  const scaleBig = BigInt(scale);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / scaleBig;
  const frac = abs % scaleBig;
  if (frac === 0n) return `${negative && whole !== 0n ? "-" : ""}${whole}`;
  const fracDigits = String(scaleBig).length - 1;
  const fracStr = frac.toString().padStart(fracDigits, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fracStr}`;
}

export function splitNulRecords(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      if (i > start) parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

function gitBuffer(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SUBMODULE_STRATEGY: "none" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)])
      .toString("utf8")
      .trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout || Buffer.alloc(0);
}

export function gitOut(cwd, args) {
  return gitBuffer(cwd, args).toString("utf8").trim();
}

export function listGitTreeEntries(repoRoot, commit) {
  const raw = gitBuffer(repoRoot, ["ls-tree", "-r", "-z", commit]);
  const entries = [];
  for (const record of splitNulRecords(raw)) {
    if (!record.length) continue;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error(`unparseable ls-tree record: ${record.toString("utf8")}`);
    const meta = record.subarray(0, tab).toString("utf8").split(/\s+/);
    const pathBytes = record.subarray(tab + 1);
    const [mode, objType, objSha] = meta;
    const treePath = pathBytes.toString("utf8");
    let blob;
    if (objType === "commit" || mode === "160000") {
      blob = Buffer.from(objSha, "hex");
    } else {
      blob = gitBuffer(repoRoot, ["cat-file", "blob", objSha]);
    }
    entries.push({ path: treePath, mode, blob });
  }
  return entries;
}

export async function gitRefFromCheckout({ repoRoot, commit, repository }) {
  const sha = gitOut(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
  const entries = listGitTreeEntries(repoRoot, sha);
  return createGitRef(repository, sha, entries);
}

export function assertGitRefEqual(actual, expected, label = "git ref") {
  const a = gitRefJson(actual);
  const b = gitRefJson(expected);
  if (a.repo !== b.repo) {
    throw new Error(`${label} repo mismatch: expected ${b.repo}, got ${a.repo}`);
  }
  if (a.commit !== b.commit) {
    throw new Error(`${label} commit mismatch: expected ${b.commit}, got ${a.commit}`);
  }
  if (a.treeHash !== b.treeHash) {
    throw new Error(`${label} tree_hash mismatch: expected ${b.treeHash}, got ${a.treeHash}`);
  }
  return a;
}

export async function assertRepositoryMatches(repository, expectedRepoHex) {
  const actual = (await hashRepositoryIdentity(repository)).toString("hex");
  const expected = String(expectedRepoHex).replace(/^0x/, "").toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `repository identity mismatch: '${repository}' hashes to ${actual} but the contract records ${expected}. ` +
        "Stellar preserves owner/repository case; use the same clone URL that was published.",
    );
  }
  return actual;
}

export async function materializeGitRef({ dir, remote, gitRef, repository, depth = 1 }) {
  const url = assertAllowedRemote(remote);
  const commit = formatCommitId(gitRef.commit);
  await assertRepositoryMatches(repository || url, hexBuffer(gitRef.repo));
  fetchCommit({ dir, remote: url, commit, depth });
  const actual = await gitRefFromCheckout({
    repoRoot: dir,
    commit,
    repository: repository || url,
  });
  assertGitRefEqual(actual, gitRef);
  return { dir, commit, gitRef: actual, remote: url };
}

export function protocolPathInTree(repoRoot, extra = []) {
  const seen = new Set();
  for (const rel of [...extra, ...PROTOCOL_CANDIDATES]) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return { rel, path: full };
  }
  return null;
}

export async function protocolHashFromFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const digest = await hashProtocol(bytes);
  return { bytes, hash: digest.toString("hex"), path: filePath };
}

export function protocolBytesAtCommit(repoRoot, commit, relPath) {
  return gitBuffer(repoRoot, ["show", `${commit}:${relPath}`]);
}

export async function findProtocolInCommit(repoRoot, commit, extra = []) {
  for (const rel of [...extra, ...PROTOCOL_CANDIDATES]) {
    if (!rel) continue;
    try {
      const bytes = protocolBytesAtCommit(repoRoot, commit, rel);
      const digest = await hashProtocol(bytes);
      return { rel, bytes, hash: digest.toString("hex") };
    } catch {
      continue;
    }
  }
  return null;
}

export function writeChainConfig(dir, chain = "stellar") {
  const file = path.join(dir, ".autoresearch", "chain.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ chain }, null, 2)}\n`);
  return file;
}

export function explorerTxUrl(hash, deployment) {
  const network = deployment?.network || "testnet";
  return `https://lab.stellar.org/transaction/${hash}?network=${network}`;
}

export function txHashFromSend(sent) {
  return (
    sent?.hash ||
    sent?.txHash ||
    sent?.id ||
    sent?.getTransactionResponse?.txHash ||
    null
  );
}

export function homeSecretPath(name) {
  return path.join(os.homedir(), ".config", "stellar", name);
}

async function mainCli(argv) {
  const args = [...argv];
  const action = args[0] && !args[0].startsWith("--") ? args.shift() : null;
  const options = parseArgs(args, { boolKeys: ["help"] });
  if (!action || options.help) {
    console.log(`Usage:
  node scripts/stellar_open_research.mjs init-identity --out ~/.config/stellar/arah.secret
  node scripts/stellar_open_research.mjs address --secret-key-file ~/.config/stellar/arah.secret
  node scripts/stellar_open_research.mjs git-ref --repo-root <path> --commit HEAD --repository <url>
`);
    return 0;
  }
  if (action === "init-identity") {
    if (!options.out) throw new Error("--out is required");
    const identity = generateIdentity();
    const file = writeSecretKeyFile(options.out, identity.secret);
    console.log(JSON.stringify({ publicKey: identity.publicKey, file }, null, 2));
    return 0;
  }
  if (action === "address") {
    const loaded = loadSecretKeyFile(options.secretKeyFile);
    console.log(loaded.publicKey);
    return 0;
  }
  if (action === "git-ref") {
    const gitRef = await gitRefFromCheckout({
      repoRoot: options.repoRoot || process.cwd(),
      commit: options.commit || "HEAD",
      repository: options.repository,
    });
    console.log(JSON.stringify(gitRefJson(gitRef), null, 2));
    return 0;
  }
  throw new Error(`unknown action: ${action}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  mainCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message || err);
      process.exit(1);
    },
  );
}
