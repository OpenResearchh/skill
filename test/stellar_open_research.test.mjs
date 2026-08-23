import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  formatCommitId,
  gitRefFromCheckout,
  gitRefJson,
  hashCanonicalTree,
  hashProtocol,
  hashRepositoryIdentity,
  improvementThreshold,
  incumbentScore,
  isSufficient,
  listGitTreeEntries,
  normalizeRepositoryIdentity,
  parseCommitId,
  scaleMetric,
  serializeCanonicalTree,
  splitNulRecords,
  unwrapOption,
} from "../autoresearch-create/scripts/stellar_open_research.mjs";
import { DEFAULT_CHAIN, SUPPORTED_CHAINS, resolveChain } from "../autoresearch-create/scripts/chain.mjs";
import {
  DEFAULT_CHAIN as MINE_DEFAULT_CHAIN,
  SUPPORTED_CHAINS as MINE_SUPPORTED_CHAINS,
} from "../autoresearch-mine/scripts/chain.mjs";
import {
  DEFAULT_CHAIN as VALIDATE_DEFAULT_CHAIN,
  SUPPORTED_CHAINS as VALIDATE_SUPPORTED_CHAINS,
} from "../autoresearch-validate/scripts/chain.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const gitVectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, "fixtures/stellar/git.json"), "utf8"),
);
const scoreVectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, "fixtures/stellar/score.json"), "utf8"),
);

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arah-stellar-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "c"]);
  return dir;
}

test("stellar is the default settlement layer", () => {
  assert.equal(DEFAULT_CHAIN, "stellar");
  assert.deepEqual(SUPPORTED_CHAINS, ["stellar", "solana", "0g"]);
  assert.equal(MINE_DEFAULT_CHAIN, "stellar");
  assert.deepEqual(MINE_SUPPORTED_CHAINS, ["stellar", "solana", "0g"]);
  assert.equal(VALIDATE_DEFAULT_CHAIN, "stellar");
  assert.deepEqual(VALIDATE_SUPPORTED_CHAINS, ["stellar", "solana", "0g"]);
  const previous = process.env.ARAH_CHAIN;
  delete process.env.ARAH_CHAIN;
  try {
    assert.equal(resolveChain({}), "stellar");
  } finally {
    if (previous === undefined) delete process.env.ARAH_CHAIN;
    else process.env.ARAH_CHAIN = previous;
  }
});

test("repository identity matches the Stellar client vectors", async () => {
  for (const vector of gitVectors.repositories) {
    assert.equal(normalizeRepositoryIdentity(vector.input), vector.normalized);
  }
  const digest = await hashRepositoryIdentity(gitVectors.repositoryHash.normalized);
  assert.equal(digest.toString("hex"), gitVectors.repositoryHash.sha256);
});

test("canonical tree hash matches the Stellar client vectors", async () => {
  const entries = gitVectors.tree.entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    blob: Buffer.from(entry.blobHex, "hex"),
  }));
  assert.equal(
    serializeCanonicalTree(entries).toString("hex"),
    gitVectors.tree.serializationHex,
  );
  const digest = await hashCanonicalTree(entries);
  assert.equal(digest.toString("hex"), gitVectors.tree.sha256);
});

test("protocol hash matches the Stellar client vector", async () => {
  const bytes = Buffer.from(gitVectors.protocol.bytesHex, "hex");
  const digest = await hashProtocol(bytes);
  assert.equal(digest.toString("hex"), gitVectors.protocol.sha256);
});

test("gitRefFromCheckout uses the Stellar canonical tree", async () => {
  const dir = makeRepo({
    "README.md": "# Demo\n",
    "src/main.ts": "console.log('hi');\n",
  });
  fs.symlinkSync("README.md", path.join(dir, "link"));
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/run"), Buffer.from([0, 1, 255]));
  fs.chmodSync(path.join(dir, "bin/run"), 0o755);
  git(dir, ["add", "-A"]);
  git(dir, ["update-index", "--chmod=+x", "bin/run"]);
  git(dir, ["commit", "-q", "-m", "tree"]);
  const commit = git(dir, ["rev-parse", "HEAD"]);
  const gitRef = await gitRefFromCheckout({
    repoRoot: dir,
    commit,
    repository: "https://github.com/OpenResearch/Protocol.git",
  });
  const json = gitRefJson(gitRef);
  assert.equal(json.commit, commit);
  assert.equal(json.repo, gitVectors.repositoryHash.sha256);
  const entries = listGitTreeEntries(dir, commit);
  const expected = await hashCanonicalTree(entries);
  assert.equal(json.treeHash, expected.toString("hex"));
});

test("scaleMetric and thresholds match the Stellar client vectors", () => {
  for (const row of scoreVectors.scaling) {
    assert.equal(
      scaleMetric(row.metric, BigInt(row.scale), row.direction).toString(),
      row.expected,
    );
  }
  for (const row of scoreVectors.thresholds) {
    assert.equal(
      improvementThreshold(BigInt(row.incumbent), row.improvementBips).toString(),
      row.expected,
    );
  }
  assert.equal(isSufficient(1_050_000n, 1_000_000n, 500), true);
  assert.equal(isSufficient(1_049_999n, 1_000_000n, 500), false);
  assert.equal(isSufficient(1_000_000n, 1_000_000n, 0), false);
  assert.equal(isSufficient(1_000_001n, 1_000_000n, 0), true);
});

test("genesis incumbent is baseline_score when current_best is absent", () => {
  const genesis = {
    baseline_score: -2_500_000n,
    current_best_score: 0n,
    current_best: { present: false, value: null },
  };
  assert.equal(incumbentScore(genesis).toString(), "-2500000");
  const advanced = {
    baseline_score: -2_500_000n,
    current_best_score: -2_400_000n,
    current_best: {
      present: true,
      value: { commit: parseCommitId("0123456789abcdef0123456789abcdef01234567") },
    },
  };
  assert.equal(incumbentScore(advanced).toString(), "-2400000");
});

test("commit IDs round-trip", () => {
  for (const vector of gitVectors.commits) {
    const commit = parseCommitId(vector.hex);
    assert.equal(commit.tag, vector.tag);
    assert.equal(formatCommitId(commit), vector.hex.toLowerCase());
  }
});

test("unwrapOption reads Soroban Option encodings", () => {
  assert.equal(unwrapOption(null), null);
  assert.equal(unwrapOption(undefined), null);
  assert.equal(unwrapOption("GABC"), "GABC");
  assert.equal(unwrapOption(["GABC"]), "GABC");
  assert.equal(unwrapOption({ tag: "None", values: undefined }), null);
  assert.equal(unwrapOption({ tag: "Some", values: ["GABC"] }), "GABC");
});

test("splitNulRecords splits git ls-tree -z output", () => {
  const raw = Buffer.concat([
    Buffer.from("100644 blob abc\tREADME.md"),
    Buffer.from([0]),
    Buffer.from("100755 blob def\tbin/run"),
    Buffer.from([0]),
  ]);
  const parts = splitNulRecords(raw).map((part) => part.toString("utf8"));
  assert.deepEqual(parts, ["100644 blob abc\tREADME.md", "100755 blob def\tbin/run"]);
});

test("python mine chain defaults to stellar", () => {
  const result = spawnSync(
    "python3",
    ["-c", "import chain; print(chain.DEFAULT_CHAIN); print(','.join(chain.SUPPORTED_CHAINS))"],
    {
      cwd: path.join(ROOT, "..", "autoresearch-mine", "scripts"),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [def, supported] = result.stdout.trim().split("\n");
  assert.equal(def, "stellar");
  assert.equal(supported, "stellar,solana,0g");
});
