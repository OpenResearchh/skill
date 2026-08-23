#!/usr/bin/env python3
"""Submit a committed winning trial as a proposal.

Two artifact models, and it matters which contract each one targets:

**Git mode (default).** The commits *are* the artifact. The proposal carries
``base_commit`` -> ``head_commit`` plus a ``tree_hash``, and nothing is packed
or uploaded: the miner pushes a candidate branch with
``push_candidate_branch.sh`` and the verifier fetches the commit. Stellar, the
default settlement layer, stores a GitRef and this mode submits live.
``GIT_ARTIFACT_CHAINS`` is the list of layers whose deployed contract accepts
these fields. Other layers still exit 3 after writing the payload, rather than
silently packing a tarball that would hide which artifact was committed.

**Legacy mode (``--legacy-artifact``).** Solana and 0G contracts that still
expect uploaded archives: ``git archive`` the tree into a tar, hash it, upload
it to permanent storage, and submit a storage id alongside the benchmark log.
It also records the git ref of the same commit in ``submission.json``.

Both modes refuse to run against a dirty tree. A proposal commits to the tree
at a commit; an uncommitted edit means the miner measured something the
verifier will never see.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from _git_safe import GIT_SAFE_ENV  # noqa: E402
import chain as chain_mod  # noqa: E402
import repo_identity  # noqa: E402
from env_utils import env_or_default_stake, load_dotenv_from_cwd  # noqa: E402

# Settlement layers whose deployed contract stores a GitRef (repo / commit /
# tree_hash) instead of a storage id. Add the layer name here and wire its
# adapter flags in `git_submit_command` at the same time.
GIT_ARTIFACT_CHAINS: frozenset[str] = frozenset({"stellar"})

# Mirrors the transport allowlist in scripts/git_artifacts.mjs: only remotes
# that authenticate the server, and nothing that can execute a command.
ALLOWED_REMOTE_PREFIXES = ("https://", "ssh://", "git@")

# Set by a git-mode bootstrap to record which commit the working tree started
# from. A private ref namespace, so it never shows up as a branch.
BASE_REF = "refs/openresearch/base"


def run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    capture: bool = False,
    git: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        env=GIT_SAFE_ENV if git else None,
    )


def git_out(repo_root: Path, args: list[str]) -> str:
    return run(["git", *args], cwd=repo_root, capture=True, git=True).stdout.strip()


def git_try(repo_root: Path, args: list[str]) -> str | None:
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        text=True,
        capture_output=True,
        env=GIT_SAFE_ENV,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def git_clean_tracked(repo_root: Path) -> bool:
    return git_out(repo_root, ["status", "--porcelain", "--untracked-files=no"]) == ""


def git_head(repo_root: Path, rev: str = "HEAD") -> str:
    return git_out(repo_root, ["rev-parse", "--verify", f"{rev}^{{commit}}"])


def create_code_archive(repo_root: Path, output: Path, commit: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run(
        ["git", "archive", "--format=tar", "--output", str(output), commit],
        cwd=repo_root,
        git=True,
    )


def tree_hash(repo_root: Path, commit: str) -> str:
    """Canonical SHA-256 tree commitment, via the shared implementation.

    Shelling out to tree_hash.py rather than reimplementing it is the point:
    the miner and the verifier must produce identical bytes, so there can only
    be one definition of this digest in the repo.
    """
    result = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "tree_hash.py"), "--repo-root", str(repo_root), "--commit", commit],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "tree_hash failed").strip())
    return result.stdout.strip()


def assert_allowed_remote(url: str) -> str:
    value = str(url or "")
    if not any(value.startswith(p) for p in ALLOWED_REMOTE_PREFIXES):
        raise ValueError(
            f"refusing remote '{value}': only https, ssh, or scp-style git remotes are allowed"
        )
    if value.startswith("ext::") or "--upload-pack" in value:
        raise ValueError(f"refusing remote '{value}': transport would execute a command")
    return value


def resolve_remote_url(repo_root: Path, remote: str) -> str:
    """Accept either a configured remote name or a URL."""
    configured = git_try(repo_root, ["remote", "get-url", remote])
    return assert_allowed_remote(configured or remote)


def repo_commitment(remote_url: str) -> tuple[str, str]:
    """Return (canonical "host/owner/repo", sha256 hex of it).

    Delegates to the shared implementation. The researcher publishing a project,
    the miner submitting against it, and the verifier scoring it must all derive
    the same identity from the same repository; two implementations of this would
    silently produce different project ids and nothing would ever match.
    """
    result = repo_identity.identity(remote_url)
    return result["canonical"], result["repoId"]

def commit_is_published(repo_root: Path, remote_url: str, commit: str) -> bool:
    """True when some ref on the remote points at this exact commit.

    A branch name is mutable; the commit id is what the proposal commits to. So
    the check is "is this object reachable from a ref tip", not "does branch X
    exist".
    """
    listing = git_try(repo_root, ["ls-remote", remote_url])
    if listing is None:
        return False
    return any(line.split("\t", 1)[0].strip() == commit for line in listing.splitlines() if line.strip())


def resolve_base_commit(repo_root: Path, explicit: str | None, remote: str) -> str:
    """Find the commit this candidate branched from.

    Order, first match wins: explicit flag, the private ref a git-mode
    bootstrap leaves behind, the tracked upstream, then the remote's default
    branch. There is no final guess: an invented base_commit produces a
    proposal that claims a diff the miner never made, so this errors instead.
    """
    if explicit:
        return git_head(repo_root, explicit)
    for candidate in (BASE_REF, "@{upstream}", f"{remote}/HEAD"):
        resolved = git_try(repo_root, ["rev-parse", "--verify", f"{candidate}^{{commit}}"])
        if not resolved:
            continue
        if candidate == BASE_REF:
            return resolved
        merge_base = git_try(repo_root, ["merge-base", "HEAD", resolved])
        if merge_base:
            return merge_base
    raise ValueError(
        "cannot determine base_commit: pass --base-commit with the commit this "
        f"candidate branched from (a git-mode bootstrap records it at {BASE_REF})"
    )


def git_submit_command(args: argparse.Namespace, git_ref: dict[str, str], trial_log: Path) -> list[str]:
    """Adapter invocation for a layer whose contract stores a GitRef."""
    if args.chain == "stellar":
        cmd = [
            "node",
            str(SCRIPT_DIR / "submit_proposal_stellar.mjs"),
            "--project-id",
            str(args.project_id),
            "--repo-root",
            str(args.repo_root),
            "--head-commit",
            git_ref["head_commit"],
            "--base-commit",
            git_ref["base_commit"],
            "--repo-url",
            git_ref["remote_url"],
            "--claimed-metric",
            args.claimed_metric,
            "--metric-scale",
            str(args.metric_scale),
            "--stake",
            args.stake,
            "--reward-recipient",
            args.reward_recipient,
        ]
        if args.stellar_secret_key_file:
            cmd.extend(["--secret-key-file", args.stellar_secret_key_file])
        if args.stellar_miner:
            cmd.extend(["--miner", args.stellar_miner])
        if args.yes:
            cmd.append("--yes")
        if args.dry_run:
            cmd.append("--dry-run")
        return cmd
    raise NotImplementedError(
        f"no git-artifact adapter is wired for chain '{args.chain}'"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Submit a committed winning trial as a proposal. Default: git mode "
            "(base_commit/head_commit/tree_hash). Stellar, the default settlement "
            "layer, accepts this payload. Pass --legacy-artifact to submit a tar + "
            "storage id to Solana or 0G contracts that still expect uploaded archives."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Artifact modes:\n"
            "  (default)          git mode. Requires the head commit to already be\n"
            "                     pushed. On Stellar this is submitted on-chain.\n"
            "  --legacy-artifact  tar + permanent-storage id for Solana/0G contracts.\n"
        ),
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
    parser.add_argument(
        "--legacy-artifact",
        action="store_true",
        help="Submit a tar + storage id to the deployed contract instead of a git ref.",
    )
    parser.add_argument(
        "--head-commit",
        default="HEAD",
        help="Commit the proposal points at (git mode; default HEAD).",
    )
    parser.add_argument(
        "--base-commit",
        help="Commit this candidate branched from (git mode; auto-detected when omitted).",
    )
    parser.add_argument(
        "--remote",
        default=os.environ.get("ARAH_PUSH_REMOTE", "origin"),
        help="Project repo remote name or URL used to confirm the commit is published.",
    )
    parser.add_argument(
        "--allow-unpushed",
        action="store_true",
        help="Skip the published-commit check (diagnostics only; a verifier cannot fetch it).",
    )
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
    parser.add_argument("--solana-code-irys-id", help="Storage id for the submitted code archive (legacy mode).")
    parser.add_argument(
        "--solana-benchmark-log-irys-id",
        help="Storage id for the submitted benchmark log (legacy mode).",
    )
    parser.add_argument("--solana-buy-lamports", help="Override lamports sent to Solana buy() when stake tokens are missing.")
    parser.add_argument("--solana-buy-slippage-bps", help="Slippage added to the quoted Solana missing-stake buy.")
    parser.add_argument(
        "--solana-allow-missing-irys-ids",
        action="store_true",
        help="Submit zero storage ids for legacy dry-runs only.",
    )
    parser.add_argument("--yes", action="store_true", help="Confirm live transaction submission.")
    parser.add_argument("--stellar-secret-key-file", help="Stellar secret key file for live git-mode submit.")
    parser.add_argument("--stellar-miner", help="Stellar public key for dry-run without a secret key file.")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def legacy_command(args: argparse.Namespace, code_tar: Path, trial_log: Path) -> list[str]:
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
        return cmd

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
    return cmd


def stellar_git_ref(repo_root: Path, commit: str, remote_url: str) -> dict[str, str]:
    result = subprocess.run(
        [
            "node",
            str(SCRIPT_DIR / "stellar_open_research.mjs"),
            "git-ref",
            "--repo-root",
            str(repo_root),
            "--commit",
            commit,
            "--repository",
            remote_url,
        ],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "stellar git-ref failed").strip())
    payload = json.loads(result.stdout)
    return {
        "repo": payload["repo"],
        "commit": payload["commit"],
        "tree_hash": payload["treeHash"],
        "commit_algo": payload.get("commitAlgo", "sha1"),
    }


def collect_git_ref(args: argparse.Namespace, repo_root: Path, head: str) -> dict[str, str]:
    remote_url = resolve_remote_url(repo_root, args.remote)
    if args.chain == "stellar":
        stellar = stellar_git_ref(repo_root, head, remote_url)
        return {
            "repo": stellar["repo"],
            "repo_hash": stellar["repo"],
            "remote_url": remote_url,
            "base_commit": resolve_base_commit(repo_root, args.base_commit, args.remote),
            "head_commit": head,
            "tree_hash": stellar["tree_hash"],
            "hash_algo": 0 if stellar.get("commit_algo") != "sha256" else 1,
            "tree_hash_algorithm": "stellar-client",
        }
    canonical, repo_hash = repo_commitment(remote_url)
    return {
        "repo": canonical,
        "repo_hash": repo_hash,
        "remote_url": remote_url,
        "base_commit": resolve_base_commit(repo_root, args.base_commit, args.remote),
        "head_commit": head,
        "tree_hash": tree_hash(repo_root, head),
        "hash_algo": 0,
    }


def main() -> int:
    load_dotenv_from_cwd()
    parser = build_parser()
    args = parser.parse_args()

    try:
        args.chain = chain_mod.resolve_chain(args.chain, args.repo_root)
    except ValueError as exc:
        parser.error(str(exc))
    chain_mod.chain_detail(f"submit proposal via {args.chain} adapter")

    if args.legacy_artifact and args.chain == "0g" and not args.wallet_id:
        parser.error("--wallet-id is required for --chain 0g")
    if args.chain == "solana" and args.token_address:
        parser.error("--chain solana requires --project-id; --token-address is 0G-only")
    if args.chain == "stellar" and args.token_address:
        parser.error("--chain stellar requires --project-id; --token-address is 0G-only")
    if args.chain == "stellar" and not args.legacy_artifact and not args.dry_run and not args.stellar_secret_key_file:
        parser.error("--stellar-secret-key-file is required for live Stellar git-mode submit")

    repo_root = args.repo_root.expanduser().resolve()
    trial_log = repo_root / ".autoresearch" / "mine" / "runs" / args.trial_id / "stdout.log"
    if not trial_log.is_file():
        print(f"trial stdout log missing: {trial_log}", file=sys.stderr)
        return 1

    submission_dir = repo_root / ".autoresearch" / "mine" / "submissions" / args.trial_id

    try:
        if not git_clean_tracked(repo_root):
            print("repo has uncommitted tracked changes; commit the winning trial before submitting", file=sys.stderr)
            return 1
        head = git_head(repo_root, args.head_commit)

        if args.legacy_artifact:
            code_tar = submission_dir / "repo-snapshot.tar"
            create_code_archive(repo_root, code_tar, head)
            # Recorded, not submitted: the deployed contract has no GitRef
            # fields, but keeping the commit next to the tar is what lets a
            # legacy submission be correlated with its commit later.
            try:
                git_ref = collect_git_ref(args, repo_root, head)
            except (ValueError, RuntimeError) as exc:
                git_ref = {"unavailable": str(exc)}

            result = run(legacy_command(args, code_tar, trial_log), cwd=SCRIPT_DIR, capture=True)
            submission = {
                "schemaVersion": "1",
                "artifact_model": "legacy-archive",
                "trial_id": args.trial_id,
                "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "git_head": head,
                "git_ref": git_ref,
                "code_file": str(code_tar),
                "benchmark_log_file": str(trial_log),
                "claimed_metric": args.claimed_metric,
                "stake": args.stake,
                "reward_recipient": args.reward_recipient,
                "chain": args.chain,
                "dry_run": args.dry_run,
                "submit_output": result.stdout,
            }
            submission_dir.mkdir(parents=True, exist_ok=True)
            (submission_dir / "submission.json").write_text(json.dumps(submission, indent=2) + "\n", encoding="utf-8")
            print(result.stdout, end="")
            print(str((submission_dir / "submission.json").resolve()))
            return 0

        # Git mode.
        git_ref = collect_git_ref(args, repo_root, head)
        published = args.allow_unpushed or commit_is_published(
            repo_root, git_ref["remote_url"], head
        )
        if not published:
            print(
                f"commit {head} is not published on {git_ref['repo']}; run "
                "push_candidate_branch.sh before submitting so a verifier can fetch it",
                file=sys.stderr,
            )
            return 4

        proposal = {
            "schemaVersion": "2",
            "artifact_model": "git",
            "trial_id": args.trial_id,
            "utc_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "project_id": args.project_id,
            "chain": args.chain,
            "repo": git_ref["repo"],
            "repo_hash": git_ref["repo_hash"],
            "base_commit": git_ref["base_commit"],
            "head_commit": git_ref["head_commit"],
            "tree_hash": git_ref["tree_hash"],
            "hash_algo": git_ref["hash_algo"],
            "published": bool(published) and not args.allow_unpushed,
            "benchmark_log_file": str(trial_log),
            "claimed_metric": args.claimed_metric,
            "metric_scale": args.metric_scale,
            "stake": args.stake,
            "reward_recipient": args.reward_recipient,
            "dry_run": args.dry_run,
        }
        submission_dir.mkdir(parents=True, exist_ok=True)
        proposal_path = submission_dir / "proposal.json"
        proposal_path.write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf-8")

        print(f"repo={git_ref['repo']}")
        print(f"repo_hash={git_ref['repo_hash']}")
        print(f"base_commit={git_ref['base_commit']}")
        print(f"head_commit={git_ref['head_commit']}")
        print(f"tree_hash={git_ref['tree_hash']}")
        print(str(proposal_path.resolve()))

        if args.chain not in GIT_ARTIFACT_CHAINS:
            print(
                f"chain '{args.chain}' has no deployed contract that stores a git ref; "
                "the proposal above was computed but not submitted. Re-run with "
                "--legacy-artifact to submit to the contract deployed today.",
                file=sys.stderr,
            )
            return 0 if args.dry_run else 3

        result = run(git_submit_command(args, git_ref, trial_log), cwd=SCRIPT_DIR, capture=True)
        proposal["submit_output"] = result.stdout
        proposal_path.write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf-8")
        print(result.stdout, end="")
        return 0
    except subprocess.CalledProcessError as e:
        if e.stdout:
            print(e.stdout, file=sys.stderr, end="")
        return e.returncode or 1
    except (ValueError, RuntimeError, NotImplementedError) as e:
        print(str(e), file=sys.stderr)
        return 1
    except OSError as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
