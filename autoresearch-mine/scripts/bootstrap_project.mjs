#!/usr/bin/env node
// Fetch a published project and prepare a working tree for mining.
//
// Chain-neutral entrypoint: it resolves the active settlement layer and hands
// off to that chain's adapter. Callers describe the project by id and say where
// they want it; which chain the project settles on is configuration, not part
// of the mining workflow.
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adapterPath, chainDetail, resolveChain, SUPPORTED_CHAINS } from "./chain.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/bootstrap_project.mjs \\
    --project-id <id> \\
    --output-dir /path/to/mining-work/project \\
    --prepare-repo

Options:
  --project-id <id>        Published project identifier.
  --output-dir <path>      Where artifacts are downloaded.
  --repo-root <path>       Where the working tree is created.
  --prepare-repo           Unpack the code and initialize the mining workspace.
  --skip-existing          Reuse existing downloads after hash verification.
  --chain <name>           Override the configured settlement layer (${SUPPORTED_CHAINS.join(", ")}).
  --show-chain             Print settlement-layer detail while running.

Any other option is passed through to the active adapter unchanged.
`);
}

// Flags whose spelling differs per adapter. Everything else passes through, so
// an operator who needs a chain-specific knob is never blocked by this layer.
const ALIASES = {
  "--prepare-repo": { stellar: "--unpack-repo", solana: "--unpack-repo", "0g": "--download-artifacts" },
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
  const adapter = adapterPath(SCRIPT_DIR, "bootstrap", chain);
  const args = translate(passthrough, chain);

  chainDetail(`bootstrap via ${chain} adapter (${adapter.script})`);
  const result = spawnSync(adapter.runner, [adapter.path, ...args], { stdio: "inherit" });
  if (result.error) {
    console.error(`bootstrap failed: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`bootstrap failed: ${err.message}`);
  process.exit(1);
}
