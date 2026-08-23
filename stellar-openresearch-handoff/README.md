# Stellar OpenResearch Handoff

This folder is a standalone planning bundle for moving the OpenResearch on-chain layer to Stellar smart contracts.

It is intended to be copied into a fresh repository and used as the initial design brief before implementation starts.

## Files

| File | Purpose |
|---|---|
| `SPEC.md` | **Start here.** Authoritative design brief. Supersedes `contract-api.md`, `architecture.md`, and the storage sections of `migration-map.md`. |
| `handoff-prompt.md` | Copy/paste prompt for a new agent or engineering team. |
| `architecture.md` | Proposed Stellar architecture and design rationale. |
| `contract-api.md` | Soroban contract model, state, methods, events, and errors. |
| `implementation-plan.md` | Repo/file plan and phased implementation checklist. |
| `cli-and-env.md` | Proposed CLI commands, env vars, deployment records, and dry-run behavior. |
| `security-and-tests.md` | Security requirements, threat model, and test plan. |
| `migration-map.md` | Mapping from current Solana and 0G concepts to Stellar. |
| `open-questions.md` | Product and protocol decisions to settle before writing contracts. |

## Official References

- Stellar developer docs: https://developers.stellar.org/
- Stellar CLI: https://developers.stellar.org/docs/tools/cli/stellar-cli
- Stellar Asset Contract: https://developers.stellar.org/docs/tokens/stellar-asset-contract
- Contract storage and TTL: https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage
- Authorization: https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
- Events ingestion: https://developers.stellar.org/docs/build/guides/events/ingest

## Starting Point

Read files in this order:

1. `handoff-prompt.md`
2. `architecture.md`
3. `contract-api.md`
4. `implementation-plan.md`
5. `security-and-tests.md`

The design assumes Stellar smart contracts, formerly Soroban, with Rust contracts compiled to WASM and operated through Stellar CLI or SDK clients.

