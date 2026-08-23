#!/usr/bin/env python3
"""Deterministic static checks: forbidden globs, permit globs, red-flag regex scan."""
from __future__ import annotations

import argparse
import fnmatch
import os
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_RED_FLAGS = SCRIPT_DIR.parent / "watchouts" / "red_flags.txt"
DEFAULT_PERMIT = [
    "README*",
    "LICENSE*",
    "LICENSE.*",
    ".gitignore",
    "CONTRIBUTING*",
    ".github/ISSUE_TEMPLATE/**",
    ".github/PULL_REQUEST_TEMPLATE*",
    ".github/dependabot.yml",
    ".autoresearch/**",
]

# Always-rejected paths. Match BEFORE the protocol's forbidden/allowed/permit
# lists are consulted, so a protocol cannot opt these in. These are paths that
# can execute code on the verifier host or downstream CI, or that constitute a
# secret-bearing surface.
HARD_DENY = [
    ".git/**",
    ".github/workflows/**",
    ".gitlab-ci.yml",
    ".gitlab/**",
    ".husky/**",
    ".envrc",
    ".envrc.*",
    ".direnv/**",
    ".vscode/tasks.json",
    ".vscode/launch.json",
    ".idea/runConfigurations/**",
]

GITHUB_WORKFLOW_DENY = ".github/workflows/**"


def match_any(path: str, globs: list[str]) -> bool:
    path_f = path.replace("\\", "/")
    for g in globs:
        if fnmatch.fnmatch(path_f, g):
            return True
        base = path_f.split("/")[-1]
        if fnmatch.fnmatch(base, g):
            return True
    return False


def load_red_flag_patterns(path: Path) -> list[re.Pattern[str]]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    pats: list[re.Pattern[str]] = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        pats.append(re.compile(s))
    return pats


def iter_files(root: Path, paths: list[str] | None = None):
    if paths is not None:
        for rel in paths:
            if rel.startswith(".git/"):
                continue
            p = root / rel
            if p.is_file():
                yield rel, p
        return
    for p in root.rglob("*"):
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            if rel.startswith(".git/"):
                continue
            yield rel, p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--protocol", type=Path, required=True)
    ap.add_argument("--repo-root", type=Path, required=True)
    ap.add_argument("--red-flags-file", type=Path, default=DEFAULT_RED_FLAGS)
    ap.add_argument(
        "--allow-github-workflows",
        action="store_true",
        help="Allow existing .github/workflows files. Use only after a diff gate has rejected PR changes to workflow files.",
    )
    ap.add_argument(
        "--paths-file",
        type=Path,
        help="Optional newline-delimited list of repository-relative files to scan instead of the full tree.",
    )
    args = ap.parse_args()
    proto = json.loads(args.protocol.read_text(encoding="utf-8"))
    ms = proto.get("mutableSurface") or {}
    allowed = ms.get("allowedGlobs") or []
    forbidden = ms.get("forbiddenGlobs") or []
    ih = proto.get("immutableHarness") or {}
    immutable = ih.get("paths") or []
    permit = list(DEFAULT_PERMIT)
    extra = os.environ.get("ARAH_EXTRA_PERMIT_GLOBS")
    if extra:
        permit.extend([x.strip() for x in extra.split(":") if x.strip()])
    if args.allow_github_workflows:
        permit.append(GITHUB_WORKFLOW_DENY)
    red_patterns = load_red_flag_patterns(args.red_flags_file) if args.red_flags_file.is_file() else []

    root = args.repo_root.resolve()
    if not root.is_dir():
        print("repo root not found", file=sys.stderr)
        return 2

    scan_paths = None
    if args.paths_file:
        scan_paths = [
            line.strip()
            for line in args.paths_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    hard_deny = [
        pattern
        for pattern in HARD_DENY
        if not (args.allow_github_workflows and pattern == GITHUB_WORKFLOW_DENY)
    ]
    text_suffixes = {".py", ".sh", ".md", ".txt", ".c", ".h", ".cpp", ".cc", ".rs", ".toml", ".yaml", ".yml", ".json"}
    for rel, p in iter_files(root, scan_paths):
        if match_any(rel, hard_deny):
            print(f"hard-denied path: {rel}", file=sys.stderr)
            return 3
        if match_any(rel, forbidden):
            print(f"forbidden path touched: {rel}", file=sys.stderr)
            return 3
        permitted = match_any(rel, allowed) or match_any(rel, immutable) or match_any(rel, permit)
        if not permitted:
            print(f"path not on allowed/immutable/permit list: {rel}", file=sys.stderr)
            return 4
        suf = p.suffix.lower()
        if suf in text_suffixes or p.name.endswith("Dockerfile"):
            try:
                body = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for rx in red_patterns:
                if rx.search(body):
                    print(f"red flag pattern {rx.pattern!r} matched in {rel}", file=sys.stderr)
                    return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
