#!/usr/bin/env node
// Stellar settlement actions: claim, approve, reject, release, expire, record_merge.
import process from "node:process";
import {
  approveMergeAndRecord,
  call,
  createClient,
  jsonReplacer,
  loadDeployment,
  loadSecretKeyFile,
  parseArgs,
  parseCommitId,
  send,
  unwrapContract,
} from "./stellar_open_research.mjs";

function usage() {
  console.log(`Usage:
  node scripts/settle_proposal_stellar.mjs --action claim-review --proposal-id 1 --secret-key-file verifier.secret --yes
  node scripts/settle_proposal_stellar.mjs --action approve --proposal-id 1 --verified-score 1010000 --secret-key-file verifier.secret --yes
  node scripts/settle_proposal_stellar.mjs --action reject --proposal-id 1 --reason-code harness_tampered --secret-key-file verifier.secret --yes
  node scripts/settle_proposal_stellar.mjs --action release-review --proposal-id 1 --secret-key-file verifier.secret --yes
  node scripts/settle_proposal_stellar.mjs --action expire --proposal-id 1 --secret-key-file cranker.secret --yes
  node scripts/settle_proposal_stellar.mjs --action record-merge --proposal-id 1 --merged-commit <sha> --secret-key-file verifier.secret --yes
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { boolKeys: ["help", "yes", "dryRun"] });
  if (options.help || !options.action || !options.proposalId) {
    usage();
    return options.help ? 0 : 1;
  }
  if (!options.dryRun && !options.yes) {
    throw new Error("refusing to submit Stellar settlement without --yes");
  }
  if (!options.secretKeyFile) throw new Error("--secret-key-file is required");

  const deployment = loadDeployment(options.deploymentJson);
  const loaded = loadSecretKeyFile(options.secretKeyFile);
  const { client } = createClient({
    deployment,
    publicKey: loaded.publicKey,
    keypair: loaded.keypair,
  });
  const proposalId = BigInt(options.proposalId);
  const verifier = loaded.publicKey;
  const action = options.action;

  if (options.dryRun) {
    const proposal = await call(client, "get_proposal", { proposal_id: proposalId });
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          action,
          proposalId: proposalId.toString(),
          verifier,
          status: proposal.status?.tag,
        },
        jsonReplacer,
        2,
      ),
    );
    return 0;
  }

  let assembled;
  let extra = {};
  if (action === "claim-review") {
    assembled = await client.claim_review({ verifier, proposal_id: proposalId });
  } else if (action === "approve") {
    if (options.verifiedScore === undefined) throw new Error("--verified-score is required for approve");
    assembled = await client.approve({
      verifier,
      proposal_id: proposalId,
      verified_score: BigInt(options.verifiedScore),
    });
  } else if (action === "reject") {
    assembled = await client.reject({
      verifier,
      proposal_id: proposalId,
      reason_code: options.reasonCode || "rejected",
    });
  } else if (action === "release-review") {
    assembled = await client.release_review({ verifier, proposal_id: proposalId });
  } else if (action === "expire") {
    assembled = await client.expire({ proposal_id: proposalId });
  } else if (action === "record-merge") {
    if (!options.mergedCommit) throw new Error("--merged-commit is required for record-merge");
    assembled = await client.record_merge({
      verifier,
      proposal_id: proposalId,
      merged_commit: parseCommitId(options.mergedCommit),
    });
  } else if (action === "approve-merge-record") {
    if (options.verifiedScore === undefined) throw new Error("--verified-score is required");
    const merge = async () => {
      if (!options.mergedCommit) throw new Error("no merged commit");
      return options.mergedCommit;
    };
    const result = await approveMergeAndRecord(
      client,
      {
        verifier,
        proposal_id: proposalId,
        verified_score: BigInt(options.verifiedScore),
      },
      merge,
    );
    console.log(JSON.stringify({ action, proposalId: proposalId.toString(), verifier, ...result }, jsonReplacer, 2));
    return 0;
  } else {
    throw new Error(`unknown action: ${action}`);
  }

  unwrapContract(assembled.result);
  const sent = await send(assembled);
  console.log(
    JSON.stringify(
      {
        action,
        proposalId: proposalId.toString(),
        verifier,
        hash: sent?.hash || sent?.txHash || null,
        ...extra,
      },
      jsonReplacer,
      2,
    ),
  );
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
