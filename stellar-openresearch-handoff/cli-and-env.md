# CLI And Environment

## Deployment Record

Proposed file:

```text
contracts/stellar-open-research/deployment.json
```

Shape:

```json
{
  "schemaVersion": "1",
  "chain": "stellar",
  "network": "testnet",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "openResearchContractId": "<contract-id>",
  "projectTokenContractId": "<optional-contract-id>",
  "artifactProvider": "irys-or-other",
  "createdAt": "<iso8601>",
  "wasmSha256": "<hex>"
}
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `ARAH_STELLAR_NETWORK` | `testnet`, `mainnet`, or local alias. |
| `ARAH_STELLAR_RPC_URL` | Override Stellar RPC URL. |
| `ARAH_STELLAR_HORIZON_URL` | Optional Horizon URL for account and classic asset queries. |
| `ARAH_STELLAR_NETWORK_PASSPHRASE` | Network passphrase override. |
| `ARAH_STELLAR_CONTRACT_ID` | OpenResearch contract ID override. |
| `ARAH_STELLAR_SOURCE_ACCOUNT` | Stellar CLI identity/account alias. |
| `ARAH_STELLAR_SECRET_KEY` | Only for explicit local automation; avoid by default. |
| `ARAH_ARTIFACT_PROVIDER` | Artifact provider name. |
| `ARAH_METRIC_SCALE` | Decimal metric scale, default `1000000`. |
| `ARAH_STAKE` | Stake amount in token base units. |

Never ask for seed phrases. Prefer wallet integration or explicit local keypair/identity setup.

## Publish Project

Dry run:

```bash
node scripts/publish_project_stellar.mjs \
  --protocol-json ./out/protocol.json \
  --repo-snapshot-file ./repo-snapshot.tar \
  --benchmark-file ./benchmark.tar \
  --baseline-metrics-file ./out/baseline_run.log \
  --baseline-metric 2.5 \
  --metric-scale 1000000 \
  --direction minimize \
  --token-name "Research Token" \
  --token-symbol RCH \
  --minimum-stake 1 \
  --dry-run
```

Live:

```bash
node scripts/publish_project_stellar.mjs \
  --protocol-json ./out/protocol.json \
  --repo-snapshot-file ./repo-snapshot.tar \
  --benchmark-file ./benchmark.tar \
  --baseline-metrics-file ./out/baseline_run.log \
  --baseline-metric 2.5 \
  --metric-scale 1000000 \
  --direction minimize \
  --token-name "Research Token" \
  --token-symbol RCH \
  --minimum-stake 1 \
  --source-account publisher \
  --upload-artifacts \
  --yes
```

Output:

```text
publish_stellar_plan.json
publish_stellar.json
storage_stellar.json
```

## Bootstrap Miner

```bash
node scripts/bootstrap_from_stellar.mjs \
  --project-id 0 \
  --output-dir /tmp/openresearch-stellar-project \
  --unpack-repo
```

Expected behavior:

- Fetch project state.
- Download artifacts.
- Verify SHA-256.
- Extract repo safely.
- Write network state using baseline as frontier when no current best exists.

## Submit Proposal

```bash
python3 scripts/submit_trial_proposal.py \
  --chain stellar \
  --project-id 0 \
  --repo-root /path/to/repo \
  --trial-id trial-001 \
  --claimed-metric 2.41 \
  --reward-recipient <stellar-address> \
  --stellar-source-account miner \
  --yes
```

Or direct Stellar script:

```bash
node scripts/submit_proposal_stellar.mjs \
  --project-id 0 \
  --code-file .autoresearch/mine/submissions/trial-001/repo-snapshot.tar \
  --benchmark-log-file .autoresearch/mine/runs/trial-001/stdout.log \
  --claimed-metric 2.41 \
  --metric-scale 1000000 \
  --stake 1 \
  --reward-recipient <stellar-address> \
  --source-account miner \
  --upload-artifacts \
  --yes
```

## Validate Loop

```bash
node scripts/run_validate_loop_stellar.mjs \
  --project-id 0 \
  --source-account verifier \
  --work-dir /tmp/openresearch-stellar-verify \
  --yes
```

Validator must:

- Claim proposal before doing verifier work.
- Use trusted project protocol and benchmark.
- Upload metrics/evidence before settlement.
- Release, not reject, when measurement is too noisy or host failure is ambiguous.

## Stellar CLI Notes

The Stellar CLI groups contract commands under `stellar contract`.

Common patterns:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/open_research.wasm \
  --source publisher \
  --network testnet
```

```bash
stellar contract invoke \
  --id <contract-id> \
  --source publisher \
  --network testnet \
  -- \
  initialize \
  --admin <address>
```

Exact invocation flags should be generated from the final contract schema.

