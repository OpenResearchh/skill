# Mining bootstrap (agent prompt)

You are preparing an **autoresearch-mine** workspace. Operate **unattended**: do not ask the miner to confirm benchmark definitions (that is **autoresearch-create** only).

## Inputs

- Either a published project id on the configured settlement layer, a legacy storage publish manifest, or absolute paths to finalized `protocol.json` (`schemaKind: protocol`, `meta.eligibility: eligible`) and the **target repository root** (checkout of `meta.repo`).
- Optional path to `program.md` (human-readable mirror of the protocol).
- For legacy 0G on-chain mining, an initialized mining wallet keystore (`scripts/wallet.py init --id <id>`). The skill calls `submit_proposal.py` / `submit_trial_proposal.py` with `--wallet-id <id>` and `--passphrase-file` (or `ARAH_WALLET_PASSPHRASE`). It does **not** read `ARAH_PRIVATE_KEY`. The user's main wallet is only used as `--reward-recipient`; the mining keystore signs `buy()`, `approve()`, and `submit()`.
- For Solana on-chain mining, a dedicated local Solana keypair JSON for live `submit`, funded with native SOL for gas and missing project-token buys, plus the user's reward-recipient Solana wallet address. Only ask the user for faucet funding of the generated miner public key and for the reward-recipient address; do CLI installation and keypair setup yourself.
- For Stellar on-chain mining, a funded Stellar miner address and reward-recipient address. Live submit uses `ARAH_STELLAR_MINER_SECRET_KEY` or an explicit local signer only after a dry run.

## Steps

1. Export `GIT_TERMINAL_PROMPT=0` for all subsequent shell/git operations.
2. Resolve the active layer with `bootstrap_project.mjs --show-chain` and read its reference doc: Stellar, Solana, or 0G.
3. For Stellar projects, run **`bootstrap_project.mjs --chain stellar --project-id <id> --output-dir <dir> --repo-root <repo_root> --prepare-repo`** so the skill reads `get_project`, fetches the accepted GitRef, verifies the tree hash, initializes `.autoresearch/mine`, and writes `network_state.json`.
4. For Solana projects, read `references/onchain-mining-solana.md` and finish wallet preflight before bootstrapping. Prefer `bootstrap_from_solana.mjs` with the project id so the skill fetches the `Project` account, reads on-chain artifact ids, downloads those files, and verifies hashes before mining.
5. For legacy 0G on-chain mining, run **`check_wallet.py --wallet-id <id>`** before bootstrapping or trials, plus `--project-id` or `--token-address`. Stop if the wallet has no native gas or cannot cover/buy the missing ProjectToken stake.
6. If starting from local files, run `init_mine_workspace.sh <repo_root>` from `autoresearch-mine/scripts/`, then set `.autoresearch/mine/network_state.json` from the active layer's bootstrap/sync adapter or edit **`templates/network_state.manual.json`** placeholders. Then run **`validate_network_state.sh`**.
6. Run `preview_mining_context.sh <protocol.json>` (uses bundled `vendor/harness/preview_metrics.py`).
7. Run `python3 read_mining_limits.py <protocol.json>` and record limits for the loop.

If `validate_network_state.sh` fails, fix `network_state.json` or stop with a clear error—do not proceed to the mining loop.
