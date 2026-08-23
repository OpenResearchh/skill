# Implementation Plan

## Phase 0: Decisions

Settle these before coding:

- Token/stake design: Stellar Asset Contract, custom Soroban token, or internal escrow ledger.
- Artifact provider: Irys, IPFS, S3-compatible storage, Stellar-hosted mirror, or pluggable provider.
- Contract split: one OpenResearch contract plus token, or multiple contracts.
- Verifier admission model: admin allowlist, stake-based verifier set, or external registry.
- Mainnet posture: testnet-only prototype or mainnet-ready audit path.

## Phase 1: Stellar Reference Docs

Add:

```text
autoresearch-create/references/onchain-stellar.md
autoresearch-mine/references/onchain-mining-stellar.md
autoresearch-validate/references/onchain-verify-stellar.md
```

Each doc should cover:

- Network defaults.
- Contract ID and deployment record format.
- Artifact storage.
- CLI commands.
- Score scaling.
- Failure modes.
- Security notes.

## Phase 2: Contract Workspace

Add a Stellar contract workspace, likely in a new repo first:

```text
contracts/stellar-open-research/
  Cargo.toml
  contracts/
    open_research/
      Cargo.toml
      src/lib.rs
      src/storage.rs
      src/types.rs
      src/errors.rs
      src/events.rs
      src/tests.rs
    project_token/              # optional
      Cargo.toml
      src/lib.rs
  deployment.testnet.json
  README.md
```

Build target:

```bash
stellar contract build
```

Deploy target:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/open_research.wasm \
  --source <identity> \
  --network testnet
```

## Phase 3: Create Package

Add:

```text
autoresearch-create/contracts/stellar-open-research/deployment.json
autoresearch-create/scripts/stellar_open_research.*
autoresearch-create/scripts/publish_project_stellar.*
```

`publish_project_stellar` must:

- Read finalized `protocol.json`.
- Verify baseline artifact exists.
- Compute raw SHA-256 for protocol, repo snapshot, benchmark, and baseline metrics.
- Upload artifacts using the selected off-chain provider.
- Convert metric to signed integer aggregate score.
- Build or invoke `create_project`.
- Write:
  - `storage_stellar.json`
  - `publish_stellar_plan.json` for dry run
  - `publish_stellar.json` for live transaction

Dry run must not require funds.

## Phase 4: Mine Package

Add:

```text
autoresearch-mine/contracts/stellar-open-research/deployment.json
autoresearch-mine/scripts/bootstrap_from_stellar.*
autoresearch-mine/scripts/submit_proposal_stellar.*
```

`bootstrap_from_stellar` must:

- Fetch project state by project ID or token/stake asset.
- Download project artifacts from `storage_stellar.json` or provider metadata.
- Verify raw SHA-256 hashes.
- Unpack repo snapshot safely.
- Initialize `.autoresearch/mine`.
- Write `.autoresearch/mine/network_state.json`.
- Use baseline aggregate score as frontier until current-best code exists.

`submit_proposal_stellar` must:

- Archive committed candidate code.
- Use measured trial aggregate score.
- Upload code archive and benchmark log.
- Submit proposal with stake.
- Write submission metadata.

## Phase 5: Validate Package

Add:

```text
autoresearch-validate/contracts/stellar-open-research/deployment.json
autoresearch-validate/scripts/fetch_project_artifacts_stellar.*
autoresearch-validate/scripts/resolve_proposal_artifacts_stellar.*
autoresearch-validate/scripts/run_validate_loop_stellar.*
autoresearch-validate/scripts/settle_proposal_stellar.*
```

Validator loop must:

- Load contract deployment.
- Check validator identity and verifier registration.
- Poll submitted proposals.
- Claim first.
- Fetch candidate code/log artifacts.
- Fetch trusted project protocol and benchmark artifacts.
- Restore trusted harness into candidate tree.
- Run static gates.
- Run measured trials.
- Approve only if verified score improves incumbent by the protocol margin.
- Reject for fraud or static-gate failure.
- Release for ambiguous verifier-side or host-side failures.

## Phase 6: Event Indexer

Add an indexer or documented integration:

```text
indexer/
  README.md
  schema.sql
  ingest_stellar_events.*
```

The indexer should persist:

- Projects.
- Proposals.
- Frontier updates.
- Verifier actions.
- Artifact references.
- Transaction hashes.
- Ledger numbers.

Do not rely on Stellar RPC event retention for durable project history.

## Phase 7: Tests

Required tests:

- Rust unit tests for contract state transitions.
- Rust authorization tests.
- Score threshold tests.
- Stake accounting tests.
- Event emission tests.
- CLI dry-run tests.
- Local sandbox integration tests.
- Testnet smoke script.

## Phase 8: Audit Readiness

Before mainnet:

- Freeze contract API.
- Generate contract docs.
- Run fuzz/property tests for scoring and state transitions.
- Add replay and authorization tests.
- Review storage TTL extension strategy.
- Review event schema and indexer correctness.
- Get external audit for token/stake logic.

