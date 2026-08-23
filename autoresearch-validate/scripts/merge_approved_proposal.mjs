#!/usr/bin/env node
// Merge an approved proposal into the project repository.
//
// The on-chain verifier allowlist is also the merge authority: the address that
// approved a proposal is the identity that merges it. There is no separate bot
// holding write credentials, so there is no actor whose compromise moves code
// without also being able to move money.
//
// Two rules this script exists to enforce:
//
//   1. Approval is final; the merge is not a settlement input. On-chain state
//      is already committed and the miner is already paid by the time this
//      runs, so a merge that cannot happen — a conflict, or a project repo
//      owned by a third party the verifier cannot write to — is reported as
//      approved-but-unmerged. It never fails the settlement, because a
//      settlement that can be undone by a GitHub outcome is worse than one
//      that occasionally has no merge commit to point at.
//
//   2. Never squash. The miner's commits and their authorship are the
//      contribution record; a squash erases both. This merges through the
//      merge API, which always writes a merge commit and keeps history.
//
// The result is printed as JSON so the caller can pass `mergedCommit` to
// `record_merge` on-chain.
//
// SECURITY: the GitHub token this reads is write access to the project
// repository. The same process also runs untrusted miner code. Never export
// the token into a sandbox, a harness environment, or a git subprocess — this
// script talks to the REST API only, and the token never leaves it.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const USER_AGENT = "autoresearch-validate";
const API_VERSION = "2022-11-28";

// Reported in `reason` when no merge commit was produced. Each of these is a
// normal, non-fatal outcome of an already-final approval.
const UNMERGED_REASONS = {
  ALREADY_MERGED: "already_merged",
  HEAD_MOVED: "head_moved",
  MERGE_CONFLICT: "merge_conflict",
  NO_WRITE_ACCESS: "no_write_access",
  DRY_RUN: "dry_run",
  API_ERROR: "api_error",
};

function usage() {
  console.log(`Usage:
  node scripts/merge_approved_proposal.mjs \\
    --proposal-id 7 \\
    --repo-url https://github.com/owner/project \\
    --commit <approved head sha> \\
    --yes

Options:
  --repo-url <url>       Project repository. Defaults to ARAH_PROJECT_REPO.
  --commit <sha>         The head commit that was approved on-chain (full 40-char sha).
  --base <branch>        Branch to merge into. Defaults to the repository's default branch.
  --head-ref <ref>       Branch the miner pushed. When given, its tip must still equal --commit.
  --pull-number <n>      Merge through this pull request instead of the merges API.
  --message <text>       Merge commit message. A default naming the proposal is used otherwise.
  --token-file <path>    Read the GitHub token from a file instead of the environment.
  --dry-run              Run every check, print the plan, merge nothing.
  --yes                  Required to perform a live merge.

Token: --token-file, else ARAH_GITHUB_TOKEN, GITHUB_TOKEN, or GH_TOKEN.
Least privilege is contents:write on this repository only (plus pull_requests:write
when --pull-number is used). It needs nothing else and must never be broader.

Exit codes:
  0  merged; mergedCommit is in the JSON result
  2  usage or configuration error (nothing was attempted)
  3  approved but not merged — a reported, non-fatal outcome
`);
}

function parseArgs(argv) {
  const options = {};
  const boolKeys = new Set(["help", "yes", "dryRun"]);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) throw new Error(`unexpected argument: ${raw}`);
    const key = raw.slice(2).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
    if (boolKeys.has(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${raw} requires a value`);
    options[key] = value;
    i += 1;
  }
  return options;
}

class UsageError extends Error {}

/** Split a git remote into host/owner/repo. */
function parseRepoRef(url) {
  const value = String(url || "").trim().replace(/\/+$/, "");
  let host = "";
  let rest = "";
  let match;
  if ((match = /^https?:\/\/([^/]+)\/(.+)$/.exec(value))) {
    [, host, rest] = match;
  } else if ((match = /^ssh:\/\/([^/]+)\/(.+)$/.exec(value))) {
    [, host, rest] = match;
  } else if ((match = /^[^@/]+@([^:]+):(.+)$/.exec(value))) {
    [, host, rest] = match;
  } else {
    throw new UsageError(`cannot parse git remote '${url}'`);
  }
  host = host.replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
  const parts = rest.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) throw new UsageError(`git remote '${url}' has no owner/name`);
  const repo = parts.pop();
  const owner = parts.join("/");
  return { host, owner, repo };
}

function apiBaseFor(host) {
  if (host === "github.com" || host === "www.github.com") return "https://api.github.com";
  return `https://${host}/api/v3`;
}

function readToken(options) {
  if (options.tokenFile) {
    const file = path.resolve(options.tokenFile);
    if (!fs.existsSync(file)) throw new UsageError(`--token-file not found: ${file}`);
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value) throw new UsageError(`--token-file is empty: ${file}`);
    return value;
  }
  const value = (
    process.env.ARAH_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim();
  if (!value) {
    throw new UsageError(
      "no GitHub token: set ARAH_GITHUB_TOKEN (or GITHUB_TOKEN / GH_TOKEN) or pass --token-file",
    );
  }
  return value;
}

function makeClient({ apiBase, token }) {
  return async function call(method, route, body) {
    const res = await fetch(`${apiBase}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": API_VERSION,
        "user-agent": USER_AGENT,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let payload = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 400) };
      }
    }
    return { status: res.status, ok: res.ok, payload };
  };
}

function unmerged({ reason, detail, context }) {
  return { merged: false, mergedCommit: null, reason, detail: detail || "", ...context };
}

/**
 * Confirm the code about to be merged is still the code that was approved.
 *
 * A branch name is mutable. If the miner repointed it after approval, merging
 * the branch would put code on the frontier that no verifier ever scored, so
 * the tip is re-read here rather than at claim time and the merge is abandoned
 * if it moved.
 */
async function assertHeadUnchanged({ call, owner, repo, commit, headRef }) {
  const target = headRef || commit;
  const res = await call("GET", `/repos/${owner}/${repo}/commits/${encodeURIComponent(target)}`);
  if (res.status === 404) {
    return { ok: false, reason: UNMERGED_REASONS.HEAD_MOVED, detail: `${target} not found in ${owner}/${repo}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: UNMERGED_REASONS.API_ERROR,
      detail: `GET commit ${target} failed (${res.status}): ${res.payload?.message || ""}`,
    };
  }
  const sha = String(res.payload?.sha || "").toLowerCase();
  if (sha !== commit) {
    return {
      ok: false,
      reason: UNMERGED_REASONS.HEAD_MOVED,
      detail: `${target} is now ${sha}, approved commit was ${commit}`,
    };
  }
  return { ok: true, sha };
}

/** Is the approved commit already contained in the base branch? */
async function alreadyMerged({ call, owner, repo, base, commit }) {
  const res = await call(
    "GET",
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${commit}`,
  );
  if (!res.ok) return { known: false };
  const status = String(res.payload?.status || "");
  // "identical" and "behind" both mean base already contains the commit.
  return { known: true, merged: status === "identical" || status === "behind" };
}

async function baseHeadSha({ call, owner, repo, base }) {
  const res = await call("GET", `/repos/${owner}/${repo}/commits/${encodeURIComponent(base)}`);
  return res.ok ? String(res.payload?.sha || "").toLowerCase() || null : null;
}

async function mergeViaPullRequest({ call, owner, repo, pullNumber, commit, message }) {
  // merge_method "merge" writes a merge commit; "squash" and "rebase" would
  // rewrite the miner's commits and drop their authorship.
  // `sha` makes GitHub itself reject the merge if the head moved since we read it.
  const res = await call("PUT", `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
    merge_method: "merge",
    sha: commit,
    commit_title: message,
  });
  if (res.ok && res.payload?.merged) {
    return { merged: true, mergedCommit: String(res.payload.sha || "").toLowerCase() };
  }
  if (res.status === 409) {
    const detail = String(res.payload?.message || "");
    return unmerged({
      reason: /head sha|sha.*match/i.test(detail)
        ? UNMERGED_REASONS.HEAD_MOVED
        : UNMERGED_REASONS.MERGE_CONFLICT,
      detail,
    });
  }
  if (res.status === 403 || res.status === 404) {
    return unmerged({
      reason: UNMERGED_REASONS.NO_WRITE_ACCESS,
      detail: res.payload?.message || `pull merge refused (${res.status})`,
    });
  }
  return unmerged({
    reason: UNMERGED_REASONS.API_ERROR,
    detail: `pull merge failed (${res.status}): ${res.payload?.message || ""}`,
  });
}

async function mergeViaMergesApi({ call, owner, repo, base, commit, message }) {
  // The merges API always produces a merge commit — there is no squash option
  // to get wrong — and it accepts a raw sha as head, so no mutable branch name
  // sits between the approved commit and what lands.
  const res = await call("POST", `/repos/${owner}/${repo}/merges`, {
    base,
    head: commit,
    commit_message: message,
  });
  if (res.status === 201) {
    return { merged: true, mergedCommit: String(res.payload?.sha || "").toLowerCase() };
  }
  if (res.status === 204) {
    // Nothing to merge: base already contains the commit.
    const sha = await baseHeadSha({ call, owner, repo, base });
    return unmerged({
      reason: UNMERGED_REASONS.ALREADY_MERGED,
      detail: "base already contains the approved commit",
      context: { baseHead: sha },
    });
  }
  if (res.status === 409) {
    return unmerged({
      reason: UNMERGED_REASONS.MERGE_CONFLICT,
      detail: res.payload?.message || "merge conflict",
    });
  }
  if (res.status === 403 || res.status === 404) {
    // The common upstream case: the project repo belongs to a third party and
    // the verifier has no write access. The protocol still paid the miner.
    return unmerged({
      reason: UNMERGED_REASONS.NO_WRITE_ACCESS,
      detail: res.payload?.message || `merge refused (${res.status})`,
    });
  }
  return unmerged({
    reason: UNMERGED_REASONS.API_ERROR,
    detail: `merge failed (${res.status}): ${res.payload?.message || ""}`,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  const proposalId = options.proposalId;
  if (proposalId === undefined) throw new UsageError("--proposal-id is required");
  const commit = String(options.commit || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new UsageError("--commit must be the full 40-character approved head sha");
  }
  const repoUrl = options.repoUrl || process.env.ARAH_PROJECT_REPO;
  if (!repoUrl) throw new UsageError("--repo-url is required (or set ARAH_PROJECT_REPO)");
  if (!options.dryRun && !options.yes) {
    throw new UsageError("refusing to merge without --yes (use --dry-run to rehearse)");
  }

  const { host, owner, repo } = parseRepoRef(repoUrl);
  const token = readToken(options);
  const call = makeClient({ apiBase: apiBaseFor(host), token });

  const repoInfo = await call("GET", `/repos/${owner}/${repo}`);
  if (!repoInfo.ok) {
    const result = unmerged({
      reason:
        repoInfo.status === 403 || repoInfo.status === 404
          ? UNMERGED_REASONS.NO_WRITE_ACCESS
          : UNMERGED_REASONS.API_ERROR,
      detail: `GET repo failed (${repoInfo.status}): ${repoInfo.payload?.message || ""}`,
    });
    return report({ proposalId, host, owner, repo, base: options.base || null, commit, result });
  }
  const base = options.base || repoInfo.payload?.default_branch;
  if (!base) throw new UsageError("cannot determine the base branch; pass --base");

  const context = { proposalId, host, owner, repo, base, commit };

  const already = await alreadyMerged({ call, owner, repo, base, commit });
  if (already.known && already.merged) {
    const sha = await baseHeadSha({ call, owner, repo, base });
    return report({
      ...context,
      result: unmerged({
        reason: UNMERGED_REASONS.ALREADY_MERGED,
        detail: `${base} already contains ${commit}`,
        context: { baseHead: sha },
      }),
    });
  }

  const head = await assertHeadUnchanged({ call, owner, repo, commit, headRef: options.headRef });
  if (!head.ok) {
    return report({ ...context, result: unmerged({ reason: head.reason, detail: head.detail }) });
  }

  const message =
    options.message ||
    `Merge OpenResearch proposal ${proposalId}\n\n` +
      `Approved on-chain by the verifier merging it. Candidate ${commit}.\n` +
      "Merge commit, not a squash: the miner's commits are the contribution record.";

  if (options.dryRun) {
    return report({
      ...context,
      result: unmerged({
        reason: UNMERGED_REASONS.DRY_RUN,
        detail: `would merge ${commit} into ${base} of ${owner}/${repo}`,
      }),
    });
  }

  const result = options.pullNumber
    ? await mergeViaPullRequest({
        call,
        owner,
        repo,
        pullNumber: options.pullNumber,
        commit,
        message,
      })
    : await mergeViaMergesApi({ call, owner, repo, base, commit, message });

  return report({ ...context, result });
}

function report({ proposalId, host, owner, repo, base, commit, result }) {
  const payload = {
    schemaVersion: "1",
    proposalId: String(proposalId),
    repo: `${host}/${owner}/${repo}`,
    base,
    approvedCommit: commit,
    ...result,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (result.merged) return 0;
  console.error(
    `proposal ${proposalId} approved but not merged (${result.reason}): ${result.detail}`,
  );
  return 3;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`merge failed: ${err.message}`);
    process.exit(2);
  },
);
