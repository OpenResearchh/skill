# Stellar OpenResearch verification

This is the verifier reference for the default `stellar` settlement layer.
`validate_loop.mjs` selects it unless `--chain`, `ARAH_CHAIN`, or
`.autoresearch/chain.json` says otherwise.

Read `../autoresearch-create/references/onchain-stellar.md` for network IDs,
GitRef hashing, and scoring.

## Identity

The verifier secret stays in a secured environment. Never embed it in a
frontend. The address must already be on the on-chain allowlist
(`is_verifier`). `add_verifier` is admin-only; this skill never calls it.
Ask the contract admin to add the address on-chain before starting the loop.

```bash
node scripts/stellar_open_research.mjs init-identity \
  --out ~/.config/stellar/arah-verifier.secret
```

`--identity` on `validate_loop.mjs` becomes `--secret-key-file` on the Stellar
adapter.

## Loop

```bash
node scripts/validate_loop.mjs \
  --project-id <id> \
  --identity ~/.config/stellar/arah-verifier.secret \
  --repo-url https://github.com/owner/repo.git \
  --yes
```

The adapter:

1. Confirms the signer is an active verifier and stops if not.
2. Reads `get_open_proposals`.
3. `claim_review` before any candidate fetch.
4. Fetches the candidate GitRef and verifies `tree_hash` with the Stellar client.
5. Materializes the **baseline** tree as the trusted harness and checks
   `protocol_hash`.
6. Restores immutable paths; divergence is tampering → `reject`.
7. Runs static gates; failure → `reject`.
8. Reruns the sandbox benchmark. Harness/parse/noise failures → `release_review`,
   not `reject`.
9. Refreshes `incumbent_score` / `improvement_threshold`. Genesis incumbent is
   `baseline_score` when `current_best.present` is false.
10. Approves with `isSufficient` (inclusive at a nonzero bips threshold).
11. After approve, merges without squash and `record_merge` via
    `approveMergeAndRecord`. Merge failure is approved-but-unmerged.

Reject is financially destructive (full stake slash). Use it only for
reproducible miner fault. Inconclusive host/parser/sandbox failures release.

## Settlement helpers

Do not call these from the workflow; the loop does:

- `fetch_project_artifacts_stellar.mjs`
- `resolve_proposal_artifacts_stellar.mjs`
- `settle_proposal_stellar.mjs`
- `run_validate_loop_stellar.mjs`
