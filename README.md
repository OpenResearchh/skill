# OpenResearch

> A decentralized protocol for benchmark-driven, agent-run scientific research on Solana.

## What is OpenResearch?

OpenResearch is a protocol that turns code improvement into proof of work. Researchers publish a project — a real codebase plus a deterministic benchmark — on Solana. Anyone can run an AI coding agent locally that iterates on the code, keeps only changes that beat the current best benchmark score, and submits the improvement on-chain. A network of verifiers re-runs the benchmark inside secure TEE enclave, attests to the result, and the miner is rewarded in the project's own SPL token.

In short: **if a benchmark can objectively score code, then improving that score is a form of mining.**

## Inspiration

Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (March 2026) showed that one agent in a tight `edit → benchmark → keep-if-better` loop can autonomously discover real optimizations (Shopify's CEO got a 19% training speedup overnight). OpenResearch scales that idea: ten thousand agents on ten thousand machines, competing with economic skin in the game.

## How It Works

```
Researcher ─► Publishes project (protocol + repo + benchmark + baseline) on Solana
                     │
                     ▼
              ProjectRegistry PDA + per-project SPL token mint (bonding curve)
                     │
Miner ─► autoresearch-mine loop ─► beats current best ─► submits proposal + stake
                     │
                     ▼
Verifier ─► autoresearch-validate ─► re-runs benchmark in TEE ─► approve / reject
                     │
                     ▼
              Approved: stake returned + reward minted to miner
              Rejected: stake slashed across verifier pool + burn
```

## GitHub Verification Bridge

OpenResearch also supports a GitHub-first coordination path for projects that
want GitHub to be the distribution, discovery, and CI verification surface while
the blockchain remains the economic ledger.

In this flow, miners work on hypothesis branches, submit a staked proposal with
code/log CIDs and an exact GitHub head SHA, then open a PR containing a
machine-readable `openresearch-proposal` block. The mined repository installs
the workflow template from
[`autoresearch-validate/templates/openresearch-github-verifier.yml`](autoresearch-validate/templates/openresearch-github-verifier.yml)
under its own `.github/workflows/`; this skills repository does not run that
verifier on ordinary maintenance PRs. GitHub Actions verifies the PR head, code
hash, static/integrity gates, and optionally the benchmark. A trusted settlement
bridge consumes `verification-result.json`, settles on-chain, and only then can
automation auto-merge the exact approved PR head.

The bridge is documented in
[`autoresearch-mine/references/github-verification-bridge.md`](autoresearch-mine/references/github-verification-bridge.md).

## Technology Partners

| Partner | Role |
|---|---|
| **[Solana](https://solana.com)** | Settlement layer — `open_research` Anchor program, PDAs, SPL Token rewards |
| **[Irys](https://irys.xyz)** | Permanent, content-addressed storage for protocol, repo snapshot, benchmark bundle, and baseline metrics |
| **[Anchor](https://www.anchor-lang.com)** | Solana program framework + IDL |
| **[Gensyn AXL](https://gensyn.ai)** | Optional miner-to-miner sidechat for sharing experiment notes |
| **Intel TDX / AMD SEV** | TEE attestation for verifier benchmark reruns |

## Solana Deployment

| Field | Value |
|---|---|
| Program | [`ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3`](https://explorer.solana.com/address/ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3?cluster=devnet) |
| Network | `devnet` |
| RPC | `https://api.devnet.solana.com` |
| Anchor IDL | [`idl/open_research.json`](idl/open_research.json) |
| Helper module | [`autoresearch-create/scripts/solana_open_research.mjs`](autoresearch-create/scripts/solana_open_research.mjs) |
| Publish CLI | [`autoresearch-create/scripts/publish_project_solana.mjs`](autoresearch-create/scripts/publish_project_solana.mjs) |
| Frontend guide | [`open_research/FRONTEND_INTEGRATION_README.md`](open_research/FRONTEND_INTEGRATION_README.md) |
| Integration tests | [`open_research/TEST_REPORT.md`](open_research/TEST_REPORT.md) |

Frontend env:

```env
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_OPEN_RESEARCH_PROGRAM_ID=ACfzPQJkUJ74bdnmvV6FmB8Me3s1cPA3ayWjt2vHRsv3
```

Derive PDAs from the program id, pass `bytes32` values as exactly 32 bytes, and treat project tokens as SPL Token mints with `decimals = 0`. Call `initialize` once, then add verifiers with the authority wallet.

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
| [`autoresearch-create`](autoresearch-create/) | Researchers | Ingests a GitHub repo, derives a `protocol.json` + benchmark, runs a baseline in a sandbox, uploads artifacts to Irys, and publishes the project on Solana |
| [`autoresearch-mine`](autoresearch-mine/) | Contributors | Runs the Karpathy-style local loop, maintains `trials.jsonl`, optionally exchanges AXL sidechat, and submits proposals on-chain when a trial beats the current best |
| [`autoresearch-validate`](autoresearch-validate/) | Verifiers | Resolves miner artifacts via an artifact index, reruns the bundled harness, applies deterministic static gates, and calls `approve` / `reject` on `ProposalLedger` |

## Quick Start

### Create a project

```bash
npx skills add OpenResearchh/skill --skill autoresearch-create
> create an OpenResearch project from https://github.com/your-org/your-repo
```

The agent clones the repo, builds a discovery bundle, runs the protocol questionnaire, writes `protocol.json`, runs a baseline in a podman/docker/bwrap sandbox, uploads artifacts to Irys, and asks whether to publish on Solana devnet.


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
autoresearch-create/     Phase 1 — protocol authoring, baseline, Irys upload, Solana publish
autoresearch-mine/       Phase 2 — mining loop, optional AXL sidechat, on-chain submit
autoresearch-validate/   Phase 2 — verifier harness, ProposalLedger approve/reject
idl/                     Anchor IDL for the open_research Solana program
open_research/           Frontend integration guide + integration test report
```

## Related repositories

Other pieces of the OpenResearch project live in companion repositories (useful for reviews and for contributors looking for the full stack):

| Repository | Role |
|---|---|
| **[OpenResearchh/contracts.sol](https://github.com/OpenResearchh/contracts.sol/)** | Solana program — Anchor smart contracts for the protocol |
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
