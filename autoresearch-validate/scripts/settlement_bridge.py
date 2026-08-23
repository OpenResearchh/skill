#!/usr/bin/env python3
"""Convert a GitHub verification result into a chain-neutral settlement plan."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def decide_action(result: dict) -> tuple[str, str]:
    outcome = result.get("result")
    reason = result.get("reason_code") or "unknown"
    if outcome == "approved":
        return "approve", reason
    if outcome == "rejected":
        return "reject", reason
    if outcome == "released":
        return "release-review", reason
    return "no-op", reason


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verification-result", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("settlement-plan.json"))
    parser.add_argument("--dry-run", action="store_true", default=True)
    args = parser.parse_args()

    try:
        result = load_json(args.verification_result)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read verification result: {exc}", file=sys.stderr)
        return 1

    action, reason = decide_action(result)
    proposal = result.get("proposal") or {}
    github = result.get("github") or {}
    plan = {
        "schemaVersion": "1",
        "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dry_run": args.dry_run,
        "action": action,
        "reason_code": reason,
        "proposal": {
            "proposal_id": proposal.get("proposal_id"),
            "project_id": proposal.get("project_id"),
            "stake": proposal.get("stake"),
            "chain": proposal.get("chain"),
        },
        "github": {
            "owner": github.get("owner"),
            "repo": github.get("repo"),
            "pr_number": github.get("pr_number"),
            "head_sha": github.get("head_sha"),
        },
        "verification_result": str(args.verification_result),
        "adapter_command": None,
    }
    args.output.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    print(str(args.output.resolve()))

    if action == "no-op":
        print("verification result is not settleable", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
