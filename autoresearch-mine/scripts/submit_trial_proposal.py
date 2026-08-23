#!/usr/bin/env python3
"""Package a committed winning trial and submit it on-chain."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from _git_safe import GIT_SAFE_ENV  # noqa: E402
import chain as chain_mod  # noqa: E402
from env_utils import env_or_default_stake, load_dotenv_from_cwd  # noqa: E402


def run(cmd: list[str], *, cwd: Path | None = None, capture: bool = False, git: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        env=GIT_SAFE_ENV if git else None,
    )


def git_clean_tracked(repo_root: Path) -> bool:
    result = run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo_root, capture=True, git=True)
    return result.stdout.strip() == ""


def git_head(repo_root: Path) -> str:
    return run(["git", "rev-parse", "HEAD"], cwd=repo_root, capture=True, git=True).stdout.strip()


def create_code_archive(repo_root: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "archive", "--format=tar", "--output", str(output), "HEAD"], cwd=repo_root, git=True)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def maybe_github_binding(args: argparse.Namespace, *, head: str) -> dict[str, object] | None:
    fields = {
        "owner": args.github_owner,
        "repo": args.github_repo,
        "base_branch": args.github_base_branch,
        "base_sha": args.github_base_sha,
        "head_branch": args.github_head_branch,
        "head_sha": args.github_head_sha or head,
        "pr_number": args.github_pr_number,
        "pr_url": args.github_pr_url,
    }
    if not any(v is not None for v in fields.values()):
        return None
    missing = [k for k in ("owner", "repo", "base_branch", "base_sha", "head_branch", "head_sha") if not fields[k]]
    if missing:
        raise ValueError(f"GitHub proposal binding is incomplete; missing: {', '.join(missing)}")
    return fields


def main() -> int:
    load_dotenv_from_cwd()

    parser = argparse.ArgumentParser(
        description="Archive the committed repo state for a trial and submit ProposalLedger.submit.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--project-id", type=int)
    source.add_argument("--token-address")
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--trial-id", required=True)
    parser.add_argument("--claimed-metric", required=True)
    parser.add_argument("--stake", default=env_or_default_stake())
    parser.add_argument("--reward-recipient", required=True)
    # Resolved after parsing so this shares one order with the Node entrypoints;
    # a default here would shadow .autoresearch/chain.json.
    parser.add_argument("--chain", choices=chain_mod.SUPPORTED_CHAINS, default=None)
    parser.add_argument("--wallet-id", help="0G mining wallet keystore id (scripts/wallet.py).")
    parser.add_argument("--passphrase-file", help="Path to a file with the wallet passphrase.")
    parser.add_argument("--metric-scale", type=int, default=int(os.environ.get("ARAH_METRIC_SCALE", "1000000")))
    parser.add_argument("--buy-value-wei", default="0")
    parser.add_argument("--auto-buy", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--solana-keypair", help="Solana keypair JSON for live Solana proposal submission.")
    parser.add_argument("--solana-miner", help="Solana miner pubkey for dry-run without a keypair.")
    parser.add_argument("--solana-idl", help="Override Anchor IDL for Solana proposal submission.")
    parser.add_argument("--solana-cluster", help="Solana cluster override.")
    parser.add_argument("--solana-rpc-url", help="Solana RPC URL override.")
    parser.add_argument("--solana-proposal-id", help="Proposal id override, mainly for dry-runs.")
    parser.add_argument("--solana-code-irys-id", help="Irys id for the submitted code archive.")
    parser.add_argument("--solana-benchmark-log-irys-id", help="Irys id for the submitted benchmark log.")
    parser.add_argument("--solana-buy-lamports", help="Override lamports sent to Solana buy() when stake tokens are missing.")
    parser.add_argument("--solana-buy-slippage-bps", help="Slippage added to the quoted Solana missing-stake buy.")
    parser.add_argument("--github-owner", help="GitHub owner/org for proposal-first PR binding.")
    parser.add_argument("--github-repo", help="GitHub repository name for proposal-first PR binding.")
    parser.add_argument("--github-base-branch", help="GitHub base branch the miner started from.")
    parser.add_argument("--github-base-sha", help="GitHub base commit SHA the miner started from.")
    parser.add_argument("--github-head-branch", help="GitHub miner branch containing the candidate.")
    parser.add_argument("--github-head-sha", help="GitHub candidate head SHA. Defaults to git HEAD.")
    parser.add_argument("--github-pr-number", type=int, help="GitHub PR number, normally filled after PR creation.")
    parser.add_argument("--github-pr-url", help="GitHub PR URL, normally filled after PR creation.")
    parser.add_argument("--code-cid", help="Content-addressed id for the submitted code snapshot.")
    parser.add_argument("--benchmark-log-cid", help="Content-addressed id for the submitted benchmark log.")
    parser.add_argument(
        "--solana-allow-missing-irys-ids",
        action="store_true",
        help="Submit zero Irys ids for legacy dry-runs only.",
    )
    parser.add_argument("--yes", action="store_true", help="Confirm live Solana transaction submission.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        args.chain = chain_mod.resolve_chain(args.chain, args.repo_root)
    except ValueError as exc:
        parser.error(str(exc))
    chain_mod.chain_detail(f"submit proposal via {args.chain} adapter")

    if args.chain == "0g" and not args.wallet_id:
        parser.error("--wallet-id is required for --chain 0g")
    if args.chain == "solana" and args.token_address:
        parser.error("--chain solana requires --project-id; --token-address is 0G-only")

    repo_root = args.repo_root.expanduser().resolve()
    trial_log = repo_root / ".autoresearch" / "mine" / "runs" / args.trial_id / "stdout.log"
    if not trial_log.is_file():
        print(f"trial stdout log missing: {trial_log}", file=sys.stderr)
        return 1

    try:
        if not git_clean_tracked(repo_root):
            print("repo has uncommitted tracked changes; commit the winning trial before submitting", file=sys.stderr)
            return 1
        head = git_head(repo_root)
        submission_dir = repo_root / ".autoresearch" / "mine" / "submissions" / args.trial_id
        code_tar = submission_dir / "repo-snapshot.tar"
        create_code_archive(repo_root, code_tar)
        github_binding = maybe_github_binding(args, head=head)

        if args.chain == "solana":
            cmd = [
                "node",
                str(SCRIPT_DIR / "submit_proposal_solana.mjs"),
                "--project-id",
                str(args.project_id),
                "--code-file",
                str(code_tar),
                "--benchmark-log-file",
                str(trial_log),
                "--claimed-metric",
                args.claimed_metric,
                "--metric-scale",
                str(args.metric_scale),
                "--stake",
                args.stake,
                "--reward-recipient",
                args.reward_recipient,
            ]
            if args.solana_keypair:
                cmd.extend(["--keypair", args.solana_keypair])
            if args.solana_miner:
                cmd.extend(["--miner", args.solana_miner])
            if args.solana_idl:
                cmd.extend(["--idl", args.solana_idl])
            if args.solana_cluster:
                cmd.extend(["--cluster", args.solana_cluster])
            if args.solana_rpc_url:
                cmd.extend(["--rpc-url", args.solana_rpc_url])
            if args.solana_proposal_id:
                cmd.extend(["--proposal-id", args.solana_proposal_id])
            if args.solana_code_irys_id:
                cmd.extend(["--code-irys-id", args.solana_code_irys_id])
            if args.solana_benchmark_log_irys_id:
                cmd.extend(["--benchmark-log-irys-id", args.solana_benchmark_log_irys_id])
            if args.solana_buy_lamports:
                cmd.extend(["--buy-lamports", args.solana_buy_lamports])
            if args.solana_buy_slippage_bps:
                cmd.extend(["--buy-slippage-bps", args.solana_buy_slippage_bps])
            if not args.auto_buy:
                cmd.append("--skip-buy")
            if args.solana_allow_missing_irys_ids:
                cmd.append("--allow-missing-irys-ids")
            if args.yes:
                cmd.append("--yes")
            if args.dry_run:
                cmd.append("--dry-run")
        else:
            cmd = [
                sys.executable,
                str(SCRIPT_DIR / "submit_proposal.py"),
                "--wallet-id",
                args.wallet_id,
                "--code-file",
                str(code_tar),
                "--benchmark-log-file",
                str(trial_log),
                "--claimed-metric",
                args.claimed_metric,
                "--metric-scale",
                str(args.metric_scale),
                "--stake",
                args.stake,
                "--reward-recipient",
                args.reward_recipient,
                "--buy-value-wei",
                args.buy_value_wei,
            ]
            if args.passphrase_file:
                cmd.extend(["--passphrase-file", args.passphrase_file])
            if args.project_id is not None:
                cmd.extend(["--project-id", str(args.project_id)])
            if args.token_address:
                cmd.extend(["--token-address", args.token_address])
            if args.auto_buy:
                cmd.append("--auto-buy")
            if args.dry_run:
                cmd.append("--dry-run")

        result = run(cmd, cwd=SCRIPT_DIR, capture=True)
        submission = {
            "schemaVersion": "1",
            "trial_id": args.trial_id,
            "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "git_head": head,
            "code_file": str(code_tar),
            "benchmark_log_file": str(trial_log),
            "claimed_metric": args.claimed_metric,
            "stake": args.stake,
            "reward_recipient": args.reward_recipient,
            "chain": args.chain,
            "dry_run": args.dry_run,
            "github": github_binding,
            "proposal": {
                "proposal_id": args.solana_proposal_id,
                "stake": args.stake,
                "reward_recipient": args.reward_recipient,
                "status": "submitted" if not args.dry_run else "unknown",
            },
            "artifacts": {
                "code_cid": args.code_cid or args.solana_code_irys_id,
                "code_hash": sha256_file(code_tar),
                "benchmark_log_cid": args.benchmark_log_cid or args.solana_benchmark_log_irys_id,
                "benchmark_log_hash": sha256_file(trial_log),
            },
            "submit_output": result.stdout,
        }
        (submission_dir / "submission.json").write_text(json.dumps(submission, indent=2) + "\n", encoding="utf-8")
        print(result.stdout, end="")
        print(str((submission_dir / "submission.json").resolve()))
        return 0
    except subprocess.CalledProcessError as e:
        if e.stdout:
            print(e.stdout, file=sys.stderr, end="")
        return e.returncode or 1
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    except OSError as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
