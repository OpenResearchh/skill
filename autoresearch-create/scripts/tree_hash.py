#!/usr/bin/env python3
"""Compute the canonical content hash of a git tree.

A proposal points at a git commit, and a commit id is already an integrity
check: fetching an object by its id and having git accept it proves the bytes.
This hash exists for a narrower reason — git commit ids are SHA-1, and this
system has value attached to them. A second, independent SHA-256 commitment
means a SHA-1 collision alone is not enough to swap the code a proposal points
at.

Miner and verifier must agree byte for byte, so the digest is defined over
git's own object model rather than over an archive:

    sha256( "openresearch/tree/v1\\n" ||
            for each entry, sorted by raw path bytes:
                len(path) ":" path "\\n"
                octal_mode "\\n"
                sha256(blob contents) "\\n" )

Deliberately NOT a hash of `git archive` output: that varies with git version
and with export-subst / export-ignore gitattributes, so two honest machines can
produce different bytes for the same commit and every proposal would fail.

Symlinks hash as their target path, which is exactly the blob content git
stores for them. Submodules (gitlinks) and any other entry type are rejected
rather than hashed, because their contents are not in this repository and so
cannot be part of a self-contained commitment.

Usage:
  tree_hash.py --repo-root . --commit HEAD
  tree_hash.py --repo-root . --commit <sha> --verify <expected-hex>
  tree_hash.py --repo-root . --commit <sha> --explain

Exit codes:
  0  hash printed (and matched --verify when given)
  2  usage error, or not a git repository
  3  --verify mismatch
  4  tree contains an entry that cannot be hashed (submodule or unknown mode)
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys

DOMAIN = b"openresearch/tree/v1\n"

MODE_FILE = "100644"
MODE_EXEC = "100755"
MODE_SYMLINK = "120000"
MODE_SUBMODULE = "160000"

HASHABLE_MODES = {MODE_FILE, MODE_EXEC, MODE_SYMLINK}


class TreeHashError(Exception):
    def __init__(self, message: str, code: int) -> None:
        super().__init__(message)
        self.code = code


def git(repo_root: str, args: list[str], binary: bool = False):
    result = subprocess.run(
        ["git", "-C", repo_root, *args],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise TreeHashError(
            f"git {' '.join(args)} failed: {result.stderr.decode('utf-8', 'replace').strip()}",
            2,
        )
    return result.stdout if binary else result.stdout.decode("utf-8")


def list_entries(repo_root: str, commit: str) -> list[tuple[str, str, str]]:
    """Return (path, mode, blob_sha) for every entry, sorted by raw path bytes.

    `git ls-tree -r -z` gives NUL-separated records so paths containing
    newlines or quotes are unambiguous; -z also disables git's path quoting,
    which would otherwise mangle non-ASCII names differently across configs.
    """
    raw = git(repo_root, ["ls-tree", "-r", "-z", commit], binary=True)
    entries: list[tuple[str, str, str]] = []
    for record in raw.split(b"\x00"):
        if not record:
            continue
        meta, _, path_bytes = record.partition(b"\t")
        fields = meta.decode("utf-8").split()
        if len(fields) < 3:
            raise TreeHashError(f"unparseable ls-tree record: {meta!r}", 2)
        mode, obj_type, obj_sha = fields[0], fields[1], fields[2]
        path = path_bytes.decode("utf-8", "surrogateescape")
        if mode == MODE_SUBMODULE or obj_type == "commit":
            raise TreeHashError(
                f"submodule at '{path}' cannot be part of a self-contained "
                "commitment; remove it or exclude it from the mutable surface",
                4,
            )
        if mode not in HASHABLE_MODES:
            raise TreeHashError(f"unsupported entry mode {mode} at '{path}'", 4)
        entries.append((path, mode, obj_sha))
    # Sort by raw path bytes so ordering does not depend on locale or on
    # Python's str comparison of surrogate-escaped names.
    entries.sort(key=lambda e: e[0].encode("utf-8", "surrogateescape"))
    return entries


def compute(repo_root: str, commit: str, explain: bool = False) -> str:
    entries = list_entries(repo_root, commit)
    digest = hashlib.sha256()
    digest.update(DOMAIN)
    for path, mode, obj_sha in entries:
        blob = git(repo_root, ["cat-file", "blob", obj_sha], binary=True)
        blob_hash = hashlib.sha256(blob).hexdigest()
        path_bytes = path.encode("utf-8", "surrogateescape")
        digest.update(f"{len(path_bytes)}:".encode("ascii"))
        digest.update(path_bytes)
        digest.update(b"\n")
        digest.update(mode.encode("ascii") + b"\n")
        digest.update(blob_hash.encode("ascii") + b"\n")
        if explain:
            print(f"{mode} {blob_hash} {path}", file=sys.stderr)
    if explain:
        print(f"({len(entries)} entries)", file=sys.stderr)
    return digest.hexdigest()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo-root", default=".")
    p.add_argument("--commit", default="HEAD")
    p.add_argument("--verify", help="Expected hex digest; exit 3 on mismatch.")
    p.add_argument("--explain", action="store_true", help="List hashed entries on stderr.")
    args = p.parse_args()

    try:
        value = compute(args.repo_root, args.commit, explain=args.explain)
    except TreeHashError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code

    print(value)
    if args.verify:
        expected = args.verify.lower().removeprefix("0x")
        if expected != value:
            print(f"tree hash mismatch: expected {expected}, got {value}", file=sys.stderr)
            return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
