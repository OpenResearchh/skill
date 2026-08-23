# Architecture

## Objective

Build a Stellar smart contract layer for OpenResearch that replaces or parallels the current Solana and legacy 0G on-chain paths.

The Stellar layer should do four things:

1. Anchor a project's immutable research contract and baseline.
2. Accept miner proposals with staked value.
3. Let authorized verifiers settle proposals.
4. Maintain the network frontier: the best accepted aggregate score and code artifact for each project.

## Recommended Contract Model

Use one main OpenResearch Soroban contract for project and proposal state, plus a token/stake strategy selected before implementation.

Recommended split:

| Component | Stellar implementation |
|---|---|
| Project registry | Main OpenResearch contract persistent storage. |
| Proposal ledger | Main OpenResearch contract persistent storage. |
| Verifier registry | Main OpenResearch contract persistent or instance storage. |
| Project token/stake | Either Stellar Asset Contract or a custom Soroban token. |

One main contract is simpler for consistency checks because project frontier, proposals, verifier permissions, and settlement rules share state. A separate token contract or Stellar Asset Contract can be used for balances and transfers.

## State Model

The main contract stores:

- Global config.
- Project records keyed by project ID.
- Proposal records keyed by proposal ID.
- Verifier records keyed by address.
- Optional claimable reward records.

Use persistent storage for project/proposal/verifier state that must survive indefinitely. Use instance storage for global config and counters when all values can share contract instance TTL. Use temporary storage only for non-critical short-lived records; do not use TTL as a security boundary.

## Artifact Model

Do not store protocol bundles, repo snapshots, benchmark tarballs, logs, or metrics blobs on-chain.

Store on-chain:

- Raw SHA-256 hash as `BytesN<32>`.
- Artifact ID as `BytesN<32>` when the storage provider ID can be losslessly encoded.
- Optional storage provider enum or short symbol.

Store off-chain:

- Human-readable artifact IDs.
- Gateway URLs.
- Size.
- SHA-256.
- Upload receipt.
- Storage network name.

Proposed metadata file: `storage_stellar.json`.

## Score Model

Scores must be signed integers on-chain.

Rules:

- Convert decimal metric values off-chain using a project-specific `metric_scale`.
- For maximize metrics, higher aggregate score is better.
- For minimize metrics, negate the scaled metric so higher aggregate score is still better.
- Store `baseline_aggregate_score` and `current_best_aggregate_score`.
- Genesis frontier is `baseline_aggregate_score`.
- Once current-best code exists, frontier is `current_best_aggregate_score`.
- A proposal is approvable only when `verified_score >= incumbent + margin`.
- `margin = abs(incumbent) * min_score_improvement_bips / 10000`.

Exact-threshold improvements must pass because `min_score_improvement_bips` is the minimum required improvement.

## Token And Stake Options

### Option A: Stellar Asset Contract

Use Stellar Asset Contract when the project token should be a Stellar issued asset.

Pros:

- Native Stellar asset semantics.
- Existing asset issuer/trustline model.
- Fits wallets and ecosystem tools.

Risks:

- Trustline and authorization rules must be designed carefully.
- Classic trustline balances have 7 decimal places and 64-bit representation constraints.
- Contract balances and authorization state differ for contract addresses.

### Option B: Custom Soroban Token

Use a custom token contract when OpenResearch needs exact project-token behavior, mint/burn permissions, and escrow semantics.

Pros:

- Full control over stake escrow and reward minting.
- Easier to mirror existing ProjectToken behavior.
- Avoids issuer/trustline ambiguity in the first implementation.

Risks:

- More contract code to audit.
- More wallet/indexer integration work.

Recommendation for first implementation:

Start with a custom Soroban token or internal stake ledger for testnet. Revisit Stellar Asset Contract when product wants native asset issuance and wallet-facing project tokens.

## Lifecycle

1. Initialize contract.
2. Register verifier addresses.
3. Create project.
4. Miner submits proposal with stake.
5. Verifier claims proposal.
6. Verifier runs off-chain validation.
7. Verifier approves, rejects, releases, or proposal expires.
8. Approval updates frontier and releases/mints rewards.

## Off-Chain Services

Required scripts or services:

- Publisher CLI.
- Miner bootstrap CLI.
- Proposal submit CLI.
- Validator loop.
- Artifact resolver.
- Event indexer.

Stellar RPC event retention is not enough for long-lived project history, so production deployments need event ingestion into a durable database.

