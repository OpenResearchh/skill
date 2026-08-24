#!/usr/bin/env node
import process from "node:process";
import {
  createClient,
  parseArgs,
  readJson,
  requireAddress,
  resolveDeployment,
  secretFromEnv,
  unwrapResult,
  writeJson,
} from "../../autoresearch-create/scripts/stellar_open_research.mjs";

const BOOL_FLAGS = new Set(["help", "dryRun", "yes", "revoke"]);

function usage() {
  console.log(`Usage:
  node scripts/link_identity_stellar.mjs \\
    --payload .autoresearch/mine/identity/github-user.json \\
    --yes

Live submit requires --yes and ARAH_STELLAR_MINER_SECRET_KEY or --secret-key.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help || !options.payload) {
    usage();
    return 0;
  }
  const payload = readJson(options.payload);
  const address = requireAddress(payload.address, "address");
  const network = resolveDeployment(options);
  const dryRun = options.dryRun || !options.yes;
  const result = {
    schemaVersion: "1",
    chain: "stellar",
    dryRun,
    action: payload.action,
    address,
    handle: payload.handle,
    platform: payload.platform,
    platform_code: payload.platform_code,
    contractId: network.contractId,
  };
  if (dryRun) {
    writeJson(options.output || "link_identity_stellar.json", result);
    console.log(options.output || "link_identity_stellar.json");
    return 0;
  }
  const secretKey = secretFromEnv(options, "miner");
  if (!secretKey) throw new Error("live identity submit requires --secret-key or ARAH_STELLAR_MINER_SECRET_KEY");
  const client = await createClient(
    {
      contractId: network.contractId,
      rpcUrl: network.rpcUrl,
      networkPassphrase: network.networkPassphrase,
    },
    { publicKey: address, secretKey },
  );
  const tx =
    payload.action === "unlink"
      ? await client.unlink_identity({ address })
      : await client.link_identity({
          address,
          handle: payload.handle,
          platform: Number(payload.platform_code),
        });
  unwrapResult(tx, payload.action === "unlink" ? "unlink_identity" : "link_identity");
  const sendResult = await tx.signAndSend();
  result.sendResult = sendResult;
  writeJson(options.output || "link_identity_stellar.json", result);
  console.log(options.output || "link_identity_stellar.json");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stellar identity link failed: ${err.message}`);
    process.exit(1);
  },
);
