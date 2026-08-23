#!/usr/bin/env python3
"""Local smoke test for the GitHub verification bridge.

The test builds a tiny temporary Git repo and exercises the proposal-bound PR
path without GitHub, Irys, or a settlement chain:

1. create a hypothesis branch
2. create a code snapshot and proposal metadata
3. run the PR evidence gate
4. run the GitHub verifier
5. build a settlement plan
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
MINE_SCRIPTS = ROOT / "autoresearch-mine" / "scripts"


def run(cmd: list[str], *, cwd: Path | None = None, capture: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode != 0:
        detail = ""
        if capture:
            detail = f"\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        raise RuntimeError(f"{' '.join(cmd)} failed with {result.returncode}{detail}")
    return result


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    tmp_root = ROOT / ".tmp"
    tmp_root.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="arah-github-bridge-", dir=tmp_root))
    try:
        repo = tmp / "repo"
        repo.mkdir()
        run(["git", "init", "-b", "main"], cwd=repo)
        run(["git", "-c", "user.name=OpenResearch", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], cwd=repo)

        protocol = {
            "schemaKind": "protocol",
            "meta": {
                "archetype": "benchmark_opt",
                "eligibility": "eligible",
                "purposeStatement": "smoke test",
                "protocolBundleId": "bundle-smoke",
            },
            "environment": {"setupCommands": [], "constraints": {"networkPolicy": "offline"}},
            "mutableSurface": {"allowedGlobs": ["app.txt", "protocol.json"]},
            "immutableHarness": {"paths": []},
            "execution": {"cwd": ".", "command": "printf 'smoke\\n'"},
            "measurement": {
                "primaryMetric": {"name": "score", "direction": "minimize"},
                "minScoreImprovementBips": 100,
                "sampling": {"warmupTrials": 0, "measuredTrials": 1, "aggregator": "median"},
            },
            "provenance": {"resultsLog": {"path": ".autoresearch/mine/trials.jsonl"}},
            "safety": {},
        }
        write_json(repo / "protocol.json", protocol)
        (repo / "app.txt").write_text("before\n", encoding="utf-8")
        run(["git", "add", "protocol.json", "app.txt"], cwd=repo)
        run(["git", "-c", "user.name=OpenResearch", "-c", "user.email=test@example.com", "commit", "-m", "base"], cwd=repo)
        base_sha = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

        branch = run([
            "bash",
            str(MINE_SCRIPTS / "prepare_hypothesis_branch.sh"),
            str(repo / "protocol.json"),
            str(repo),
            "trial-smoke",
            "faster-loop",
        ]).stdout.strip()
        (repo / "app.txt").write_text("after\n", encoding="utf-8")
        run(["git", "add", "app.txt"], cwd=repo)
        run(["git", "-c", "user.name=OpenResearch", "-c", "user.email=test@example.com", "commit", "-m", "mine(trial-smoke): smoke"], cwd=repo)
        head_sha = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

        mine_root = repo / ".autoresearch" / "mine"
        run_dir = mine_root / "runs" / "trial-smoke"
        run_dir.mkdir(parents=True)
        stdout_log = run_dir / "stdout.log"
        stdout_log.write_text("AGGREGATE_METRIC=90\n", encoding="utf-8")
        network_state = {
            "schemaVersion": "1",
            "source": "manual",
            "protocolBundleId": "bundle-smoke",
            "network_best_metric": 100,
            "metric_name": "score",
            "direction": "minimize",
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        write_json(mine_root / "network_state.json", network_state)

        archive = mine_root / "submissions" / "trial-smoke" / "repo-snapshot.tar"
        archive.parent.mkdir(parents=True)
        run(["git", "archive", "--format=tar", "--output", str(archive), "HEAD"], cwd=repo)
        code_hash = sha256_file(archive)
        log_hash = sha256_file(stdout_log)

        trial = {
            "schemaVersion": "1",
            "trial_id": "trial-smoke",
            "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "protocol_bundle_id": "bundle-smoke",
            "run_ok": True,
            "primary_metric_name": "score",
            "primary_metric_value": 90,
            "direction": "minimize",
            "beats_local_best": True,
            "beats_network_best": True,
            "stdout_log_path": str(stdout_log),
            "git_head_before": base_sha,
            "git_head_after": head_sha,
            "harness_exit_code": 0,
            "error": "",
            "hypothesis": "faster loop",
            "hypothesis_branch": branch,
        }
        trial_json = tmp / "trial.json"
        write_json(trial_json, trial)

        submission = {
            "schemaVersion": "1",
            "trial_id": "trial-smoke",
            "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "git_head": head_sha,
            "code_file": str(archive),
            "benchmark_log_file": str(stdout_log),
            "claimed_metric": "90",
            "stake": "1",
            "reward_recipient": "test-recipient",
            "chain": "dry-run",
            "dry_run": True,
            "github": {
                "owner": "OpenResearchh",
                "repo": "smoke",
                "base_branch": "main",
                "base_sha": base_sha,
                "head_branch": branch,
                "head_sha": head_sha,
                "pr_number": None,
                "pr_url": None,
            },
            "proposal": {
                "proposal_id": "proposal-smoke",
                "stake": "1",
                "reward_recipient": "test-recipient",
                "status": "submitted",
            },
            "artifacts": {
                "code_cid": "cid-smoke-code",
                "code_hash": code_hash,
                "benchmark_log_cid": "cid-smoke-log",
                "benchmark_log_hash": log_hash,
            },
            "submit_output": "",
        }
        submission_json = archive.parent / "submission.json"
        write_json(submission_json, submission)

        run([
            sys.executable,
            str(MINE_SCRIPTS / "_open_pr_evidence.py"),
            "--protocol",
            str(repo / "protocol.json"),
            "--network-state",
            str(mine_root / "network_state.json"),
            "--trial-json",
            str(trial_json),
            "--proposal-json",
            str(submission_json),
            "--require-proposal",
            "1",
            "--repo-root",
            str(repo),
            "--compare-script",
            str(MINE_SCRIPTS / "compare_metric.py"),
        ])

        bound = {
            "schemaVersion": "1",
            "project": {"protocol_bundle_id": "bundle-smoke", "chain": "dry-run", "project_id": "project-smoke", "token_address": None},
            "github": submission["github"],
            "proposal": submission["proposal"],
            "trial": {
                "trial_id": "trial-smoke",
                "primary_metric_name": "score",
                "claimed_metric": 90,
                "claimed_aggregate_score": None,
                "direction": "minimize",
                "hypothesis": "faster loop",
            },
            "artifacts": submission["artifacts"],
        }
        bound_json = tmp / "bound-proposal.json"
        write_json(bound_json, bound)
        verification_result = tmp / "verification-result.json"
        run([
            sys.executable,
            str(SCRIPT_DIR / "github_verify_pr.py"),
            "--repo-root",
            str(repo),
            "--protocol",
            str(repo / "protocol.json"),
            "--proposal-json",
            str(bound_json),
            "--output",
            str(verification_result),
        ])
        result = json.loads(verification_result.read_text(encoding="utf-8"))
        if result["result"] != "approved":
            raise RuntimeError(f"expected approved verification result, got {result['result']}")

        settlement_plan = tmp / "settlement-plan.json"
        run([
            sys.executable,
            str(SCRIPT_DIR / "settlement_bridge.py"),
            "--verification-result",
            str(verification_result),
            "--output",
            str(settlement_plan),
        ])
        plan = json.loads(settlement_plan.read_text(encoding="utf-8"))
        if plan["action"] != "approve":
            raise RuntimeError(f"expected approve settlement action, got {plan['action']}")

        print("GitHub bridge smoke test passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
