# GitHub Verification Bridge

This reference describes the GitHub-first coordination flow for OpenResearch
mining while preserving the settlement layer as the economic ledger.

## Goals

- Use GitHub repositories, branches, pull requests, and Actions as the primary
  discovery and verification surface for v1.
- Bind each settlement proposal to an exact repository, base commit, head
  commit, code snapshot, benchmark claim, stake, and pull request.
- Keep the chain responsible for contribution ownership, stake, rewards,
  slashing, and canonical settlement.
- Leave room for future TEE or pure-chain verifiers to consume the same
  proposal metadata and verification result shape.

## Where the workflow lives

This repository is the OpenResearch skills/protocol repository. It should ship
the GitHub verifier as a template, not run it as an active workflow for ordinary
maintenance PRs here.

Install this template into each mined project repository:

```text
autoresearch-validate/templates/openresearch-github-verifier.yml
```

Target path in the mined repository:

```text
.github/workflows/openresearch-github-verifier.yml
```

The template checks out the mined repository into `candidate/` and checks out
the OpenResearch verifier scripts into `openresearch/`, then runs verification
against the candidate checkout. Projects may pin `verifier_repo` and
`verifier_ref` in `workflow_dispatch` or by editing the installed workflow.

## Proposal-first binding

V1 uses a proposal-first order:

1. Miner clones the GitHub repository in a sandboxed workspace.
2. Miner creates one or more hypothesis branches or worktrees.
3. Miner runs the protocol benchmark and records wins and failures.
4. Miner snapshots the winning branch at an exact `head_sha`.
5. Miner submits the proposal with stake and artifact hashes/CIDs.
6. Miner opens the PR and embeds the proposal metadata in the PR body.
7. CI verifies the PR head, CID, benchmark claim, and integrity gates.
8. A trusted settlement bridge settles the on-chain proposal from the CI result.
9. A merge bot merges only after chain settlement and required checks agree.

The proposal cannot know the GitHub PR number before the PR exists. The PR must
therefore reference the proposal id immediately, and a later adapter may add a
`link_pr` operation to backfill the PR number on-chain.

## GitHub-bound proposal fields

The canonical machine-readable shape is
`autoresearch-mine/schemas/github_bound_proposal.schema.json`.

Required binding fields:

- `github.owner`, `github.repo`
- `github.base_branch`, `github.base_sha`
- `github.head_branch`, `github.head_sha`
- `proposal.proposal_id`, `proposal.stake`, `proposal.reward_recipient`
- `trial.trial_id`, `trial.primary_metric_name`, `trial.claimed_metric`
- `artifacts.code_hash`, `artifacts.benchmark_log_hash`

Nullable fields during proposal-first flow:

- `github.pr_number`
- `github.pr_url`
- `artifacts.code_cid`
- `artifacts.benchmark_log_cid`
- `artifacts.verification_result_cid`

## PR metadata block

`open_pr_with_evidence.sh` writes a fenced JSON block with this marker:

```text
```openresearch-proposal
{ ... GitHubBoundProposal ... }
```
```

CI and settlement tools must parse this block instead of scraping prose.

## Verification outcome semantics

GitHub Actions emits `verification-result.json`, defined by
`autoresearch-validate/schemas/verification_result.schema.json`.

Outcomes mirror the existing verifier policy:

- `approved`: deterministic checks pass and the benchmark improvement clears
  the required margin.
- `rejected`: miner-side fault, such as CID mismatch, static gate failure,
  harness tamper, no improvement, or benchmark gaming.
- `released`: ambiguous or infrastructure-sensitive failure, such as excessive
  measurement noise, missing sandbox runtime, or runner capacity failure.
- `operational_failure`: the verifier itself could not run correctly.

Only `approved` is eligible for auto-merge.

## CI trust boundary

Untrusted PR code must not receive settlement credentials. The recommended
split is:

1. A read-only PR workflow runs deterministic checks and writes
   `verification-result.json`.
2. A trusted bridge, GitHub App, or `workflow_run` follow-up reads the result,
   verifies the exact head SHA, and submits settlement transactions.
3. The merge bot re-checks the PR head SHA immediately before merge.

## Integrity validation

Integrity validation is not subjective style review. It is a deterministic or
policy-based anti-abuse layer that checks for:

- harmful code paths
- benchmark gaming
- harness or metric-parser tampering
- unexpected dependency and lockfile changes
- network or secret exfiltration attempts
- changes outside the protocol mutable surface
- project test regressions

These gates are intentionally separate from human maintainability preferences.

## Migration path

Roll out the bridge in stages so GitHub verification can harden before it is
allowed to settle funds or merge code:

1. **Metadata only:** miners submit proposals and open PRs with the
   `openresearch-proposal` block; CI parses it but does not block.
2. **Dry-run verification:** GitHub Actions runs `github_verify_pr.py`, uploads
   `verification-result.json`, and comments or reports the result without
   calling settlement.
3. **Required checks:** selected pilot repositories require the metadata,
   static gates, hash/CID checks, and benchmark jobs before review.
4. **Dry-run bridge:** a trusted bridge runs `settlement_bridge.py` and writes
   settlement plans, but does not send transactions.
5. **Settlement bridge:** the trusted bridge identity submits approve, reject,
   or release-review transactions based on CI output.
6. **Auto-merge:** a merge bot merges only when the exact PR head SHA still
   matches the approved proposal and branch protection checks are green.
7. **TEE augmentation:** TEE or pure-chain verifiers can consume the same
   `GitHubBoundProposal` and `verification-result.json` shapes, replacing or
   augmenting GitHub Actions without changing miner PR metadata.

During migration, keep the existing Irys/on-chain verifier path available as a
fallback for projects that have not opted into GitHub verification.
