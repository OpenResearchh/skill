#!/usr/bin/env python3
"""Opt-in, miner-owned agent trajectory capture for one trial (stdlib only).

Records what the miner's own coding agent did during a trial — prompts, model
replies, tool calls, tool results — as an append-only JSON Lines bundle under
``<repo-root>/.autoresearch/mine/traces/<trial_id>/``. The miner owns this
data: it stays on the miner's disk until they run a separate explicit upload
command (``scripts/upload_trace_irys.mjs --yes``).

Capture is OFF by default. ``append`` and ``finalize`` no-op with exit 0 and a
clear message unless ``ARAH_TRACE_ENABLED=1`` is exported or ``--enable`` is
passed. Nothing is ever captured implicitly by the mining loop, and this script
never uploads anything.

Subcommands:
  append     Redact and append one trace event to events.jsonl
  finalize   Hash the bundle and write trace.json (schemas/trace_record.schema.json)
  status     Print the current state of a trace directory (works when disabled)
  purge      Delete a trace directory, or all of them (works when disabled)

REDACTION IS BEST-EFFORT, NOT A GUARANTEE. The redaction pass is plain pattern
matching over the text you hand it (`sk-`/`sk-ant-` style API keys, GitHub
tokens, AWS access key ids, JWTs, PEM private key blocks, 64-byte Solana
keypair arrays). It cannot recognize secrets that do not match those shapes:
passwords, bearer tokens with no prefix, internal hostnames, customer data,
proprietary source, or a key pasted in an unusual encoding will pass straight
through. Read a finalized bundle yourself before you upload it anywhere.

Layout under the trace directory:
  events.jsonl   append-only redacted events (the bundle that gets uploaded)
  trace.json     finalized trace record, including bundle sha256 and license
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_DIR = SCRIPT_DIR.parent / "vendor" / "harness"
if str(HARNESS_DIR) not in sys.path:
    sys.path.insert(0, str(HARNESS_DIR))

import _log  # noqa: E402

SCHEMA_VERSION = "1"
EVENTS_FILE = "events.jsonl"
RECORD_FILE = "trace.json"
EVENT_TYPES = ("prompt", "model_reply", "tool_call", "tool_result", "note")
LICENSE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]*$")
PRIVATE_LICENSE = "unlicensed-private"

# Best-effort secret shapes. Order matters: PEM blocks first so their base64
# body is not partially eaten by the narrower patterns.
REDACTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "pem-block",
        re.compile(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            re.DOTALL,
        ),
    ),
    ("api-key-sk-ant", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}")),
    ("api-key-sk", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}")),
    ("aws-access-key-id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*")),
    ("solana-keypair-array", re.compile(r"\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]")),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def capture_enabled(args: argparse.Namespace) -> bool:
    if getattr(args, "enable", False):
        return True
    return os.environ.get("ARAH_TRACE_ENABLED", "").strip() == "1"


def disabled_notice(command: str) -> None:
    _log.section(f"trace capture disabled ({command} skipped)", stream=sys.stderr)
    _log.detail(
        "agent trajectory capture is opt-in and stores data only on this machine",
        stream=sys.stderr,
    )
    _log.detail("enable with: export ARAH_TRACE_ENABLED=1   (or pass --enable)", stream=sys.stderr)


def trace_dir_for(args: argparse.Namespace) -> Path:
    if getattr(args, "trace_dir", None):
        return Path(args.trace_dir).resolve()
    if not getattr(args, "repo_root", None) or not getattr(args, "trial_id", None):
        raise ValueError("provide --trace-dir, or both --repo-root and --trial-id")
    return (
        Path(args.repo_root).resolve()
        / ".autoresearch"
        / "mine"
        / "traces"
        / str(args.trial_id)
    )


def traces_root_for(args: argparse.Namespace) -> Path:
    if not getattr(args, "repo_root", None):
        raise ValueError("--repo-root is required")
    return Path(args.repo_root).resolve() / ".autoresearch" / "mine" / "traces"


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Replace known secret shapes. Best-effort only — see module docstring."""
    hits: dict[str, int] = {}
    out = text
    for label, pattern in REDACTION_PATTERNS:
        out, count = pattern.subn(f"[REDACTED:{label}]", out)
        if count:
            hits[label] = hits.get(label, 0) + count
    return out, hits


def read_text_input(args: argparse.Namespace) -> str:
    sources = [bool(args.text is not None), bool(args.text_file), bool(args.stdin)]
    if sum(1 for s in sources if s) != 1:
        raise ValueError("provide exactly one of --text, --text-file, --stdin")
    if args.text is not None:
        return args.text
    if args.text_file:
        return Path(args.text_file).read_text(encoding="utf-8", errors="replace")
    return sys.stdin.read()


def sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def read_events(events_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not events_path.is_file():
        return rows
    with open(events_path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"{events_path}:{lineno}: {e}") from e
            if not isinstance(obj, dict):
                raise ValueError(f"{events_path}:{lineno}: event must be a JSON object")
            rows.append(obj)
    return rows


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def cmd_append(args: argparse.Namespace) -> int:
    if not capture_enabled(args):
        disabled_notice("append")
        emit({"captured": False, "reason": "disabled"})
        return 0

    trace_dir = trace_dir_for(args)
    events_path = trace_dir / EVENTS_FILE
    raw = read_text_input(args)
    if args.max_chars > 0 and len(raw) > args.max_chars:
        raw = raw[: args.max_chars] + f"\n[TRUNCATED after {args.max_chars} chars]"

    text, hits = (raw, {}) if args.no_redact else redact(raw)
    existing = read_events(events_path)
    seq = len(existing) + 1
    event: dict[str, Any] = {
        "seq": seq,
        "ts": utc_now(),
        "type": args.type,
        "role": args.role,
        "tool_name": args.tool_name,
        "text": text,
        "chars": len(text),
        "redactions": sum(hits.values()),
    }
    if hits:
        event["redaction_labels"] = hits
    if args.metadata:
        meta = json.loads(args.metadata)
        if not isinstance(meta, dict):
            raise ValueError("--metadata must be a JSON object")
        event["metadata"] = meta

    trace_dir.mkdir(parents=True, exist_ok=True)
    with open(events_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")

    _log.section(f"trace event {seq} appended", stream=sys.stderr)
    _log.detail(f"file: {events_path}", stream=sys.stderr)
    if args.no_redact:
        _log.fail("redaction disabled by --no-redact: raw text written to disk")
    elif hits:
        _log.detail(
            "redacted (best-effort, not a guarantee): "
            + ", ".join(f"{k}x{v}" for k, v in sorted(hits.items())),
            stream=sys.stderr,
        )
    emit(
        {
            "captured": True,
            "seq": seq,
            "eventsFile": str(events_path),
            "redactions": sum(hits.values()),
            "redactionGuarantee": "best-effort",
        }
    )
    return 0


def cmd_finalize(args: argparse.Namespace) -> int:
    if not capture_enabled(args):
        disabled_notice("finalize")
        emit({"finalized": False, "reason": "disabled"})
        return 0

    trace_dir = trace_dir_for(args)
    events_path = trace_dir / EVENTS_FILE
    if not events_path.is_file():
        raise ValueError(f"no trace events to finalize: {events_path}")

    license_id = args.license
    if not LICENSE_RE.fullmatch(license_id):
        raise ValueError(
            "--license must be an SPDX identifier (e.g. CC-BY-4.0, MIT, "
            f"CC0-1.0) or \"{PRIVATE_LICENSE}\""
        )

    events = read_events(events_path)
    hits_by_pattern: dict[str, int] = {}
    residual: dict[str, int] = {}
    for event in events:
        for label, count in (event.get("redaction_labels") or {}).items():
            hits_by_pattern[str(label)] = hits_by_pattern.get(str(label), 0) + int(count)
        # Second pass over the stored bytes so the summary reflects what is
        # actually on disk, including events appended with --no-redact.
        _, found = redact(str(event.get("text", "")))
        for label, count in found.items():
            residual[label] = residual.get(label, 0) + count

    digest, size = sha256_file(events_path)
    trial_id = args.trial_id or trace_dir.name
    inline = events if args.inline_events else []

    record: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "trial_id": trial_id,
        "captured_at": events[0]["ts"] if events else utc_now(),
        "finalized_at": utc_now(),
        "agent": args.agent,
        "agent_version": args.agent_version,
        "model": args.model,
        "protocol_bundle_id": args.protocol_bundle_id,
        "event_count": len(events),
        "events": inline,
        "event_files": [
            {
                "path": EVENTS_FILE,
                "sha256": digest,
                "size_bytes": size,
                "content_type": "application/x-ndjson",
            }
        ],
        "sha256": digest,
        "size_bytes": size,
        "redaction": {
            "enabled": not args.no_redact,
            "patterns": [label for label, _ in REDACTION_PATTERNS],
            "hits": sum(int(e.get("redactions", 0) or 0) for e in events),
            "hits_by_pattern": hits_by_pattern,
            "residual_hits_by_pattern": residual,
            "guarantee": "best-effort",
        },
        "owner_pubkey": args.owner_pubkey,
        "license": {
            "id": license_id,
            "url": args.license_url,
            "notice": args.license_notice,
        },
        "upload": {
            "status": "local",
            "network": None,
            "irys_id": None,
            "gateway_uri": None,
            "uploaded_at": None,
            "artifact_role": None,
            "error": None,
        },
    }
    if args.notes:
        record["notes"] = args.notes

    record_path = trace_dir / RECORD_FILE
    record_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    _log.section(f"trace finalized for trial {trial_id}", stream=sys.stderr)
    _log.detail(f"events: {len(events)}  bytes: {size}  sha256: {digest}", stream=sys.stderr)
    _log.detail(f"owner: {args.owner_pubkey or '(unset)'}  license: {license_id}", stream=sys.stderr)
    _log.detail(f"record: {record_path}", stream=sys.stderr)
    _log.detail(
        "redaction is best-effort pattern matching, not a guarantee - review before upload",
        stream=sys.stderr,
    )
    if residual:
        _log.fail(
            "secret-shaped text still present in the stored bundle: "
            + ", ".join(f"{k}x{v}" for k, v in sorted(residual.items()))
        )
    _log.ok("trace stays local until you run upload_trace_irys.mjs --yes", stream=sys.stderr)

    emit(
        {
            "finalized": True,
            "traceDir": str(trace_dir),
            "recordFile": str(record_path),
            "eventCount": len(events),
            "sha256": digest,
            "sizeBytes": size,
            "license": license_id,
            "ownerPubkey": args.owner_pubkey,
            "uploadStatus": "local",
        }
    )
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    trace_dir = trace_dir_for(args)
    events_path = trace_dir / EVENTS_FILE
    record_path = trace_dir / RECORD_FILE
    record = None
    if record_path.is_file():
        record = json.loads(record_path.read_text(encoding="utf-8"))
    emit(
        {
            "enabled": capture_enabled(args),
            "traceDir": str(trace_dir),
            "exists": trace_dir.is_dir(),
            "eventCount": len(read_events(events_path)),
            "finalized": record is not None,
            "sha256": (record or {}).get("sha256"),
            "license": ((record or {}).get("license") or {}).get("id"),
            "ownerPubkey": (record or {}).get("owner_pubkey"),
            "uploadStatus": ((record or {}).get("upload") or {}).get("status", "local"),
        }
    )
    return 0


def cmd_purge(args: argparse.Namespace) -> int:
    targets: list[Path]
    if args.all:
        root = traces_root_for(args)
        targets = sorted(p for p in root.glob("*") if p.is_dir()) if root.is_dir() else []
    else:
        target = trace_dir_for(args)
        targets = [target] if target.is_dir() else []

    if not args.yes:
        _log.fail("refusing to delete without --yes")
        emit({"deleted": [], "reason": "missing --yes", "wouldDelete": [str(p) for p in targets]})
        return 1

    deleted: list[str] = []
    for target in targets:
        shutil.rmtree(target)
        deleted.append(str(target))
        _log.detail(f"deleted {target}", stream=sys.stderr)
    _log.ok(f"purged {len(deleted)} trace director{'y' if len(deleted) == 1 else 'ies'}", stream=sys.stderr)
    emit({"deleted": deleted})
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--repo-root", default=os.environ.get("AUTORESEARCH_REPO_ROOT"))
        sp.add_argument("--trial-id", default=None)
        sp.add_argument("--trace-dir", default=None, help="Override the resolved trace directory")

    sp = sub.add_parser("append", help="Redact and append one trace event")
    add_common(sp)
    sp.add_argument("--enable", action="store_true", help="Opt in for this invocation")
    sp.add_argument("--type", choices=EVENT_TYPES, required=True)
    sp.add_argument("--role", default=None, help="Optional speaker label (user, assistant, system)")
    sp.add_argument("--tool-name", default=None, help="Tool name for tool_call / tool_result events")
    sp.add_argument("--text", default=None)
    sp.add_argument("--text-file", default=None)
    sp.add_argument("--stdin", action="store_true", help="Read the event text from stdin")
    sp.add_argument("--metadata", default=None, help="Extra JSON object stored with the event")
    sp.add_argument("--max-chars", type=int, default=int(os.environ.get("ARAH_TRACE_MAX_CHARS", "200000")))
    sp.add_argument("--no-redact", action="store_true", help="Store text verbatim (not recommended)")
    sp.set_defaults(func=cmd_append)

    sp = sub.add_parser("finalize", help="Hash the bundle and write trace.json")
    add_common(sp)
    sp.add_argument("--enable", action="store_true", help="Opt in for this invocation")
    sp.add_argument("--agent", required=True, help="Name of the coding agent that produced the session")
    sp.add_argument("--agent-version", default=None)
    sp.add_argument("--model", default=None)
    sp.add_argument("--protocol-bundle-id", default=None)
    sp.add_argument(
        "--license",
        default=os.environ.get("ARAH_TRACE_LICENSE", PRIVATE_LICENSE),
        help=f"SPDX identifier the miner licenses the trace under, or {PRIVATE_LICENSE} (default)",
    )
    sp.add_argument("--license-url", default=None)
    sp.add_argument("--license-notice", default=None, help="Attribution / notice line to carry with the data")
    sp.add_argument(
        "--owner-pubkey",
        default=os.environ.get("ARAH_TRACE_OWNER"),
        help="Miner public key asserted as owner of the trace",
    )
    sp.add_argument("--notes", default=None)
    sp.add_argument("--inline-events", action="store_true", help="Embed events in trace.json as well")
    sp.add_argument("--no-redact", action="store_true", help="Record redaction as disabled")
    sp.set_defaults(func=cmd_finalize)

    sp = sub.add_parser("status", help="Print trace directory state (works while disabled)")
    add_common(sp)
    sp.add_argument("--enable", action="store_true", help=argparse.SUPPRESS)
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("purge", help="Delete local traces (works while disabled)")
    add_common(sp)
    sp.add_argument("--enable", action="store_true", help=argparse.SUPPRESS)
    sp.add_argument("--all", action="store_true", help="Delete every trace directory under the repo")
    sp.add_argument("--yes", action="store_true", help="Required to actually delete")
    sp.set_defaults(func=cmd_purge)

    args = p.parse_args()
    try:
        return int(args.func(args))
    except (OSError, ValueError, json.JSONDecodeError) as e:
        _log.fail(str(e))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
