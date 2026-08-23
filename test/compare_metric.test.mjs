import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "autoresearch-mine",
  "scripts",
  "compare_metric.py",
);

function compare(args) {
  return spawnSync("python3", [SCRIPT, ...args], { encoding: "utf8" });
}

test("default margin is 100 bips, matching the protocol schema", () => {
  // 0.5% better than 100 is not enough for the 1% default.
  const under = compare([
    "--direction",
    "minimize",
    "--candidate",
    "99.6",
    "--baseline",
    "100",
  ]);
  assert.equal(under.status, 1, under.stderr);
  const enough = compare([
    "--direction",
    "minimize",
    "--candidate",
    "99",
    "--baseline",
    "100",
  ]);
  assert.equal(enough.status, 0, enough.stderr);
});

test("exact threshold counts as an improvement when bips > 0", () => {
  const min = compare([
    "--direction",
    "minimize",
    "--candidate",
    "99",
    "--baseline",
    "100",
    "--min-improvement-bips",
    "100",
  ]);
  assert.equal(min.status, 0, min.stderr);
  const max = compare([
    "--direction",
    "maximize",
    "--candidate",
    "101",
    "--baseline",
    "100",
    "--min-improvement-bips",
    "100",
  ]);
  assert.equal(max.status, 0, max.stderr);
});

test("zero bips stays strict", () => {
  const tie = compare([
    "--direction",
    "minimize",
    "--candidate",
    "100",
    "--baseline",
    "100",
    "--min-improvement-bips",
    "0",
  ]);
  assert.equal(tie.status, 1, tie.stderr);
});
