#!/usr/bin/env node
// Bootstrap a mining workspace from a published Stellar OpenResearch project.
//
// The contract stores a GitRef, not an archive. The working tree is a checkout
// of the live incumbent commit (current best when present, otherwise baseline).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertAllowedRemote } from "./git_artifacts.mjs";
import {
  call,
  createReadonlyClient,
  directionFromTag,
  findProtocolInCommit,
  formatCommitId,
  gitRefJson,
  hexBuffer,
  incumbentGitRef,
  incumbentScore,
  jsonReplacer,
  loadDeployment,
  materializeGitRef,
  parseArgs,
  readJson,
  scoreToMetric,
  slotGitRef,
  writeChainConfig,
} from "./stellar_open_research.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node scripts/bootstrap_from_stellar.mjs \\
    --project-id 1 \\
    --output-dir /tmp/openresearch-stellar-project \\
    --repo-url https://github.com/owner/repo.git \\
    --unpack-repo

Options:
  --from-baseline          Start from the published baseline instead of current best.
  --repo-root <path>       Working tree location. Defaults to <output-dir>/repo.
  --protocol-file <path>   protocol.json override after the checkout is verified.
  --skip-existing          Reuse an existing checkout if the commit is already present.
`);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    text: true,
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed${result.stderr ? `\n${result.stderr}` : ""}`);
  }
  return result.stdout || "";
}

function writeNetworkState({ repoRoot, protocolPath, project, projectId, deployment, codeOrigin }) {
  let protocol;
  try {
    protocol = readJson(protocolPath);
  } catch {
    console.error("protocol.json unreadable; leaving network_state.json untouched");
    return;
  }
  const direction = directionFromTag(
    project.direction || protocol?.measurement?.primaryMetric?.direction,
  );
  const scale = Number(project.metric_scale || process.env.ARAH_METRIC_SCALE || 1_000_000);
  const score = incumbentScore(project);
  const best = Number(scoreToMetric(score, scale, direction));
  const state = {
    schemaVersion: "1",
    source: "stellar",
    protocolBundleId: protocol?.meta?.protocolBundleId || `stellar:project:${projectId}`,
    project_id: Number(projectId),
    network: deployment.network,
    contract_id: deployment.openResearchContractId,
    network_best_metric: best,
    aggregate_score_int256: score.toString(),
    metric_scale: scale,
    metric_name: protocol?.measurement?.primaryMetric?.name || "primary",
    direction,
    code_origin: codeOrigin,
    min_score_improvement_bips: Number(
      project.min_improvement_bips ?? protocol?.measurement?.minScoreImprovementBips ?? 100,
    ),
    updated_at: new Date().toISOString(),
  };
  const statePath = path.join(repoRoot, ".autoresearch", "mine", "network_state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, jsonReplacer, 2)}\n`);
  console.error(`network_state.json synced (best=${best} ${state.metric_name})`);
  return statePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    boolKeys: ["help", "unpackRepo", "skipExisting", "fromBaseline"],
  });
  if (options.help || !options.projectId) {
    usage();
    return options.help ? 0 : 1;
  }
  if (!options.outputDir) throw new Error("--output-dir is required");
  const remote = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (!remote) throw new Error("pass --repo-url or set ARAH_PROJECT_REPO");
  assertAllowedRemote(remote);

  const deployment = loadDeployment(options.deploymentJson);
  const client = createReadonlyClient(deployment);
  const projectId = BigInt(options.projectId);
  const project = await call(client, "get_project", { project_id: projectId });
  if (project.frozen) {
    console.error(`project ${projectId} is frozen; mining submissions will fail`);
  }

  const fromBaseline = Boolean(options.fromBaseline);
  const gitRef = fromBaseline ? project.baseline : incumbentGitRef(project);
  const codeOrigin = !fromBaseline && slotGitRef(project.current_best) ? "current_best" : "baseline";
  const commit = formatCommitId(gitRef.commit);

  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const repoRoot = path.resolve(options.repoRoot || path.join(outputDir, "repo"));

  const result = await materializeGitRef({
    dir: repoRoot,
    remote,
    gitRef,
    repository: remote,
  });

  const protocolInTree = await findProtocolInCommit(repoRoot, commit);
  if (!protocolInTree) {
    throw new Error("protocol.json not found in the checked-out commit");
  }
  const expectedProtocol = hexBuffer(project.protocol_hash);
  if (protocolInTree.hash !== expectedProtocol) {
    throw new Error(
      `protocol.json SHA-256 mismatch: tree has ${protocolInTree.hash} at ${protocolInTree.rel}, contract records ${expectedProtocol}`,
    );
  }

  const protocolPath = options.protocolFile
    ? path.resolve(options.protocolFile)
    : path.join(repoRoot, protocolInTree.rel);
  if (options.protocolFile) {
    fs.mkdirSync(path.dirname(protocolPath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, protocolInTree.rel), protocolPath);
  }

  fs.writeFileSync(
    path.join(outputDir, "bootstrap_result.json"),
    `${JSON.stringify(
      {
        chain: "stellar",
        projectId: projectId.toString(),
        contractId: deployment.openResearchContractId,
        codeOrigin,
        commit,
        gitRef: gitRefJson(gitRef),
        protocolPath,
        protocolHash: protocolInTree.hash,
        repoRoot,
        remote,
        frozen: project.frozen,
        minimumStake: project.minimum_stake.toString(),
        token: project.token,
        incumbentScore: incumbentScore(project).toString(),
      },
      jsonReplacer,
      2,
    )}\n`,
  );

  writeChainConfig(outputDir, "stellar");
  writeChainConfig(repoRoot, "stellar");

  if (options.unpackRepo) {
    run("bash", [path.join(SCRIPT_DIR, "init_mine_workspace.sh"), repoRoot]);
    run("git", ["update-ref", "refs/openresearch/base", commit], { cwd: repoRoot });
    writeNetworkState({
      repoRoot,
      protocolPath,
      project,
      projectId: projectId.toString(),
      deployment,
      codeOrigin,
    });
  }

  console.log(path.join(outputDir, "bootstrap_result.json"));
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
