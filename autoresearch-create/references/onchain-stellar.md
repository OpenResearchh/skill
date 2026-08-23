# Stellar OpenResearch Publishing

This is the reference for the **default** `stellar` settlement layer. The
workflow calls `scripts/publish_project.mjs`; when nothing overrides the chain,
that entrypoint delegates to `scripts/publish_project_stellar.mjs`.

Select this layer with `--chain stellar`, `ARAH_CHAIN=stellar`,
`.autoresearch/chain.json`, or by using the built-in default.

Solana and 0G remain available as explicit alternates (`--chain solana` or
`--chain 0g`).

## Network

| Item | Value |
|---|---|
| Network | Stellar testnet |
| Contract | `CD5EKGUD3Y72UGV2VGQTLUTLOAIGZC6X3LFHARXX2A2D6LBR4IWXAWIQ` |
| RPC | `https://soroban-testnet.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

Explorer:

`https://lab.stellar.org/r/testnet/contract/CD5EKGUD3Y72UGV2VGQTLUTLOAIGZC6X3LFHARXX2A2D6LBR4IWXAWIQ`

Bundled deployment: `contracts/stellar-open-research/deployment.json`.
The TypeScript client is vendored at `vendor/openresearch-stellar-client`
(OpenResearch v2 ABI). Override RPC/contract with `ARAH_STELLAR_RPC_URL` and
`ARAH_STELLAR_CONTRACT_ID`.

Testnet is disposable. Do not assume its contract ID, identities, or balances
apply to mainnet.

## Artifact model

Git is the artifact store. `create_project` records:

- `protocol_hash`: SHA-256 of the committed `protocol.json` bytes
- `baseline`: a `GitRef` (`repo`, `commit`, `tree_hash`)
- oriented `baseline_score`, `direction`, `min_improvement_bips`, `metric_scale`
- SEP-41 `token`, `minimum_stake`, `reward_per_approval`, `reward_pool_funding`

`repo` is `sha256` of the client-normalized identity `host/owner/repo`: DNS host
lowercased, owner/repository case preserved, `.git` stripped. `tree_hash` is
the Stellar client canonical tree (`mode SP path NUL decimal-byte-length NUL raw-blob NUL`),
**not** `scripts/tree_hash.py`.

The approved `protocol.json` must be committed in the pinned baseline so miners
and verifiers hash the same bytes.

## Economics

Amounts are token base units. Native XLM uses stroops (`10_000_000 = 1 XLM`).
There is no per-project mint or bonding curve. The project chooses an existing
SEP-41 token. Defaults for a testnet smoke publish:

- `--token` native testnet XLM SAC unless the user names another SEP-41 contract
- `--minimum-stake` must be positive
- `--reward-per-approval` and `--reward-pool-funding` may be `0`

Funding is transferred from the creator into contract custody at create time.

## Scoring

On-chain scores are oriented so larger is always better:

```
maximize: score = metric × scale
minimize: score = -(metric × scale)
```

Genesis incumbent is `baseline_score`. After an approval, incumbent is
`current_best_score`. Approval uses:

- `bips == 0`: `verified_score > incumbent`
- `bips > 0`: `verified_score >= incumbent + floor(abs(incumbent) × bips / 10000)`

Use `scaleMetric` / `isSufficient` from the vendored client. Do not compare raw
floats in the settlement path.

## Signing

Default live publish opens a localhost page that can sign with Freighter,
Rabet, xBull, or Albedo (web, no extension). The CLI never sees a secret key.

Headless opt-in:

```bash
node scripts/stellar_open_research.mjs init-identity --out ~/.config/stellar/arah-create.secret
node scripts/publish_project.mjs \
  --protocol-json <protocol.json> \
  --repo-root <repo> \
  --baseline-metric 2.5 \
  --minimum-stake 10000000 \
  --secret-key-file ~/.config/stellar/arah-create.secret \
  --yes
```

Never ask for a seed phrase. A secret key file is a single `S…` line with mode
`0600`.

## Publish command

```bash
node scripts/publish_project.mjs \
  --protocol-json <output-dir>/protocol.json \
  --repo-root <repo-path> \
  --baseline-metric <decimal> \
  --minimum-stake 10000000 \
  --reward-per-approval 0 \
  --reward-pool-funding 0 \
  --yes
```

Use `--dry-run` first. Pass `--baseline-aggregate-score` when the metric is
already scaled. Outputs next to the protocol bundle:

- `publish_stellar_plan.json` (dry-run) or `publish_stellar.json` (live)
- `storage_git.json`
- `chain.json` (`{"chain":"stellar"}`)

## Environment

| Variable | Purpose |
|---|---|
| `ARAH_CHAIN` | `stellar` (default), `solana`, or `0g` |
| `ARAH_STELLAR_RPC_URL` | RPC override |
| `ARAH_STELLAR_CONTRACT_ID` | Contract override |
| `ARAH_STELLAR_NETWORK_PASSPHRASE` | Passphrase override |
| `ARAH_STELLAR_TOKEN` | Default SEP-41 token |
| `ARAH_METRIC_SCALE` | Decimal scale, default `1000000` |
