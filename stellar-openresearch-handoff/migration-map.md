# Migration Map

## Concept Mapping

| Existing concept | Solana | 0G/EVM | Stellar target |
|---|---|---|---|
| Smart contract layer | Anchor program | EVM contracts | Stellar smart contract WASM |
| Project registry | `Project` PDA | `ProjectRegistry` | `Project` persistent record |
| Proposal ledger | `Proposal` PDA | `ProposalLedger` | `Proposal` persistent record |
| Verifier registry | Verifier PDA | `VerifierRegistry` | Verifier persistent record |
| Project token | SPL mint | ERC20-like `ProjectToken` | Custom token or Stellar Asset Contract |
| Artifact storage | Irys | 0G Storage | Pluggable off-chain provider |
| Artifact hash | SHA-256 `bytes32` | SHA-256 or 0G root `bytes32` | `BytesN<32>` SHA-256 |
| Proposal ID | PDA seed integer | uint256 | u64 counter |
| Project ID | PDA seed integer | uint256 | u64 counter |
| Score | signed integer | int256 | i128 |
| Wallet auth | Solana signer | EVM signer | Stellar address auth |
| Events | Program logs/events | EVM events | Stellar contract events |

## Project Creation

Solana:

- Browser wallet uploads artifacts to Irys.
- Program stores raw hashes and Irys IDs.
- `createProject` creates project state and token mint.

Stellar:

- Publisher uploads artifacts to selected provider.
- Contract stores raw hashes and provider IDs.
- `create_project` creates project state and stake/token configuration.

## Mining

Solana:

- Miner bootstraps from project account.
- Downloads Irys artifacts.
- Submits proposal with code/log Irys IDs.

Stellar:

- Miner bootstraps from contract project record.
- Downloads provider artifacts.
- Submits proposal with artifact refs and stake.

## Validation

Solana:

- Verifier fetches proposal account.
- Claims proposal.
- Resolves project artifacts from Project account.
- Restores trusted harness.
- Approves/rejects through settlement script.

Stellar:

- Verifier reads proposal record.
- Claims proposal.
- Resolves project artifacts from contract project record.
- Restores trusted harness.
- Approves/rejects through contract invoke.

## Score Frontier

All chains must share the same rule:

- If no current-best code exists, incumbent is baseline aggregate score.
- Otherwise, incumbent is current best aggregate score.
- A proposal can be approved only when verified score meets or exceeds the incumbent plus the required bips margin.

## Storage Differences

Solana:

- Account data lives in PDAs.
- Rent/account sizing matters.

0G/EVM:

- Contract storage is persistent unless modified.
- Gas cost dominates.

Stellar:

- Contract storage entries have TTL and can be archived.
- Persistent storage can be restored.
- TTL extension has resource cost.
- Design must include TTL maintenance.

## Token Differences

Solana:

- SPL mint and token accounts.

0G/EVM:

- ERC20-like project token with approve/allowance.

Stellar:

- Either Stellar Asset Contract or custom Soroban token.
- Authorization and trustline behavior must be explicit.

## File Migration

Add Stellar equivalents, do not replace Solana or 0G initially.

| Current area | Add |
|---|---|
| `autoresearch-create/references/onchain-solana.md` | `autoresearch-create/references/onchain-stellar.md` |
| `publish_project_solana.mjs` | `publish_project_stellar.*` |
| `contracts/solana-open-research/` | `contracts/stellar-open-research/` |
| `bootstrap_from_solana.mjs` | `bootstrap_from_stellar.*` |
| `submit_proposal_solana.mjs` | `submit_proposal_stellar.*` |
| `run_validate_loop_solana.mjs` | `run_validate_loop_stellar.*` |
| `settle_proposal_solana.mjs` | `settle_proposal_stellar.*` |

