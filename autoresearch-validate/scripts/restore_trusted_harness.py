#!/usr/bin/env python3
"""Restore the project's own harness over a submitted tree before scoring it.

A verifier must never build or run the judge out of the artifact it is judging.
If the benchmark harness, the metric extraction, or the protocol itself is read
from the submission, then whoever wrote the submission also decides how it is
scored — the score stops being an independent measurement.

This takes the harness and protocol that were published with the project
(fetched by their on-chain Irys ids and hash-verified before this runs) and
overwrites every path the protocol marks immutable in the submitted tree. It
reports any path whose content diverged, because divergence on an immutable
path is tampering, not a difference of opinion.

Usage:
  restore_trusted_harness.py --protocol <trusted protocol.json> \\
      --benchmark-dir <trusted harness tree> --repo-root <submitted tree> \\
      [--report report.json]

Exit codes:
  0  restored; no immutable path had diverged
  2  usage error, or a trusted input was unreadable
  3  at least one immutable path diverged (treat as tampering)
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import shutil
import sys


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iter_trusted_files(benchmark_dir: str, patterns: list[str]) -> list[str]:
    """Relative paths under benchmark_dir matching any immutable pattern."""
    matched: list[str] = []
    for dirpath, dirnames, filenames in os.walk(benchmark_dir):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, benchmark_dir).replace(os.sep, "/")
            for pattern in patterns:
                base = pattern.rstrip("/*")
                if (
                    fnmatch.fnmatch(rel, pattern)
                    or (base and (rel == base or rel.startswith(base + "/")))
                ):
                    matched.append(rel)
                    break
    return sorted(set(matched))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--protocol", required=True, help="Trusted protocol.json (published with the project).")
    p.add_argument("--benchmark-dir", required=True, help="Trusted harness tree.")
    p.add_argument("--repo-root", required=True, help="Submitted tree to restore into.")
    p.add_argument("--report", help="Write a JSON report of restored and diverged paths here.")
    args = p.parse_args()

    try:
        with open(args.protocol, encoding="utf-8") as f:
            protocol = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read trusted protocol: {exc}", file=sys.stderr)
        return 2

    if not os.path.isdir(args.benchmark_dir):
        print(f"trusted benchmark dir not found: {args.benchmark_dir}", file=sys.stderr)
        return 2
    if not os.path.isdir(args.repo_root):
        print(f"repo root not found: {args.repo_root}", file=sys.stderr)
        return 2

    patterns = ((protocol.get("immutableHarness") or {}).get("paths")) or []
    if not patterns:
        print(
            "protocol declares no immutableHarness.paths; nothing to restore. "
            "A project with no immutable harness cannot be independently scored.",
            file=sys.stderr,
        )

    restored: list[str] = []
    diverged: list[dict[str, str]] = []
    missing_in_submission: list[str] = []

    for rel in iter_trusted_files(args.benchmark_dir, patterns):
        trusted_path = os.path.join(args.benchmark_dir, rel)
        target_path = os.path.join(args.repo_root, rel)
        trusted_hash = sha256_file(trusted_path)

        if os.path.isfile(target_path):
            if sha256_file(target_path) != trusted_hash:
                diverged.append({"path": rel, "trustedSha256": trusted_hash})
        else:
            missing_in_submission.append(rel)

        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        # Copy rather than link so the sandbox cannot mutate the trusted tree.
        shutil.copyfile(trusted_path, target_path)
        shutil.copymode(trusted_path, target_path)
        restored.append(rel)

    report = {
        "restoredCount": len(restored),
        "restored": restored,
        "diverged": diverged,
        "missingInSubmission": missing_in_submission,
        "tampered": bool(diverged),
    }
    text = json.dumps(report, sort_keys=True)
    print(text)
    if args.report:
        try:
            with open(args.report, "w", encoding="utf-8") as f:
                f.write(text + "\n")
        except OSError as exc:
            print(f"cannot write --report: {exc}", file=sys.stderr)
            return 2

    if diverged:
        for entry in diverged:
            print(f"immutable path diverged: {entry['path']}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
