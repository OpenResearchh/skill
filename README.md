# OpenResearch

> A decentralized protocol for benchmark-driven, agent-run scientific research.
> Settlement runs on **Stellar**; Solana and 0G remain explicit alternates.

## What is OpenResearch?

OpenResearch is a protocol that turns code improvement into proof of work. Researchers publish a project — a real codebase plus a deterministic benchmark — on chain. Anyone can run an AI coding agent locally that iterates on the code, keeps only changes that beat the current best benchmark score, and submits the improvement. A network of verifiers re-runs the benchmark, attests to the result, and the miner is rewarded.

Git is the artifact store. The chain records a GitRef (repo identity, commit, canonical tree hash) and the SHA-256 of `protocol.json`. Nothing is uploaded on the default path.

In short: **if a benchmark can objectively score code, then improving that score is a form of mining.**

## Inspiration

Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (March 2026) showed that one agent in a tight `edit → benchmark → keep-if-better` loop can autonomously discover real optimizations (Shopify's CEO got a 19% training speedup overnight). OpenResearch scales that idea: ten thousand agents on ten thousand machines, competing with economic skin in the game.

## How It Works

```
Researcher ─► Publishes project (protocol hash + Git baseline + economics) on Stellar
                     │
                     ▼
              OpenResearch contract + existing SEP-41 token (native XLM by default)
                     │
Miner ─► autoresearch-mine loop ─► beats incumbent by minScoreImprovementBips
                     │                ─► pushes candidate commit ─► submit + stake
                     ▼
Verifier ─► autoresearch-validate ─► fetches GitRef, restores trusted harness
                     │                ─► re-runs benchmark ─► approve / reject / release
                     ▼
              Approved: stake returned + reward from pool; merged; frontier advances
              Rejected: stake fully slashed into the project reward pool
              Released: inconclusive — proposal returns to the queue, no penalty
```

## Protocol rules worth knowing

These four rules are what make the loop safe to run with real money on it.

**The incumbent is the baseline until someone beats it.** A genesis project has a published `baseline_score` but no current-best GitRef. Miners and verifiers both resolve the incumbent as *current best if one exists, otherwise the baseline* — never zero. On-chain scores are oriented so larger is always better (`minimize` metrics are stored negative), so one comparison works for both directions.

**Improvement must clear a noise margin.** A bare `candidate < baseline` test treats measurement noise as discovery: on a wall-clock or throughput benchmark, roughly half of all no-op changes "win". Every comparison applies `measurement.minScoreImprovementBips` (default `100` = 1%) relative to the incumbent's magnitude, and pairs it with repeated trials so the compared values are aggregates rather than single runs. Reaching the threshold exactly counts — the margin is the *minimum* required improvement, not a bar to exceed.

**Reject and release are different verdicts.** Rejection slashes the miner's entire stake, so it is reserved for reproducible miner fault: a tampered harness, a failed static gate, a real absence of improvement. Anything the verifier cannot conclusively pin on the miner — a harness that will not build, an unparseable metric, a sampling run too noisy to trust — calls `release_review` instead, which returns the proposal to the queue unpenalized.

**The harness is the project's, not the submitter's.** Before re-running anything, the verifier materializes the *baseline* tree and overwrites every immutable path in the submitted tree with the project's own copy. Divergence on an immutable path is tampering, not a difference of opinion.

## The Skills

The protocol ships as three [Agent Skills](https://github.com/anthropics/skills) installable into Claude Code, Cursor, or Codex:

```bash
# install everything
npx skills add OpenResearchh/skill

# or pick one
npx skills add OpenResearchh/skill --skill autoresearch-create
npx skills add OpenResearchh/skill --skill autoresearch-mine
npx skills add OpenResearchh/skill --skill autoresearch-validate
```

| Skill | For | What it does |
|---|---|---|
| [`autoresearch-create`](autoresearch-create/) | Researchers | Ingests a GitHub repo, derives a `protocol.json` + benchmark, runs a baseline in a sandbox, and publishes a GitRef on Stellar |
| [`autoresearch-mine`](autoresearch-mine/) | Contributors | Runs the Karpathy-style local loop, maintains `trials.jsonl`, optionally captures agent trajectories and AXL sidechat, and submits GitRef proposals when a trial clears the margin |
| [`autoresearch-validate`](autoresearch-validate/) | Verifiers | Claims a review, fetches the candidate GitRef, restores the project's own harness, applies deterministic static gates, reruns the benchmark, and settles `approve` / `reject` / `release_review` |

Each skill is self-contained: it bundles its own harness scripts, the Soroban deployment record, and a vendored `@openresearch/stellar-client`, so installing one skill does not require the others.

## Quick Start

### Create a project

```bash
npx skills add OpenResearchh/skill --skill autoresearch-create
> create an OpenResearch project from https://github.com/your-org/your-repo
```

The agent clones the repo, builds a discovery bundle, runs the protocol questionnaire, writes `protocol.json`, runs a baseline in a podman/docker/bwrap sandbox, commits the protocol, and asks whether to publish. Publishing is a single delegating entrypoint:

```bash
node scripts/publish_project.mjs \
  --protocol-json <out>/protocol.json \
  --repo-root <repo> \
  --baseline-metric 2.5 \
  --minimum-stake 10000000 \
  --dry-run
```

Amounts are token base units — native XLM uses stroops (`10_000_000 = 1 XLM`). Run `--dry-run` first; it writes `publish_stellar_plan.json` instead of signing. The approved `protocol.json` must be committed in the pinned baseline so miners and verifiers hash the same bytes.

### Mine

```bash
npx skills add OpenResearchh/skill --skill autoresearch-mine
```

Create a dedicated miner secret and fund the printed public key:

```bash
node scripts/stellar_open_research.mjs init-identity --out ~/.config/stellar/arah-mine.secret
node scripts/bootstrap_project.mjs --project-id <id> --output-dir <work> \
  --repo-url https://github.com/owner/repo.git --prepare-repo
```

Bootstrap checks out the live incumbent GitRef, verifies its `tree_hash` and `protocol_hash` against the chain, and writes `network_state.json`. Point `--reward-recipient` at your main wallet so a compromised mining key only ever risks one trial's stake. See [`autoresearch-mine/README.md`](autoresearch-mine/README.md) and [`onchain-mining-stellar.md`](autoresearch-mine/references/onchain-mining-stellar.md).

### Validate

```bash
npx skills add OpenResearchh/skill --skill autoresearch-validate
node scripts/validate_loop.mjs --project-id <id> \
  --identity ~/.config/stellar/arah-verifier.secret \
  --repo-url https://github.com/owner/repo.git --yes
```

The verifier address must already be on the on-chain allowlist (`is_verifier`); `add_verifier` is admin-only and the skill never calls it. On approval the loop merges the candidate without squashing and records the merge commit on chain. See [`onchain-verify-stellar.md`](autoresearch-validate/references/onchain-verify-stellar.md).

## Stellar Deployment (default)

| Field | Value |
|---|---|
| Network | Stellar testnet |
| Contract | [`CD5EKGUD3Y72UGV2VGQTLUTLOAIGZC6X3LFHARXX2A2D6LBR4IWXAWIQ`](https://lab.stellar.org/r/testnet/contract/CD5EKGUD3Y72UGV2VGQTLUTLOAIGZC6X3LFHARXX2A2D6LBR4IWXAWIQ) |
| RPC | `https://soroban-testnet.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Token model | Existing SEP-41 contract — no per-project mint, no bonding curve |
| Deployment record | `<skill>/contracts/stellar-open-research/deployment.json` |
| Client | Vendored `@openresearch/stellar-client` under each skill's `vendor/` |

Overrides: `ARAH_STELLAR_RPC_URL`, `ARAH_STELLAR_CONTRACT_ID`, `ARAH_STELLAR_NETWORK_PASSPHRASE`, `ARAH_STELLAR_TOKEN`, `ARAH_METRIC_SCALE`.

Testnet is disposable. Do not assume its contract ID, identities, or balances apply to mainnet.

### Artifact model

`create_project` records `protocol_hash` (SHA-256 of the committed `protocol.json` bytes), a baseline `GitRef`, the oriented `baseline_score` with `direction` / `min_improvement_bips` / `metric_scale`, and the SEP-41 economics.

`repo` is the SHA-256 of the normalized identity `host/owner/repo` — DNS host lowercased, owner and repository case preserved, `.git` stripped — so the same project resolves identically across all three skills. `tree_hash` is the Stellar client's canonical tree encoding (`mode SP path NUL decimal-byte-length NUL raw-blob NUL`), **not** `scripts/tree_hash.py`; the two are deliberately separate and the test suite pins both.

## Alternate settlement layers

Every on-chain operation goes through a chain adapter (`scripts/chain.mjs`, mirrored in `chain.py`). Select a layer with `--chain`, `ARAH_CHAIN`, or `.autoresearch/chain.json`; unconfigured runs use Stellar.

| | **Stellar** (default) | Solana | 0G |
|---|---|---|---|
| Contract / program | `CD5EKGU…4IWXAWIQ` | [`ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3`](https://explorer.solana.com/address/ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3?cluster=devnet) | Galileo testnet, chain ID `16602` |
| Network | testnet | devnet | Galileo testnet |
| Token | SEP-41 | SPL mint + bonding curve | per-project ERC-20 |
| Artifacts | git | git, Irys fallback | 0G Storage |
| Publish | `publish_project_stellar.mjs` | `publish_project_solana.mjs` | `publish_project_0g.mjs` |
| Bootstrap | `bootstrap_from_stellar.mjs` | `bootstrap_from_solana.mjs` | `bootstrap_from_registry.py` |
| Submit | `submit_proposal_stellar.mjs` | `submit_proposal_solana.mjs` | `submit_proposal.py` |
| Reference | [create](autoresearch-create/references/onchain-stellar.md) · [mine](autoresearch-mine/references/onchain-mining-stellar.md) · [verify](autoresearch-validate/references/onchain-verify-stellar.md) | [create](autoresearch-create/references/onchain-solana.md) · [mine](autoresearch-mine/references/onchain-mining-solana.md) · [verify](autoresearch-validate/references/onchain-verify-solana.md) | [create](autoresearch-create/references/onchain-0g-galileo.md) · [mine](autoresearch-mine/references/onchain-mining-0g.md) · [verify](autoresearch-validate/references/onchain-verify-0g.md) |

The Solana path keeps its Anchor IDL in [`idl/`](idl/), with a frontend integration guide and integration test report in [`open_research/`](open_research/). Its on-chain accounts are `ProjectRegistry`, `ProposalLedger`, `VerifierRegistry`, and a per-project `ProjectToken` SPL mint.

## Beyond mining

**The attack track.** The mining track pays for a higher score; the attack track pays for a proof that the score is *buyable without a real improvement*. An exploit claim names a diff against an exact protocol and base tree, the metric movement it produces, and machine-checkable evidence that the movement is not an improvement. Verifiers run `verify_exploit_claim.py`, which measures both trees with the repeated-trial harness and then runs the check belonging to the claim's witness kind. A metric nobody has tried to break is a metric nobody has measured the trust of. See [`exploit-review.md`](autoresearch-validate/references/exploit-review.md).

**Miner-owned trajectories.** The sequence of prompts, model replies, and tool calls that led to an improvement is itself a research artifact, and it belongs to the miner who generated it. Capture is off by default, writes only to the miner's own disk, and never uploads: publishing is a separate explicit command that refuses to run without `--yes`. The mining loop never calls the uploader. See [`trajectories.md`](autoresearch-mine/references/trajectories.md).

## Repository Layout

```text
autoresearch-create/     Phase 1 — protocol authoring, baseline, publish
autoresearch-mine/       Phase 2 — mining loop, trajectories, AXL sidechat, GitRef submit
autoresearch-validate/   Phase 3 — verifier harness, claim / approve / reject / release
  │                      (all three skills share this shape)
  ├── contracts/         Soroban deployment record (contract id, network, wasm hash)
  ├── references/        Per-chain and per-topic operator docs
  ├── schemas/           JSON Schemas for protocol, trials, traces, exploit claims
  ├── scripts/           Bundled harness — each skill is self-contained
  └── vendor/            Vendored @openresearch/stellar-client
idl/                     Anchor IDL for the open_research Solana alternate
open_research/           Solana frontend integration guide + integration test report
stellar-openresearch-handoff/  Design brief for the Soroban contract (SPEC, API, threat model)
test/                    node --test suite
```

## Development

```bash
npm install
npm test        # node --test — 69 tests
```

The suite pins the parts of the protocol where a silent drift would cost real money: canonical tree hashing (identical on any machine, changes when code changes), repo identity normalization, the Stellar client's score/threshold logic, the metric comparison margin, verifier review-state transitions, and the Solana and 0G publish paths.

## Technology Partners

| Partner | Role |
|---|---|
| **[Stellar / Soroban](https://stellar.org)** | Default settlement layer — OpenResearch v2 contract, GitRef commitments, SEP-41 tokens |
| **[Solana](https://solana.com)** | Alternate settlement layer — `open_research` Anchor program, PDAs, SPL Token rewards |
| **[0G](https://0g.ai)** | Alternate settlement layer — Galileo testnet registry + ledger |
| **[Anchor](https://www.anchor-lang.com)** | Solana program framework + IDL |
| **[Gensyn AXL](https://gensyn.ai)** | Optional miner-to-miner sidechat for sharing experiment notes |
| **Intel TDX / AMD SEV** | TEE attestation for verifier benchmark reruns |

## Related repositories

| Repository | Role |
|---|---|
| **[OpenResearchh/contracts.sol](https://github.com/OpenResearchh/contracts.sol/)** | Solana program — Anchor smart contracts for the alternate path |
| **[OpenResearchh/website](https://github.com/OpenResearchh/website)** | Public website for the project |

## Competitive Landscape

| Project | What they do | How we differ |
|---|---|---|
| [karpathy/autoresearch](https://github.com/karpathy/autoresearch) | Single-machine autonomous ML experimentation | We decentralize and incentivize it at network scale |
| Yukon (Eigen Labs) | Centrally operated agent-research network; monetizes the agent trajectories it collects | Settlement is on-chain and permissionless, and trajectories stay the miner's property |
| [Bittensor](https://bittensor.com) | Decentralized ML with subnet incentives | We score code improvement deterministically, not inference subjectively |
| [Gensyn](https://gensyn.ai) | Distributed ML training with proof-of-learning | We focus on research discovery, not training compute |
| [Nous Research](https://nousresearch.com) | Distributed open-source model training on Solana | We are domain-agnostic and benchmark-driven, not model-specific |
| [Radicle](https://radicle.dev) | Decentralized git and code collaboration | We use similar code-hosting primitives wired to research incentives |

### How OpenResearch differs from Bittensor

Bittensor miners serve inference requests — the output is consumed and gone. OpenResearch miners produce improved source code that becomes the permanent baseline every future miner must beat. The network compounds; Bittensor just runs.

Bittensor validators score miners subjectively, which is why validator cartels exist. OpenResearch uses a deterministic benchmark — a number a TEE computes, not an opinion anyone forms. There is nothing to collude around.

### Why TEE attestation (and not zkML, yet)

Both are viable verification paths. TEEs (Intel TDX, AMD SEV, AWS Nitro Enclaves) are the practical first step: they run arbitrary code — including GPU benchmarks — without circuit compilation, verification is millisecond-cheap, and hardware attestation is already battle-tested in confidential-compute production. zkML remains the long-term ideal for fully trustless verification; the protocol is designed so zkML validators can be added as an alternative verification path once the tooling matures.

## Security posture

Keys are compartmentalized by role: a miner runs on a dedicated secret with `--reward-recipient` pointed elsewhere, so a compromised mining key risks one trial's stake and nothing more. Verifier secrets never touch a frontend, and the verifier allowlist is admin-controlled — the skill cannot add itself.

Untrusted bytes are treated as untrusted. A candidate tree is never the source of its own harness; project-controlled archives on the Irys fallback path are inspected entry by entry and copied member by member rather than handed to `tar -xf`, so no absolute path, `..` segment, link, or device node can write outside the destination.

## License

MIT — all code contributions to projects on this protocol are open source by default.

---

*Built on Andrej Karpathy's autoresearch, Stellar, and the broader DeSci movement.*
