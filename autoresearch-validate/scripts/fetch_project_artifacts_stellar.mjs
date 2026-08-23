#!/usr/bin/env node
// Materialize the project's own baseline tree — the trusted harness.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  call,
  createReadonlyClient,
  findProtocolInCommit,
  formatCommitId,
  gitRefJson,
  hexBuffer,
  jsonReplacer,
  loadDeployment,
  materializeGitRef,
  parseArgs,
} from "./stellar_open_research.mjs";
import { assertAllowedRemote } from "./git_artifacts.mjs";

function usage() {
  console.log(`Usage:
  node scripts/fetch_project_artifacts_stellar.mjs \\
    --project-id 1 \\
    --output-dir /tmp/trusted \\
    --repo-url https://github.com/owner/repo.git
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), { boolKeys: ["help"] });
  if (options.help || !options.projectId || !options.outputDir) {
    usage();
    return options.help ? 0 : 1;
  }
  const remote = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (!remote) throw new Error("pass --repo-url or set ARAH_PROJECT_REPO");
  assertAllowedRemote(remote);

  const deployment = loadDeployment(options.deploymentJson);
  const client = createReadonlyClient(deployment);
  const projectId = BigInt(options.projectId);
  const project = await call(client, "get_project", { project_id: projectId });
  const gitRef = project.baseline;
  const commit = formatCommitId(gitRef.commit);
  const outputDir = path.resolve(options.outputDir);
  const sourceDir = path.join(outputDir, "source");

  await materializeGitRef({
    dir: sourceDir,
    remote,
    gitRef,
    repository: remote,
  });

  const protocol = await findProtocolInCommit(sourceDir, commit);
  if (!protocol) throw new Error("protocol.json not found in the project baseline commit");
  const expected = hexBuffer(project.protocol_hash);
  if (protocol.hash !== expected) {
    throw new Error(
      `protocol.json SHA-256 mismatch: tree has ${protocol.hash} at ${protocol.rel}, contract records ${expected}`,
    );
  }

  const record = {
    schemaVersion: "1",
    source: "stellar",
    artifactSource: "git",
    projectId: projectId.toString(),
    contractId: deployment.openResearchContractId,
    git: {
      ...gitRefJson(gitRef),
      remote,
      sourceDir,
    },
    harnessDir: sourceDir,
    protocolPath: path.join(sourceDir, protocol.rel),
    protocolHash: protocol.hash,
    protocolHashVerified: true,
    baselineScore: project.baseline_score.toString(),
    currentBestScore: project.current_best_score.toString(),
  };
  const recordPath = path.join(outputDir, "project_artifacts_stellar.json");
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
