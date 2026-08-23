#!/usr/bin/env python3
"""Derive the per-trial seed declared by execution.determinism.seedDerivation.

The interesting mode is `fiat_shamir`: the seed is a hash of the candidate's
own mutable surface. Because the seed moves whenever the code moves, a
candidate cannot be tuned against a fixed set of evaluation inputs — any edit
that would overfit also reseeds the run. Unlike a hidden held-out set this
needs no trusted party to keep a secret, which is what makes it usable by a
permissionless verifier network: every participant re-derives the same seed
from the same bytes and gets the same answer.

Usage:
  derive_trial_seed.py --protocol protocol.json --repo-root /path/to/repo

Exit codes:
  0  seed written to stdout (decimal)
  2  usage or unreadable protocol
  3  protocol declares no seed (mode `none` or seedDerivation absent)
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import sys

DEFAULT_ENV_VAR = "ARAH_TRIAL_SEED"
DEFAULT_SEED_BITS = 64

# Directories that never describe candidate behaviour. Including them would
# make the seed depend on scratch state and break reproducibility between the
# miner's run and the verifier's rerun.
SKIP_DIRS = {".git", ".autoresearch", "__pycache__", "node_modules", ".venv", "venv"}


def match_any(rel: str, globs: list[str]) -> bool:
    for pattern in globs:
        if fnmatch.fnmatch(rel, pattern):
            return True
        # Treat a directory glob as covering everything beneath it.
        if pattern.endswith("/**") and fnmatch.fnmatch(rel, pattern[:-3] + "/*"):
            return True
        base = pattern.rstrip("/*")
        if base and (rel == base or rel.startswith(base + "/")):
            return True
    return False


def iter_source_files(root: str, globs: list[str]) -> list[str]:
    matched: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            # Canonical POSIX separators so the digest matches across platforms.
            rel = rel.replace(os.sep, "/")
            if match_any(rel, globs):
                matched.append(rel)
    return sorted(matched)


def derive(root: str, globs: list[str], salt: str, seed_bits: int) -> tuple[int, list[str]]:
    digest = hashlib.sha256()
    digest.update(b"openresearch/seed/v1\n")
    digest.update(salt.encode("utf-8") + b"\n")
    files = iter_source_files(root, globs)
    for rel in files:
        file_hash = hashlib.sha256()
        with open(os.path.join(root, rel), "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                file_hash.update(chunk)
        # Length-prefix the path so that concatenation is unambiguous.
        digest.update(f"{len(rel)}:{rel}\n".encode("utf-8"))
        digest.update(file_hash.hexdigest().encode("ascii") + b"\n")
    raw = int.from_bytes(digest.digest(), "big")
    return raw % (1 << seed_bits), files


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--protocol", required=True)
    p.add_argument("--repo-root", required=True)
    p.add_argument("--salt", default=None, help="Overrides seedDerivation.salt when set.")
    p.add_argument("--print-env", action="store_true", help="Print NAME=VALUE instead of the bare seed.")
    p.add_argument("--explain", action="store_true", help="Write the hashed file list to stderr.")
    args = p.parse_args()

    try:
        with open(args.protocol, encoding="utf-8") as f:
            protocol = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read protocol: {exc}", file=sys.stderr)
        return 2

    determinism = ((protocol.get("execution") or {}).get("determinism")) or {}
    spec = determinism.get("seedDerivation") or {}
    mode = spec.get("mode", "none")
    env_var = spec.get("envVar", DEFAULT_ENV_VAR)
    seed_bits = int(spec.get("seedBits", DEFAULT_SEED_BITS))

    if mode == "none":
        return 3
    if mode == "fixed":
        seed = int(spec.get("fixedSeed", 0))
    elif mode == "fiat_shamir":
        globs = spec.get("sourcePaths")
        if not globs:
            globs = ((protocol.get("mutableSurface") or {}).get("allowedGlobs")) or []
        if not globs:
            print(
                "seedDerivation.mode is fiat_shamir but neither sourcePaths nor "
                "mutableSurface.allowedGlobs is set",
                file=sys.stderr,
            )
            return 2
        if not os.path.isdir(args.repo_root):
            print(f"repo root not found: {args.repo_root}", file=sys.stderr)
            return 2
        salt = args.salt if args.salt is not None else spec.get("salt", "")
        seed, files = derive(args.repo_root, globs, salt, seed_bits)
        if args.explain:
            print(f"hashed {len(files)} file(s) under {len(globs)} glob(s):", file=sys.stderr)
            for rel in files:
                print(f"  {rel}", file=sys.stderr)
    else:
        print(f"unknown seedDerivation.mode: {mode}", file=sys.stderr)
        return 2

    print(f"{env_var}={seed}" if args.print_env else str(seed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
