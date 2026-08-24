# Stellar Mining Adapter

Use the neutral entrypoints with `--chain stellar`:

- `node scripts/bootstrap_project.mjs --chain stellar --project-id <id> --output-dir <dir> --repo-root <repo> --prepare-repo`
- `python3 scripts/submit_trial_proposal.py --chain stellar --project-id <id> --repo-root <repo> --trial-id <trial> --claimed-metric <value> --stellar-miner <G...> --reward-recipient <G...>`

Bootstrap reads `get_project` from the Stellar OpenResearch contract, selects the
current best `GitRef` when present (or the baseline with `--from-baseline`),
fetches that commit from `clone_url`, verifies `tree_hash`, initializes
`.autoresearch/mine`, stamps `refs/openresearch/base` to the incumbent commit,
and writes `network_state.json` with `source: "stellar"`.

Git mode is live for Stellar. `submit_trial_proposal.py` computes
`base_commit`, `head_commit`, and `tree_hash`, confirms the head commit is
published, then dispatches to `submit_proposal_stellar.mjs`. The Stellar path
uses the ABI v3 GitRef encoding from `@openresearch/stellar-client`, including
host-only repo normalization and the contract tree-hash serialization. Live
submission preflights the current contract incumbent and protocol epoch before
`submit`; it requires `--yes` and a miner signer via
`ARAH_STELLAR_MINER_SECRET_KEY` or `--secret-key`.

Network defaults come from `smart-contracts/deployments/mainnet.json`. Override
with `OPEN_RESEARCH_CONTRACT_ID`, `STELLAR_RPC_URL`,
`STELLAR_NETWORK_PASSPHRASE`, or `--deployment-json`.
