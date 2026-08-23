# 0G Galileo On-Chain Publishing

This is the reference for the `0g` settlement layer. The workflow calls
`scripts/publish_project.mjs`; when `0g` is the active layer that entrypoint
delegates to `scripts/publish_project_0g.mjs` and translates
`--upload-artifacts` into `--upload-artifacts-to-0g`. Every other flag below can
be passed straight through `publish_project.mjs`. Select this layer with
`--chain 0g`, `ARAH_CHAIN=0g`, or `.autoresearch/chain.json`.

`--base-price` and `--slope` are denominated in wei on this layer.

Use this reference only after the create flow has a finalized `protocol.json`, the benchmark has passed the Step 5b approval gate, and an eligible project has a measured baseline.

## Deployment

- Chain: 0G Galileo testnet
- Chain ID: `16602`
- RPC: `https://evmrpc-testnet.0g.ai`
- Deployment manifest: `contracts/0g-galileo-testnet/deployment.json`
- ABI/artifacts: `contracts/0g-galileo-testnet/artifacts/*.json`

Deployed contracts:

| Contract | Address |
|---|---|
| `VerifierRegistry` | `0x257974E406f206BfAEd3abB8D93C232e3226f032` |
| `ProposalLedger` | `0x701db5f8Ed847651209A438695dfe5520adD6A5A` |
| `ProjectRegistry` | `0xc84768e450534974C0DD5BAb7c1b695744124136` |
| `ProjectToken` | deployed per project by `ProjectRegistry.createProject(...)` |

## ABI-derived create flow

Create projects by calling:

```text
ProjectRegistry.createProject(
  bytes32 protocolHash,
  bytes32 repoSnapshotHash,
  bytes32 benchmarkHash,
  int256 baselineAggregateScore,
  bytes32 baselineMetricsHash,
  string tokenName,
  string tokenSymbol,
  uint256 basePrice,
  uint256 slope,
  uint256 minerPoolCap
) returns (uint256 projectId, address tokenAddr)
```

Before submitting a transaction, confirm or derive:

- `protocolHash`: bytes32 digest of the immutable protocol bundle or its canonical off-chain artifact. When using 0G Storage, use the uploaded artifact's 0G Storage root hash.
- `repoSnapshotHash`: bytes32 digest of the repository snapshot miners must start from. When using 0G Storage, use the uploaded artifact's 0G Storage root hash.
- `benchmarkHash`: bytes32 digest of the immutable benchmark/harness bundle. When using 0G Storage, use the uploaded artifact's 0G Storage root hash.
- `baselineAggregateScore`: signed integer representation of the approved baseline metric. If the metric is decimal, choose and record a deterministic scale before publishing.
- `baselineMetricsHash`: bytes32 digest of the baseline metrics artifact/log. When using 0G Storage, use the uploaded artifact's 0G Storage root hash.
- `tokenName`, `tokenSymbol`, `basePrice`, `slope`, `minerPoolCap`: tokenomics parameters. Ask the user if not already specified.

The `ProjectCreated(projectId, creator, token, protocolHash)` event gives the canonical `projectId` and per-project `ProjectToken` address. Store those values with the protocol authoring artifacts.

Do not pass raw IPFS CIDs or URLs into `bytes32` fields. For 0G Storage, the root hash is already a `bytes32` Merkle root and can be used directly. Store the download metadata off-chain in `storage_0g_galileo.json`.

Use `scripts/publish_project_0g.mjs` for publishing. It opens a temporary localhost browser page, discovers injected EIP-1193 wallets, asks the user to sign a SIWE-style publish approval message, verifies that signature locally, sends `eth_sendTransaction` through the browser wallet after user approval, polls the 0G RPC for the receipt, and writes `publish_0g_galileo.json`.

## 0G Storage artifact publication

The publish CLI can upload the protocol, repo snapshot, benchmark bundle, and baseline metrics artifact to 0G Storage before calling `ProjectRegistry.createProject(...)`:

```bash
node scripts/publish_project_0g.mjs \
  --protocol-json ./out/protocol.json \
  --repo-snapshot-file ./repo-snapshot.tar \
  --benchmark-file ./benchmark.tar \
  --baseline-metrics-file ./out/baseline_run.log \
  --baseline-aggregate-score 12345 \
  --token-name "Research Token" \
  --token-symbol RCH \
  --base-price 1000000000000000 \
  --slope 1000000000000 \
  --miner-pool-cap 21000000 \
  --upload-artifacts-to-0g \
  --yes
```

0G Storage does not use a web2 API key in this flow. Uploads are paid/signed by an EVM wallet on the 0G network. By default, the CLI opens a localhost browser page and routes 0G Storage SDK transaction requests to an injected wallet extension. Set `ZG_STORAGE_PRIVATE_KEY` only for a local throwaway/publisher wallet with 0G testnet gas. Do not use a backend-held project key.

With `--dry-run --upload-artifacts-to-0g`, the CLI computes the 0G Merkle roots and writes a preview manifest, but does not submit storage transactions. With a real upload, it writes `storage_0g_galileo.json` containing each artifact path, size, SHA-256 digest, 0G root hash, tx hash, and storage indexer RPC.

## ABI-derived mining and review flow

Miner path:

1. Read `ProjectRegistry.tokenOf(projectId)` to find the project token.
2. Buy project tokens with `ProjectToken.buy()` if needed.
3. Approve stake transfer with `ProjectToken.approve(ProposalLedger, stake)`.
4. Submit a proposal with:

```text
ProposalLedger.submit(
  uint256 projectId,
  bytes32 codeHash,
  bytes32 benchmarkLogHash,
  int256 claimedAggregateScore,
  uint256 stake,
  address rewardRecipient
) returns (uint256 proposalId)
```

The `rewardRecipient` is separate from the transaction sender/miner and must be set deliberately.

Verifier path:

1. Check allowlist status with `VerifierRegistry.isVerifier(verifier)`.
2. A verifier claims work with `ProposalLedger.claimReview(proposalId)`.
3. Approve with `ProposalLedger.approve(proposalId, verifiedAggregateScore, metricsHash)` or reject with `ProposalLedger.reject(proposalId, metricsHash)`.
4. Expired proposals can be finalized with `ProposalLedger.expire(proposalId)`.

Approved proposals return stake to the miner and mint the reward to `rewardRecipient`. Rejected or expired proposals slash stake 50/50 across burn and verifier-pool paths according to the deployed ledger constants.
