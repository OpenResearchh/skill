#!/usr/bin/env python3
"""Validate PR gate (network_state vs trial); exit 0 ok, 4 blocked."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_hash(value: object) -> str:
    s = str(value or "")
    return s.split("sha256:", 1)[1] if s.startswith("sha256:") else s


def blocked(message: str) -> int:
    print(message, file=sys.stderr)
    return 4


def git_head(repo_root: str) -> str:
    r = subprocess.run(
        ["git", "-C", repo_root, "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "cannot read git HEAD")
    return r.stdout.strip()


def validate_proposal_binding(args: argparse.Namespace, trial: dict) -> int:
    if not args.proposal_json:
        if args.require_proposal:
            return blocked("settlement-bearing PR requires --proposal-json")
        return 0

    with open(args.proposal_json, encoding="utf-8") as f:
        submission = json.load(f)

    if submission.get("trial_id") != trial.get("trial_id"):
        return blocked("proposal trial_id does not match trial record")
    if trial.get("git_head_after") and submission.get("git_head") != trial.get("git_head_after"):
        return blocked("proposal git_head does not match trial git_head_after")

    proposal = submission.get("proposal") or {}
    artifacts = submission.get("artifacts") or {}
    github = submission.get("github") or {}
    if not proposal.get("proposal_id"):
        return blocked("proposal metadata missing proposal_id")
    if not proposal.get("stake"):
        return blocked("proposal metadata missing stake")
    if not artifacts.get("code_hash"):
        return blocked("proposal metadata missing code_hash")
    if not github:
        return blocked("proposal metadata missing GitHub binding")

    current_head = git_head(args.repo_root)
    expected_head = github.get("head_sha") or submission.get("git_head")
    if expected_head and current_head != expected_head:
        return blocked("current git HEAD does not match proposal GitHub head_sha")

    code_file = submission.get("code_file")
    if code_file:
        code_path = Path(code_file)
        if not code_path.is_file():
            return blocked(f"proposal code_file missing: {code_file}")
        actual_hash = sha256_file(code_path)
        if actual_hash != normalize_hash(artifacts.get("code_hash")):
            return blocked("proposal code_hash does not match code_file")

    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--protocol", required=True)
    p.add_argument("--network-state", required=True)
    p.add_argument("--trial-json", required=True)
    p.add_argument("--proposal-json")
    p.add_argument("--require-proposal", type=int, default=0)
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
        return blocked("trial missing metric or run_ok false")

    proposal_result = validate_proposal_binding(args, trial)
    if proposal_result != 0:
        return proposal_result

    nb = net.get("network_best_metric")
    allow = bool(args.allow_local_only_pr)

    if nb is None:
        if not allow:
            return blocked("network_best_metric is null; use --allow-local-only-pr for local-best PRs")
        if not trial.get("beats_local_best"):
            return blocked("local-only PR requires beats_local_best")
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
        return blocked("metric does not beat network_best per compare_metric.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
