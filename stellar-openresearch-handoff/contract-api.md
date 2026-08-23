# Contract API

This is a contract API sketch, not final Rust code.

## Types

```rust
pub type ProjectId = u64;
pub type ProposalId = u64;

#[contracttype]
pub enum Direction {
    Maximize,
    Minimize,
}

#[contracttype]
pub enum ProposalStatus {
    Submitted,
    Claimed,
    Approved,
    Rejected,
    Released,
    Expired,
}

#[contracttype]
pub enum CodeOrigin {
    Baseline,
    CurrentBest,
}

#[contracttype]
pub struct ArtifactRef {
    pub sha256: BytesN<32>,
    pub storage_id: BytesN<32>,
    pub provider: Symbol,
}

#[contracttype]
pub struct Project {
    pub id: u64,
    pub creator: Address,
    pub protocol: ArtifactRef,
    pub repo_snapshot: ArtifactRef,
    pub benchmark: ArtifactRef,
    pub baseline_metrics: ArtifactRef,
    pub baseline_aggregate_score: i128,
    pub current_best_aggregate_score: i128,
    pub current_best_code: Option<ArtifactRef>,
    pub current_best_metrics: Option<ArtifactRef>,
    pub current_best_miner: Option<Address>,
    pub metric_scale: i128,
    pub direction: Direction,
    pub min_score_improvement_bips: u32,
    pub stake_token: Address,
    pub minimum_stake: i128,
    pub reward_pool_cap: i128,
    pub created_ledger: u32,
}

#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub project_id: u64,
    pub miner: Address,
    pub reward_recipient: Address,
    pub code: ArtifactRef,
    pub benchmark_log: ArtifactRef,
    pub claimed_aggregate_score: i128,
    pub verified_aggregate_score: Option<i128>,
    pub stake: i128,
    pub status: ProposalStatus,
    pub claimed_by: Option<Address>,
    pub metrics: Option<ArtifactRef>,
    pub submitted_ledger: u32,
    pub claimed_ledger: Option<u32>,
    pub settled_ledger: Option<u32>,
}
```

## Initialization

```rust
pub fn initialize(
    env: Env,
    admin: Address,
    review_timeout_ledgers: u32,
    proposal_expiry_ledgers: u32,
)
```

Requirements:

- Can only run once.
- `admin.require_auth()`.
- Writes global config and counters.

## Verifier Registry

```rust
pub fn add_verifier(env: Env, admin: Address, verifier: Address)
pub fn remove_verifier(env: Env, admin: Address, verifier: Address)
pub fn is_verifier(env: Env, verifier: Address) -> bool
```

Requirements:

- Admin authorization required for add/remove.
- Settlement methods require `is_verifier(caller)`.

## Project Creation

```rust
pub fn create_project(
    env: Env,
    creator: Address,
    protocol: ArtifactRef,
    repo_snapshot: ArtifactRef,
    benchmark: ArtifactRef,
    baseline_metrics: ArtifactRef,
    baseline_aggregate_score: i128,
    metric_scale: i128,
    direction: Direction,
    min_score_improvement_bips: u32,
    stake_token: Address,
    minimum_stake: i128,
    reward_pool_cap: i128,
) -> u64
```

Requirements:

- `creator.require_auth()`.
- Artifact hashes must be exactly 32 bytes.
- `metric_scale > 0`.
- `minimum_stake > 0`.
- `min_score_improvement_bips` must be bounded by a safe max, for example `<= 10000`.
- Initializes current frontier to baseline.

Event:

```text
project_created(project_id, creator, protocol_sha256, baseline_aggregate_score)
```

## Proposal Submission

```rust
pub fn submit_proposal(
    env: Env,
    miner: Address,
    project_id: u64,
    code: ArtifactRef,
    benchmark_log: ArtifactRef,
    claimed_aggregate_score: i128,
    stake: i128,
    reward_recipient: Address,
) -> u64
```

Requirements:

- `miner.require_auth()`.
- Project exists.
- Stake is at least project minimum.
- Transfer stake from miner to escrow.
- Status starts as `Submitted`.

Event:

```text
proposal_submitted(proposal_id, project_id, miner, claimed_aggregate_score)
```

## Claim Review

```rust
pub fn claim_review(env: Env, verifier: Address, proposal_id: u64)
```

Requirements:

- `verifier.require_auth()`.
- Verifier is registered.
- Proposal status is `Submitted`.
- Sets status to `Claimed`.

Event:

```text
review_claimed(proposal_id, verifier)
```

## Approval

```rust
pub fn approve(
    env: Env,
    verifier: Address,
    proposal_id: u64,
    verified_aggregate_score: i128,
    metrics: ArtifactRef,
)
```

Requirements:

- `verifier.require_auth()`.
- Verifier is registered.
- Proposal is claimed by verifier.
- Verified score meets threshold:
  - incumbent is current best if current-best code exists, else baseline.
  - threshold is incumbent plus relative margin.
  - approve if `verified_aggregate_score >= threshold`.
- Releases stake to miner or reward recipient per tokenomics.
- Updates current best code, metrics, miner, and score.

Event:

```text
proposal_approved(proposal_id, project_id, verifier, verified_aggregate_score)
frontier_updated(project_id, verified_aggregate_score, miner)
```

## Rejection

```rust
pub fn reject(
    env: Env,
    verifier: Address,
    proposal_id: u64,
    evidence: ArtifactRef,
    reason_code: Symbol,
)
```

Requirements:

- `verifier.require_auth()`.
- Verifier is registered.
- Proposal is claimed by verifier.
- Applies configured slashing rule.

Event:

```text
proposal_rejected(proposal_id, verifier, reason_code)
```

## Release Review

```rust
pub fn release_review(env: Env, verifier: Address, proposal_id: u64, reason_code: Symbol)
```

Use for ambiguous failures that should not slash the miner:

- Harness failure.
- Measurement too noisy.
- Verifier host problem.
- Artifact provider outage.

Requirements:

- Claimed by verifier.
- Returns proposal to `Submitted` or marks `Released`, depending on product decision.

## Expire

```rust
pub fn expire(env: Env, caller: Address, proposal_id: u64)
```

Requirements:

- `caller.require_auth()`.
- Proposal exceeded expiry ledger.
- Applies product-defined expiry behavior.

Do not rely on Stellar storage TTL for expiry. Store ledger numbers explicitly.

## Read Methods

```rust
pub fn get_project(env: Env, project_id: u64) -> Project
pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal
pub fn next_project_id(env: Env) -> u64
pub fn next_proposal_id(env: Env) -> u64
pub fn incumbent_score(env: Env, project_id: u64) -> i128
pub fn improvement_threshold(env: Env, project_id: u64) -> i128
```

