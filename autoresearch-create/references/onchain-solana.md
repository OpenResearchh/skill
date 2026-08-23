# Solana OpenResearch Publishing

This is the reference for the `solana` settlement layer. The workflow calls
`scripts/publish_project.mjs`; when `solana` is the active layer that entrypoint
delegates to `scripts/publish_project_solana.mjs` and translates
`--upload-artifacts` into `--upload-artifacts-to-irys`. Every other flag below
can be passed straight through `publish_project.mjs`. Select this layer with
`--chain solana`, `ARAH_CHAIN=solana`, or `.autoresearch/chain.json`; it is also
the default when nothing is configured.

`--base-price` and `--slope` are denominated in lamports on this layer.

OpenResearch Solana program id:

```text
ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3
```

Deployment:

```text
Network: devnet
RPC: https://api.devnet.solana.com
```

Frontend env:

```env
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_OPEN_RESEARCH_PROGRAM_ID=ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3
```

Irys is the default artifact layer for the Solana path. The Solana program
stores 32-byte SHA-256 hashes of the raw protocol, repo snapshot, benchmark
bundle, and baseline metrics files plus the 32-byte Irys transaction ids for
those same artifacts. `storage_irys.json` records the human-readable Irys ids,
gateway URLs, and upload receipts.

Devnet/testnet publishes use Irys devnet, which is suitable for testing and
may expire after the devnet retention window. Mainnet-beta publishes use Irys
mainnet and pay real SOL for permanent Arweave-backed storage.

## Deployment prerequisite: initialize the program

The publish CLI reads the on-chain `GlobalConfig` PDA to fetch the next
project id. A fresh program deployment has no `GlobalConfig` yet — anyone
running the publish flow on a cluster where the program was never initialized
will see the wallet page hang on a transaction that cannot be built.

Bootstrap the program once on each target cluster, signed by the program's
authority wallet:

```bash
node scripts/publish_project_solana.mjs --initialize-only --yes
```

This opens the same localhost wallet page and submits a single `initialize`
instruction. Add `--keypair` to sign headlessly, or `--cluster` / `--rpc-url`
to target a non-default cluster. The CLI writes `initialize_solana.json` next
to the working directory and exits.

`publish_project_solana.mjs` performs a preflight check before opening the
wallet page; if `GlobalConfig` is missing it now fails fast with the exact
bootstrap command instead of waiting on a signature.

## Default flow: browser wallet

By default, live publishes use a temporary localhost HTTP page that discovers
Solana wallet extensions (Phantom, Solflare, Backpack, plus any Wallet
Standard wallet). The CLI never sees the private key: the browser uploads
artifacts to Irys with the connected wallet, then signs and submits the
`createProject` transaction directly.

```bash
node scripts/publish_project_solana.mjs \
  --protocol-json ./out/protocol.json \
  --repo-snapshot-file ./repo-snapshot.tar \
  --benchmark-file ./benchmark.tar \
  --baseline-metrics-file ./out/baseline_run.log \
  --baseline-aggregate-score 12345 \
  --token-name "My Research Token" \
  --token-symbol MRT \
  --base-price 100000 \
  --slope 1000 \
  --miner-pool-cap 21000000 \
  --upload-artifacts-to-irys \
  --yes
```

The CLI:

1. Computes raw SHA-256 hashes for each artifact and serves them only to the
   localhost browser page.
2. Opens `http://127.0.0.1:<port>/<token>/sign` in the browser.
3. Waits for the user to connect a Solana wallet there.
4. The browser uploads the artifacts to Irys and returns upload receipts.
5. Converts returned Irys ids into their 32-byte on-chain form, reads
   `GlobalConfig.next_project_id`, builds the `createProject` instruction, and
   hands it to the page.
6. Waits for the wallet to sign and submit the transaction, then confirms
   the signature on devnet.

The bundled Anchor IDL at `contracts/solana-open-research/open_research.json`
is the full OpenResearch IDL and covers project creation, miner proposals,
verifier settlement, reward claims, and account decoding. Pass `--idl` only
when testing another build.

## Dry run

```bash
node scripts/publish_project_solana.mjs \
  --protocol-json ./out/protocol.json \
  --repo-snapshot-file ./repo-snapshot.tar \
  --benchmark-file ./benchmark.tar \
  --baseline-metrics-file ./out/baseline_run.log \
  --baseline-aggregate-score 12345 \
  --token-name "My Research Token" \
  --token-symbol MRT \
  --base-price 100000 \
  --slope 1000 \
  --miner-pool-cap 21000000 \
  --creator <solana-pubkey> \
  --upload-artifacts-to-irys \
  --dry-run
```

`--dry-run` defaults `--project-id` to 0 if not supplied and writes a
`publish_solana_plan.json` next to the protocol bundle.

Use `--irys-network devnet|mainnet` only when overriding the automatic mapping
from Solana cluster to Irys network.

## Filesystem keypair (opt-in)

For headless or automated runs, pass `--keypair`:

```bash
node scripts/publish_project_solana.mjs ... \
  --keypair ~/.config/solana/id.json \
  --yes
```

This skips the browser flow and signs locally, so it cannot upload artifacts
to Irys. Only use it when the user explicitly opts in and intentionally passes
`--allow-skip-storage`.

## PDA Seeds

All numeric ids are little-endian `u64`:

| Account | Seeds |
|---|---|
| config | `"config"` |
| verifier | `"verifier"`, verifier public key |
| project | `"project"`, project id |
| mint | `"mint"`, project id |
| mint authority | `"mint_authority"`, project id |
| SOL vault | `"sol_vault"`, project id |
| project pool | `"pool"`, project id |
| proposal | `"proposal"`, proposal id |
| proposal escrow | `"proposal_escrow"`, proposal id |
| claimable | `"claim"`, project id, account public key |
| token metadata | Metaplex metadata PDA for the project mint |

Use `scripts/solana_open_research.mjs` for canonical derivation and input
conversion. It validates 32-byte hashes, `u64` token/lamport fields, `i64`
scores, Associated Token Accounts, and Anchor account maps.

## Frontend Action Items

1. Copy the Anchor IDL into the frontend and build calls through
   `program.methods.*`.
2. Add verifiers using the authority wallet.
3. Derive PDAs from seeds instead of storing per-module contract addresses.
4. Treat project tokens as SPL Token mints with `decimals = 0`.
5. Convert every EVM `address` to a Solana `PublicKey`.
6. Convert every EVM `bytes32` to exactly 32 bytes.
7. Convert EVM `uint256` values to Anchor `BN`, then ensure on-chain
   token/lamport amounts fit `u64`.
8. Replace ERC20 approval/allowance flows with wallet-signed SPL token
   account transfers.

Detailed frontend examples are mirrored in
`open_research/FRONTEND_INTEGRATION_README.md`.
