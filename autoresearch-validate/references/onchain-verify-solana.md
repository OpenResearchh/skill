# Solana OpenResearch — verifier path

This is the reference for the `solana` settlement layer. Select it with
`--chain solana`, `ARAH_CHAIN=solana`, or `.autoresearch/chain.json`; it is also
the default when nothing is configured.

The workflow calls `scripts/validate_loop.mjs`, which delegates here:

| Neutral entrypoint | Adapter | Flag translation |
|---|---|---|
| `scripts/validate_loop.mjs` | `scripts/run_validate_loop_solana.mjs` | `--identity` → `--keypair` |

Adapter flags pass straight through: `--token-address`, `--once`, `--yes`,
`--dry-run`, `--poll-seconds`, `--work-dir`, `--record-root`, `--cluster`,
`--rpc-url`, `--program-id`.

Prerequisites specific to this layer: Node dependencies installed
(`npm install`), the Solana CLI on PATH (`solana --version` must succeed —
install it before proceeding), and a Solana keypair able to sign and pay gas.
The validator wallet must also have a verifier PDA/account; if it is not
registered, the loop stops and reports that without sending transactions.

Solana verification must validate the same benchmark claims as the legacy 0G
path, but the chain and artifact assumptions change.

## Causation From Solana Create

`autoresearch-create` now writes project artifacts to Irys and stores raw
SHA-256 artifact hashes plus 32-byte Irys transaction ids in the Solana project
account. Miner proposals store the same hash/id pair for proposal artifacts.
Therefore a verifier
must:

1. Read project and proposal accounts from the OpenResearch Solana program.
2. Resolve project bootstrap artifacts from the on-chain Irys ids, then verify
   the on-chain hashes.
3. Resolve proposal code and benchmark-log artifacts from their on-chain Irys
   ids, then verify the on-chain hashes.
4. Recompute SHA-256 over downloaded bytes before running the harness.
5. Upload verifier metrics/evidence to Irys and pass `metrics_irys_id` with
   approve/reject.
6. Approve/reject/release/expire via Solana instructions, not 0G
   `ProposalLedger` calls.

## What Can Be Reused

The verifier can keep these existing local checks:

- artifact SHA-256 verification,
- tarball extraction hardening,
- `protocol.json` hash comparison,
- static gates,
- sandboxed benchmark rerun,
- metric parsing and scaled integer comparison,
- append-only review records.

## What Must Change

- Replace `ProjectRegistry.getProject` with Solana `Project` account fetch.
- Replace `ProposalLedger.getProposal` with Solana `Proposal` account fetch.
- Replace `VerifierRegistry.isVerifier` with the verifier PDA/account check.
- Replace `claimReview`, `approve`, `reject`, `releaseReview`, and `expire`
  EVM transactions with Solana instructions.
- Replace EVM keystore signing with Solana wallet/keypair signing.
- Replace 0G artifact index defaults with Irys resolution where proposal
  artifacts are published to Irys.

## Validator Loop

For normal operation, run the neutral entrypoint:

```bash
node scripts/validate_loop.mjs \
  --project-id <project_id> \
  --identity ~/.config/solana/id.json \
  --yes
```

This layer can also start from the project token mint; `--token-address` passes
straight through:

```bash
node scripts/validate_loop.mjs \
  --token-address <PROJECT_TOKEN_MINT> \
  --identity ~/.config/solana/id.json \
  --yes
```

The adapter resolves and prints the project first. It checks `solana --version`,
the keypair address/balance, and the validator PDA. If the wallet is not a
registered verifier, it stops without sending transactions.

The loop is claim-first: it sends `claim-review` for a pending staked proposal,
and only if that transaction succeeds does it download artifacts, set up the
sandboxed verification run, and settle. Before scoring, it fetches the
**project's own** `protocol.json` and benchmark harness with
`fetch_project_artifacts_solana.mjs` (by the Irys ids on the `Project` account,
hash-verified) and runs `restore_trusted_harness.py` over the submitted tree, so
the judge is never built out of the artifact being judged. Divergence on a
protocol-immutable path is tampering and is rejected with evidence.

Approve/reject always uploads the verifier metrics log or reject evidence to
Irys using the same Solana keypair before calling settlement; do not skip the
Irys step.

Score comparison uses aggregate-score semantics because the contract only
accepts increasing scores. `maximize` metrics are scaled directly; `minimize`
metrics are negated after scaling. With the default scale of `1_000_000`, a
minimized benchmark value of `1.981456` becomes aggregate score `-1981456`.

The loop settles on the verifier's own repeated-sample measurement against the
score the network already holds: approve when the verified aggregate score
clears the current best by `measurement.minScoreImprovementBips`, reject with
`no_improvement` evidence when it does not. The miner's
`claimedAggregateScore` is recorded in the review row but never gates the
outcome. A `run_verify_trial.sh` exit of 4 means the sample was too dispersed to
score on this host — release the review, do not reject.

## Manual Settlement

The skill bundles the full OpenResearch Anchor IDL at
`contracts/solana-open-research/open_research.json`. Use
`scripts/resolve_proposal_artifacts_solana.mjs` first to fetch the proposal
artifact ids from chain and download the exact Irys objects:

```bash
node scripts/resolve_proposal_artifacts_solana.mjs \
  --proposal-id <proposal_id> \
  --output-dir /tmp/arah-review/p<proposal_id> \
  --extract-code
```

Then use `scripts/settle_proposal_solana.mjs` after benchmark rerun:

```bash
node scripts/settle_proposal_solana.mjs \
  --action claim-review \
  --proposal-id <proposal_id> \
  --keypair ~/.config/solana/id.json \
  --yes

node scripts/settle_proposal_solana.mjs \
  --action approve \
  --proposal-id <proposal_id> \
  --verified-metric <metric> \
  --metrics-log-file .autoresearch/verify/runs/<review_id>/stdout.log \
  --metrics-irys-id <uploaded_metrics_id> \
  --keypair ~/.config/solana/id.json \
  --yes
```

Supported actions are `claim-review`, `release-review`, `approve`, `reject`,
`expire`, and `claim-reward`. Dry-runs can pass `--actor <pubkey>` instead of
`--keypair`; for approve/reject/expire dry-runs also pass `--project-id`, and
approve dry-runs pass `--miner` plus `--reward-recipient`.

## Remaining Follow-up

1. Add a dedicated event-based `watch_solana_proposals.mjs` instead of polling
   `nextProposalId`.
2. Extend review records with `chain`, `cluster`, `programId`, `projectPda`,
   and `proposalPda`.
