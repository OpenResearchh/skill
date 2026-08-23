#!/usr/bin/env node
// Publish a finalized protocol and its artifacts as a project.
//
// Chain-neutral entrypoint: it resolves the active settlement layer and hands
// off to that chain's adapter. Authoring a protocol is identical regardless of
// where the project is registered.
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adapterPath, chainDetail, resolveChain, SUPPORTED_CHAINS } from "./chain.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/publish_project.mjs \\
    --protocol-json <path> \\
    --repo-snapshot-file <path> \\
    --benchmark-file <path> \\
    --baseline-metrics-file <path> \\
    --baseline-aggregate-score <int> \\
    --upload-artifacts --yes

Options:
  --upload-artifacts       Upload artifacts to the active layer's storage.
  --chain <name>           Override the configured settlement layer (${SUPPORTED_CHAINS.join(", ")}).
  --show-chain             Print settlement-layer detail while running.

Any other option is passed through to the active adapter unchanged.
`);
}

const ALIASES = {
  "--upload-artifacts": { solana: "--upload-artifacts-to-irys", "0g": "--upload-artifacts-to-0g" },
};

function translate(argv, chain) {
  const out = [];
  for (const arg of argv) {
    const alias = ALIASES[arg];
    if (alias) {
      const mapped = alias[chain];
      if (mapped) out.push(mapped);
      continue;
    }
    out.push(arg);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    usage();
    return 0;
  }

  // --chain and --show-chain are consumed here; adapters never see them.
  const passthrough = [];
  let chainOverride;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--chain") {
      chainOverride = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === "--show-chain") continue;
    passthrough.push(argv[i]);
  }

  const chain = resolveChain({ chain: chainOverride });
  const adapter = adapterPath(SCRIPT_DIR, "publishProject", chain);
  const args = translate(passthrough, chain);

  chainDetail(`publish via ${chain} adapter (${adapter.script})`);
  const result = spawnSync(adapter.runner, [adapter.path, ...args], { stdio: "inherit" });
  if (result.error) {
    console.error(`publish failed: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`publish failed: ${err.message}`);
  process.exit(1);
}
