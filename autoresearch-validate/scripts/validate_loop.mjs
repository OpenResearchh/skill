#!/usr/bin/env node
// Review pending proposals for a project and settle them.
//
// Chain-neutral entrypoint: it resolves the active settlement layer and hands
// off to that chain's adapter. Verification is the same work regardless of
// where the result is recorded, so the loop does not name a chain.
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adapterPath, chainDetail, resolveChain, SUPPORTED_CHAINS } from "./chain.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/validate_loop.mjs \\
    --project-id <id> \\
    --identity <keystore id or key file> \\
    --yes

Options:
  --project-id <id>        Published project identifier.
  --identity <ref>         Verifier identity for the active settlement layer.
  --once                   Process at most one proposal, then exit.
  --dry-run                Print plans without settling.
  --chain <name>           Override the configured settlement layer (${SUPPORTED_CHAINS.join(", ")}).
  --show-chain             Print settlement-layer detail while running.

Any other option is passed through to the active adapter unchanged.
`);
}

const ALIASES = {
  "--identity": { stellar: "--secret-key-file", solana: "--keypair", "0g": "--wallet-id" },
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
  const adapter = adapterPath(SCRIPT_DIR, "validateLoop", chain);

  // Fail here, naming the replacement, rather than letting the adapter reject
  // the flag with a message that does not mention the settlement layer.
  for (const [flag, guidance] of Object.entries(adapter.unsupported || {})) {
    if (passthrough.includes(flag)) {
      console.error(`${flag} is not supported on the ${chain} settlement layer: ${guidance}`);
      return 2;
    }
  }

  const args = translate(passthrough, chain);

  chainDetail(`validate loop via ${chain} adapter (${adapter.script})`);
  const result = spawnSync(adapter.runner, [adapter.path, ...args], { stdio: "inherit" });
  if (result.error) {
    console.error(`validate loop failed: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`validate loop failed: ${err.message}`);
  process.exit(1);
}
