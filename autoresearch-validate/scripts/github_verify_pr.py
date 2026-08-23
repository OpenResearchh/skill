#!/usr/bin/env python3
"""Verify a GitHub PR candidate bound to an OpenResearch proposal.

This script is intentionally chain-neutral. It validates the PR/proposal binding
and emits verification-result.json for a trusted settlement bridge to consume.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def run(cmd: list[str], *, cwd: Path | None = None, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_hash(value: object) -> str:
    s = str(value or "")
    return s.split("sha256:", 1)[1] if s.startswith("sha256:") else s


def load_bound_proposal(*, proposal_json: Path | None, pr_body_file: Path | None) -> dict:
    if proposal_json:
        return json.loads(proposal_json.read_text(encoding="utf-8"))
    if not pr_body_file:
        raise ValueError("--proposal-json or --pr-body-file is required")
    body = pr_body_file.read_text(encoding="utf-8")
    match = re.search(r"```openresearch-proposal\s*(\{.*?\})\s*```", body, re.DOTALL)
    if not match:
        raise ValueError("PR body missing openresearch-proposal JSON block")
    return json.loads(match.group(1))


def gate(name: str, status: str, reason: str | None = None, detail: str | None = None) -> dict[str, str | None]:
    return {"name": name, "status": status, "reason": reason, "detail": detail}


def fail_result(bound: dict, gates: list[dict], reason: str, *, result: str = "rejected", error: str | None = None) -> dict:
    return build_result(bound, gates, result=result, reason_code=reason, error=error)


def build_result(
    bound: dict,
    gates: list[dict],
    *,
    result: str,
    reason_code: str,
    verified_metric: float | None = None,
    error: str | None = None,
) -> dict:
    proposal = bound.get("proposal") or {}
    project = bound.get("project") or {}
    github = bound.get("github") or {}
    artifacts = bound.get("artifacts") or {}
    trial = bound.get("trial") or {}
    return {
        "schemaVersion": "1",
        "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "proposal": {
            "proposal_id": proposal.get("proposal_id"),
            "project_id": project.get("project_id"),
            "stake": str(proposal.get("stake", "")),
            "chain": project.get("chain"),
        },
        "github": {
            "owner": github.get("owner"),
            "repo": github.get("repo"),
            "pr_number": github.get("pr_number"),
            "pr_url": github.get("pr_url"),
            "base_sha": github.get("base_sha"),
            "head_sha": github.get("head_sha"),
        },
        "result": result,
        "reason_code": reason_code,
        "claimed_metric": trial.get("claimed_metric"),
        "verified_metric": verified_metric,
        "verified_aggregate_score": None,
        "artifacts": {
            "code_hash": artifacts.get("code_hash"),
            "benchmark_log_hash": artifacts.get("benchmark_log_hash"),
            "metrics_hash": None,
            "result_cid": None,
        },
        "gates": gates,
        "error": error,
    }


def find_protocol(repo_root: Path, explicit: Path | None) -> Path:
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates.extend([
        repo_root / ".autoresearch" / "publish" / "protocol.json",
        repo_root / "protocol.json",
    ])
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise ValueError("protocol.json not found; pass --protocol")


def parse_aggregate(samples_path: Path) -> float:
    samples = json.loads(samples_path.read_text(encoding="utf-8"))
    return float(samples["aggregate"])


def changed_paths(repo_root: Path, base_sha: str | None, head_sha: str) -> list[str]:
    if not base_sha:
        return []
    diff = run(["git", "diff", "--name-only", f"{base_sha}..{head_sha}"], cwd=repo_root)
    if diff.returncode != 0:
        raise ValueError(diff.stderr.strip() or "cannot compute changed paths")
    return [line.strip() for line in diff.stdout.splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--protocol", type=Path)
    parser.add_argument("--proposal-json", type=Path)
    parser.add_argument("--pr-body-file", type=Path)
    parser.add_argument("--output", type=Path, default=Path("verification-result.json"))
    parser.add_argument("--run-benchmark", action="store_true")
    parser.add_argument("--baseline-metric", type=float, help="Current best metric for improvement check.")
    parser.add_argument("--min-improvement-bips", type=int)
    parser.add_argument("--review-id", default=None)
    parser.add_argument("--static-gates-script", type=Path, default=SCRIPT_DIR / "verify_static_gates.py")
    parser.add_argument("--run-verify-trial-script", type=Path, default=SCRIPT_DIR / "run_verify_trial.sh")
    parser.add_argument("--compare-script", type=Path, default=SCRIPT_DIR / "compare_metric.py")
    args = parser.parse_args()

    gates: list[dict] = []
    repo_root = args.repo_root.resolve()
    try:
        bound = load_bound_proposal(proposal_json=args.proposal_json, pr_body_file=args.pr_body_file)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        bound = {"proposal": {}, "project": {}, "github": {}, "trial": {}, "artifacts": {}}
        result = fail_result(bound, [gate("metadata", "failed", "metadata_invalid", str(exc))], "metadata_invalid", error=str(exc))
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return 1

    try:
        github = bound.get("github") or {}
        artifacts = bound.get("artifacts") or {}
        trial = bound.get("trial") or {}

        head = run(["git", "rev-parse", "HEAD"], cwd=repo_root)
        if head.returncode != 0:
            gates.append(gate("head_sha", "failed", "git_head_failed", head.stderr.strip()))
            result = fail_result(bound, gates, "git_head_failed", error=head.stderr.strip())
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            return 1
        current_head = head.stdout.strip()
        if current_head != github.get("head_sha"):
            gates.append(gate("head_sha", "failed", "head_sha_mismatch", f"checkout={current_head} expected={github.get('head_sha')}"))
            result = fail_result(bound, gates, "head_sha_mismatch")
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            return 1
        gates.append(gate("head_sha", "passed"))

        with tempfile.TemporaryDirectory(prefix="arah-pr-") as tmp:
            archive = Path(tmp) / "repo-snapshot.tar"
            arch = run(["git", "archive", "--format=tar", "--output", str(archive), "HEAD"], cwd=repo_root)
            if arch.returncode != 0:
                gates.append(gate("code_hash", "failed", "archive_failed", arch.stderr.strip()))
                result = fail_result(bound, gates, "archive_failed", error=arch.stderr.strip())
                args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
                return 1
            actual_code_hash = sha256_file(archive)
        if actual_code_hash != normalize_hash(artifacts.get("code_hash")):
            gates.append(gate("code_hash", "failed", "code_hash_mismatch", actual_code_hash))
            result = fail_result(bound, gates, "code_hash_mismatch")
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            return 1
        gates.append(gate("code_hash", "passed"))

        changed = changed_paths(repo_root, github.get("base_sha"), current_head)
        workflow_changes = [p for p in changed if p.startswith(".github/workflows/")]
        if workflow_changes:
            gates.append(gate("workflow_diff", "failed", "workflow_changed", ", ".join(workflow_changes)))
            result = fail_result(bound, gates, "workflow_changed")
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            return 1
        gates.append(gate("workflow_diff", "passed"))

        protocol = find_protocol(repo_root, args.protocol)
        static = run([
            sys.executable,
            str(args.static_gates_script),
            "--protocol",
            str(protocol),
            "--repo-root",
            str(repo_root),
            "--allow-github-workflows",
        ])
        if static.returncode != 0:
            gates.append(gate("static_gates", "failed", "static_gate_failed", (static.stdout + static.stderr).strip()))
            result = fail_result(bound, gates, "static_gate_failed")
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            return 1
        gates.append(gate("static_gates", "passed"))

        verified_metric = None
        if args.run_benchmark:
            review_id = args.review_id or f"github-pr-{github.get('pr_number') or current_head[:12]}"
            bench = run(["bash", str(args.run_verify_trial_script), str(protocol), str(repo_root), review_id], cwd=repo_root)
            samples_path = repo_root / ".autoresearch" / "verify" / "runs" / review_id / "samples.json"
            if bench.returncode != 0:
                status = "released" if bench.returncode == 4 else "failed"
                reason = "measurement_too_noisy" if bench.returncode == 4 else "harness_failed"
                gates.append(gate("benchmark", status, reason, (bench.stdout + bench.stderr).strip()))
                result = fail_result(bound, gates, reason, result="released" if bench.returncode == 4 else "rejected")
                args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
                return 1
            verified_metric = parse_aggregate(samples_path)
            gates.append(gate("benchmark", "passed", detail=str(verified_metric)))

            if args.baseline_metric is not None:
                bips = args.min_improvement_bips
                if bips is None:
                    protocol_json = json.loads(protocol.read_text(encoding="utf-8"))
                    bips = int((protocol_json.get("measurement") or {}).get("minScoreImprovementBips", 100))
                compare = run([
                    sys.executable,
                    str(args.compare_script),
                    "--direction",
                    str(trial.get("direction")),
                    "--candidate",
                    str(verified_metric),
                    "--baseline",
                    str(args.baseline_metric),
                    "--min-improvement-bips",
                    str(bips),
                ])
                if compare.returncode != 0:
                    gates.append(gate("improvement", "failed", "no_improvement", (compare.stdout + compare.stderr).strip()))
                    result = fail_result(bound, gates, "no_improvement", verified_metric=verified_metric)
                    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
                    return 1
                gates.append(gate("improvement", "passed"))
            else:
                gates.append(gate("improvement", "skipped", "baseline_metric_not_provided"))
        else:
            gates.append(gate("benchmark", "skipped", "run_benchmark_not_set"))

        result = build_result(bound, gates, result="approved", reason_code="ok", verified_metric=verified_metric)
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return 0
    except (OSError, ValueError, KeyError) as exc:
        gates.append(gate("operational", "failed", "operational_failure", str(exc)))
        result = fail_result(bound, gates, "operational_failure", result="operational_failure", error=str(exc))
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
