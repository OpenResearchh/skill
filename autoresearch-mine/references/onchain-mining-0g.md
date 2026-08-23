# 0G Galileo — miner path (excerpt)

This is the reference for the `0g` settlement layer. Select it with
`--chain 0g`, `ARAH_CHAIN=0g`, or `.autoresearch/chain.json`.

The workflow calls the neutral entrypoints, which delegate here:

| Neutral entrypoint | Adapter | Flag translation |
|---|---|---|
| `scripts/bootstrap_project.mjs` | `scripts/bootstrap_from_registry.py` | `--prepare-repo` → `--download-artifacts` |
| `scripts/submit_trial_proposal.py --chain 0g` | `scripts/submit_proposal.py` | identity is `--wallet-id` (+ `--passphrase-file`) |

Every adapter flag below can be passed straight through `bootstrap_project.mjs`
unchanged — including `--token-address`, `--protocol-json`, `--repo-root`, and
`--skip-existing`.

This file distills the **miner submit path** from [`autoresearch-create/references/onchain-0g-galileo.md`](../../autoresearch-create/references/onchain-0g-galileo.md). Use that doc for full deployment tables and publish (`createProject`) flow.

## Identity and funding on this layer

The signing identity is an isolated mining wallet in a passphrase-encrypted
keystore under `~/.autoresearch/wallets/<id>.json` (`ARAH_WALLET_HOME` to
relocate):

```bash
python3 scripts/wallet.py init --id project-42       # generates a fresh secp256k1 key
python3 scripts/wallet.py address --id project-42    # print the address; the user funds it from their main wallet
```

Scripts that send transactions take **`--wallet-id`** + **`--passphrase-file`**
(or `ARAH_WALLET_PASSPHRASE`). They never read `ARAH_PRIVATE_KEY`, and the
keystore is decrypted only inside `wallet.py` itself, so the trial harness —
which runs untrusted code inside the sandbox — cannot reach the key. The dotenv
loader explicitly skips `ARAH_PRIVATE_KEY` even if it is present in `.env`.

Then preflight the wallet so it has native gas and either enough `ProjectToken`
stake or enough native balance to buy the missing stake automatically:

```bash
python3 scripts/check_wallet.py \
  --wallet-id project-42 \
  --token-address 0xProjectTokenAddress
# or: --project-id "${ARAH_PROJECT_ID:?}"
```

If `ready` is false, stop and report the missing gas/token/stake condition
before spending compute on trials. If `missingStake` is nonzero and
`canAutoBuyMissingStake` is true, continue and submit later with
**`--auto-buy`**. A low allowance is reported as `needsApproval`; it is not
fatal because `submit_proposal.py` sends `approve()` itself.

Keep `--reward-recipient` set to the user's main wallet (e.g. their MetaMask
address), never the mining keystore address.

## Deployment layout

- Default bundled paths (inside `autoresearch-mine`): `contracts/0g-galileo-testnet/deployment.json`, `contracts/0g-galileo-testnet/artifacts/*.json`.
- Network: chainId **16602**, RPC **`https://evmrpc-testnet.0g.ai`** (see `deployment.json`).
- Contracts: **`ProjectRegistry`**, **`ProposalLedger`**, **`VerifierRegistry`**. **`ProjectToken`** is **per project** (address from `tokenOf`, not in root `deployment.json`).

## Hashes (must match publish pipeline)

- **`protocolHash`**, **`repoSnapshotHash`**, **`benchmarkHash`**, **`baselineMetricsHash`**: **SHA-256** of the respective file bytes, encoded as **`0x` + 64 hex chars** (bytes32). Same rule as `scripts/publish_project_0g_lib.mjs` (`hashFileBytes32`).
- **`claimedAggregateScore`**: **`int256`** on chain; the float metric in `protocol.json` is scaled with an integer **metric scale** agreed at `createProject` (same scale as baseline). Encode/decode consistently with the publish script.

## Miner transaction order

0. **Wallet preflight:** see [Identity and funding on this layer](#identity-and-funding-on-this-layer) above. The keystore identity pays gas, buys missing stake, approves the ledger, and submits. `ARAH_STAKE` sets the stake count in whole tokens (`ProjectToken.decimals() == 0`, so the contract only requires `stake > 0`); it defaults to `1`.
1. **`ProjectRegistry.tokenOf(projectId)`** → project token address. If the miner only has a token address, scan `tokenOf(0..nextProjectId-1)` to recover `projectId`.
2. **`ProjectToken.balanceOf(wallet)`** and **`allowance(wallet, ProposalLedger)`** → check stake readiness.
3. **`ProjectToken.costBetween(totalSupply, totalSupply + missingStake)`** → quote the native value needed to buy missing stake.
4. **`ProjectToken.buy()`** if the wallet needs more tokens for stake (bonding-curve buy).
5. **`ProjectToken.approve(ProposalLedger_address, stake)`** so the ledger can pull stake.
6. **`ProposalLedger.submit(projectId, codeHash, benchmarkLogHash, claimedAggregateScore, stake, rewardRecipient)`** → `proposalId`.

`rewardRecipient` is explicit and may differ from `msg.sender`.

## Registry reads (frontier / sync)

- **`ProjectRegistry.getProject(projectId)`** — project metadata including **`protocolHash`**, **`token`**, etc.
- **`ProjectRegistry.currentBestAggregateScore(projectId)`** — network best as **`int256`** (compare using the same metric scale as create).
- **`ProjectRegistry.tokenOf(projectId)`** — project token address. To mine from only a token address, `scripts/bootstrap_from_registry.py` scans `tokenOf(0..nextProjectId-1)` to recover the project id, then reads the project hashes.

## Bootstrap from token address

When publish used `--upload-artifacts-to-0g`, the project hash fields are 0G Storage roots. Miners can bootstrap directly:

```bash
python3 scripts/bootstrap_from_registry.py \
  --token-address 0xProjectTokenAddress \
  --output-dir /tmp/arah-mine/my-project \
  --download-artifacts
```

This downloads `protocol.json`, `repo-snapshot.tar`, `benchmark.tar`, and `baseline-metrics.log`, verifies each 0G Merkle root, unpacks the repo snapshot, initializes `.autoresearch/mine`, and writes registry frontier state.

If the project was published with plain SHA-256 file hashes, the registry proves integrity but does not provide retrievable storage roots. In that case, supply the local protocol and repo checkout and omit `--download-artifacts` (i.e. call `bootstrap_project.mjs` without `--prepare-repo`):

```bash
python3 scripts/bootstrap_from_registry.py \
  --token-address 0xProjectTokenAddress \
  --protocol-json /path/to/protocol.json \
  --repo-root /path/to/repo \
  --output-dir /tmp/arah-mine/my-project
```

`bootstrap_from_registry.py` resolves project metadata and initializes an existing protocol/repo checkout without Node deps; Node deps (`npm install` from the skill root) are only required for `--download-artifacts`.

Either way it writes `bootstrap_result.json`, initializes `.autoresearch/mine`, and prints the resolved `protocolJson` and `repoRoot`.

## Automatic buy / approve / submit

`scripts/submit_proposal.py` accepts either **`--project-id`** or **`--token-address`**. With **`--auto-buy`**, it resolves the ProjectToken, checks the wallet token balance, quotes any missing stake with `costBetween`, sends `buy()` with the quoted value plus slippage margin, then sends `approve()` and `submit()`.

Use `--dry-run` to print unsigned transactions after RPC resolution, or `--print-only` to verify local hashes and metric scaling without RPC (requires `--project-id`).

For normal mining, agents should call **`scripts/submit_trial_proposal.py`** instead of assembling hashes by hand. It archives the committed winning repo state from `HEAD`, uses `.autoresearch/mine/runs/<trial_id>/stdout.log` as the benchmark log, and then calls `submit_proposal.py`. The trigger is automatic: if a completed trial beats the freshly synced `ProjectRegistry.currentBestAggregateScore(projectId)`, submit the proposal transaction immediately.

```bash
python3 scripts/submit_trial_proposal.py \
  --chain 0g \
  --wallet-id project-42 \
  --token-address 0xProjectTokenAddress \
  --repo-root /path/to/repo \
  --trial-id <trial_id> \
  --claimed-metric 1.23 \
  --reward-recipient 0xUserMainWalletAddress \
  --auto-buy
```

`--wallet-id` is required on this layer; `--project-id` may be used instead of `--token-address`. `submit_trial_proposal.py` reads `--chain` / `ARAH_CHAIN` only — it does not consult `.autoresearch/chain.json`, so pass `--chain 0g` explicitly.

## Out of scope here

Verifier **`approve` / `reject` / `claimReview`** flows are documented in the full onchain reference; miners never call them.
