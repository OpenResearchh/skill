#!/usr/bin/env python3
"""Restore the project's own harness over a submitted tree before scoring it.

A verifier must never build or run the judge out of the artifact it is judging.
If the benchmark harness, the metric extraction, or the protocol itself is read
from the submission, then whoever wrote the submission also decides how it is
scored — the score stops being an independent measurement.

The trusted source is a checkout of the project's repository at its pinned
commit: git is content-addressed, so fetching that commit by id and having git
accept it fixes the bytes, and the caller has already verified the canonical
tree hash and the on-chain SHA-256 of `protocol.json` before this runs. (A
directory extracted from a published archive still works and is treated
identically — this script only reads files out of the trusted root.)

Every path the protocol marks immutable is overwritten in the submitted tree.
Any path whose content diverged is reported, because divergence on an immutable
path is tampering, not a difference of opinion.

Usage:
  restore_trusted_harness.py --protocol <trusted protocol.json> \\
      --trusted-root <checkout at the project's pinned commit> \\
      --repo-root <submitted tree> [--expect-commit <sha>] [--report report.json]

`--benchmark-dir` is accepted as an alias for `--trusted-root`.

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
import subprocess
import sys


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def head_commit(trusted_root: str) -> str | None:
    """Commit the trusted root is checked out at, or None if it is not a repo."""
    try:
        result = subprocess.run(
            ["git", "-C", trusted_root, "rev-parse", "HEAD"],
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", "replace").strip().lower() or None


def iter_trusted_files(benchmark_dir: str, patterns: list[str]) -> list[str]:
    """Relative paths under benchmark_dir matching any immutable pattern.

    `.git` is skipped: it is repository bookkeeping, not harness content, and
    copying it into the submitted tree would replace the submission's own
    history with the project's.
    """
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
    p.add_argument(
        "--trusted-root",
        "--benchmark-dir",
        dest="trusted_root",
        required=True,
        help="Checkout of the project at its pinned commit (or an extracted harness tree).",
    )
    p.add_argument(
        "--expect-commit",
        help="Require the trusted root to be checked out at this commit.",
    )
    p.add_argument("--repo-root", required=True, help="Submitted tree to restore into.")
    p.add_argument("--report", help="Write a JSON report of restored and diverged paths here.")
    args = p.parse_args()

    try:
        with open(args.protocol, encoding="utf-8") as f:
            protocol = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read trusted protocol: {exc}", file=sys.stderr)
        return 2

    if not os.path.isdir(args.trusted_root):
        print(f"trusted root not found: {args.trusted_root}", file=sys.stderr)
        return 2
    if not os.path.isdir(args.repo_root):
        print(f"repo root not found: {args.repo_root}", file=sys.stderr)
        return 2

    # A trusted root at the wrong commit is a configuration fault on this host,
    # not miner tampering, so it is a usage error rather than an exit-3 reject.
    trusted_commit = head_commit(args.trusted_root)
    if args.expect_commit:
        expected = args.expect_commit.strip().lower()
        if trusted_commit is None:
            print(
                f"--expect-commit given but {args.trusted_root} is not a git checkout",
                file=sys.stderr,
            )
            return 2
        if trusted_commit != expected:
            print(
                f"trusted root is at {trusted_commit}, expected {expected}",
                file=sys.stderr,
            )
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

    for rel in iter_trusted_files(args.trusted_root, patterns):
        trusted_path = os.path.join(args.trusted_root, rel)
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
        "trustedRoot": os.path.abspath(args.trusted_root),
        "trustedCommit": trusted_commit,
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
