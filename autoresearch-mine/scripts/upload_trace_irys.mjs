#!/usr/bin/env node
// Upload a finalized, miner-owned agent trajectory bundle to Irys.
//
// Nothing here runs implicitly. The mining loop never calls this script; the
// miner does, once, per trace, with --yes. Without --yes the script only
// prints the upload plan and exits non-zero.
//
// The bundle is tagged as owned by the miner's public key and carries the
// license the miner picked at finalize time (an SPDX identifier, or
// "unlicensed-private" to publish no reuse rights at all).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const RECORD_FILE = "trace.json";
const MANIFEST_FILE = "upload_trace_irys.json";
const DEFAULT_ARTIFACT_ROLE = "minerTrace";
const APP_NAME = "OpenResearch AutoResearch";
const PRIVATE_LICENSE = "unlicensed-private";
const LICENSE_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const IRYS_NETWORKS = Object.freeze({
  devnet: { name: "devnet", gatewayUrl: "https://devnet.irys.xyz" },
  mainnet: { name: "mainnet", gatewayUrl: "https://gateway.irys.xyz" },
});

const SOLANA_RPC_URLS = Object.freeze({
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
});

// Common choices only; any SPDX-shaped id is accepted with a warning.
const SUGGESTED_LICENSES = [
  PRIVATE_LICENSE,
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "ODC-By-1.0",
  "MIT",
  "Apache-2.0",
];

function usage() {
  console.log(`Usage:
  node scripts/upload_trace_irys.mjs \\
    --repo-root /path/to/repo \\
    --trial-id <trial_id> \\
    --keypair ~/.config/solana/arah-mine-<project_id>.json \\
    --yes

Dry-run (no upload, no funding, no signing):
  node scripts/upload_trace_irys.mjs --trace-dir /path/to/trace --dry-run

Options:
  --trace-dir <path>     Trace directory; overrides --repo-root/--trial-id.
  --license <spdx>       Override the license recorded at finalize time.
                         Suggested: ${SUGGESTED_LICENSES.join(", ")}
  --owner <pubkey>       Override the owner pubkey recorded at finalize time.
                         Defaults to the trace record, then to --keypair.
  --artifact-role <role> Irys tag Artifact-Role. Defaults to ${DEFAULT_ARTIFACT_ROLE}.
  --cluster <name>       devnet, testnet, localnet, mainnet-beta. Defaults to devnet.
  --rpc-url <url>        Override Solana RPC URL.
  --irys-network <name>  devnet or mainnet. Defaults from cluster.
  --dry-run              Print the upload plan and exit 0.
  --yes                  Required to actually upload. The miner owns this data;
                         uploading publishes it under the chosen license.

The trace must already be finalized with:
  python3 scripts/capture_trace.py finalize --repo-root ... --trial-id ... \\
    --agent <name> --license <spdx> --owner-pubkey <pubkey>
`);
}

function parseArgs(argv) {
  const options = {};
  const boolKeys = new Set(["help", "dryRun", "yes"]);
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

function resolveTraceDir(options) {
  if (options.traceDir) return path.resolve(options.traceDir);
  const repoRoot = options.repoRoot || process.env.AUTORESEARCH_REPO_ROOT;
  if (!repoRoot || !options.trialId) {
    throw new Error("provide --trace-dir, or both --repo-root and --trial-id");
  }
  return path.resolve(repoRoot, ".autoresearch", "mine", "traces", String(options.trialId));
}

function resolveSolanaConfig(options, env = process.env) {
  const cluster = options.cluster || env.SOLANA_CLUSTER || "devnet";
  const rpcUrl = options.rpcUrl || env.SOLANA_RPC_URL || SOLANA_RPC_URLS[cluster];
  if (!rpcUrl) throw new Error(`unknown cluster: ${cluster} (pass --rpc-url)`);
  return { cluster, rpcUrl };
}

function resolveIrysNetwork({ cluster, irysNetwork }) {
  if (irysNetwork) {
    const explicit = String(irysNetwork).toLowerCase();
    if (!IRYS_NETWORKS[explicit]) throw new Error("--irys-network must be devnet or mainnet");
    return IRYS_NETWORKS[explicit];
  }
  const name = String(cluster).toLowerCase();
  return name === "mainnet-beta" || name === "mainnet"
    ? IRYS_NETWORKS.mainnet
    : IRYS_NETWORKS.devnet;
}

function sha256Hex(filePath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function readTraceRecord(traceDir) {
  const recordPath = path.join(traceDir, RECORD_FILE);
  if (!fs.existsSync(recordPath)) {
    throw new Error(
      `finalized trace record not found: ${recordPath} (run capture_trace.py finalize first)`,
    );
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (record.schemaVersion !== "1") {
    throw new Error(`unsupported trace schemaVersion: ${record.schemaVersion}`);
  }
  const files = Array.isArray(record.event_files) ? record.event_files : [];
  if (files.length !== 1) {
    throw new Error("this uploader handles exactly one event bundle file per trace");
  }
  return { record, recordPath, bundleRef: files[0] };
}

function resolveOwner(options, record) {
  const owner =
    options.owner ||
    record.owner_pubkey ||
    (options.keypair ? keypairPubkey(options.keypair) : null);
  if (!owner) {
    throw new Error(
      "no owner pubkey: pass --owner or re-run capture_trace.py finalize --owner-pubkey",
    );
  }
  if (!BASE58_RE.test(String(owner))) {
    throw new Error(`--owner must be a base58 Solana public key: ${owner}`);
  }
  return String(owner);
}

function resolveLicense(options, record) {
  const licenseId = options.license || record.license?.id || PRIVATE_LICENSE;
  if (!LICENSE_RE.test(String(licenseId))) {
    throw new Error(
      `license must be an SPDX identifier or "${PRIVATE_LICENSE}", got: ${licenseId}`,
    );
  }
  if (!SUGGESTED_LICENSES.includes(String(licenseId))) {
    console.error(
      `[trace] warning: "${licenseId}" is not in the suggested list (${SUGGESTED_LICENSES.join(", ")}); uploading it as given`,
    );
  }
  return String(licenseId);
}

function keypairPubkey(keypairPath) {
  // Last 32 bytes of a 64-byte ed25519 secret key are the public key.
  const secret = JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf8"));
  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error(`not a 64-byte Solana keypair file: ${keypairPath}`);
  }
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = Buffer.from(secret.slice(32));
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = alphabet[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = alphabet[0] + out;
  }
  return out;
}

function toComparable(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.ceil(value));
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value.toString === "function") return BigInt(value.toString());
  throw new Error("cannot convert Irys amount to bigint");
}

function writeManifest(traceDir, manifest) {
  const manifestPath = path.join(traceDir, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}

function updateRecordUpload(recordPath, record, upload) {
  const next = { ...record, upload: { ...record.upload, ...upload } };
  fs.writeFileSync(recordPath, JSON.stringify(next, null, 2) + "\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const traceDir = resolveTraceDir(options);
  const { record, recordPath, bundleRef } = readTraceRecord(traceDir);
  const bundlePath = path.resolve(traceDir, bundleRef.path);
  if (!fs.existsSync(bundlePath)) throw new Error(`trace bundle not found: ${bundlePath}`);

  const expected = String(record.sha256 || "").toLowerCase();
  if (!SHA256_RE.test(expected)) throw new Error("trace record sha256 must be lowercase hex");
  const actual = sha256Hex(bundlePath);
  if (actual !== expected) {
    throw new Error(
      `trace bundle SHA-256 mismatch: ${actual} != ${expected} (re-run capture_trace.py finalize)`,
    );
  }

  const config = resolveSolanaConfig(options);
  const network = resolveIrysNetwork({ cluster: config.cluster, irysNetwork: options.irysNetwork });
  const owner = resolveOwner(options, record);
  const license = resolveLicense(options, record);
  const artifactRole = options.artifactRole || DEFAULT_ARTIFACT_ROLE;
  const sizeBytes = fs.statSync(bundlePath).size;

  const tags = [
    { name: "Content-Type", value: bundleRef.content_type || "application/x-ndjson" },
    { name: "App-Name", value: APP_NAME },
    { name: "Artifact-Role", value: artifactRole },
    { name: "SHA-256", value: actual },
    { name: "Owner", value: owner },
    { name: "License", value: license },
    { name: "Trial-Id", value: String(record.trial_id) },
    { name: "Schema-Version", value: String(record.schemaVersion) },
  ];

  const plan = {
    traceDir,
    bundle: bundlePath,
    recordFile: recordPath,
    trialId: record.trial_id,
    agent: record.agent,
    model: record.model,
    eventCount: record.event_count,
    sizeBytes,
    sha256: actual,
    owner,
    license,
    redaction: record.redaction,
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    irysNetwork: network.name,
    gatewayUrl: network.gatewayUrl,
    tags,
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ ...plan, uploaded: false, dryRun: true }, null, 2));
    return 0;
  }

  if (!options.yes) {
    console.error(
      `refusing to upload without --yes. This trace is yours: uploading publishes ${sizeBytes} bytes of agent session data to Irys ${network.name} under license "${license}", owned by ${owner}. Re-run with --dry-run to inspect the plan, or --yes to publish.`,
    );
    return 1;
  }
  if (!options.keypair) throw new Error("--keypair is required for a live upload");
  if (license === PRIVATE_LICENSE) {
    console.error(
      `[trace] warning: uploading with License=${PRIVATE_LICENSE}. The bytes become publicly readable on Irys; the tag only asserts that no reuse rights are granted.`,
    );
  }

  const [{ Uploader }, { Solana }] = await Promise.all([
    import("@irys/upload"),
    import("@irys/upload-solana"),
  ]).catch((err) => {
    throw new Error(
      `Irys upload deps missing (@irys/upload, @irys/upload-solana). Run npm install at the skill repo root. Cause: ${err.message}`,
    );
  });

  const privateKey = JSON.parse(fs.readFileSync(path.resolve(options.keypair), "utf8"));
  let uploader = Uploader(Solana).withWallet(privateKey).withRpc(config.rpcUrl);
  if (network.name === "devnet") uploader = uploader.devnet();

  try {
    const irys = await uploader;
    const price = await irys.getPrice(sizeBytes);
    const balance = await irys.getLoadedBalance();
    if (toComparable(balance) < toComparable(price)) {
      await irys.fund((toComparable(price) - toComparable(balance)).toString());
    }
    const receipt = await irys.uploadFile(bundlePath, { tags });
    const id = String(receipt.id);
    const uploadedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const upload = {
      status: "uploaded",
      network: network.name,
      irys_id: id,
      gateway_uri: `${network.gatewayUrl}/${id}`,
      uploaded_at: uploadedAt,
      artifact_role: artifactRole,
      error: null,
    };
    updateRecordUpload(recordPath, record, upload);
    const manifestPath = writeManifest(traceDir, {
      ...plan,
      uploaded: true,
      id,
      gatewayUri: upload.gateway_uri,
      uploadedAt,
      receipt,
    });
    console.log(JSON.stringify({ ...plan, uploaded: true, id, manifestPath, receipt }, null, 2));
    return 0;
  } catch (err) {
    updateRecordUpload(recordPath, record, {
      status: "failed",
      network: network.name,
      artifact_role: artifactRole,
      error: err.message,
    });
    writeManifest(traceDir, { ...plan, uploaded: false, error: err.message });
    throw err;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`trace upload failed: ${err.message}`);
    process.exit(1);
  },
);
