import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CHAIN as CREATE_DEFAULT,
  SUPPORTED_CHAINS as CREATE_CHAINS,
  adapterFor as createAdapterFor,
} from "../autoresearch-create/scripts/chain.mjs";
import {
  DEFAULT_CHAIN as MINE_DEFAULT,
  SUPPORTED_CHAINS as MINE_CHAINS,
  adapterFor as mineAdapterFor,
} from "../autoresearch-mine/scripts/chain.mjs";
import {
  DEFAULT_CHAIN as VALIDATE_DEFAULT,
  SUPPORTED_CHAINS as VALIDATE_CHAINS,
  adapterFor as validateAdapterFor,
} from "../autoresearch-validate/scripts/chain.mjs";
import {
  hashCanonicalTree,
  repoCommitment,
} from "../autoresearch-create/scripts/stellar_open_research.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH = path.join(ROOT, "autoresearch-create", "scripts", "publish_project.mjs");
const SUBMIT_STELLAR = path.join(ROOT, "autoresearch-mine", "scripts", "submit_proposal_stellar.mjs");
const LINK_STELLAR = path.join(ROOT, "autoresearch-mine", "scripts", "link_identity_stellar.mjs");
const C_ID = `C${"A".repeat(55)}`;
const G_ADDR = `G${"A".repeat(55)}`;
const GIT_VECTORS = path.resolve(ROOT, "..", "smart-contracts", "test-vectors", "git.json");

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arah-stellar-"));
  run("git", ["init", "-q", "-b", "main"], dir);
  run("git", ["config", "user.email", "t@example.com"], dir);
  run("git", ["config", "user.name", "t"], dir);
  fs.writeFileSync(path.join(dir, "model.py"), "VALUE = 1\n");
  const protocol = {
    schemaKind: "protocol",
    meta: {
      protocolBundleId: "bundle-test",
      eligibility: "eligible",
      purposeStatement: "Improve the test metric.",
      repo: { cloneUrl: "https://github.com/OpenResearchh/Skill.git" },
    },
    measurement: {
      primaryMetric: { name: "score", direction: "maximize" },
      minScoreImprovementBips: 100,
    },
  };
  fs.mkdirSync(path.join(dir, ".autoresearch", "create"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".autoresearch", "create", "protocol.json"),
    JSON.stringify(protocol, null, 2),
  );
  run("git", ["add", "-A"], dir);
  run("git", ["commit", "-q", "-m", "baseline"], dir);
  return dir;
}

test("stellar is wired through neutral chain registries", () => {
  assert.equal(CREATE_DEFAULT, "stellar");
  assert.equal(MINE_DEFAULT, "stellar");
  assert.equal(VALIDATE_DEFAULT, "stellar");
  assert.ok(CREATE_CHAINS.includes("stellar"));
  assert.ok(MINE_CHAINS.includes("stellar"));
  assert.ok(VALIDATE_CHAINS.includes("stellar"));
  assert.equal(createAdapterFor("publishProject", "stellar").script, "publish_project_stellar.mjs");
  assert.equal(mineAdapterFor("bootstrap", "stellar").script, "bootstrap_from_stellar.mjs");
  assert.equal(mineAdapterFor("submitProposal", "stellar").script, "submit_proposal_stellar.mjs");
  assert.equal(validateAdapterFor("validateLoop", "stellar").script, "run_validate_loop_stellar.mjs");
});

test("stellar publish dry-run writes git and publish manifests", () => {
  const repo = makeRepo();
  const protocolJson = path.join(repo, ".autoresearch", "create", "protocol.json");
  run(
    "node",
    [
      PUBLISH,
      "--chain",
      "stellar",
      "--protocol-json",
      protocolJson,
      "--repo-root",
      repo,
      "--repo-url",
      "https://github.com/OpenResearchh/Skill.git",
      "--allow-unpushed-baseline",
      "--baseline-aggregate-score",
      "123",
      "--token",
      C_ID,
      "--creator",
      G_ADDR,
      "--minimum-stake",
      "1",
      "--reward-per-approval",
      "2",
      "--reward-pool-funding",
      "3",
      "--contract-id",
      C_ID,
      "--rpc-url",
      "https://example.invalid/rpc",
      "--network-passphrase",
      "Test Network",
      "--dry-run",
    ],
    ROOT,
  );
  const publish = JSON.parse(fs.readFileSync(path.join(repo, ".autoresearch", "create", "publish_stellar.json")));
  const git = JSON.parse(fs.readFileSync(path.join(repo, ".autoresearch", "create", "storage_git.json")));
  assert.equal(publish.chain, "stellar");
  assert.equal(publish.dryRun, true);
  assert.equal(publish.args.baseline_score, "123");
  assert.equal(publish.args.token, C_ID);
  assert.equal(git.settlementLayer, "stellar");
  assert.match(git.repo.repoId, /^[0-9a-f]{64}$/);
  assert.match(git.treeHash, /^0x[0-9a-f]{64}$/);
});

test("stellar git helpers match smart-contracts vectors", () => {
  const vectors = JSON.parse(fs.readFileSync(GIT_VECTORS));
  for (const vector of vectors.repositories) {
    assert.equal(repoCommitment(vector.input).canonical, vector.normalized);
  }
  assert.equal(repoCommitment(vectors.repositoryHash.normalized).repoId, vectors.repositoryHash.sha256);
  assert.throws(() => repoCommitment("https://github.com:8443/OpenResearch/Protocol"));
  assert.throws(() => repoCommitment("https://github.com/OpenResearch/Protocol?token=secret"));
  const entries = vectors.tree.entries.map((entry) => ({
    mode: entry.mode,
    path: entry.path,
    blob: Buffer.from(entry.blobHex, "hex"),
  }));
  assert.equal(hashCanonicalTree(entries), vectors.tree.sha256);
});

test("stellar network_state template matches the schema variant", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "autoresearch-mine", "schemas", "network_state.schema.json")),
  );
  const template = JSON.parse(
    fs.readFileSync(path.join(ROOT, "autoresearch-mine", "templates", "network_state.stellar.json")),
  );
  const variant = schema.oneOf.find((entry) => entry.properties?.source?.const === "stellar");
  assert.ok(variant, "stellar schema variant is present");
  for (const key of variant.required) {
    assert.ok(Object.hasOwn(template, key), `template missing ${key}`);
  }
  assert.equal(template.source, "stellar");
  assert.match(template.contract_id, new RegExp(variant.properties.contract_id.pattern));
});

test("stellar proposal submit dry-run writes submit payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arah-stellar-submit-"));
  const output = path.join(dir, "submission_stellar.json");
  run(
    "node",
    [
      SUBMIT_STELLAR,
      "--project-id",
      "7",
      "--repo-hash",
      "1".repeat(64),
      "--head-commit",
      "2".repeat(40),
      "--tree-hash",
      "3".repeat(64),
      "--base-commit",
      "4".repeat(40),
      "--clone-url",
      "https://github.com/OpenResearchh/Skill.git",
      "--claimed-metric",
      "1.25",
      "--metric-scale",
      "100",
      "--direction",
      "maximize",
      "--stake",
      "5",
      "--miner",
      G_ADDR,
      "--reward-recipient",
      G_ADDR,
      "--contract-id",
      C_ID,
      "--rpc-url",
      "https://example.invalid/rpc",
      "--network-passphrase",
      "Test Network",
      "--output",
      output,
      "--dry-run",
    ],
    ROOT,
  );
  const payload = JSON.parse(fs.readFileSync(output));
  assert.equal(payload.chain, "stellar");
  assert.equal(payload.input.project_id, "7");
  assert.equal(payload.input.claimed_score, "125");
  assert.equal(payload.input.stake, "5");
});

test("stellar identity link dry-run writes payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arah-stellar-link-"));
  const payloadPath = path.join(dir, "identity.json");
  const output = path.join(dir, "link_identity_stellar.json");
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      schemaVersion: "1",
      action: "link",
      address: G_ADDR,
      platform: "github",
      platform_code: 0,
      handle: "OpenResearchh",
    }),
  );
  run(
    "node",
    [
      LINK_STELLAR,
      "--payload",
      payloadPath,
      "--contract-id",
      C_ID,
      "--rpc-url",
      "https://example.invalid/rpc",
      "--network-passphrase",
      "Test Network",
      "--output",
      output,
      "--dry-run",
    ],
    ROOT,
  );
  const linked = JSON.parse(fs.readFileSync(output));
  assert.equal(linked.chain, "stellar");
  assert.equal(linked.action, "link");
  assert.equal(linked.address, G_ADDR);
});
