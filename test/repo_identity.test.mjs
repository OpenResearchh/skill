// Project identity must be byte-identical everywhere.
//
// The chain stores sha256("<host>/<owner>/<repo>"), and three separate skills
// derive it: the researcher publishing a project, the miner submitting against
// it, and the verifier scoring it. If any two disagree the ids never match and
// every proposal fails for a reason none of them can see locally. These tests
// pin the definition and pin the JavaScript and Python implementations to each
// other.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalRepo, repoIdentity } from "../autoresearch-create/scripts/git_artifacts.mjs";

const PY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "autoresearch-create",
  "scripts",
  "repo_identity.py",
);

function pythonIdentity(url) {
  const r = spawnSync("python3", [PY, "--json", url], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return JSON.parse(r.stdout);
}

const EQUIVALENT = [
  "https://github.com/OpenResearchh/skill.git",
  "https://github.com/openresearchh/skill",
  "https://github.com/OpenResearchh/skill/",
  "https://GitHub.com/OpenResearchh/Skill.git",
  "git@github.com:OpenResearchh/skill.git",
  "ssh://git@github.com/OpenResearchh/skill.git",
  "ssh://git@GitHub.com:22/OpenResearchh/skill.git",
  "https://token@github.com/OpenResearchh/skill.git",
];

test("every equivalent remote form yields one project id", () => {
  const ids = new Set(EQUIVALENT.map((u) => repoIdentity(u).repoId));
  assert.equal(ids.size, 1, `expected one id, got ${[...ids].length}`);
  assert.equal(canonicalRepo(EQUIVALENT[0]), "github.com/openresearchh/skill");
});

test("case differences in owner and repo do not fork identity", () => {
  // The bug this guards: lower-casing only the host means a project published
  // as Owner/Repo gets a different id from one cloned as owner/repo.
  assert.equal(
    repoIdentity("https://github.com/OpenResearchh/Skill").repoId,
    repoIdentity("https://github.com/openresearchh/skill").repoId,
  );
});

test("javascript and python agree on every form", () => {
  for (const url of EQUIVALENT) {
    const js = repoIdentity(url);
    const py = pythonIdentity(url);
    assert.equal(js.canonical, py.canonical, `canonical mismatch for ${url}`);
    assert.equal(js.repoId, py.repoId, `repoId mismatch for ${url}`);
  }
});

test("different repositories keep different identities", () => {
  const a = repoIdentity("https://github.com/OpenResearchh/skill").repoId;
  const b = repoIdentity("https://github.com/OpenResearchh/contracts.sol").repoId;
  const c = repoIdentity("https://gitlab.com/OpenResearchh/skill").repoId;
  assert.equal(new Set([a, b, c]).size, 3, "owner, name, and host must all be significant");
});

test("credentials never reach the hashed preimage", () => {
  const withToken = canonicalRepo("https://ghp_secretvalue@github.com/o/r.git");
  assert.ok(!withToken.includes("ghp_"), "a token must never be hashed into a public identifier");
  assert.equal(withToken, "github.com/o/r");
});

test("unparseable remotes raise rather than yielding a junk id", () => {
  for (const bad of ["", "   ", "not-a-url", "https://github.com/"]) {
    assert.throws(() => canonicalRepo(bad), `expected '${bad}' to be rejected`);
  }
});
