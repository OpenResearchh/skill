# 0G Galileo — verifier (claim / approve / reject)

This is the reference for the `0g` settlement layer. Select it with `--chain 0g`,
`ARAH_CHAIN=0g`, or `.autoresearch/chain.json`.

The workflow calls `scripts/validate_loop.mjs`, which delegates here:

| Neutral entrypoint | Adapter | Flag translation |
|---|---|---|
| `scripts/validate_loop.mjs` | `scripts/run_validate_loop.py` | `--identity` → `--wallet-id` |

Adapter flags pass straight through: `--passphrase-file`, `--proposal-id`,
`--max-proposals`, `--dry-run`.

> **Adapter gap:** `run_validate_loop.py` has no `--project-id` and no `--once`.
> On this layer, either pass `--proposal-id <id>` for a single proposal or omit
> it and let the loop scan claimable ids, and cap the run with
> `--max-proposals` / `VALIDATE_MAX_PROPOSALS`.

Use with finalized deployments under `contracts/0g-galileo-testnet/`. Full publish flow: [`autoresearch-create/references/onchain-0g-galileo.md`](../../autoresearch-create/references/onchain-0g-galileo.md).

## Deployment

- Chain: 0G Galileo testnet, chain id **16602**
- RPC: `https://evmrpc-testnet.0g.ai` (overridable via `ARAH_RPC_URL`)
- `ProposalLedger` and `VerifierRegistry` addresses: see `deployment.json` in this skill

## Identity on this layer

The verifier identity is a passphrase-encrypted keystore:

```bash
python3 scripts/wallet.py init --id verifier-1
```

All settlement scripts (`claim_review.py`, `finalize_approve.py`,
`finalize_reject.py`, `release_review.py`, `expire_proposal.py`,
`run_validate_loop.py`) take **`--wallet-id`** + **`--passphrase-file`** (or
`ARAH_WALLET_PASSPHRASE`). They do **not** read `ARAH_PRIVATE_KEY`. Pass the
keystore id as `--identity <id>` to `validate_loop.mjs`.

`VerifierRegistry.isVerifier(your_address)` must be true before the loop will
send anything; check it with `scripts/check_verifier_eligibility.py`.

## Verifier path (ABI)

1. `VerifierRegistry.isVerifier(verifier)` must be true.
2. `ProposalLedger.claimReview(proposalId)`
3. `ProposalLedger.approve(proposalId, verifiedAggregateScore, metricsHash)` or `reject(proposalId, metricsHash)` or `releaseReview(proposalId)` (operational release) or `expire(proposalId)` (expiry window).

## Legacy pipeline ordering on this layer

This adapter resolves artifacts and compares the protocol hash **before**
claiming, which differs from the claim-first ordering in the skill's normative
pipeline:

1. **`getProposal`**: skip if `status` ∉ claimable set ([`constants/status_enum.json`](../constants/status_enum.json)).
2. **`artifact_resolve`**: fail → **skip** (no transaction), record `artifact_resolve_failed`.
3. Extract tarball; load **`protocol.json`** at `ARAH_PROTOCOL_SUBPATH`.
4. **Protocol hash**: `SHA-256(protocol.json)` vs `ProjectRegistry.getProject(projectId).protocolHash` unless skipped → mismatch → **`claimReview` + `reject`** (fraud).
5. Else **`claimReview`** → **`verify_static_gates`** → **`run_verify_trial`**.
6. Parse metric; compare the scaled integer to on-chain **`claimedAggregateScore`** (strict equality).
7. Outcomes:
   - **Match** → **`approve`** with `metricsHash = SHA-256(harness stdout log)`.
   - **Static-gate fail / metric mismatch / metric encode fail** → **`reject`** with the evidence file as metrics log (slashing — unambiguous miner-side faults).
   - **Harness exit ≠ 0 / metric not parseable from log** → **`releaseReview`** (NOT reject). These signals are ambiguous: they could be miner-side, but they could also be verifier-side (no sandbox runtime, image divergence, `networkPolicy=full` without `ARAH_ALLOW_FULL_NETWORK=1`). Slashing on those signals is unsafe; let another verifier try. If every verifier fails, the proposal eventually expires.

## Status enum (`uint8`)

The `getProposal` tuple includes `status` as the last field. Default mapping is shipped in [`constants/status_enum.json`](../constants/status_enum.json) (`Submitted=0` …). If your deployment differs, set `ARAH_CLAIMABLE_STATUS_CODES` to the comma-separated list of claimable status integers.

**Why defaults might need updates:** the on-chain `nextProposalId` on Galileo was **0** at the time of writing, so the enum was not derivable from live proposals. Re-verify against verified contract source before production stakes.

## `metricsHash` (normative for this skill)

On-chain `approve` / `reject` accept `metricsHash` as **`bytes32`**.

This skill sets **`metricsHash` = SHA-256 (32 bytes) of the verifier harness stdout log file** referenced by `--metrics-log-file` in `finalize_approve.py` / `finalize_reject.py`, encoded as hex **`0x` + 64 hex characters** (same as other ARAH file hashes).

- Approve: hash of **`.autoresearch/verify/runs/<review_id>/stdout.log`** after a successful `run_verify_trial.sh`.
- Reject: hash of an evidence file (stderr, JSON diff, or short UTF-8 reason) passed to `--metrics-log-file`.

This is **not** automatically equal to the miner’s `benchmarkLogHash`. The miner’s log commitment is checked **offline** when resolving artifacts (`artifact_resolve.py`) against the artifact index.

## Slash economics

Read live constants from the ledger (`SLASH_BPS_TO_BURN`, `SLASH_BPS_TO_VERIFIER_POOL`, `BPS_DENOMINATOR`) via `eth_call`, or inspect the deployed `ProposalLedger` artifact. Rejected proposals slash stake across burn + verifier pool per deployed rules.

## Protocol hash compare

`ProjectRegistry.getProject(projectId)` returns `protocolHash` (`bytes32`). With default settings, this skill compares **`SHA-256 (protocol.json bytes)`** from the extracted tarball to that field.

If your project published **`protocolHash` as a 0G Storage Merkle root** (not raw SHA-256 of JSON), set **`ARAH_SKIP_PROTOCOL_HASH_COMPARE=1`** and enforce alignment through your artifact pipeline (not recommended unless you operate the indexer yourself).
