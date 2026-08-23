"""Chain selection, matching the resolution order used by `chain.mjs`.

Python entrypoints resolve the active settlement layer the same way the Node
entrypoints do. Keeping one order across both runtimes is the point: a miner
who sets `.autoresearch/chain.json` should not find that bootstrap honours it
and submit silently does something else.

Order, first match wins:
  explicit --chain > ARAH_CHAIN > .autoresearch/chain.json > recorded
  network_state source > DEFAULT_CHAIN
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_CHAIN = "stellar"
SUPPORTED_CHAINS = ("stellar", "solana", "0g")

# `network_state.source` describes where the frontier came from, not where the
# project settles; "manual" and "registry" say nothing about the layer.
_NON_CHAIN_SOURCES = {"manual", "registry"}


def _read_json(path: Path) -> dict | None:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def resolve_chain(explicit: str | None = None, work_dir: Path | None = None) -> str:
    root = Path(work_dir or Path.cwd())
    config = _read_json(root / ".autoresearch" / "chain.json") or {}
    state = _read_json(root / ".autoresearch" / "mine" / "network_state.json") or {}

    for candidate in (
        explicit,
        os.environ.get("ARAH_CHAIN"),
        config.get("chain"),
        state.get("source"),
    ):
        if not candidate:
            continue
        normalized = str(candidate).lower()
        if normalized in _NON_CHAIN_SOURCES:
            continue
        if normalized not in SUPPORTED_CHAINS:
            raise ValueError(
                f"unsupported chain: {candidate} (supported: {', '.join(SUPPORTED_CHAINS)})"
            )
        return normalized
    return DEFAULT_CHAIN


def show_chain_detail() -> bool:
    return bool(os.environ.get("ARAH_SHOW_CHAIN"))


def chain_detail(message: str) -> None:
    if show_chain_detail():
        import sys

        print(f"[chain] {message}", file=sys.stderr)
