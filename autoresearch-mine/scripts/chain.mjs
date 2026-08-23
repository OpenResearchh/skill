// Chain selection and adapter registry.
//
// Skills describe what they want done — bootstrap a project, submit a
// proposal — and never name a settlement layer. This module is the only place
// in the mine skill that knows which implementation serves which chain, so
// supporting a new chain means adding an entry here and an adapter script,
// not editing the skill or its documentation.
//
// Resolution order: explicit --chain > ARAH_CHAIN > .autoresearch/chain.json
// in the work tree > the chain recorded in a previous bootstrap > DEFAULT_CHAIN.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const DEFAULT_CHAIN = "solana";
export const SUPPORTED_CHAINS = ["solana", "0g"];

// operation -> chain -> { script, runner }. Adapters live beside this file.
const REGISTRY = {
  bootstrap: {
    solana: { script: "bootstrap_from_solana.mjs", runner: "node" },
    "0g": { script: "bootstrap_from_registry.py", runner: "python3" },
  },
  submitProposal: {
    solana: { script: "submit_proposal_solana.mjs", runner: "node" },
    "0g": { script: "submit_proposal.py", runner: "python3" },
  },
};

export function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveChain({ chain, workDir } = {}) {
  const candidates = [
    chain,
    process.env.ARAH_CHAIN,
    readJsonIfPresent(path.join(workDir || process.cwd(), ".autoresearch", "chain.json"))?.chain,
    readJsonIfPresent(path.join(workDir || process.cwd(), ".autoresearch", "mine", "network_state.json"))?.source,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = String(candidate).toLowerCase();
    // network_state.source is "manual" when the frontier was hand-edited; that
    // says nothing about the settlement layer, so it is not a chain signal.
    if (normalized === "manual" || normalized === "registry") continue;
    if (!SUPPORTED_CHAINS.includes(normalized)) {
      throw new Error(
        `unsupported chain: ${candidate} (supported: ${SUPPORTED_CHAINS.join(", ")})`,
      );
    }
    return normalized;
  }
  return DEFAULT_CHAIN;
}

export function adapterFor(operation, chain) {
  const byChain = REGISTRY[operation];
  if (!byChain) throw new Error(`unknown operation: ${operation}`);
  const entry = byChain[chain];
  if (!entry) {
    throw new Error(`operation ${operation} is not supported on ${chain}`);
  }
  return entry;
}

export function adapterPath(scriptDir, operation, chain) {
  const entry = adapterFor(operation, chain);
  return { ...entry, path: path.join(scriptDir, entry.script) };
}

// Chain plumbing is noise during a normal run and essential when something
// fails, so it is available on request rather than removed.
export function showChainDetail() {
  return Boolean(process.env.ARAH_SHOW_CHAIN) || process.argv.includes("--show-chain");
}

export function chainDetail(message) {
  if (showChainDetail()) console.error(`[chain] ${message}`);
}
