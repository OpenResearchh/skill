#!/usr/bin/env bash
# Run a protocol's benchmark repeatedly and reduce the repeats to one score.
#
# Usage:
#   run_measured_trials.sh <protocol.json> <repo_root> --out <samples.json>
#                          [--warmup-trials N] [--measured-trials N]
#                          [--aggregator median|mean|min|max] [--run-dir DIR]
#
# Sampling defaults come from measurement.sampling in the protocol; the flags
# above override them. Warm-up trials are executed and discarded so that cold
# caches and JIT warmup do not land in the score. Each measured trial is a
# fresh run_baseline.sh invocation, so no state carries between them.
#
# Exit codes:
#   0  samples written; AGGREGATE_METRIC=<value> printed on stdout
#   1  a trial failed, or its metric could not be extracted
#   2  usage error
#   4  measured dispersion exceeded measurement.sampling.maxRelativeStdDev
#
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_log.sh
source "$SCRIPT_DIR/_log.sh"

usage() {
  echo "Usage: $0 <protocol.json> <repo_root> --out <samples.json> [--warmup-trials N] [--measured-trials N] [--aggregator NAME] [--run-dir DIR]" >&2
  exit 2
}

[[ ${1-} ]] && [[ ${2-} ]] || usage
PROTOCOL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
REPO_ROOT=$(cd "$2" && pwd)
shift 2

OUT=""
WARMUP=""
MEASURED=""
AGGREGATOR=""
RUN_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT=${2:?}; shift ;;
    --warmup-trials) WARMUP=${2:?}; shift ;;
    --measured-trials) MEASURED=${2:?}; shift ;;
    --aggregator) AGGREGATOR=${2:?}; shift ;;
    --run-dir) RUN_DIR=${2:?}; shift ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
  shift
done

if ! command -v jq >/dev/null 2>&1; then
  log_fail "jq is required (brew install jq / apt install jq)."
  exit 2
fi
[[ -f "$PROTOCOL" ]] || { log_fail "protocol not found: $PROTOCOL"; exit 2; }

# Protocol values first, flags override. Keep these defaults in step with
# measurement.sampling in protocol.schema.json.
P_WARMUP=$(jq -r '.measurement.sampling.warmupTrials // 1' "$PROTOCOL")
P_MEASURED=$(jq -r '.measurement.sampling.measuredTrials // 5' "$PROTOCOL")
P_AGG=$(jq -r '.measurement.sampling.aggregator // "median"' "$PROTOCOL")
P_MAXCV=$(jq -r '.measurement.sampling.maxRelativeStdDev // empty' "$PROTOCOL")

WARMUP=${WARMUP:-$P_WARMUP}
MEASURED=${MEASURED:-$P_MEASURED}
AGGREGATOR=${AGGREGATOR:-$P_AGG}

[[ "$WARMUP" =~ ^[0-9]+$ ]] || { log_fail "--warmup-trials must be a non-negative integer"; exit 2; }
[[ "$MEASURED" =~ ^[0-9]+$ ]] && [[ "$MEASURED" -ge 1 ]] || { log_fail "--measured-trials must be >= 1"; exit 2; }
[[ -n "$OUT" ]] || { log_fail "--out is required"; exit 2; }

RUN_DIR=${RUN_DIR:-$REPO_ROOT/.autoresearch/measured/$$}
mkdir -p "$RUN_DIR"
mkdir -p "$(dirname "$OUT")"

log_section "measured trials"
log_detail "warmup:   $WARMUP"
log_detail "measured: $MEASURED"
log_detail "reduce:   $AGGREGATOR"
log_detail "runs:     $RUN_DIR"

# Run one trial; echo its extracted metric on success.
run_one() {
  local label=$1
  local log_path="$RUN_DIR/$label.log"
  local out
  set +e
  out=$(bash "$SCRIPT_DIR/run_baseline.sh" "$PROTOCOL" "$REPO_ROOT" --log "$log_path" 2>&1)
  local rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    printf '%s\n' "$out" >&2
    log_fail "$label failed (exit $rc)"
    return 1
  fi
  # run_baseline.sh prints BASELINE_METRIC=<value> once the regex matched.
  local metric
  metric=$(printf '%s\n' "$out" | grep -E '^BASELINE_METRIC=' | tail -n 1 | cut -d= -f2-)
  if [[ -z "$metric" ]]; then
    printf '%s\n' "$out" >&2
    log_fail "$label produced no metric"
    return 1
  fi
  printf '%s\n' "$metric"
}

for ((i = 1; i <= WARMUP; i++)); do
  log_detail "warmup $i/$WARMUP (discarded)"
  if ! run_one "warmup-$i" >/dev/null; then
    exit 1
  fi
done

SAMPLES=()
for ((i = 1; i <= MEASURED; i++)); do
  log_detail "measured $i/$MEASURED"
  metric=$(run_one "measured-$i") || exit 1
  log_ok "measured $i/$MEASURED metric=$metric"
  SAMPLES+=("$metric")
done

AGG_ARGS=(--samples "${SAMPLES[@]}" --aggregator "$AGGREGATOR" --out "$OUT")
if [[ -n "$P_MAXCV" ]]; then
  AGG_ARGS+=(--max-relative-stddev "$P_MAXCV")
fi

set +e
REPORT=$(python3 "$SCRIPT_DIR/aggregate_samples.py" "${AGG_ARGS[@]}")
AGG_RC=$?
set -e

if [[ "$AGG_RC" -ne 0 ]] && [[ "$AGG_RC" -ne 4 ]]; then
  log_fail "aggregation failed (exit $AGG_RC)"
  exit 1
fi

AGGREGATE=$(printf '%s' "$REPORT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["aggregate"])')
CV=$(printf '%s' "$REPORT" | python3 -c 'import json,sys; v=json.load(sys.stdin)["cv"]; print("n/a" if v is None else f"{v:.4f}")')

# Publish one representative run as stdout.log: the measured trial whose metric
# is closest to the aggregate. Downstream consumers treat that path as the
# benchmark log for a trial — it is the evidence attached to a proposal and the
# log the legacy verifier parses — so it must keep pointing at a real run.
# With the default median of an odd sample this is exactly the scored trial.
REP_INDEX=$(python3 -c '
import sys
agg = float(sys.argv[1])
vals = [float(v) for v in sys.argv[2:]]
print(min(range(len(vals)), key=lambda i: abs(vals[i] - agg)) + 1)
' "$AGGREGATE" "${SAMPLES[@]}")
cp "$RUN_DIR/measured-$REP_INDEX.log" "$RUN_DIR/stdout.log"
python3 - "$OUT" "$REP_INDEX" "$WARMUP" "$MEASURED" <<'PY'
import json, sys
out, rep, warmup, measured = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
with open(out, encoding="utf-8") as f:
    report = json.load(f)
report["representativeTrial"] = rep
report["representativeLog"] = f"measured-{rep}.log"
report["warmupTrials"] = warmup
report["measuredTrials"] = measured
with open(out, "w", encoding="utf-8") as f:
    f.write(json.dumps(report, sort_keys=True) + "\n")
PY

log_section "measured trials · result"
log_detail "samples: ${SAMPLES[*]}"
log_detail "cv:      $CV"

if [[ "$AGG_RC" -eq 4 ]]; then
  log_fail "dispersion exceeded measurement.sampling.maxRelativeStdDev; not scoring this run"
  echo "AGGREGATE_METRIC=$AGGREGATE"
  exit 4
fi

log_ok "aggregate=$AGGREGATE ($AGGREGATOR of $MEASURED)"
echo "AGGREGATE_METRIC=$AGGREGATE"
