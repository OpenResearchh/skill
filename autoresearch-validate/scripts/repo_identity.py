#!/usr/bin/env python3
"""Canonical project identity derived from a git remote URL.

The chain stores `sha256("<host>/<owner>/<repo>")` rather than a URL, so a
project is one identity no matter how a given participant happens to reach it.
Every party must derive the same bytes from the same repository, so this
definition lives in exactly one place per language and is checked for parity
against the JavaScript twin in `git_artifacts.mjs`.

Normalisation, and why each step exists:

- Credentials are stripped. `https://token@host/o/r` and `https://host/o/r`
  are the same repository, and a token must never end up hashed into a public
  identifier.
- The port is stripped and the host lower-cased. Hostnames are case-insensitive.
- A trailing `.git` and surrounding slashes are removed, since both forms
  address the same repository.
- **The whole string is lower-cased**, not just the host. Git hosts treat
  owner and repository names case-insensitively, so `Owner/Repo` and
  `owner/repo` are the same project. Lower-casing only the host would give a
  project published as `Owner/Repo` a different id from the one a miner typing
  `owner/repo` computes, and nothing would ever match.

Usage:
  repo_identity.py https://github.com/Owner/Repo.git
  repo_identity.py --json git@github.com:Owner/Repo.git
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from urllib.parse import urlsplit

SCP_RE = re.compile(r"^(?:[^@/]+@)?([^:/]+):(.+)$")


def canonical_repo(url: str) -> str:
    value = str(url or "").strip()
    if not value:
        raise ValueError("remote url is empty")

    # scp-style (git@host:owner/repo) has no scheme, so urlsplit misreads it.
    if "://" not in value:
        match = SCP_RE.match(value)
        if not match:
            raise ValueError(f"cannot derive repo identity from remote '{url}'")
        host, path_part = match.group(1), match.group(2)
    else:
        parts = urlsplit(value)
        host = parts.hostname or ""
        path_part = parts.path

    host = host.split("@")[-1]
    host = re.sub(r":\d+$", "", host)
    path_part = path_part.strip("/")
    if path_part.endswith(".git"):
        path_part = path_part[: -len(".git")]

    if not host or not path_part:
        raise ValueError(f"cannot derive repo identity from remote '{url}'")

    return f"{host}/{path_part}".lower()


def repo_id(url: str) -> str:
    return hashlib.sha256(canonical_repo(url).encode("utf-8")).hexdigest()


def identity(url: str) -> dict[str, str]:
    canonical = canonical_repo(url)
    return {
        "canonical": canonical,
        "repoId": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("url")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    try:
        result = identity(args.url)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True) if args.json else result["repoId"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
