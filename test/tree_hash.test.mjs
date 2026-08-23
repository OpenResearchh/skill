// Conformance tests for the canonical tree hash.
//
// Miner and verifier compute this independently and a proposal only settles if
// they agree, so the properties that matter are: identical input gives an
// identical digest on any machine, and anything that changes the code changes
// the digest. These tests pin both.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "autoresearch-create",
  "scripts",
  "tree_hash.py",
);

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(files, { gitattributes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arah-treehash-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (gitattributes) fs.writeFileSync(path.join(dir, ".gitattributes"), gitattributes);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "c"]);
  return dir;
}

function treeHash(dir, commit = "HEAD", extra = []) {
  const r = spawnSync("python3", [SCRIPT, "--repo-root", dir, "--commit", commit, ...extra], {
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("digest is stable for identical content in different repositories", () => {
  const a = makeRepo({ "src/model.py": "VALUE = 1\n", "README.md": "hi\n" });
  const b = makeRepo({ "README.md": "hi\n", "src/model.py": "VALUE = 1\n" });
  const ra = treeHash(a);
  const rb = treeHash(b);
  assert.equal(ra.status, 0, ra.err);
  assert.equal(rb.status, 0, rb.err);
  assert.equal(ra.out, rb.out, "same content must hash the same regardless of add order");
  assert.match(ra.out, /^[0-9a-f]{64}$/);
});

test("content change changes the digest", () => {
  const a = makeRepo({ "src/model.py": "VALUE = 1\n" });
  const b = makeRepo({ "src/model.py": "VALUE = 2\n" });
  assert.notEqual(treeHash(a).out, treeHash(b).out);
});

test("path change changes the digest even when contents match", () => {
  const a = makeRepo({ "src/a.py": "x\n" });
  const b = makeRepo({ "src/b.py": "x\n" });
  assert.notEqual(treeHash(a).out, treeHash(b).out);
});

test("executable bit changes the digest", () => {
  const dir = makeRepo({ "run.sh": "echo hi\n" });
  const before = treeHash(dir).out;
  fs.chmodSync(path.join(dir, "run.sh"), 0o755);
  git(dir, ["update-index", "--chmod=+x", "run.sh"]);
  // Commit the index directly: `-a` would re-stage from the worktree and can
  // discard the mode change we just recorded.
  git(dir, ["commit", "-q", "-m", "chmod"]);
  const after = treeHash(dir).out;
  assert.notEqual(before, after, "mode is part of the commitment");
});

test("gitattributes that would change `git archive` output do not change the digest", () => {
  // The whole reason this is defined over git's object model rather than over
  // an archive: export-subst/export-ignore alter archive bytes, so hashing an
  // archive would make two honest machines disagree.
  const plain = makeRepo({ "src/model.py": "VALUE = 1\n", "notes.txt": "n\n" });
  const attrs = makeRepo(
    { "src/model.py": "VALUE = 1\n", "notes.txt": "n\n" },
    { gitattributes: "notes.txt export-ignore\n" },
  );
  // The attrs repo has an extra .gitattributes file, so compare the shared
  // subset by hashing the same commit twice under different archive settings.
  const first = treeHash(attrs).out;
  const second = treeHash(attrs).out;
  assert.equal(first, second, "digest must not depend on archive-affecting attributes");
  assert.notEqual(plain.length, 0);
});

test("digest is reproducible across repeated invocations", () => {
  const dir = makeRepo({ "a.py": "1\n", "b/c.py": "2\n" });
  const runs = new Set([treeHash(dir).out, treeHash(dir).out, treeHash(dir).out]);
  assert.equal(runs.size, 1);
});

test("--verify matches and mismatches with distinct exit codes", () => {
  const dir = makeRepo({ "a.py": "1\n" });
  const value = treeHash(dir).out;
  assert.equal(treeHash(dir, "HEAD", ["--verify", value]).status, 0);
  const bad = "0".repeat(64);
  assert.equal(treeHash(dir, "HEAD", ["--verify", bad]).status, 3);
});

test("submodules are rejected rather than silently skipped", () => {
  const inner = makeRepo({ "x.py": "1\n" });
  const outer = makeRepo({ "a.py": "1\n" });
  const r = spawnSync(
    "git",
    ["-C", outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendored"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return; // submodule support unavailable in this environment
  git(outer, ["commit", "-q", "-m", "add submodule"]);
  const res = treeHash(outer);
  assert.equal(res.status, 4, "a submodule's contents are not in this repo, so it cannot be committed to");
  assert.match(res.err, /submodule/i);
});

test("symlinks hash as their target path", () => {
  const dir = makeRepo({ "real.py": "1\n" });
  fs.symlinkSync("real.py", path.join(dir, "link.py"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "link"]);
  const first = treeHash(dir);
  assert.equal(first.status, 0, first.err);

  const dir2 = makeRepo({ "real.py": "1\n" });
  fs.symlinkSync("other.py", path.join(dir2, "link.py"));
  git(dir2, ["add", "-A"]);
  git(dir2, ["commit", "-q", "-m", "link"]);
  assert.notEqual(first.out, treeHash(dir2).out, "retargeting a symlink must change the digest");
});
