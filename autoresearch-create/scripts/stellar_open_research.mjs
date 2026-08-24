import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_DEPLOYMENT = path.join(REPO_ROOT, "smart-contracts", "deployments", "mainnet.json");
const CLIENT_DIST = path.join(REPO_ROOT, "smart-contracts", "packages", "client", "dist", "index.js");
const HEX40 = /^[0-9a-fA-F]{40}$/;
const HEX64 = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ADDRESS = /^G[A-Z2-7]{55}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const BIPS_DENOMINATOR = 10_000n;

export function parseArgs(argv, boolKeys = new Set()) {
  const options = {};
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

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, jsonReplacer, 2) + "\n", "utf8");
}

export function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  return value;
}

export function resolveDeployment(options = {}) {
  const deploymentPath = path.resolve(
    options.deploymentJson ||
      process.env.ARAH_STELLAR_DEPLOYMENT_JSON ||
      process.env.ARAH_DEPLOYMENT_FILE ||
      DEFAULT_DEPLOYMENT,
  );
  const deployment = readJson(deploymentPath);
  const contractId =
    options.contractId ||
    process.env.OPEN_RESEARCH_CONTRACT_ID ||
    process.env.ARAH_STELLAR_OPEN_RESEARCH_CONTRACT_ID ||
    deployment.openResearchContractId;
  const rpcUrl =
    options.rpcUrl ||
    process.env.STELLAR_RPC_URL ||
    process.env.ARAH_STELLAR_RPC_URL ||
    deployment.rpcUrl;
  const networkPassphrase =
    options.networkPassphrase ||
    process.env.STELLAR_NETWORK_PASSPHRASE ||
    process.env.ARAH_STELLAR_NETWORK_PASSPHRASE ||
    deployment.networkPassphrase;
  if (!contractId) throw new Error("missing Stellar OpenResearch contract id");
  if (!rpcUrl) throw new Error("missing Stellar RPC URL");
  if (!networkPassphrase) throw new Error("missing Stellar network passphrase");
  return {
    deploymentPath,
    deployment,
    network: deployment.network || options.network || "mainnet",
    contractId,
    rpcUrl,
    networkPassphrase,
  };
}

export async function loadStellarClient() {
  try {
    return await import("@openresearch/stellar-client");
  } catch (firstError) {
    if (fs.existsSync(CLIENT_DIST)) return import(pathToFileURL(CLIENT_DIST));
    throw new Error(
      [
        "Stellar client package is not available.",
        "Install experiment-protocol dependencies and build the local client:",
        "  cd ../smart-contracts/packages/client && npm install && npm run build",
        "  cd ../../experiment-protocol && npm install",
        `Original import error: ${firstError.message}`,
      ].join("\n"),
    );
  }
}

export async function createClient(
  networkConfig,
  { publicKey, secretKey, signTransaction, signAuthEntry } = {},
) {
  const { generated } = await loadStellarClient();
  if (signTransaction) {
    return new generated.Client({
      ...networkConfig,
      publicKey,
      signTransaction,
      ...(signAuthEntry ? { signAuthEntry } : {}),
    });
  }
  if (!secretKey) return new generated.Client(networkConfig);

  const keypair = generated.Keypair.fromSecret(secretKey);
  return new generated.Client({
    ...networkConfig,
    publicKey: publicKey || keypair.publicKey(),
    signTransaction: keypair,
  });
}

export function unwrapResult(tx, label) {
  const result = tx?.result;
  if (!result) throw new Error(`${label} did not return a contract result`);
  if (typeof result.isErr === "function" && result.isErr()) {
    const err = typeof result.unwrapErr === "function" ? result.unwrapErr() : result;
    throw new Error(`${label} failed: ${err?.message || String(err)}`);
  }
  return typeof result.unwrap === "function" ? result.unwrap() : result;
}

export function secretFromEnv(options, role) {
  const key =
    options.secretKey ||
    process.env[`ARAH_STELLAR_${role.toUpperCase()}_SECRET_KEY`] ||
    process.env.ARAH_STELLAR_SECRET_KEY ||
    process.env.STELLAR_SECRET_KEY;
  return key || null;
}

export function requireAddress(value, label) {
  const text = String(value || "").trim();
  if (!ADDRESS.test(text)) throw new Error(`${label} must be a Stellar G... address`);
  return text;
}

export function requireContractId(value, label) {
  const text = String(value || "").trim();
  if (!CONTRACT_ID.test(text)) throw new Error(`${label} must be a Stellar C... contract id`);
  return text;
}

export function parseI128(value, label) {
  const text = String(value ?? "");
  if (!/^-?[0-9]+$/.test(text)) throw new Error(`${label} must be an integer`);
  const n = BigInt(text);
  const min = -(1n << 127n);
  const max = (1n << 127n) - 1n;
  if (n < min || n > max) throw new Error(`${label} is outside i128`);
  return n;
}

export function parseU32(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 4_294_967_295) {
    throw new Error(`${label} must be a u32 integer`);
  }
  return n;
}

export function scaleMetric(metric, scale, direction) {
  const scaleBig = BigInt(scale);
  if (scaleBig <= 0n) throw new Error("metric scale must be positive");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(metric).trim());
  if (!match) throw new Error("metric must be a base-10 decimal string");
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] || "";
  const den = 10n ** BigInt(fraction.length);
  const num = (whole * den + BigInt(fraction || "0")) * sign * scaleBig;
  if (num % den !== 0n) throw new Error("metric cannot be represented exactly at this scale");
  const scaled = num / den;
  return assertI128(direction === "minimize" ? -scaled : scaled, "scaled metric");
}

export function metricFromScore(score, direction, scale) {
  const directed = direction === "minimize" ? -BigInt(score) : BigInt(score);
  return Number(directed) / Number(scale);
}

export function directionTag(direction) {
  if (direction === "maximize") return { tag: "Maximize", values: undefined };
  if (direction === "minimize") return { tag: "Minimize", values: undefined };
  throw new Error("primary metric direction must be minimize or maximize");
}

export function directionText(direction) {
  if (direction?.tag === "Maximize") return "maximize";
  if (direction?.tag === "Minimize") return "minimize";
  throw new Error("unknown Stellar direction variant");
}

export function hexToBuffer(value, label, bytes = 32) {
  const hex = String(value || "").replace(/^0x/, "");
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(hex)) {
    throw new Error(`${label} must be ${bytes} bytes of hex`);
  }
  return Buffer.from(hex, "hex");
}

export function bufferHex(value) {
  return Buffer.from(value).toString("hex");
}

export function parseCommitId(hex) {
  const value = String(hex || "").replace(/^0x/, "");
  if (HEX40.test(value)) return { tag: "Sha1", values: [Buffer.from(value, "hex")] };
  if (/^[0-9a-fA-F]{64}$/.test(value)) return { tag: "Sha256", values: [Buffer.from(value, "hex")] };
  throw new Error("commit id must be a 40- or 64-character hex digest");
}

export function formatCommitId(commit) {
  return bufferHex(commit.values[0]);
}

export function gitRef({ repoHash, commit, treeHash }) {
  return {
    repo: hexToBuffer(repoHash, "repo hash"),
    commit: parseCommitId(commit),
    tree_hash: hexToBuffer(treeHash, "tree hash"),
  };
}

export function assertI128(value, label = "value") {
  const n = BigInt(value);
  if (n < I128_MIN || n > I128_MAX) throw new Error(`${label} is outside i128`);
  return n;
}

export function improvementThreshold(incumbent, improvementBips) {
  const base = assertI128(incumbent, "incumbent score");
  const bips = Number(improvementBips);
  if (!Number.isInteger(bips) || bips < 0 || bips > 10_000) {
    throw new Error("improvement bips must be between 0 and 10000");
  }
  if (bips === 0) return base;
  const abs = base < 0n ? -base : base;
  return assertI128(base + (abs * BigInt(bips)) / BIPS_DENOMINATOR, "improvement threshold");
}

export function isSufficient(score, incumbent, improvementBips) {
  const checked = assertI128(score, "score");
  const base = assertI128(incumbent, "incumbent score");
  return Number(improvementBips) === 0
    ? checked > base
    : checked >= improvementThreshold(base, improvementBips);
}

export function gitOutput(cwd, args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SUBMODULE_STRATEGY: "none",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.toString().trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

export function stellarTreeEntries(repoRoot, commit = "HEAD") {
  const raw = gitOutput(repoRoot, ["ls-tree", "-rz", "-r", commit], { encoding: "buffer" });
  const records = raw.toString("utf8").split("\0").filter(Boolean);
  return records.map((record) => {
    const match = /^([0-7]{6}) ([^\s]+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`unparseable git tree entry: ${record}`);
    const [, mode, type, object, entryPath] = match;
    if (type !== "blob") {
      throw new Error(`unsupported git tree entry ${entryPath}: ${type}`);
    }
    const blob = gitOutput(repoRoot, ["cat-file", "blob", object], { encoding: "buffer" });
    return { mode, path: entryPath, blob: Buffer.from(blob) };
  });
}

export function hashCanonicalTree(entries) {
  const encoded = entries.map((entry) => {
    if (!["100644", "100755", "120000"].includes(entry.mode)) {
      throw new Error(`unsupported git tree mode: ${entry.mode}`);
    }
    if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\0")) {
      throw new Error(`invalid git tree path: ${entry.path}`);
    }
    return {
      ...entry,
      pathBytes: Buffer.from(entry.path, "utf8"),
      blob: Buffer.from(entry.blob),
    };
  });
  encoded.sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
  const zero = Buffer.from([0]);
  const chunks = [];
  for (const entry of encoded) {
    chunks.push(
      Buffer.from(`${entry.mode} `, "ascii"),
      entry.pathBytes,
      zero,
      Buffer.from(String(entry.blob.length), "ascii"),
      zero,
      entry.blob,
      zero,
    );
  }
  return crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}

export function stellarTreeHash(repoRoot, commit = "HEAD") {
  return hashCanonicalTree(stellarTreeEntries(repoRoot, commit));
}

export function verifyStellarTreeHash({ repoRoot, commit = "HEAD", expected }) {
  const actual = stellarTreeHash(repoRoot, commit);
  const want = String(expected || "").replace(/^0x/, "").toLowerCase();
  if (!want) throw new Error("expected tree hash is empty");
  if (actual !== want) throw new Error(`tree hash mismatch: expected ${want}, got ${actual}`);
  return actual;
}

export function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest();
}

export function hashFileHex(filePath) {
  return hashFile(filePath).toString("hex");
}

export function normalizeRepositoryIdentity(repository) {
  if (!repository) throw new Error("repository identity is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) {
    return normalizeUrlRepository(repository);
  }
  const scpMatch = /^git@([^/:]+):(.+)$/.exec(repository);
  if (scpMatch) return canonicalIdentity(scpMatch[1], scpMatch[2]);
  const stripped = String(repository).replace(/^\/+|\/+$/g, "");
  const segments = stripped.split("/");
  if (segments.length !== 3) throw new Error("canonical repository identity must have host/owner/repo");
  return canonicalIdentity(segments[0], `${segments[1]}/${segments[2]}`);
}

export function repoCommitment(repository) {
  const canonical = normalizeRepositoryIdentity(repository);
  return {
    canonical,
    repoId: crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

export function assertRepoMatches(remoteUrl, expectedHash) {
  const actual = repoCommitment(remoteUrl);
  if (actual.repoId !== String(expectedHash).replace(/^0x/, "").toLowerCase()) {
    throw new Error(
      `repo identity mismatch: ${remoteUrl} hashes to ${actual.repoId}, expected ${expectedHash}`,
    );
  }
  return actual;
}

function normalizeUrlRepository(repository) {
  if (repository.includes("?") || repository.includes("#")) {
    throw new Error("repository URL must not contain a query or fragment");
  }
  const url = new URL(repository);
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new Error("repository URL must use HTTPS or SSH");
  }
  if (url.protocol === "https:" && (url.username || url.password)) {
    throw new Error("HTTPS repository URL must not contain credentials");
  }
  if (url.protocol === "https:" && url.port && url.port !== "443") {
    throw new Error("repository URL must not use a non-default HTTPS port");
  }
  if (url.protocol === "ssh:") {
    if ((url.username && url.username !== "git") || url.password) {
      throw new Error("SSH repository credentials must be optional git@");
    }
    if (url.port && url.port !== "22") {
      throw new Error("repository URL must not use a non-default SSH port");
    }
  }
  return canonicalIdentity(url.hostname, decodeURIComponent(url.pathname));
}

function canonicalIdentity(hostInput, pathInput) {
  const host = String(hostInput || "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) {
    throw new Error("repository host must be a valid DNS host");
  }
  const parts = String(pathInput || "").replace(/^\/+|\/+$/g, "").split("/");
  if (!host || parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("repository identity must have host/owner/repo");
  }
  const repo = parts[1].endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
  if (!repo || parts[0] === "." || parts[0] === ".." || repo === "." || repo === "..") {
    throw new Error("repository owner and name must be valid");
  }
  if (parts[0].includes("?") || parts[0].includes("#") || repo.includes("?") || repo.includes("#")) {
    throw new Error("repository owner and name must not contain query or fragment characters");
  }
  return `${host}/${parts[0]}/${repo}`;
}

export function projectGitRef(project, { fromBaseline = false } = {}) {
  const baseline = {
    origin: "baseline",
    gitRef: project.baseline,
    score: project.baseline_score,
  };
  const current = project.current_best?.present
    ? {
        origin: "currentBestCode",
        gitRef: project.current_best.value,
        score: project.current_best_score,
      }
    : null;
  return !fromBaseline && current ? current : baseline;
}

export function projectSummary(project) {
  return {
    id: Number(project.id),
    creator: project.creator,
    clone_url: project.clone_url,
    protocol_hash: bufferHex(project.protocol_hash),
    baseline: gitRefSummary(project.baseline),
    baseline_score: project.baseline_score.toString(),
    current_best: project.current_best?.present ? gitRefSummary(project.current_best.value) : null,
    current_best_score: project.current_best_score.toString(),
    current_best_miner: project.current_best_miner ?? null,
    direction: directionText(project.direction),
    metric_scale: Number(project.metric_scale),
    min_improvement_bips: Number(project.min_improvement_bips),
    protocol_epoch: Number(project.protocol_epoch),
    token: project.token,
    minimum_stake: project.minimum_stake.toString(),
    reward_pool_balance: project.reward_pool_balance.toString(),
  };
}

export function gitRefSummary(ref) {
  return {
    repo: bufferHex(ref.repo),
    commit: formatCommitId(ref.commit),
    tree_hash: bufferHex(ref.tree_hash),
  };
}

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
