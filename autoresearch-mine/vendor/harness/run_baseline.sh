#!/usr/bin/env bash
# Run a finalized protocol's setup + main command inside a sandbox and extract the metric.
#
# Usage:
#   run_baseline.sh <protocol.json> <repo_root> [--dry-run] [--log baseline_run.log]
#
# All command execution is delegated to run_in_sandbox.sh. The host shell never
# evaluates protocol-supplied strings except as argv to the sandbox. Setup
# commands and the main command are executed inside a separate child runtime
# with no host env passthrough, default-deny network, and resource caps.
#
# Knobs (env):
#   ARAH_SANDBOX             auto|podman|docker|bwrap|none
#   ARAH_SANDBOX_IMAGE       container image when using docker/podman
#   ARAH_SANDBOX_CPUS        --cpus value (default 2)
#   ARAH_SANDBOX_MEMORY      --memory value (default 4g)
#   ARAH_SANDBOX_PIDS        --pids-limit (default 256)
#   ARAH_SANDBOX_LOG_BYTES   tail bytes scanned for metric (default 65536)
#   ARAH_SANDBOX_ALLOW_UNSAFE=1 + ARAH_SANDBOX=none to opt into host-mode (NOT recommended)
#
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_log.sh
source "$SCRIPT_DIR/_log.sh"

usage() {
  echo "Usage: $0 <protocol.json> <repo_root> [--dry-run] [--log FILE]" >&2
  exit 1
}

[[ ${1-} ]] && [[ ${2-} ]] || usage
PROTOCOL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO_ROOT=$(cd "$2" && pwd)
shift 2

DRY_RUN=0
LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --log) LOG_FILE=${2:?}; shift ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
  shift
done

if ! command -v jq >/dev/null 2>&1; then
  log_fail "jq is required (brew install jq / apt install jq)."
  exit 1
fi

if [[ ! -f "$PROTOCOL" ]]; then
  log_fail "protocol not found: $PROTOCOL"
  exit 1
fi

SKIND=$(jq -r '.schemaKind // empty' "$PROTOCOL")
if [[ "$SKIND" != "protocol" ]]; then
  log_fail "protocol.json must have schemaKind \"protocol\" (got: ${SKIND:-missing})."
  exit 1
fi

REL_CWD=$(jq -r '.execution.cwd // "."' "$PROTOCOL")
HARD=$(jq -r '.execution.hardTimeoutSeconds // 0' "$PROTOCOL")
HARD=$(printf '%.0f' "$HARD")
MAIN_CMD=$(jq -r '.execution.command // empty' "$PROTOCOL")
NET_POLICY=$(jq -r '.environment.constraints.networkPolicy // "sandbox"' "$PROTOCOL")

if [[ -z "$MAIN_CMD" ]]; then
  log_fail "execution.command is empty."
  exit 1
fi

WORKDIR="$REPO_ROOT"
if [[ -z "$LOG_FILE" ]]; then
  LOG_FILE="$REPO_ROOT/$REL_CWD/baseline_run.log"
fi

# Translate protocol networkPolicy -> sandbox flag.
# Fail closed on unknown / unspecified; require an explicit operator opt-in for `full`
# because we do not yet enforce environment.constraints.networkAllowlist on egress.
case "$NET_POLICY" in
  sandbox|offline|unknown) SBX_NETWORK="none" ;;
  full)
    if [[ -z "${ARAH_ALLOW_FULL_NETWORK:-}" ]]; then
      log_fail "protocol declares networkPolicy=full but ARAH_ALLOW_FULL_NETWORK is not set."
      log_fail "The harness does not yet enforce environment.constraints.networkAllowlist;"
      log_fail "set ARAH_ALLOW_FULL_NETWORK=1 to opt into bridged egress on this host."
      exit 1
    fi
    SBX_NETWORK="bridge"
    ;;
  *) log_fail "invalid environment.constraints.networkPolicy: $NET_POLICY"; exit 1 ;;
esac

# Sandbox knobs: env var > protocol environment.sandbox > harness default.
# environment.sandbox is part of protocolHash, so miner and verifier read the
# same defaults and produce the same metric absent local overrides.
PROTO_IMAGE=$(jq -r '.environment.sandbox.image // empty' "$PROTOCOL")
PROTO_CPUS=$(jq -r '.environment.sandbox.cpus // empty' "$PROTOCOL")
PROTO_MEMORY=$(jq -r '.environment.sandbox.memory // empty' "$PROTOCOL")
PROTO_PIDS=$(jq -r '.environment.sandbox.pids // empty' "$PROTOCOL")

# Warn (but don't fail) when the protocol pinned an image by tag rather than
# digest; mismatched tag content between miner/verifier silently breaks
# reproducibility. Digest pins look like `name@sha256:<64hex>`.
if [[ -n "$PROTO_IMAGE" ]] && [[ "$PROTO_IMAGE" != *"@sha256:"* ]]; then
  log_detail "warning: environment.sandbox.image is tag-pinned ($PROTO_IMAGE); for reproducibility prefer name@sha256:<digest>."
fi

IMAGE=${ARAH_SANDBOX_IMAGE:-${PROTO_IMAGE:-docker.io/library/debian:stable-slim}}
CPUS=${ARAH_SANDBOX_CPUS:-${PROTO_CPUS:-2}}
MEMORY=${ARAH_SANDBOX_MEMORY:-${PROTO_MEMORY:-4g}}
PIDS=${ARAH_SANDBOX_PIDS:-${PROTO_PIDS:-256}}
LOG_BYTES=${ARAH_SANDBOX_LOG_BYTES:-65536}

log_section "baseline"
log_detail "workdir: $WORKDIR  cwd: $REL_CWD"
log_detail "log:     $LOG_FILE"
log_detail "image:   $IMAGE"
log_detail "timeout: ${HARD}s   network: $SBX_NETWORK   sandbox knobs: cpus=$CPUS mem=$MEMORY pids=$PIDS"

# Read setup commands. Each entry is either a JSON string (legacy free-form
# shell) or a structured object {kind: "...", args: [...]}. Structured kinds
# are mapped to a fixed argv to keep the protocol from injecting flags into
# host tools.
SETUP_ARGV_FILE=$(mktemp)
trap 'rm -f "$SETUP_ARGV_FILE"' EXIT

python3 - "$PROTOCOL" >"$SETUP_ARGV_FILE" <<'PY'
import json
import shlex
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    proto = json.load(f)
items = (proto.get("environment") or {}).get("setupCommands") or []

ALLOWED = {
    "pip":   ["python3", "-m", "pip"],
    "uv":    ["uv"],
    "npm":   ["npm"],
    "pnpm":  ["pnpm"],
    "yarn":  ["yarn"],
    "cargo": ["cargo"],
    "make":  ["make"],
    "bash":  ["bash", "-c"],
    "sh":    ["sh", "-c"],
}

for entry in items:
    if isinstance(entry, str):
        # Legacy free-form shell — wrap in `bash -c` so it still routes
        # through the sandbox without re-evaluating on the host.
        argv = ["bash", "-c", entry]
    elif isinstance(entry, dict):
        kind = entry.get("kind")
        args = entry.get("args") or []
        if kind not in ALLOWED:
            print(f"ERR unknown setupCommand kind: {kind!r}", file=sys.stderr)
            sys.exit(2)
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            print(f"ERR setupCommand.args must be list[str] (kind={kind})", file=sys.stderr)
            sys.exit(2)
        argv = ALLOWED[kind] + args
    else:
        print(f"ERR setupCommand entries must be str or object, got {type(entry).__name__}", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(argv))
PY

# Each line in $SETUP_ARGV_FILE is a JSON array — one command argv per line.

# Per-trial seed. When the protocol derives the seed from the candidate's own
# mutable surface, the evaluation inputs move whenever the code moves, so a
# candidate cannot be tuned against a fixed set of inputs. Miner and verifier
# derive the same seed from the same bytes, so the run stays reproducible.
SEED_ENV=()
SEED_MODE=$(jq -r '.execution.determinism.seedDerivation.mode // "none"' "$PROTOCOL")
if [[ "$SEED_MODE" != "none" ]]; then
  set +e
  SEED_KV=$(python3 "$SCRIPT_DIR/derive_trial_seed.py" \
    --protocol "$PROTOCOL" --repo-root "$REPO_ROOT" --print-env)
  SEED_RC=$?
  set -e
  case "$SEED_RC" in
    0) SEED_ENV=(--env "$SEED_KV"); log_detail "seed:    $SEED_KV (mode=$SEED_MODE)" ;;
    3) : ;; # protocol declares no seed after all
    *) log_fail "seed derivation failed (exit $SEED_RC)"; exit 1 ;;
  esac
fi

run_in_sandbox() {
  bash "$SCRIPT_DIR/run_in_sandbox.sh" \
    --workdir "$WORKDIR" \
    --cwd "$REL_CWD" \
    --timeout "$HARD" \
    --cpus "$CPUS" \
    --memory "$MEMORY" \
    --pids "$PIDS" \
    --network "$SBX_NETWORK" \
    --image "$IMAGE" \
    "${SEED_ENV[@]+"${SEED_ENV[@]}"}" \
    -- "$@"
}

extract_metric() {
  local log_path=$1
  python3 - "$PROTOCOL" "$log_path" "$LOG_BYTES" <<'PY'
import json, re, sys

proto_path, log_path, tail_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(proto_path, encoding="utf-8") as f:
    proto = json.load(f)
ext = proto["measurement"]["primaryMetric"]["extract"]
kind = ext.get("kind")
pattern = ext.get("pattern") or ""
with open(log_path, "rb") as f:
    f.seek(0, 2)
    size = f.tell()
    f.seek(max(0, size - tail_bytes), 0)
    text = f.read().decode("utf-8", errors="replace")
if kind != "regex":
    print("extract kind is not regex; inspect log manually.", file=sys.stderr)
    sys.exit(2)
m = re.search(pattern, text, re.MULTILINE)
if not m:
    print("primary metric regex did not match log tail.", file=sys.stderr)
    sys.exit(3)
val = m.group(1) if m.lastindex else m.group(0)
print(val)
PY
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  log_section "baseline · dry run"
  setup_count=$(grep -c '' "$SETUP_ARGV_FILE" || true)
  log_detail "would run $setup_count setup command(s) inside sandbox"
  log_detail "would run main command inside sandbox: $MAIN_CMD"
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

# Setup pass — never tee to LOG_FILE; setup output is informational only and the
# metric regex must match the main command's stdout.
if [[ -s "$SETUP_ARGV_FILE" ]]; then
  setup_count=$(grep -c '' "$SETUP_ARGV_FILE" || true)
  log_section "baseline · setup ($setup_count command(s))"
  i=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    i=$((i + 1))
    log_detail "[$i/$setup_count] $line"
    # Each line is a JSON array; reparse into an array.
    mapfile -t ARGV < <(python3 -c 'import json,sys; [print(x) for x in json.loads(sys.argv[1])]' "$line")
    set +e
    run_in_sandbox "${ARGV[@]}"
    rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      log_fail "setup command failed (exit $rc): $line"
      exit "$rc"
    fi
  done < "$SETUP_ARGV_FILE"
fi

log_section "baseline · run (timeout ${HARD}s)"
log_detail "main: $MAIN_CMD"
log_detail "(streaming to $LOG_FILE)"

set +e
run_in_sandbox bash -c "$MAIN_CMD" 2>&1 | tee "$LOG_FILE"
EXIT_MAIN=${PIPESTATUS[0]}
set -e

# Truncate captured log if it exploded (defense-in-depth; sandbox already caps).
if command -v stat >/dev/null 2>&1; then
  size=$(wc -c <"$LOG_FILE" || echo 0)
  if [[ "$size" -gt $((LOG_BYTES * 32)) ]]; then
    tmp=$(mktemp)
    tail -c "$((LOG_BYTES * 16))" "$LOG_FILE" >"$tmp"
    mv "$tmp" "$LOG_FILE"
    log_detail "log truncated to last $((LOG_BYTES * 16)) bytes (was $size)"
  fi
fi

log_section "baseline · result"
METRIC=""
if [[ "$EXIT_MAIN" -eq 0 ]]; then
  if METRIC=$(extract_metric "$LOG_FILE" 2>/tmp/baseline_extract_err.$$); then
    log_ok "exit 0   metric=$METRIC"
    echo "BASELINE_METRIC=$METRIC"
  else
    log_fail "exit 0 but metric not extractable: $(cat /tmp/baseline_extract_err.$$ 2>/dev/null)"
  fi
  rm -f /tmp/baseline_extract_err.$$
else
  log_fail "main command failed (exit $EXIT_MAIN); skipping metric extraction."
fi

exit "$EXIT_MAIN"
