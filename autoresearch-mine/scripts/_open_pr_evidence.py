#!/usr/bin/env python3
"""Validate PR gate (network_state vs trial); exit 0 ok, 4 blocked."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--protocol", required=True)
    p.add_argument("--network-state", required=True)
    p.add_argument("--trial-json", required=True)
    p.add_argument("--allow-local-only-pr", type=int, default=0)
    p.add_argument("--repo-root", required=True)
    p.add_argument("--compare-script", required=True)
    args = p.parse_args()

    with open(args.protocol, encoding="utf-8") as f:
        proto = json.load(f)
    with open(args.network_state, encoding="utf-8") as f:
        net = json.load(f)
    with open(args.trial_json, encoding="utf-8") as f:
        trial = json.load(f)

    direction = proto["measurement"]["primaryMetric"]["direction"]
    min_improvement_bips = int((proto.get("measurement") or {}).get("minScoreImprovementBips", 100))
    cand = trial.get("primary_metric_value")
    if cand is None or not trial.get("run_ok", False):
        print("trial missing metric or run_ok false", file=sys.stderr)
        return 4

    nb = net.get("network_best_metric")
    allow = bool(args.allow_local_only_pr)

    if nb is None:
        if not allow:
            print(
                "network_best_metric is null; use --allow-local-only-pr for local-best PRs",
                file=sys.stderr,
            )
            return 4
        if not trial.get("beats_local_best"):
            print("local-only PR requires beats_local_best", file=sys.stderr)
            return 4
        return 0

    r = subprocess.run(
        [
            sys.executable,
            args.compare_script,
            "--direction",
            direction,
            "--candidate",
            str(cand),
            "--baseline",
            str(nb),
            "--min-improvement-bips",
            str(min_improvement_bips),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print("metric does not beat network_best per compare_metric.py", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
