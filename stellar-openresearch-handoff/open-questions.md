# Open Questions

Resolve these before implementation.

## Chain And Network

1. Is Stellar the default path or an alternate path beside Solana?
2. Should the first milestone target Stellar testnet only?
3. Is a local Stellar sandbox required for CI?
4. Who controls initial contract initialization and verifier registration?

## Contract Architecture

1. One contract or multiple contracts?
2. Is the contract upgradeable?
3. If upgradeable, who controls upgrades?
4. Should verifier registry live in the same contract as proposals?
5. Should project token logic be internal or separate?

## Tokenomics

1. Should project tokens be Stellar issued assets/SAC or custom Soroban tokens?
2. Are project tokens transferable?
3. Can miners buy stake from a bonding curve?
4. Is there a miner reward pool cap?
5. What happens to slashed stake?
6. What happens to expired proposal stake?
7. Should reward recipient differ from miner account?

## Artifacts

1. Which artifact provider should Stellar use?
2. Should Irys remain the artifact provider for Stellar?
3. If not Irys, what stores raw artifacts and gives stable retrieval IDs?
4. How are artifact IDs encoded into `BytesN<32>`?
5. Is a gateway URL allowed in metadata, or only provider IDs?

## Scoring

1. Is `ARAH_METRIC_SCALE=1000000` still the default?
2. Should metric scale be stored per project on-chain?
3. What is the maximum allowed `min_score_improvement_bips`?
4. How should zero incumbent score be handled?
5. Should claimed score be checked on-chain, or only verified score?

## Validation

1. How many verifiers are required per proposal?
2. Is one verifier approval enough to update frontier?
3. Can a verifier release a proposal back to the queue?
4. What prevents verifier griefing by repeated claims/releases?
5. Is there a verifier stake or reputation system?

## Storage And Indexing

1. Who pays for TTL extension?
2. What method renews TTL for project/proposal state?
3. How often should TTL maintenance run?
4. What indexer will persist events beyond RPC retention?
5. What database schema should indexer use?

## Wallet UX

1. Is browser-wallet signing required for publish?
2. Which Stellar wallets should be supported?
3. Is local keypair mode allowed for automation?
4. What is the policy for secrets in CI?

## Mainnet

1. What audit level is required before mainnet?
2. What emergency pause controls are acceptable?
3. Should mainnet launch use immutable contracts?
4. What monitoring is required?

