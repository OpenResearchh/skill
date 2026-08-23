#!/usr/bin/env bash
# Create and checkout mine/<protocolBundleId>/hypothesis-<slug>-<trial_id>.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_git_safe.sh
source "$SCRIPT_DIR/_git_safe.sh"

usage() {
  echo "Usage: $0 <protocol.json> <repo_root> <trial_id> <hypothesis_slug>" >&2
  exit 1
}

[[ ${4:-} ]] || usage
PROTOCOL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO_ROOT=$(cd "$2" && pwd)
TRIAL_ID=$3
RAW_SLUG=$4

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

BUNDLE=$(jq -r '.meta.protocolBundleId // "unknown-bundle"' "$PROTOCOL")
SLUG=$(printf '%s' "$RAW_SLUG" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-' | sed 's/^-//; s/-$//')
if [[ -z "$SLUG" ]]; then
  SLUG="candidate"
fi

BRANCH="mine/${BUNDLE}/hypothesis-${SLUG}-${TRIAL_ID}"
git -C "$REPO_ROOT" checkout -B "$BRANCH"
printf '%s\n' "$BRANCH"
