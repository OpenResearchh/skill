#!/usr/bin/env node
// Optional GitHub identity binding. Grants no authority and does not redirect rewards.
import {
  call,
  createClient,
  jsonReplacer,
  loadDeployment,
  loadSecretKeyFile,
  parseArgs,
  send,
  unwrapContract,
  GITHUB_PLATFORM,
} from "./stellar_open_research.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    boolKeys: ["help", "yes", "dryRun", "revoke"],
  });
  if (options.help || !options.secretKeyFile) {
    console.log(`Usage:
  node scripts/link_identity_stellar.mjs --handle researcher --secret-key-file miner.secret --yes
  node scripts/link_identity_stellar.mjs --revoke --secret-key-file miner.secret --yes
`);
    return options.help ? 0 : 1;
  }
  if (!options.dryRun && !options.yes) throw new Error("pass --yes for live identity updates");
  const deployment = loadDeployment(options.deploymentJson);
  const loaded = loadSecretKeyFile(options.secretKeyFile);
  const { client } = createClient({
    deployment,
    publicKey: loaded.publicKey,
    keypair: loaded.keypair,
  });
  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      address: loaded.publicKey,
      action: options.revoke ? "unlink_identity" : "link_identity",
      handle: options.handle || null,
    }, jsonReplacer, 2));
    return 0;
  }
  const assembled = options.revoke
    ? await client.unlink_identity({ address: loaded.publicKey })
    : await client.link_identity({
        address: loaded.publicKey,
        handle: options.handle,
        platform: GITHUB_PLATFORM,
      });
  unwrapContract(assembled.result);
  const sent = await send(assembled);
  console.log(JSON.stringify({
    address: loaded.publicKey,
    action: options.revoke ? "unlink_identity" : "link_identity",
    handle: options.handle || null,
    hash: sent?.hash || sent?.txHash || null,
  }, jsonReplacer, 2));
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
