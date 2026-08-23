# autoresearch-mine workflow

Phase 1 (authoring), typically with **`autoresearch-create`**, produces `protocol.json` and optional `program.md`. Phase 2 (mining) consumes those artifacts in a target repo. **Miners only need `autoresearch-mine`:** the trial harness is bundled under [`vendor/harness/`](../vendor/harness/) (vendored from the same scripts `autoresearch-create` uses in this monorepo).

```mermaid
flowchart LR
  subgraph p1 [Phase 1]
    create[autoresearch-create]
    proto[protocol.json + program.md]
  end
  subgraph p2 [Phase 2]
    boot[bootstrap + init_mine_workspace]
    loop[edit / run_trial / compare / log / git]
    push[push_candidate_branch]
    submit[submit_trial_proposal]
  end
  create --> proto --> boot --> loop --> push --> submit
```

- **Per-trial** time limits: `execution` in `protocol.json` (see `run_baseline.sh`).
- **Outer session** limits: optional `miningLoop` in `protocol.json`, merged by `read_mining_limits.py` with env fallbacks.
- **Frontier** for submissions: `.autoresearch/mine/network_state.json` — **manual** (`source: manual`), synced from the published Solana project (`source: solana`), or from the legacy registry (`source: registry`; see **`scripts/sync_registry_frontier.py`**).
- **Miners do not open pull requests.** A winning trial is published as a
  candidate branch and referenced by commit in the proposal. Verifiers settle
  on-chain and merge the accepted work; that keeps the merge power and the
  settlement power on the same allowlist instead of splitting them across two
  identities.

See [autoresearch-create/workflow.md](../../autoresearch-create/workflow.md) for Phase 1 touch points.
