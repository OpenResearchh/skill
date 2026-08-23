#!/usr/bin/env python3
"""Bind a code-hosting handle to the miner's chain address.

Mining pays to an address. An address is not a portfolio: a miner whose work
advanced a project's frontier has nothing on a real profile to show for it.
This binding is what turns an accepted proposal into public credit, because a
mirror can then attribute the merged commits to a person rather than to a
base58 string.

Three properties, all deliberate:

* **Optional.** Mining, submitting, and getting paid never require it. Nothing
  in settlement reads the binding, so a miner who wants to stay pseudonymous
  loses no reward.
* **Revocable.** ``--revoke`` emits the unlink payload. A binding that cannot
  be withdrawn is a doxxing hazard, not a feature.
* **Miner-signed.** The binding is authorized by the miner's own key, so no
  operator can attach someone else's handle to an address.

What this does *not* do: prove the miner controls the handle. The chain
learns "this address claims this handle"; the direction "this handle claims
this address" needs a matching public post from the account itself. The
printed plan says where that goes. Treat an unconfirmed binding as a claim.

**This requires the identity instructions from the contract spec
(``link_identity`` / ``unlink_identity``), which are not deployed on any
settlement layer yet.** The command therefore emits the exact payload and
prints the plan; it does not invent a contract call. ``--submit`` exits 3 to
say so rather than pretending.

Exit codes:
  0  payload written and plan printed
  1  bad arguments or IO failure
  3  --submit requested but no deployed contract has link_identity
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import chain as chain_mod  # noqa: E402

DOMAIN = "openresearch/identity/v1"

# Platform discriminants from the contract spec's Identity record.
PLATFORMS = {"github": 0}

# Settlement layers whose deployed contract has link_identity / unlink_identity.
# Empty until one ships; adding a name here without wiring the adapter would be
# worse than the current honest refusal.
IDENTITY_CHAINS: frozenset[str] = frozenset()

# GitHub handle rules: 1-39 chars, alphanumerics and single inner hyphens.
GITHUB_HANDLE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")


def validate_handle(platform: str, handle: str) -> str:
    if platform == "github" and not GITHUB_HANDLE.fullmatch(handle):
        raise ValueError(
            f"'{handle}' is not a valid GitHub handle "
            "(1-39 chars, alphanumerics and single inner hyphens)"
        )
    return handle


def canonical_message(payload: dict[str, str]) -> str:
    """The exact bytes the miner signs.

    Field order is fixed and the domain line is first, so a signature over this
    message cannot be replayed as a signature over anything else the protocol
    asks a miner to sign.
    """
    lines = [DOMAIN]
    for key in ("action", "platform", "handle", "address", "chain", "issued_at", "nonce"):
        lines.append(f"{key}: {payload[key]}")
    return "\n".join(lines) + "\n"


def build_payload(args: argparse.Namespace) -> dict[str, object]:
    action = "unlink" if args.revoke else "link"
    handle = "" if args.revoke and not args.handle else validate_handle(args.platform, args.handle)
    fields = {
        "action": action,
        "platform": args.platform,
        "handle": handle,
        "address": args.address,
        "chain": args.chain,
        "issued_at": args.issued_at,
        "nonce": args.nonce,
    }
    message = canonical_message(fields)
    return {
        "schemaVersion": "1",
        "domain": DOMAIN,
        **fields,
        "platform_code": PLATFORMS[args.platform],
        "message": message,
        "message_sha256": hashlib.sha256(message.encode("utf-8")).hexdigest(),
    }


def print_plan(payload: dict[str, object], chain: str, submitted: bool) -> None:
    action = payload["action"]
    instruction = "unlink_identity()" if action == "unlink" else (
        f"link_identity(handle=\"{payload['handle']}\", platform={payload['platform_code']})"
    )
    print("--- plan ---", file=sys.stderr)
    print(f"1. Miner {payload['address']} signs the message below with the mining key.", file=sys.stderr)
    print(f"2. Miner calls {instruction} on the {chain} settlement layer.", file=sys.stderr)
    if action == "link":
        print(
            f"3. To make the claim two-sided, publish the same message from the "
            f"{payload['platform']} account '{payload['handle']}' (a public gist or a "
            "file in the project repo). Until then the binding is a claim, not a proof.",
            file=sys.stderr,
        )
    if not submitted:
        print(
            f"Step 2 is not available: the {chain} contract has no identity "
            "instruction yet. The payload above is ready for the moment it does.",
            file=sys.stderr,
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Emit a miner-signed payload binding a code-hosting handle to a chain "
            "address, so accepted work shows up on a real profile. Optional and "
            "revocable. Requires the identity instructions from the contract spec, "
            "which are not deployed yet."
        ),
    )
    parser.add_argument("--handle", help="Handle to bind (omit with --revoke).")
    parser.add_argument("--platform", choices=sorted(PLATFORMS), default="github")
    parser.add_argument("--address", required=True, help="Miner address on the settlement layer.")
    parser.add_argument("--chain", choices=chain_mod.SUPPORTED_CHAINS, default=None)
    parser.add_argument("--repo-root", type=Path, help="Repo whose .autoresearch/mine holds the payload.")
    parser.add_argument("--output", type=Path, help="Write the payload here instead.")
    parser.add_argument("--revoke", action="store_true", help="Emit the unlink payload instead.")
    parser.add_argument("--nonce", default=None, help="Replay nonce (random when omitted).")
    parser.add_argument(
        "--submit",
        action="store_true",
        help="Send the binding on-chain. Exits 3 until a layer deploys link_identity.",
    )
    args = parser.parse_args()

    if not args.revoke and not args.handle:
        parser.error("--handle is required unless --revoke is passed")

    try:
        args.chain = chain_mod.resolve_chain(args.chain, args.repo_root)
    except ValueError as exc:
        parser.error(str(exc))

    args.nonce = args.nonce or secrets.token_hex(16)
    args.issued_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        payload = build_payload(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if args.output:
        out_path = args.output.expanduser().resolve()
    elif args.repo_root:
        name = "unlink" if args.revoke else f"{args.platform}-{args.handle}"
        out_path = (
            args.repo_root.expanduser().resolve()
            / ".autoresearch"
            / "mine"
            / "identity"
            / f"{name}.json"
        )
    else:
        out_path = Path.cwd() / "link_identity.json"

    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(payload["message"], end="")
    print(str(out_path))

    submitted = args.submit and args.chain in IDENTITY_CHAINS
    print_plan(payload, args.chain, submitted)

    if args.submit and not submitted:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
