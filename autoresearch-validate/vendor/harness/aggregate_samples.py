#!/usr/bin/env python3
"""Reduce repeated trial metrics to a single score and report dispersion.

A single run of a wall-clock or throughput benchmark is dominated by host
noise. Scoring one run therefore makes noise indistinguishable from a real
discovery. This reduces N measured trials to one number and reports the
coefficient of variation so callers can tell a signal from jitter.

Usage:
  aggregate_samples.py --samples 2.51 2.48 2.50 [--aggregator median]
  aggregate_samples.py --samples-file trials.txt --max-relative-stddev 0.02

Exit codes:
  0  aggregate written to stdout as JSON
  2  usage or parse error
  4  dispersion exceeded --max-relative-stddev (aggregate still printed)
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys

AGGREGATORS = ("median", "mean", "min", "max")


def reduce_samples(values: list[float], aggregator: str) -> float:
    if aggregator == "median":
        return statistics.median(values)
    if aggregator == "mean":
        return statistics.fmean(values)
    if aggregator == "min":
        return min(values)
    if aggregator == "max":
        return max(values)
    raise ValueError(f"unknown aggregator: {aggregator}")


def parse_values(raw: list[str]) -> list[float]:
    values: list[float] = []
    for item in raw:
        for token in item.replace(",", " ").split():
            values.append(float(token))
    return values


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--samples", nargs="*", default=[], help="Metric values as arguments.")
    p.add_argument("--samples-file", help="File with one metric value per line ('-' for stdin).")
    p.add_argument("--aggregator", choices=AGGREGATORS, default="median")
    p.add_argument(
        "--max-relative-stddev",
        type=float,
        default=None,
        help="Fail with exit 4 when the coefficient of variation exceeds this.",
    )
    p.add_argument("--out", help="Also write the JSON report to this path.")
    args = p.parse_args()

    raw = list(args.samples)
    if args.samples_file:
        try:
            if args.samples_file == "-":
                raw.append(sys.stdin.read())
            else:
                with open(args.samples_file, encoding="utf-8") as f:
                    raw.append(f.read())
        except OSError as exc:
            print(f"cannot read samples file: {exc}", file=sys.stderr)
            return 2

    try:
        values = parse_values(raw)
    except ValueError as exc:
        print(f"non-numeric sample: {exc}", file=sys.stderr)
        return 2

    if not values:
        print("no samples provided", file=sys.stderr)
        return 2
    if any(math.isnan(v) or math.isinf(v) for v in values):
        print("samples must all be finite", file=sys.stderr)
        return 2

    aggregate = reduce_samples(values, args.aggregator)
    mean = statistics.fmean(values)
    stddev = statistics.stdev(values) if len(values) > 1 else 0.0
    # Coefficient of variation is undefined at a zero mean; report null rather
    # than dividing, so a legitimately zero-centred metric does not crash here.
    cv = (stddev / abs(mean)) if mean != 0 else None

    report = {
        "samples": values,
        "count": len(values),
        "aggregator": args.aggregator,
        "aggregate": aggregate,
        "mean": mean,
        "stddev": stddev,
        "cv": cv,
    }

    too_noisy = (
        args.max_relative_stddev is not None
        and cv is not None
        and cv > args.max_relative_stddev
    )
    report["tooNoisy"] = bool(too_noisy)
    if args.max_relative_stddev is not None:
        report["maxRelativeStdDev"] = args.max_relative_stddev

    text = json.dumps(report, sort_keys=True)
    print(text)
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text + "\n")
        except OSError as exc:
            print(f"cannot write --out: {exc}", file=sys.stderr)
            return 2

    if too_noisy:
        print(
            f"coefficient of variation {cv:.4f} exceeds limit {args.max_relative_stddev:.4f}",
            file=sys.stderr,
        )
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
