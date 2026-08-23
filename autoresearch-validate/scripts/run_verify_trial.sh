#!/usr/bin/env bash
# Run benchmark harness for verification (writes under .autoresearch/verify/runs/).
set -euo pipefail
export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_resolve_create_scripts.sh
CREATE_SCRIPTS_DIR=$("$SCRIPT_DIR/_resolve_create_scripts.sh") || exit 3

usage() {
  echo "Usage: $0 <protocol.json> <repo_root> <review_id>" >&2
  exit 2
}

[[ ${3:-} ]] || usage
PROTOCOL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO_ROOT=$(cd "$2" && pwd)
REVIEW_ID=$3

RUN_DIR="$REPO_ROOT/.autoresearch/verify/runs/$REVIEW_ID"
mkdir -p "$RUN_DIR"

# Score a repeated sample, not a single run. One run of a wall-clock or
# throughput benchmark is dominated by host noise, so a lone measurement
# cannot distinguish a real improvement from variance. Sampling counts come
# from measurement.sampling in the protocol.
exec bash "$CREATE_SCRIPTS_DIR/run_measured_trials.sh" "$PROTOCOL" "$REPO_ROOT" \
  --out "$RUN_DIR/samples.json" --run-dir "$RUN_DIR"
