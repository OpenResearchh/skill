# Experiment protocol: practical flow

This document describes how Phase 1 (authoring a protocol from a repo) and Phase 2 (running experiments under that protocol) connect in practice: **entry points**, **touch points** (artifacts and tools), and **final outputs**.

---

## High-level picture

```mermaid
flowchart TB
  subgraph entry [Entry points]
    url[Repo URL or path]
    bundleScript[build_discovery_bundle.py]
    llm[LLM with discovery prompts]
    human[Human questionnaire]
  end

  subgraph phase1 [Phase 1 — Author protocol]
    clone[Clone or existing checkout]
    fill[Fill discovery_user template]
    draft[DiscoveryDraft JSON]
    merge[Merge plus validate]
    proto[protocol.json]
    render[Render program.md.j2]
    baseline[Dry run plus baseline log]
    publish[Ask to publish on settlement layer]
  end

  subgraph phase2 [Phase 2 — Experiment loop]
    edit[Edit allowed globs]
    run[Run execution.command]
    metric[Parse primary metric]
    log[Append results log]
    gitkeep[Keep or revert git]
  end

  url --> clone
  bundleScript --> fill
  clone --> bundleScript
  fill --> llm
  llm --> draft
  draft --> human
  human --> merge
  merge --> proto
  proto --> render
  proto --> baseline
  baseline --> publish
  baseline --> phase2
  publish --> phase2
  render --> phase2
  edit --> run --> metric --> log --> gitkeep
```

---

## Phase 1 — detailed touch points

```mermaid
flowchart LR
  subgraph inputs [Inputs]
    A[Git URL]
    B[prompts and schema in this repo]
  end

  subgraph tools [Scripts and assets]
    S[build_discovery_bundle.py]
    P[discovery_system.md plus discovery_user_filled.md]
    V[protocol.schema.json validator]
    Q[questionnaire universal plus by_archetype]
    R[eligibility_rubric.md]
    T[program.md.j2]
  end

  subgraph outputs [Phase 1 outputs]
    M[bundle_meta.json]
    U[discovery_user_filled.md]
    SYS[discovery_system.md copy]
    D[discovery_draft.json from LLM]
    PR[protocol.json finalized]
    MD[program.md rendered]
    BL[Baseline row plus optional run.log]
    OC[On-chain project id plus settlement record]
  end

  A --> S
  B --> S
  S --> M
  S --> U
  S --> SYS
  U --> P
  SYS --> P
  P --> D
  Q --> PR
  D --> PR
  R --> PR
  PR --> V
  PR --> T
  T --> MD
  PR --> BL
  BL --> OC
```

**Reading left to right:** the human or automation starts from a **repo URL** (or `--existing-repo`). **`build_discovery_bundle`** is the main **entry point** that produces the **prompt bundle** (`discovery_user_filled.md`, `discovery_system.md`, `bundle_meta.json`). The **LLM** consumes those files and emits **`DiscoveryDraft` JSON**. The **questionnaire** plus merge step produces **`protocol.json`**, optional **`program.md`** via **Jinja**, and a **baseline** artifact after a **dry run**. If the project is eligible, the agent asks the user whether to publish through the configured settlement layer.

---

## Entry points (what you actually invoke)

| Step | Entry point | Purpose |
|------|-------------|---------|
| Bundle prompts | From this repo root: `python scripts/build_discovery_bundle.py <URL> --output-dir DIR` | Clone (optional), scan repo, fill template |
| Same repo, no clone | `... --existing-repo /path/to/repo --output-dir DIR` | Faster iteration on local checkout |
| Discovery LLM | Any agent/API: system = `prompts/discovery_system.md`, user = `discovery_user_filled.md` | Emit strict JSON matching **DiscoveryDraft** |
| Validate draft | JSON Schema: `protocol.schema.json` (this repo) | Reject malformed LLM output |
| Human gate | `questionnaire/universal.md` + `questionnaire/by_archetype/*.md` | Resolve blockers, globs, metric, eligibility |
| Final protocol | Merge DiscoveryDraft + answers → **`protocol.json`** (`schemaKind: "protocol"`) | Single source of truth for Phase 2 |
| Render narrative | `python scripts/render_program_md.py path/to/protocol.json` (requires `pip install jinja2`) | Human-readable **`program.md`** (not automatic when JSON changes) |
| Eligibility | `eligibility_rubric.md` | Decide `eligible` / `needs_harness` / `ineligible` |
| Baseline | Run `execution.command` from protocol on pinned setup | Prove runnable; record first metric row |
| Publish prompt | `scripts/publish_project.mjs` + active `references/onchain-*.md` | Resolve `--chain` / `ARAH_CHAIN`, prepare the git-primary publish payload, and hand off to the configured settlement adapter |

---

## Touch points (files you always touch)

| Artifact | Role |
|----------|------|
| [`prompts/discovery_system.md`](prompts/discovery_system.md) | Fixed system instructions for the discovery model |
| [`prompts/discovery_user.md`](prompts/discovery_user.md) | Template; filled copy is **`discovery_user_filled.md`** |
| [`protocol.schema.json`](protocol.schema.json) | Validates **DiscoveryDraft** and full **protocol** |
| [`questionnaire/universal.md`](questionnaire/universal.md) | Required human answers |
| [`questionnaire/by_archetype/*.md`](questionnaire/by_archetype/ml_train.md) | Branch-specific addenda |
| [`eligibility_rubric.md`](eligibility_rubric.md) | When Phase 1 can stop vs needs harness |
| [`templates/program.md.j2`](templates/program.md.j2) | Renders agent-facing **`program.md`** |
| [`archetypes.yaml`](archetypes.yaml) | Defaults and taxonomy reference |
| [`references/onchain-stellar.md`](references/onchain-stellar.md) | Active Stellar publish flow using ABI v3 GitRef projects |
| [`contracts/solana-open-research/deployment.json`](contracts/solana-open-research/deployment.json) | Solana adapter program id, RPC defaults, and bundled IDL path |
| [`contracts/solana-open-research/open_research.json`](contracts/solana-open-research/open_research.json) | Bundled full Anchor IDL for Solana publish, mining, and verifier paths |
| [`references/onchain-solana.md`](references/onchain-solana.md) | Solana publish flow (browser-wallet, PDA seeds) |
| [`contracts/0g-galileo-testnet/deployment.json`](contracts/0g-galileo-testnet/deployment.json) | Alternate path: 0G Galileo registry addresses and ABI artifact paths |
| [`references/onchain-0g-galileo.md`](references/onchain-0g-galileo.md) | Alternate path: ABI-derived 0G Galileo publish, miner, and verifier flow |

---

## Final outputs (what Phase 2 needs)

| Output | Description |
|--------|-------------|
| **`protocol.json`** | Canonical machine-readable contract (`schemaKind: "protocol"`), includes `meta.protocolBundleId`, metric extract, globs, commands |
| **`program.md`** (optional but recommended) | Render of the same contract for humans and coding agents |
| **`bundle_meta.json`** | From the bundle script only: clone path, SHA, paths to schema — audit trail |
| **`discovery_draft.json`** (retained) | Raw LLM output for debugging / reproducibility |
| **Baseline record** | Row in `provenance.resultsLog` (e.g. `results.tsv`) + stored log artifact path |
| **Git publish record** | `storage_git.json`: repo identity, baseline commit, tree hash, protocol hash, and materialization command |
| **On-chain publish record** | `publish_stellar.json`, `publish_solana.json`, or `publish_0g_galileo.json` depending on the configured settlement layer |
| **`needs_harness` follow-ups** | If rubric says so: issues or scripts to add before **`eligible`** |

Phase 2 **only** needs the **protocol bundle** ( **`protocol.json`** + baseline policy + optional **`program.md`** ); it does **not** need to re-run discovery unless the repo or contract changes.

---

## Two-operator split (optional)

```mermaid
flowchart LR
  subgraph author [Protocol author Phase 1]
    E1[Entry URL]
    E2[Bundle plus LLM plus questionnaire]
    E3[protocol.json and baseline]
  end

  subgraph runners [Experimenters Phase 2]
    E4[Read protocol plus program.md]
    E5[Edit train surface]
    E6[Run command and log results]
  end

  E1 --> E2 --> E3
  E3 --> E4 --> E5 --> E6
```

The **handoff artifact** is **`protocol.json`** (and rendered **`program.md`**) plus **baseline** metadata referenced in **`meta.protocolBundleId`** / **`provenance`**.
