// Irys artifact uploads.
//
// NOT ON THE SETTLEMENT PATH. A project is published as a git reference now:
// the code is already content-addressed and already replicated to everyone who
// cloned it, so an upload only added a gateway dependency and a class of
// "artifact fetch failed" states to verification. This module stays because
// the deployed contract still carries the Irys id fields, and because
// trajectory capture uploads to Irys for reasons that have nothing to do with
// settling a proposal.
import fs from "node:fs";
import path from "node:path";
import { assertBytes32, hashFileBytes32 } from "./publish_project_0g_lib.mjs";

export const IRYS_NETWORKS = Object.freeze({
  devnet: {
    name: "devnet",
    gatewayUrl: "https://devnet.irys.xyz",
    permanence: "ephemeral",
    note: "Irys devnet uploads are suitable for Solana devnet/testnet and may expire after the devnet retention window.",
  },
  mainnet: {
    name: "mainnet",
    gatewayUrl: "https://gateway.irys.xyz",
    permanence: "permanent",
    note: "Irys mainnet uploads are permanent Arweave-backed storage paid with real SOL.",
  },
});

export function resolveIrysNetwork({ cluster, irysNetwork }) {
  const explicit = irysNetwork ? String(irysNetwork).toLowerCase() : null;
  if (explicit) {
    if (!IRYS_NETWORKS[explicit]) {
      throw new Error("--irys-network must be devnet or mainnet");
    }
    return IRYS_NETWORKS[explicit];
  }
  return String(cluster).toLowerCase() === "mainnet-beta" ||
    String(cluster).toLowerCase() === "mainnet"
    ? IRYS_NETWORKS.mainnet
    : IRYS_NETWORKS.devnet;
}

export function prepareIrysStorageArtifacts({ artifactPaths, network }) {
  const artifacts = {};
  for (const [name, artifact] of Object.entries(artifactPaths)) {
    const filePath = artifact.path;
    artifacts[name] = {
      path: filePath,
      fileName: path.basename(filePath),
      sizeBytes: fs.statSync(filePath).size,
      sha256Bytes32: hashFileBytes32(filePath),
      irys: {
        network: network.name,
        gatewayUrl: network.gatewayUrl,
        uploaded: false,
      },
    };
  }
  return artifacts;
}

export function applyIrysArtifactHashes(options, storageArtifacts) {
  return {
    ...options,
    protocolHash: assertBytes32(storageArtifacts.protocol.sha256Bytes32, "protocolHash"),
    repoSnapshotHash: assertBytes32(
      storageArtifacts.repoSnapshot.sha256Bytes32,
      "repoSnapshotHash",
    ),
    benchmarkHash: assertBytes32(
      storageArtifacts.benchmark.sha256Bytes32,
      "benchmarkHash",
    ),
    baselineMetricsHash: assertBytes32(
      storageArtifacts.baselineMetrics.sha256Bytes32,
      "baselineMetricsHash",
    ),
  };
}

export function applyIrysArtifactIds(options, storageArtifacts) {
  return {
    ...options,
    protocolIrysId: requireIrysId(storageArtifacts.protocol, "protocolIrysId"),
    repoSnapshotIrysId: requireIrysId(
      storageArtifacts.repoSnapshot,
      "repoSnapshotIrysId",
    ),
    benchmarkIrysId: requireIrysId(storageArtifacts.benchmark, "benchmarkIrysId"),
    baselineMetricsIrysId: requireIrysId(
      storageArtifacts.baselineMetrics,
      "baselineMetricsIrysId",
    ),
  };
}

function requireIrysId(artifact, label) {
  const id = artifact?.irys?.id || artifact?.id;
  if (!id) {
    throw new Error(`${label} requires an uploaded Irys receipt id`);
  }
  return String(id);
}

export function buildIrysBrowserUploadPlan({ storageArtifacts, network }) {
  return {
    network: network.name,
    gatewayUrl: network.gatewayUrl,
    permanence: network.permanence,
    note: network.note,
    artifacts: Object.entries(storageArtifacts).map(([name, artifact]) => ({
      name,
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes,
      sha256Bytes32: artifact.sha256Bytes32,
      fetchPath: `artifact/${encodeURIComponent(name)}`,
      tags: [
        { name: "Content-Type", value: "application/octet-stream" },
        { name: "App-Name", value: "OpenResearch AutoResearch" },
        { name: "Artifact-Role", value: name },
        { name: "SHA-256", value: artifact.sha256Bytes32.slice(2) },
      ],
    })),
  };
}

export function mergeIrysUploadReceipts({ storageArtifacts, uploadResult, network }) {
  const uploaded = uploadResult?.artifacts || {};
  const out = {};
  for (const [name, artifact] of Object.entries(storageArtifacts)) {
    const receipt = uploaded[name];
    if (!receipt?.id) {
      throw new Error(`Irys upload result missing receipt for ${name}`);
    }
    out[name] = {
      ...artifact,
      irys: {
        network: network.name,
        gatewayUrl: network.gatewayUrl,
        uploaded: true,
        id: String(receipt.id),
        gatewayUri: receipt.gatewayUri || `${network.gatewayUrl}/${receipt.id}`,
        signature: receipt.signature || null,
        timestamp: receipt.timestamp || null,
      },
    };
  }
  return out;
}
