#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertRepoMatches,
  bufferHex,
  createClient,
  directionText,
  formatCommitId,
  hashFileHex,
  metricFromScore,
  parseArgs,
  projectGitRef,
  projectSummary,
  readJson,
  resolveDeployment,
  unwrapResult,
  utcNow,
  verifyStellarTreeHash,
  writeJson,
} from "../../autoresearch-create/scripts/stellar_open_research.mjs";
import { assertAllowedRemote, fetchCommit, git } from "./git_artifacts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOOL_FLAGS = new Set(["help", "prepareRepo", "skipExisting", "fromBaseline", "dryRun"]);

function usage() {
  console.log(`Usage:
  node scripts/bootstrap_from_stellar.mjs \\
    --project-id 1 \\
    --output-dir /tmp/arah-stellar-project \\
    --repo-root ./project \\
    --prepare-repo

Options:
  --repo-url <url>           Override project clone_url.
  --project-json <path>      Read a captured project JSON instead of RPC (dry-run/tests).
  --protocol-file <path>     Use this protocol.json for network_state metadata.
  --from-baseline            Bootstrap from the original baseline, not current best.
  --contract-id / --rpc-url / --network-passphrase / --deployment-json
`);
}

function run(cmd, cwd) {
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function loadProject(options, network) {
  if (options.projectJson) return readJson(path.resolve(options.projectJson));
  const client = await createClient({
    contractId: network.contractId,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
  });
  const tx = await client.get_project({ project_id: BigInt(options.projectId) });
  return unwrapResult(tx, "get_project");
}

function findProtocol(repoRoot, explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    "protocol.json",
    path.join(".autoresearch", "protocol.json"),
    path.join("autoresearch", "protocol.json"),
  ];
  for (const candidate of candidates) {
    const full = path.join(repoRoot, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function writeNetworkState({ repoRoot, protocolPath, project, projectId, network, codeOrigin, score }) {
  if (!protocolPath || !fs.existsSync(protocolPath)) {
    console.error("protocol.json not found; leaving network_state.json untouched");
    return null;
  }
  const protocol = readJson(protocolPath);
  const actualProtocolHash = hashFileHex(protocolPath);
  const expectedProtocolHash = bufferHex(project.protocol_hash);
  if (actualProtocolHash !== expectedProtocolHash) {
    throw new Error(
      `protocol hash mismatch: expected ${expectedProtocolHash}, got ${actualProtocolHash}`,
    );
  }
  const primary = protocol?.measurement?.primaryMetric || {};
  const direction = directionText(project.direction);
  const metricName = primary.name || "aggregate_score";
  const metricScale = Number(project.metric_scale);
  const state = {
    schemaVersion: "1",
    source: "stellar",
    protocolBundleId: protocol?.meta?.protocolBundleId || null,
    project_id: Number(projectId),
    contract_id: network.contractId,
    rpc_url: network.rpcUrl,
    network_passphrase: network.networkPassphrase,
    protocol_epoch: Number(project.protocol_epoch),
    protocol_hash: expectedProtocolHash,
    code_origin: codeOrigin,
    network_best_metric: metricFromScore(score, direction, metricScale),
    aggregate_score_int256: BigInt(score).toString(),
    metric_scale: metricScale,
    metric_name: metricName,
    direction,
    min_score_improvement_bips: Number(project.min_improvement_bips),
    current_best: project.current_best?.present
      ? {
          repo: bufferHex(project.current_best.value.repo),
          commit: formatCommitId(project.current_best.value.commit),
          tree_hash: bufferHex(project.current_best.value.tree_hash),
        }
      : null,
    updated_at: utcNow(),
  };
  const statePath = path.join(repoRoot, ".autoresearch", "mine", "network_state.json");
  writeJson(statePath, state);
  return statePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help || !options.projectId || !options.outputDir) {
    usage();
    return 0;
  }
  const network = resolveDeployment(options);
  const project = await loadProject(options, network);
  const chosen = projectGitRef(project, { fromBaseline: Boolean(options.fromBaseline) });
  const remoteUrl = assertAllowedRemote(options.repoUrl || project.clone_url);
  assertRepoMatches(remoteUrl, bufferHex(chosen.gitRef.repo));

  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const summary = {
    schemaVersion: "1",
    source: "stellar",
    network: network.network,
    contractId: network.contractId,
    project: projectSummary(project),
    selectedCode: {
      origin: chosen.origin,
      repo: bufferHex(chosen.gitRef.repo),
      commit: formatCommitId(chosen.gitRef.commit),
      tree_hash: bufferHex(chosen.gitRef.tree_hash),
      clone_url: remoteUrl,
    },
  };
  const summaryPath = path.join(outputDir, "project_stellar.json");
  writeJson(summaryPath, summary);

  if (options.prepareRepo) {
    const repoRoot = path.resolve(options.repoRoot || path.join(outputDir, "repo"));
    fetchCommit({
      dir: repoRoot,
      remote: remoteUrl,
      commit: summary.selectedCode.commit,
      depth: Number(options.depth || 1),
    });
    verifyStellarTreeHash({
      repoRoot,
      commit: summary.selectedCode.commit,
      expected: summary.selectedCode.tree_hash,
    });
    git(repoRoot, ["update-ref", "refs/openresearch/base", summary.selectedCode.commit]);
    run([path.join(SCRIPT_DIR, "init_mine_workspace.sh"), repoRoot]);
    const protocolPath = findProtocol(repoRoot, options.protocolFile);
    const statePath = writeNetworkState({
      repoRoot,
      protocolPath,
      project,
      projectId: options.projectId,
      network,
      codeOrigin: chosen.origin,
      score: chosen.score,
    });
    if (statePath) console.log(statePath);
  }

  console.log(summaryPath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stellar bootstrap failed: ${err.message}`);
    process.exit(1);
  },
);
