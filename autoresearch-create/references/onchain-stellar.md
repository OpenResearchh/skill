# Stellar Publish Adapter

Use `scripts/publish_project.mjs --chain stellar` to publish through the neutral
entrypoint. The adapter calls the Stellar/Soroban `OpenResearch` ABI v3 contract
and records a git-primary project: `repo`, `baseline_commit`, `tree_hash`, and
`protocol_hash`.

The adapter derives `repo` and `tree_hash` with the ABI v3 GitRef rules from
`@openresearch/stellar-client`: lower-case the repo host only, preserve
owner/repo case, and hash canonical tree entries as
`mode SP path NUL decimal-length NUL raw-blob NUL`.

Required publish inputs:

- `--protocol-json <path>`
- `--repo-root <checkout>`
- `--baseline-aggregate-score <int>` or `--baseline-metric <decimal>`
- `--creator <G...>` or `ARAH_STELLAR_CREATOR`
- `--token <C...>` or `ARAH_STELLAR_STAKE_TOKEN`
- `--minimum-stake`, `--reward-per-approval`, `--reward-pool-funding`

Network defaults come from `smart-contracts/deployments/mainnet.json`. Override
with `OPEN_RESEARCH_CONTRACT_ID`, `STELLAR_RPC_URL`,
`STELLAR_NETWORK_PASSPHRASE`, or `--deployment-json`.

Run without `--yes` first. The adapter writes:

- `storage_git.json`: git artifact commitment and materialization command
- `publish_stellar.json`: Stellar network, contract id, and `create_project`
  payload

Live publish requires `--yes` and a local creator signer via
`ARAH_STELLAR_CREATOR_SECRET_KEY` or `--secret-key`. Never place a seed phrase in
the protocol bundle or mining workspace.
