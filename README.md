# OpenResearch

> A decentralized protocol for benchmark-driven, agent-run scientific research over pluggable settlement layers.

## What is OpenResearch?

OpenResearch is a protocol that turns code improvement into proof of work. Researchers publish a project — a real codebase plus a deterministic benchmark — to a configured settlement layer. Anyone can run an AI coding agent locally that iterates on the code, keeps only changes that beat the current best benchmark score, and submits the improvement on-chain. Verifiers re-run the benchmark in a sandbox, settle the result, and accepted commits advance the project's frontier.

In short: **if a benchmark can objectively score code, then improving that score is a form of mining.**

## Inspiration

Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (March 2026) showed that one agent in a tight `edit → benchmark → keep-if-better` loop can autonomously discover real optimizations (Shopify's CEO got a 19% training speedup overnight). OpenResearch scales that idea: ten thousand agents on ten thousand machines, competing with economic skin in the game.

## How It Works

```
Researcher ─► Publishes project (protocol + Git baseline + benchmark) on settlement layer
                     │
                     ▼
              OpenResearch project frontier + reward/stake token
                     │
Miner ─► autoresearch-mine loop ─► beats current best ─► submits proposal + stake
                     │
                     ▼
Verifier ─► autoresearch-validate ─► re-runs benchmark ─► approve / reject
                     │
                     ▼
              Approved: stake returned + reward paid
              Rejected: stake slashed
```

## Technology Partners

| Partner | Role |
|---|---|
| **[Stellar](https://stellar.org)** | Active settlement layer — Soroban `OpenResearch` ABI v3 with GitRef projects and proposals |
| **Solana / 0G adapters** | Legacy and alternate settlement adapters retained behind the same neutral entrypoints |
| **Git** | Content-addressed artifact transport for baselines and candidate commits |
| **[Gensyn AXL](https://gensyn.ai)** | Optional miner-to-miner sidechat for sharing experiment notes |
| **Intel TDX / AMD SEV** | TEE attestation for verifier benchmark reruns |

## Active Stellar Deployment

| Field | Value |
|---|---|
| Contract | `CDGF3SS27QEF4LDV63MSMKVOXZOZM4OTF2BPV5QK3PQEAEMOITUVDMDH` |
| Network | Stellar mainnet |
| RPC | `https://soroban-rpc.mainnet.stellar.gateway.fm` |
| Deployment metadata | [`../smart-contracts/deployments/mainnet.json`](../smart-contracts/deployments/mainnet.json) |
| Helper module | [`autoresearch-create/scripts/stellar_open_research.mjs`](autoresearch-create/scripts/stellar_open_research.mjs) |
| Publish CLI | [`autoresearch-create/scripts/publish_project.mjs`](autoresearch-create/scripts/publish_project.mjs) |

Runtime env:

```env
OPEN_RESEARCH_CONTRACT_ID=CDGF3SS27QEF4LDV63MSMKVOXZOZM4OTF2BPV5QK3PQEAEMOITUVDMDH
STELLAR_RPC_URL=https://soroban-rpc.mainnet.stellar.gateway.fm
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```

The skills keep settlement details behind `--chain`. `stellar` is the default;
use `--chain solana` or `--chain 0g` only when intentionally targeting those
adapters.

### On-chain accounts

- **`ProjectRegistry`** PDA — global index of projects, current best scores, per-project token mint
- **`ProposalLedger`** PDA — miner proposals, stake, review claims, approve/reject
- **`VerifierRegistry`** PDA — allowlisted verifier addresses
- **`ProjectToken`** — per-project SPL Token mint with a bonding curve; stake & reward unit

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
| [`autoresearch-create`](autoresearch-create/) | Researchers | Ingests a GitHub repo, derives a `protocol.json` + benchmark, runs a baseline in a sandbox, and publishes the project through the configured settlement layer |
| [`autoresearch-mine`](autoresearch-mine/) | Contributors | Runs the Karpathy-style local loop, maintains `trials.jsonl`, optionally exchanges AXL sidechat, and submits proposals on-chain when a trial beats the current best |
| [`autoresearch-validate`](autoresearch-validate/) | Verifiers | Resolves miner artifacts via an artifact index, reruns the bundled harness, applies deterministic static gates, and calls `approve` / `reject` on `ProposalLedger` |

## Quick Start

### Create a project

```bash
npx skills add OpenResearchh/skill --skill autoresearch-create
> create an OpenResearch project from https://github.com/your-org/your-repo
```

The agent clones the repo, builds a discovery bundle, runs the protocol questionnaire, writes `protocol.json`, runs a baseline in a podman/docker/bwrap sandbox, and asks whether to publish through the configured settlement layer.


### Mine

```bash
npx skills add OpenResearchh/skill --skill autoresearch-mine
```

Create an isolated mining keystore (`python3 scripts/wallet.py init --id <id>`), fund the printed address, and point `--reward-recipient` at your main wallet so a compromised mining key only ever risks one trial's stake. See [`autoresearch-mine/README.md`](autoresearch-mine/README.md).

### Validate

```bash
npx skills add OpenResearchh/skill --skill autoresearch-validate
```

Allowlist your verifier via `VerifierRegistry`, point the skill at an `ARAH_ARTIFACT_INDEX`, and it will claim, rerun, and settle proposals deterministically. See [`autoresearch-validate/README.md`](autoresearch-validate/README.md).

## Repository Layout

```text
autoresearch-create/     Phase 1 — protocol authoring, baseline, settlement publish
autoresearch-mine/       Phase 2 — mining loop, optional AXL sidechat, on-chain submit
autoresearch-validate/   Phase 2 — verifier harness, ProposalLedger approve/reject
smart-contract adapters live under each skill; Stellar ABI v3 lives in ../smart-contracts
```

## Related repositories

Other pieces of the OpenResearch project live in companion repositories (useful for reviews and for contributors looking for the full stack):

| Repository | Role |
|---|---|
| **`../smart-contracts`** | Stellar Soroban OpenResearch contract and TypeScript client |
| **[OpenResearchh/website](https://github.com/OpenResearchh/website)** | Public website for the project |

## Competitive Landscape

| Project | What they do | How we differ |
|---|---|---|
| [karpathy/autoresearch](https://github.com/karpathy/autoresearch) | Single-machine autonomous ML experimentation | We decentralize and incentivize it at network scale |
| [Bittensor](https://bittensor.com) | Decentralized ML with subnet incentives | We score code improvement deterministically, not inference subjectively |
| [Gensyn](https://gensyn.ai) | Distributed ML training with proof-of-learning | We focus on research discovery, not training compute |
| [Nous Research](https://nousresearch.com) | Distributed open-source model training on Solana | We are domain-agnostic and benchmark-driven, not model-specific |
| [Radicle](https://radicle.dev) | Decentralized git and code collaboration | We use similar code-hosting primitives wired to research incentives |

### How OpenResearch differs from Bittensor

Bittensor miners serve inference requests — the output is consumed and gone. OpenResearch miners produce improved source code that becomes the permanent baseline every future miner must beat. The network compounds; Bittensor just runs.

Bittensor validators score miners subjectively, which is why validator cartels exist. OpenResearch uses a deterministic benchmark — a number a TEE computes, not an opinion anyone forms. There is nothing to collude around.

### Why TEE attestation (and not zkML, yet)

Both are viable verification paths. TEEs (Intel TDX, AMD SEV, AWS Nitro Enclaves) are the practical first step: they run arbitrary code — including GPU benchmarks — without circuit compilation, verification is millisecond-cheap, and hardware attestation is already battle-tested in confidential-compute production. zkML remains the long-term ideal for fully trustless verification; the protocol is designed so zkML validators can be added as an alternative verification path once the tooling matures.

## License

MIT — all code contributions to projects on this protocol are open source by default.

---

*Built on Andrej Karpathy's autoresearch, Solana, Irys, and the broader DeSci movement.*
