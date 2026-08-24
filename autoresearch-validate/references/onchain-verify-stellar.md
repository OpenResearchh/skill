# Stellar Validate Adapter

Use `node scripts/validate_loop.mjs --chain stellar --project-id <id>` through the
neutral validate entrypoint.

The adapter:

1. Reads `get_project` and checks `is_verifier` for `--verifier <G...>` or
   `ARAH_STELLAR_VERIFIER`.
2. Polls `get_open_proposals(project_id)`.
3. Calls `claim_review` before running untrusted code.
4. Fetches the candidate `GitRef` and the trusted incumbent `GitRef`, verifying
   repo identity and the ABI v3 tree hash from `@openresearch/stellar-client`.
5. Restores immutable harness paths from the trusted incumbent tree, runs static
   gates, then reruns the benchmark in the sandbox.
6. Calls `approve`, `reject`, or `release_review` from the verifier address.
7. After approval, optionally runs `merge_approved_proposal.mjs` and records the
   merge with `record_merge`.

Live settlement requires `--yes` plus `ARAH_STELLAR_VERIFIER_SECRET_KEY` or
`--secret-key`. `--dry-run` still reads project/proposal state and can run local
verification, but does not submit transactions.

Network defaults come from `smart-contracts/deployments/mainnet.json`. Override
with `OPEN_RESEARCH_CONTRACT_ID`, `STELLAR_RPC_URL`,
`STELLAR_NETWORK_PASSPHRASE`, or `--deployment-json`.
