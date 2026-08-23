#!/usr/bin/env python3
"""Decide whether a candidate metric beats a baseline by a required margin.

A bare `candidate < baseline` test treats measurement noise as discovery: on a
wall-clock or throughput benchmark, roughly half of all no-op changes "win" by
some margin. `--min-improvement-bips` sets the bar above the benchmark's noise
floor so only real movement counts. Pair it with repeated trials
(run_measured_trials.sh) so the compared values are aggregates, not single runs.

Exit 0 if candidate improves baseline by at least the required margin;
1 if not; 2 on error.
"""
from __future__ import annotations

import argparse
import json
import math
import sys

BIPS_PER_UNIT = 10_000
DEFAULT_MIN_IMPROVEMENT_BIPS = 100


def required_threshold(baseline: float, direction: str, bips: int) -> float:
    """Metric value a candidate must reach to count as an improvement.

    The margin is relative to the baseline's magnitude, so it behaves the same
    for a metric of 2.5 and one of 250000. A baseline of exactly zero has no
    relative scale, so the margin collapses to a strict improvement test.

    Reaching the threshold exactly counts: the margin is the minimum required
    improvement, not a value the candidate must exceed. With bips=0 the
    threshold is the baseline itself, and matching the baseline is not an
    improvement, so that case stays strict.
    """
    margin = abs(baseline) * (bips / BIPS_PER_UNIT)
    if direction == "minimize":
        return baseline - margin
    return baseline + margin


def beats_threshold(candidate: float, threshold: float, direction: str, bips: int) -> bool:
    if bips <= 0:
        # No margin configured: the candidate must strictly beat the baseline.
        return candidate < threshold if direction == "minimize" else candidate > threshold
    if direction == "minimize":
        return candidate <= threshold
    return candidate >= threshold


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--direction", choices=("minimize", "maximize"), required=True)
    p.add_argument("--candidate", required=True)
    p.add_argument("--baseline", required=True)
    p.add_argument(
        "--min-improvement-bips",
        type=int,
        default=None,
        help="Required relative improvement in basis points (100 = 1%%). "
        f"Defaults to {DEFAULT_MIN_IMPROVEMENT_BIPS} (the protocol schema default) "
        "so a caller that forgets to pass it still rejects noise. "
        "Pass 0 to accept any strict improvement.",
    )
    p.add_argument(
        "--protocol",
        help="Read the margin from this protocol.json's "
        "measurement.minScoreImprovementBips (--min-improvement-bips overrides).",
    )
    p.add_argument(
        "--explain",
        action="store_true",
        help="Print the threshold and verdict to stderr.",
    )
    args = p.parse_args()

    # Explicit flag wins; then the protocol; then the schema default. Resolving
    # in that order means an un-updated caller inherits the protocol's rule
    # rather than silently accepting any epsilon.
    bips = args.min_improvement_bips
    if bips is None and args.protocol:
        try:
            with open(args.protocol, encoding="utf-8") as f:
                protocol = json.load(f)
            bips = (protocol.get("measurement") or {}).get(
                "minScoreImprovementBips", DEFAULT_MIN_IMPROVEMENT_BIPS
            )
        except (OSError, json.JSONDecodeError) as exc:
            print(f"cannot read --protocol: {exc}", file=sys.stderr)
            return 2
    if bips is None:
        bips = DEFAULT_MIN_IMPROVEMENT_BIPS
    bips = int(bips)

    try:
        c = float(args.candidate)
        b = float(args.baseline)
    except ValueError:
        return 2
    if math.isnan(c) or math.isnan(b) or math.isinf(c) or math.isinf(b):
        return 2
    if bips < 0:
        print("--min-improvement-bips must be >= 0", file=sys.stderr)
        return 2

    threshold = required_threshold(b, args.direction, bips)
    improved = beats_threshold(c, threshold, args.direction, bips)

    if args.explain:
        print(
            f"direction={args.direction} baseline={b} candidate={c} "
            f"bips={bips} threshold={threshold} improved={improved}",
            file=sys.stderr,
        )

    return 0 if improved else 1


if __name__ == "__main__":
    raise SystemExit(main())
