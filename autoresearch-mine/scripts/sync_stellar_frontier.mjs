#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  bufferHex,
  createClient,
  directionText,
  formatCommitId,
  hashFileHex,
  metricFromScore,
  parseArgs,
  projectGitRef,
  readJson,
  resolveDeployment,
  unwrapResult,
  utcNow,
  writeJson,
} from "../../autoresearch-create/scripts/stellar_open_research.mjs";
import { git } from "./git_artifacts.mjs";

const BOOL_FLAGS = new Set(["help"]);

function usage() {
  console.log(`Usage:
  node scripts/sync_stellar_frontier.mjs \\
    --repo-root <repo> \\
    --protocol-json <repo>/protocol.json \\
    --project-id <id>

Reads get_project from Stellar, updates .autoresearch/mine/network_state.json,
and refreshes refs/openresearch/base when the incumbent commit is present in the
local checkout.
`);
}

function loadExistingState(repoRoot) {
  const statePath = path.join(repoRoot, ".autoresearch", "mine", "network_state.json");
  try {
    return { statePath, state: readJson(statePath) };
  } catch {
    return { statePath, state: {} };
  }
}

function updateBaseRef(repoRoot, commit) {
  const known = git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`], { allowFail: true });
  if (known.status === 0) {
    git(repoRoot, ["update-ref", "refs/openresearch/base", commit]);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help) {
    usage();
    return 0;
  }
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const { statePath, state } = loadExistingState(repoRoot);
  const projectId = options.projectId || state.project_id || process.env.ARAH_PROJECT_ID;
  if (projectId === undefined) throw new Error("--project-id or existing network_state.project_id is required");
  const protocolPath = path.resolve(options.protocolJson || path.join(repoRoot, "protocol.json"));
  const protocol = readJson(protocolPath);
  const network = resolveDeployment({
    ...options,
    contractId: options.contractId || state.contract_id,
    rpcUrl: options.rpcUrl || state.rpc_url,
    networkPassphrase: options.networkPassphrase || state.network_passphrase,
  });
  const client = await createClient({
    contractId: network.contractId,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
  });
  const projectTx = await client.get_project({ project_id: BigInt(projectId) });
  const project = unwrapResult(projectTx, "get_project");
  const selected = projectGitRef(project);
  const direction = directionText(project.direction);
  const score = selected.score;
  const incumbentCommit = formatCommitId(selected.gitRef.commit);
  updateBaseRef(repoRoot, incumbentCommit);

  const protocolHash = hashFileHex(protocolPath);
  const expectedProtocolHash = bufferHex(project.protocol_hash);
  if (protocolHash !== expectedProtocolHash) {
    throw new Error(`protocol hash mismatch: expected ${expectedProtocolHash}, got ${protocolHash}`);
  }
  const nextState = {
    schemaVersion: "1",
    source: "stellar",
    protocolBundleId: protocol?.meta?.protocolBundleId || null,
    project_id: Number(projectId),
    contract_id: network.contractId,
    rpc_url: network.rpcUrl,
    network_passphrase: network.networkPassphrase,
    protocol_epoch: Number(project.protocol_epoch),
    protocol_hash: expectedProtocolHash,
    code_origin: selected.origin,
    current_best: project.current_best?.present
      ? {
          repo: bufferHex(project.current_best.value.repo),
          commit: formatCommitId(project.current_best.value.commit),
          tree_hash: bufferHex(project.current_best.value.tree_hash),
        }
      : null,
    network_best_metric: metricFromScore(score, direction, Number(project.metric_scale)),
    aggregate_score_int256: BigInt(score).toString(),
    metric_scale: Number(project.metric_scale),
    metric_name: protocol?.measurement?.primaryMetric?.name || "aggregate_score",
    direction,
    min_score_improvement_bips: Number(project.min_improvement_bips),
    updated_at: utcNow(),
  };
  writeJson(statePath, nextState);
  console.log(statePath);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`stellar frontier sync failed: ${err.message}`);
    process.exit(1);
  },
);
