#!/usr/bin/env node
// Fetch the proposal's candidate commit and verify its Stellar GitRef.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  call,
  createReadonlyClient,
  formatCommitId,
  gitRefJson,
  jsonReplacer,
  loadDeployment,
  materializeGitRef,
  parseArgs,
} from "./stellar_open_research.mjs";
import { assertAllowedRemote } from "./git_artifacts.mjs";

function usage() {
  console.log(`Usage:
  node scripts/resolve_proposal_artifacts_stellar.mjs \\
    --proposal-id 1 \\
    --output-dir /tmp/proposal-1 \\
    --repo-url https://github.com/owner/repo.git
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { boolKeys: ["help"] });
  if (options.help || !options.proposalId || !options.outputDir) {
    usage();
    return options.help ? 0 : 1;
  }
  const remote = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (!remote) throw new Error("pass --repo-url or set ARAH_PROJECT_REPO");
  assertAllowedRemote(remote);

  const deployment = loadDeployment(options.deploymentJson);
  const client = createReadonlyClient(deployment);
  const proposalId = BigInt(options.proposalId);
  const proposal = await call(client, "get_proposal", { proposal_id: proposalId });
  const gitRef = proposal.candidate;
  const commit = formatCommitId(gitRef.commit);
  const outputDir = path.resolve(options.outputDir);
  const sourceDir = path.join(outputDir, "source");

  await materializeGitRef({
    dir: sourceDir,
    remote,
    gitRef,
    repository: remote,
  });

  const record = {
    schemaVersion: "1",
    source: "stellar",
    artifactSource: "git",
    proposalId: proposalId.toString(),
    projectId: proposal.project_id.toString(),
    miner: proposal.miner,
    claimedScore: proposal.claimed_score.toString(),
    git: {
      ...gitRefJson(gitRef),
      remote,
      sourceDir,
    },
    extractRoot: sourceDir,
    candidateCommit: commit,
  };
  const recordPath = path.join(outputDir, "proposal_artifacts_stellar.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, jsonReplacer, 2)}\n`);
  console.log(recordPath);
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
