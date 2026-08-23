// Fetch and verify code artifacts from git.
//
// Under the git-primary artifact model a proposal points at a commit rather
// than an uploaded archive. Git is already content-addressed and already
// replicated to everyone who touched the project, so fetching an object by its
// id and having git accept it is itself the integrity check. This module is the
// one place that knows how to do that safely, so the miner and the verifier
// cannot drift apart on it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Only fetch over transports that authenticate the server. `file://` and
// `git://` are unauthenticated, and `ext::` executes an arbitrary command.
const ALLOWED_SCHEMES = ["https://", "ssh://", "git@"];

export function assertAllowedRemote(url) {
  const value = String(url || "");
  if (!ALLOWED_SCHEMES.some((s) => value.startsWith(s))) {
    throw new Error(
      `refusing remote '${value}': only https, ssh, or scp-style git remotes are allowed`,
    );
  }
  if (value.startsWith("ext::") || value.includes("--upload-pack")) {
    throw new Error(`refusing remote '${value}': transport would execute a command`);
  }
  return value;
}

export function git(cwd, args, { capture = true, allowFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      // Never let a fetch block on a credential prompt in an unattended loop.
      GIT_TERMINAL_PROMPT: "0",
      // Submodules are rejected by the tree hash, so never fetch them.
      GIT_SUBMODULE_STRATEGY: "none",
    },
  });
  if (result.error) throw result.error;
  if (!allowFail && result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

/** Create the working directory if needed and make sure it is a git repo. */
export function ensureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(dir, ["init", "-q"]);
  }
  return dir;
}

/**
 * Fetch one commit by id and check it out detached.
 *
 * Fetching the commit directly rather than a branch matters: a branch name is
 * mutable and can be repointed after a proposal is submitted, while a commit id
 * is the thing the proposal actually committed to.
 */
export function fetchCommit({ dir, remote, commit, depth = 1 }) {
  assertAllowedRemote(remote);
  ensureRepo(dir);
  if (!/^[0-9a-f]{40}$/i.test(String(commit))) {
    throw new Error(`commit must be a full 40-character sha, got '${commit}'`);
  }

  // Servers may refuse to serve arbitrary object ids; fall back to a full
  // fetch of the default refs and then resolve the commit locally.
  const direct = git(dir, ["fetch", "--depth", String(depth), "--no-tags", remote, commit], {
    allowFail: true,
  });
  if (direct.status !== 0) {
    git(dir, ["fetch", "--no-tags", remote, "+refs/heads/*:refs/remotes/origin/*"]);
  }

  const known = git(dir, ["cat-file", "-e", `${commit}^{commit}`], { allowFail: true });
  if (known.status !== 0) {
    throw new Error(`remote does not contain commit ${commit}`);
  }

  git(dir, ["checkout", "-q", "--detach", commit]);
  // Remove files left over from a previous checkout so the tree matches the
  // commit exactly; a stale untracked file would change what gets scored.
  git(dir, ["clean", "-qxfd"]);
  return { dir, commit };
}

/** Compute the canonical tree hash via the shared implementation. */
export function treeHash(dir, commit = "HEAD") {
  const script = path.join(SCRIPT_DIR, "tree_hash.py");
  const result = spawnSync("python3", [script, "--repo-root", dir, "--commit", commit], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tree_hash failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Verify the checked-out tree matches what the proposal committed to.
 *
 * Git's own object model already ties the tree to the commit id; this is the
 * independent SHA-256 commitment that keeps a SHA-1 collision from being
 * enough to swap the code on its own.
 */
export function verifyTreeHash({ dir, commit = "HEAD", expected }) {
  const actual = treeHash(dir, commit);
  const want = String(expected || "").toLowerCase().replace(/^0x/, "");
  if (!want) throw new Error("expected tree hash is empty");
  if (actual !== want) {
    throw new Error(`tree hash mismatch: expected ${want}, got ${actual}`);
  }
  return actual;
}

/** Fetch, check out, and verify in one step. */
export function materialize({ dir, remote, commit, treeHash: expected, depth = 1 }) {
  fetchCommit({ dir, remote, commit, depth });
  const verified = expected ? verifyTreeHash({ dir, commit, expected }) : treeHash(dir, commit);
  return { dir, commit, treeHash: verified };
}

export function remoteUrlFor({ host = "github.com", owner, repo }) {
  if (!owner || !repo) throw new Error("owner and repo are required");
  return `https://${host}/${owner}/${repo}.git`;
}

/**
 * Canonical "<host>/<owner>/<repo>" for a git remote.
 *
 * The chain stores sha256 of this string rather than a URL, so a project is one
 * identity however a participant reaches it. Must stay byte-identical to
 * `repo_identity.py`; `test/repo_identity.test.mjs` pins the two together.
 *
 * The whole string is lower-cased, not just the host: git hosts treat owner and
 * repository names case-insensitively, so lower-casing only the host would give
 * a project published as `Owner/Repo` a different id from the one a miner
 * typing `owner/repo` computes, and nothing would ever match.
 */
export function canonicalRepo(url) {
  const value = String(url || "").trim();
  if (!value) throw new Error("remote url is empty");

  let host;
  let pathPart;
  if (!value.includes("://")) {
    // scp-style (git@host:owner/repo) has no scheme, so URL() cannot parse it.
    const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    if (!match) throw new Error(`cannot derive repo identity from remote '${url}'`);
    host = match[1];
    pathPart = match[2];
  } else {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`cannot derive repo identity from remote '${url}'`);
    }
    host = parsed.hostname;
    pathPart = parsed.pathname;
  }

  host = host.split("@").pop().replace(/:\d+$/, "");
  pathPart = pathPart.replace(/^\/+|\/+$/g, "");
  if (pathPart.endsWith(".git")) pathPart = pathPart.slice(0, -".git".length);

  if (!host || !pathPart) throw new Error(`cannot derive repo identity from remote '${url}'`);
  return `${host}/${pathPart}`.toLowerCase();
}

export function repoIdentity(url) {
  const canonical = canonicalRepo(url);
  return {
    canonical,
    repoId: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}
