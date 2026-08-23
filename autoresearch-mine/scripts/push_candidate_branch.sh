#!/usr/bin/env bash
# Publish a winning trial commit to the project repo as a candidate branch.
#
# Under the git-primary artifact model the commits *are* the artifact: a
# proposal references base_commit -> head_commit plus a tree_hash, and there is
# nothing to pack or upload. That only works if the verifier can fetch the
# commit, so the miner has to push it somewhere the verifier can reach before
# the proposal is submitted.
#
# This script is deliberately narrow. It publishes one commit under a branch
# name that nobody else can collide with, and it refuses every operation that
# could destroy someone else's work:
#
#   - never force-pushes, and never builds a `+refspec`
#   - refuses a branch that already exists pointing at different content
#     (re-pushing the identical commit is a no-op and succeeds, so the mining
#     loop can retry without special-casing)
#   - refuses a dirty tree, because the proposal commits to the tree at a
#     commit and an uncommitted edit means the miner is measuring something
#     the verifier will never see
#   - only speaks https / ssh, matching the transport allowlist in
#     scripts/git_artifacts.mjs; file:// and git:// do not authenticate the
#     server and ext:: executes a command
#
# Miners do not open pull requests. Verifiers merge accepted work; this branch
# is how the work becomes fetchable, not a request to merge it.
#
# Usage:
#   push_candidate_branch.sh --repo-root <path> --trial-id <id> --miner-id <id>
#                            [--remote <name|url>] [--commit <ref>]
#                            [--branch-prefix <prefix>] [--token-env <VAR>]
#                            [--dry-run]
#
# Exit codes:
#   0  pushed (or already published with identical content, or --dry-run)
#   1  usage error
#   2  not a git repo, dirty tree, or unresolvable commit
#   3  remote rejected by the transport allowlist
#   4  branch already exists on the remote with different content
#   5  push failed
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_git_safe.sh
source "$SCRIPT_DIR/_git_safe.sh"

# _git_safe.sh sets this already; restate it so the guarantee is local and
# survives anyone reordering the source line.
export GIT_TERMINAL_PROMPT=0

REPO_ROOT=""
TRIAL_ID=""
MINER_ID="${ARAH_MINER_ID:-}"
REMOTE="${ARAH_PUSH_REMOTE:-origin}"
COMMIT="HEAD"
BRANCH_PREFIX="${ARAH_CANDIDATE_PREFIX:-openresearch/candidate}"
TOKEN_ENV=""
DRY_RUN=0

usage() {
  cat >&2 <<'USAGE'
Usage:
  push_candidate_branch.sh --repo-root <path> --trial-id <id> --miner-id <id>
                           [--remote <name|url>] [--commit <ref>]
                           [--branch-prefix <prefix>] [--token-env <VAR>]
                           [--dry-run]

Publishes one commit to the project repo as a candidate branch so a verifier
can fetch it. Never force-pushes and never opens a pull request.

Exit codes:
  0  pushed (or already published with identical content, or --dry-run)
  1  usage error
  2  not a git repo, dirty tree, or unresolvable commit
  3  remote rejected by the transport allowlist
  4  branch already exists on the remote with different content
  5  push failed
USAGE
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?--repo-root requires a value}"; shift ;;
    --trial-id) TRIAL_ID="${2:?--trial-id requires a value}"; shift ;;
    --miner-id) MINER_ID="${2:?--miner-id requires a value}"; shift ;;
    --remote) REMOTE="${2:?--remote requires a value}"; shift ;;
    --commit) COMMIT="${2:?--commit requires a value}"; shift ;;
    --branch-prefix) BRANCH_PREFIX="${2:?--branch-prefix requires a value}"; shift ;;
    --token-env) TOKEN_ENV="${2:?--token-env requires a value}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
  shift
done

[[ -n "$REPO_ROOT" ]] || { echo "--repo-root is required" >&2; usage; }
[[ -n "$TRIAL_ID" ]] || { echo "--trial-id is required" >&2; usage; }
if [[ -z "$MINER_ID" ]]; then
  echo "--miner-id (or ARAH_MINER_ID) is required: the branch name carries the" >&2
  echo "miner identity so two miners working the same trial cannot collide" >&2
  usage
fi

REPO_ROOT=$(cd "$REPO_ROOT" 2>/dev/null && pwd) || {
  echo "repo root not found" >&2
  exit 2
}

if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository: $REPO_ROOT" >&2
  exit 2
fi

# Reduce a free-form identifier to something git will accept as one refname
# component: no slashes (they would forge extra path segments), no characters
# git rejects, no leading/trailing punctuation, no empty result.
slugify() {
  local value="$1"
  value=$(printf '%s' "$value" | tr -c 'A-Za-z0-9._-' '-')
  # `..` and `@{` are refname syntax, not text; collapse dot runs before the
  # generic squeeze so "a/../b" cannot smuggle a revision range into the name.
  value=$(printf '%s' "$value" | sed -e 's/\.\{2,\}/-/g' -e 's/-\{2,\}/-/g' -e 's/^[-._]*//' -e 's/[-._]*$//')
  printf '%s' "$value"
}

MINER_SLUG=$(slugify "$MINER_ID")
TRIAL_SLUG=$(slugify "$TRIAL_ID")
[[ -n "$MINER_SLUG" ]] || { echo "--miner-id has no usable characters" >&2; exit 1; }
[[ -n "$TRIAL_SLUG" ]] || { echo "--trial-id has no usable characters" >&2; exit 1; }

# A tracked-file diff means the measured tree is not the committed tree, so the
# commit this would publish is not the code that produced the metric.
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]]; then
  echo "repo has uncommitted tracked changes; commit the winning trial first" >&2
  exit 2
fi

HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse --verify "${COMMIT}^{commit}" 2>/dev/null) || {
  echo "cannot resolve commit: $COMMIT" >&2
  exit 2
}

# The short sha makes the name content-derived: re-running the same trial with
# different code lands on a different branch instead of quietly replacing the
# earlier candidate, which is what makes "never force-push" a usable rule.
SHORT_SHA=${HEAD_SHA:0:12}
BRANCH="${BRANCH_PREFIX}/${MINER_SLUG}/${TRIAL_SLUG}-${SHORT_SHA}"

# Final guard: let git itself reject anything the slug rules missed, rather
# than discovering it as a confusing server-side error mid-push.
if ! git check-ref-format "refs/heads/${BRANCH}"; then
  echo "computed branch name is not a valid refname: $BRANCH" >&2
  exit 1
fi

# Accept a remote name and resolve it, or take a URL directly.
REMOTE_URL="$REMOTE"
if git -C "$REPO_ROOT" remote get-url "$REMOTE" >/dev/null 2>&1; then
  REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url "$REMOTE")
fi

# Same allowlist as scripts/git_artifacts.mjs: only transports that
# authenticate the server, and nothing that can execute a command.
case "$REMOTE_URL" in
  https://*|ssh://*|git@*) : ;;
  *)
    echo "refusing remote '$REMOTE_URL': only https, ssh, or scp-style git remotes are allowed" >&2
    exit 3
    ;;
esac
case "$REMOTE_URL" in
  ext::*|*--upload-pack*|*--receive-pack*)
    echo "refusing remote '$REMOTE_URL': transport would execute a command" >&2
    exit 3
    ;;
esac

GIT_PUSH=(git -C "$REPO_ROOT")
if [[ -n "$TOKEN_ENV" ]]; then
  # _git_safe.sh drops the global git config, which removes any credential
  # helper, so an https push needs a token. Feed it through a helper that reads
  # the environment rather than embedding it in the URL, so the secret never
  # reaches argv, .git/config, or this script's output.
  if [[ -z "${!TOKEN_ENV:-}" ]]; then
    echo "--token-env $TOKEN_ENV is empty" >&2
    exit 1
  fi
  export GIT_PUSH_TOKEN="${!TOKEN_ENV}"
  GIT_PUSH+=(-c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_PUSH_TOKEN"; }; f')
fi

# ls-remote is the only way to know whether this name is already taken. It also
# makes the common retry case (identical commit already published) succeed
# without a push, which keeps the unattended loop idempotent.
EXISTING=""
if REMOTE_REFS=$("${GIT_PUSH[@]}" ls-remote --heads "$REMOTE_URL" "refs/heads/${BRANCH}" 2>/dev/null); then
  EXISTING=$(printf '%s\n' "$REMOTE_REFS" | awk 'NR==1{print $1}')
fi

if [[ -n "$EXISTING" && "$EXISTING" != "$HEAD_SHA" ]]; then
  echo "branch already exists on the remote with different content: $BRANCH" >&2
  echo "remote=$EXISTING local=$HEAD_SHA" >&2
  echo "not force-pushing; commit again or pass a different --trial-id" >&2
  exit 4
fi

echo "remote=$REMOTE"
echo "branch=$BRANCH"
echo "head_sha=$HEAD_SHA"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry_run=1 (nothing pushed)"
  exit 0
fi

if [[ -n "$EXISTING" ]]; then
  echo "already_published=1"
  exit 0
fi

# No leading '+' and no --force: a non-fast-forward is a hard failure, and the
# ls-remote check above already refused the fast-forward-over-someone-else case.
if ! "${GIT_PUSH[@]}" push --no-verify "$REMOTE_URL" "${HEAD_SHA}:refs/heads/${BRANCH}"; then
  echo "push failed" >&2
  exit 5
fi

echo "pushed=1"
exit 0
