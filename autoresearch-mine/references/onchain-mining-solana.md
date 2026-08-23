# Solana OpenResearch — miner path

This is the reference for the `solana` settlement layer. Select it with
`--chain solana`, `ARAH_CHAIN=solana`, or `.autoresearch/chain.json`; it is also
the default when nothing is configured.

The workflow calls the neutral entrypoints, which delegate here:

| Neutral entrypoint | Adapter | Flag translation |
|---|---|---|
| `scripts/bootstrap_project.mjs` | `scripts/bootstrap_from_solana.mjs` | `--prepare-repo` → `--unpack-repo` |
| `scripts/submit_trial_proposal.py --chain solana` | `scripts/submit_proposal_solana.mjs` | identity is `--solana-keypair` |

Every adapter flag below can be passed straight through `bootstrap_project.mjs`
unchanged, including `--from-baseline` (start from the project's original
snapshot instead of the current best code — use it only to reproduce the
baseline) and `--idl` / `--cluster` / `--rpc-url` / `--program-id` /
`--gateway-url` / `--network`.

The Solana path is the default for projects created by
`autoresearch-create`. Project metadata is stored in the OpenResearch Solana
program, and project artifacts are stored on Irys.

## What Changed From 0G

- Project ids are Solana `u64` ids, not 0G EVM registry ids.
- Project/token/proposal addresses are PDAs, not deployed EVM contract
  addresses.
- Artifact fields are raw SHA-256 bytes32 values for file bytes plus 32-byte
  Irys transaction ids, not 0G Storage Merkle roots.
- Artifact retrieval starts from the Solana `Project` account. Read the
  on-chain Irys id fields, convert the 32 bytes back to the base64url Irys id,
  download that exact object, then verify its SHA-256 hash. When only older
  hash-only metadata is available, fall back to Irys tags:
  - `App-Name = OpenResearch AutoResearch`
  - `Artifact-Role = protocol | repoSnapshot | benchmark | baselineMetrics`
  - `SHA-256 = <hex without 0x>`
- Stake/token flows use SPL token accounts and program instructions. There is
  no ERC20 `approve`.
- Proposal creation requires project SPL tokens. Before live `submit`, the
  miner must hold native SOL for gas and for any missing project-token stake.
  The submit script calls the OpenResearch `buy(project_id, lamports_in)`
  instruction first when stake tokens are missing, then calls `submit`.

## Preflight Before Mining

Finish Solana setup before artifact bootstrap or trial work so a winning trial
can be proposed automatically.

1. Check `solana --version`. If it is missing, install the CLI locally with the
   official installer:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
   solana --version
   ```

2. Configure the cluster and create or reuse a dedicated miner keypair:

   ```bash
   solana config set --url devnet
   test -f ~/.config/solana/arah-mine-<project_id>.json || solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/arah-mine-<project_id>.json
   MINER_ADDR="$(solana address -k ~/.config/solana/arah-mine-<project_id>.json)"
   solana balance "$MINER_ADDR"
   ```

3. If the miner balance is zero or too low, ask the user to fund
   `MINER_ADDR` using the Solana faucet. Do not ask the user to install the CLI
   or create the keypair.
4. Ask the user only for the reward-recipient Solana wallet address. Record it
   before the loop starts; do not defer this prompt until after a winning trial.

## Implemented Now

`scripts/bootstrap_from_solana.mjs` fetches the Solana `Project` account,
downloads the four project bootstrap artifacts by their on-chain Irys ids,
verifies the raw SHA-256 hashes, can unpack the repo snapshot, and writes
`.autoresearch/mine/network_state.json` with `source: solana` (project id,
cluster, program id, `network_best_metric`, `aggregate_score_int256`,
`metric_scale`, `code_origin`, `min_score_improvement_bips`). Reach it through
the neutral entrypoint:

```bash
node scripts/bootstrap_project.mjs \
  --project-id <project_id> \
  --output-dir /tmp/arah-project \
  --prepare-repo
```

Equivalent direct call:

```bash
node scripts/bootstrap_from_solana.mjs \
  --project-id <project_id> \
  --output-dir /tmp/arah-project \
  --unpack-repo
```

`scripts/download_irys_artifacts.mjs` is the lower-level downloader. It accepts
raw on-chain hashes plus Irys ids:

```bash
node scripts/download_irys_artifacts.mjs \
  --output-dir /tmp/arah-project/artifacts \
  --protocol-hash 0x... \
  --protocol-irys-id <id> \
  --repo-snapshot-hash 0x... \
  --repo-snapshot-irys-id <id> \
  --benchmark-hash 0x... \
  --benchmark-irys-id <id> \
  --baseline-metrics-hash 0x... \
  --baseline-metrics-irys-id <id> \
  --network devnet
```

If the creator supplied `storage_irys.json`, pass it as a fast path:

```bash
node scripts/download_irys_artifacts.mjs ... \
  --manifest /path/to/storage_irys.json
```

The script writes `download_irys_artifacts.json` and verifies every downloaded
file by SHA-256 before it can be used for mining.

## Proposal Submission

The skill bundles the full OpenResearch Anchor IDL at
`contracts/solana-open-research/open_research.json`. Submit improved trials
with the same archive-and-log packaging used by the legacy path:

```bash
python3 scripts/submit_trial_proposal.py \
  --chain solana \
  --project-id <project_id> \
  --repo-root /path/to/repo \
  --trial-id <trial_id> \
  --claimed-metric <metric> \
  --reward-recipient <SOLANA_REWARD_PUBKEY> \
  --solana-keypair ~/.config/solana/id.json \
  --yes
```

Dry-run without a keypair:

```bash
python3 scripts/submit_trial_proposal.py \
  --chain solana \
  --project-id <project_id> \
  --repo-root /path/to/repo \
  --trial-id <trial_id> \
  --claimed-metric <metric> \
  --reward-recipient <SOLANA_REWARD_PUBKEY> \
  --solana-miner <SOLANA_MINER_PUBKEY> \
  --solana-proposal-id <proposal_id> \
  --dry-run
```

Direct script:

```bash
node scripts/submit_proposal_solana.mjs \
  --project-id <project_id> \
  --code-file .autoresearch/mine/submissions/<trial_id>/repo-snapshot.tar \
  --code-irys-id <uploaded_code_id> \
  --benchmark-log-file .autoresearch/mine/runs/<trial_id>/stdout.log \
  --benchmark-log-irys-id <uploaded_log_id> \
  --claimed-metric <metric> \
  --stake 1 \
  --reward-recipient <SOLANA_REWARD_PUBKEY> \
  --keypair ~/.config/solana/id.json \
  --yes
```

Live submission checks the miner token account before `submit`. If the project
token balance is below `--stake`, it fetches the project bonding-curve
parameters and mint supply, quotes the missing stake buy, calls `buy()` with
native SOL, rechecks the token balance, and only then calls `submit`. Override
the quote with `--buy-lamports` only when necessary; use `--skip-buy` only for
diagnostic runs.

Use `--no-auto-buy` only for diagnostic runs where submission is expected to
fail without existing stake, and `--solana-buy-lamports` only to override the
automatic quote.

## Remaining Follow-up

1. Add a standalone `scripts/sync_solana_frontier.mjs` so the frontier can be
   refreshed without re-running bootstrap.
2. Add a wallet upload path for proposal code/log artifacts so miners do not
   need to upload to Irys out-of-band before passing `--code-irys-id` and
   `--benchmark-log-irys-id`.
