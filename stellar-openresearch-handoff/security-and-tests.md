# Security And Tests

## Threat Model

Threats:

- Miner submits code that tampers with benchmark or harness.
- Miner submits artifact hash that does not match bytes.
- Verifier approves without reproducing improvement.
- Verifier rejects honest work due to local noise or stale frontier.
- Publisher creates malicious benchmark tar that escapes extraction.
- Unauthorized account settles proposals.
- Proposal replay or double settlement.
- Token/stake accounting mismatch.
- Storage TTL expiry hides critical state.
- Events are lost before off-chain consumers ingest them.

## Security Requirements

### Artifact Integrity

- Use raw SHA-256 for all project and proposal artifacts.
- Validate every fixed-size hash exactly.
- Store artifact provider IDs separately from raw hashes.
- Never treat a URL as a hash.
- Verify downloaded bytes before use.

### Trusted Evaluation

- Validator must use project creation protocol and benchmark artifacts.
- Submitted candidate code must not decide how it is judged.
- Restore trusted immutable harness paths before running tests.
- Treat harness divergence as tampering.

### Archive Safety

- Reject archives containing:
  - absolute paths
  - `..` path traversal
  - symlinks
  - hardlinks
  - device files
  - special files
- Extract into a fresh directory.
- Verify expected file set after extraction.

### Score Safety

- Use deterministic signed integer score conversion.
- Store metric scale at project creation.
- For minimize, negate scaled metric so higher aggregate score is better.
- Genesis incumbent is baseline aggregate score.
- Current-best incumbent is current best aggregate score.
- Approval threshold is inclusive:
  - `verified_score >= incumbent + margin`
- Margin is:
  - `abs(incumbent) * min_score_improvement_bips / 10000`

### Authorization

- Every mutating method must require auth from the correct actor.
- Admin methods require admin auth.
- Miner proposal submission requires miner auth.
- Verifier settlement requires verifier auth and claim ownership.
- Reward claims require recipient or configured claimant auth.

### Replay And State Transitions

- Proposal IDs must be monotonic.
- A proposal can settle once.
- Valid status transitions only:
  - Submitted -> Claimed
  - Claimed -> Approved
  - Claimed -> Rejected
  - Claimed -> Released
  - Submitted or Claimed -> Expired, depending on policy
- Store submitted, claimed, and settled ledger numbers.

### Storage TTL

- Use explicit ledger deadlines for proposal timeout/expiry.
- Do not rely on Stellar storage TTL for security.
- Include TTL extension strategy for persistent and instance state.
- Add maintenance method if needed.
- Tests must simulate archival/TTL behavior where possible.

### Events

- Emit events for every lifecycle transition.
- Include project ID and proposal ID in topics/data.
- Persist events off-chain because RPC retention is limited.

## Test Plan

### Contract Unit Tests

- Initialize can run only once.
- Admin can add/remove verifier.
- Non-admin cannot add/remove verifier.
- Create project stores baseline frontier.
- Proposal submit transfers/escrows stake.
- Claim requires registered verifier.
- Approve requires claim owner.
- Reject requires claim owner.
- Release does not slash when configured as ambiguous failure.
- Expire follows ledger deadline.
- Proposal cannot settle twice.

### Score Tests

- Maximize exact threshold passes.
- Minimize exact threshold passes.
- Below margin fails.
- Genesis uses baseline.
- Current best uses current best after first approval.
- Negative aggregate scores work.
- Zero incumbent margin behavior is explicit and tested.
- Large scores do not overflow chosen integer type.

### Token/Stake Tests

- Stake escrow debits miner.
- Approval returns stake or rewards according to product rule.
- Rejection slashes according to product rule.
- Expiry behavior is product-defined and tested.
- Unauthorized transfers fail.

### Artifact Tests

- Valid hash passes.
- Mismatched hash fails.
- Missing artifact fails safely.
- Unsafe tar path is rejected.
- Symlink archive is rejected.
- Trusted harness restore detects tampering.

### CLI Tests

- Publish dry-run writes a valid plan.
- Publish live refuses without explicit confirmation.
- Bootstrap writes network state with baseline frontier on genesis.
- Submit proposal refuses dirty repo or missing log.
- Validate loop releases noisy measurement instead of rejecting.

### Integration Tests

- Local Stellar sandbox deploy.
- Create project.
- Submit proposal.
- Claim review.
- Approve exact-threshold improvement.
- Reject non-improvement.
- Ingest emitted events.

### Mainnet Readiness

- External audit for contract and token logic.
- Resource/fee profiling.
- Storage TTL strategy reviewed.
- Event indexer load tested.
- Emergency admin and upgrade policy documented.

