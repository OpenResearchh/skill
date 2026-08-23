---
name: autoresearch-mine
description: Run the Phase 2 OpenResearch mining loop on a finalized protocol.json and target repo. Self-contained bundled harness (run_baseline, preview_metrics), repeated-trial sampling, append-only trials.jsonl, optional miningLoop session limits, network_state (manual or synced from the published project), optional proposal submit to the configured settlement layer, unattended stop conditions. Use when the user wants to mine without installing autoresearch-create.
---

# autoresearch-mine

Run **unattended** mining against a finalized `protocol.json` and a **git checkout** of `meta.repo`. In this monorepo the canonical schema is [`protocol.schema.json`](../autoresearch-create/protocol.schema.json); miners normally receive a finalized protocol from the project owner. This skill **does not** re-approve the benchmark (that step lives in the **autoresearch-create** authoring flow).

**Self-contained:** Baseline harness scripts are **bundled** under [`vendor/harness/`](vendor/harness/) (vendored from `autoresearch-create`). Miners do **not** need to install **`autoresearch-create`**. Optional: set **`AUTORESEARCH_CREATE_SCRIPTS`** to use a different directory containing `run_baseline.sh` (e.g. when developing both skills side by side).

## Prerequisites

- `protocol.json` with `schemaKind: protocol` and `meta.eligibility: eligible`.
- `jq`, `git`, `bash`, `python3` on PATH.
- A sandbox runtime: **`podman`** (preferred), **`docker`**, or **`bwrap`** (Linux). The harness refuses to execute protocol-supplied commands without one. Override with `ARAH_SANDBOX=none ARAH_SANDBOX_ALLOW_UNSAFE=1` only on disposable VMs.
- Target repo checkout (or run `bootstrap_repo.sh` to clone from `meta.repo.cloneUrl`; the script enforces an https-only allowlist of git hosts).
- A funded **mining identity** on the active settlement layer, prepared **before** mining starts, plus the user's **reward-recipient** address. See [Identity and funding](#identity-and-funding).

## Settlement layer

Mining never names a settlement layer. The neutral entrypoints — `bootstrap_project.mjs` and `submit_trial_proposal.py` — resolve the active layer and hand the work to that layer's adapter.

`bootstrap_project.mjs` resolves in this order, first match wins:

1. `--chain <name>` on the command line
2. `ARAH_CHAIN` in the environment
3. `.autoresearch/chain.json` in the work tree, e.g. `{"chain":"solana"}`
4. the layer recorded by a previous bootstrap in `.autoresearch/mine/network_state.json`
5. the built-in default

Supported names are `solana` and `0g`; `solana` is the default. Pass **`--show-chain`** (or set **`ARAH_SHOW_CHAIN=1`**) to print which layer and adapter were selected — do that first whenever a bootstrap or submit fails in a way that looks layer-specific. Unknown flags are forwarded to the adapter unchanged, so layer-specific options stay reachable without appearing in this workflow.

**`submit_trial_proposal.py` is the exception:** it reads `--chain` / `ARAH_CHAIN` only and does **not** read `.autoresearch/chain.json`, so always pass `--chain` explicitly on the submit call rather than relying on the file.

Layer detail lives in the reference docs, not here:

- `solana` → [`references/onchain-mining-solana.md`](references/onchain-mining-solana.md)
- `0g` → [`references/onchain-mining-0g.md`](references/onchain-mining-0g.md)

## Identity and funding

Mining that settles proposals needs an identity on the active settlement layer that can pay fees and post stake, and a separate **reward recipient** owned by the user.

- Do the identity setup **locally and yourself**: install any tooling the layer needs, generate a dedicated mining identity for this project, and read its balance. Do not ask the user to run those steps.
- Ask the user for exactly two things: to **fund the printed mining address** if its balance is zero, and their **reward-recipient address**. Record the reward recipient before the loop starts so a winning trial can be submitted without another prompt.
- If the mining identity is unfunded, **stop before mining**. Trials burn compute that cannot be turned into a proposal.

> **Reward recipient:** keep `--reward-recipient` set to the user's main wallet, never the mining identity. The mining identity only ever holds fees + stake, so a compromised mining key bounds the loss to one trial's stake + fees instead of accumulated rewards.

Never ask the user for a private key or seed phrase, and never put one in `.env`. Where a layer's adapter needs a local signing key, it stays in a passphrase-encrypted keystore that only the adapter's own wallet helper decrypts, so the trial harness — which runs untrusted code inside the sandbox — cannot reach it.

The exact CLI install command, identity generation, funding source, balance check, and stake preflight for the active layer are in that layer's reference doc listed above. Follow its preflight section before bootstrap, artifact download, or any trial work.

## Unattended mode

- Export **`GIT_TERMINAL_PROMPT=0`** during mining so git never blocks on credentials in headless runs.
- Do **not** ask the miner between trials; stop only on limits, PR success (optional), or fatal errors.
- Optional env shortcuts: **`AUTORESEARCH_PROTOCOL`**, **`AUTORESEARCH_REPO_ROOT`** (document paths once at start).
- If the user identifies the project by **project id** rather than handing over local files, run **`bootstrap_project.mjs`** first to resolve, download, and verify the mining inputs.
- For GitHub-distributed projects, prefer the proposal-first bridge flow:
  mine on a hypothesis branch, submit the proposal with GitHub/CID binding
  metadata, then open a PR with `--require-proposal --proposal-json`.

### Env fallbacks (outer loop only; protocol `miningLoop` wins when set)

| Variable | Purpose |
|----------|---------|
| `AUTORESEARCH_CREATE_SCRIPTS` | Directory containing `run_baseline.sh` (optional; overrides bundled `vendor/harness`). |
| `MINING_MAX_TRIALS` | Fallback if `miningLoop.maxTrials` absent (default **50** if both absent). |
| `MINING_MAX_WALL_SECONDS` | Fallback if `miningLoop.maxSessionWallSeconds` absent (**-1** = no cap when merged in `read_mining_limits.py`). |
| `MINING_MAX_STAGNANT_TRIALS` | Fallback if `miningLoop.maxConsecutiveNonImprovements` absent (**-1** = no stagnation stop). |
| `MINING_STOP_AFTER_PR` | Fallback if `miningLoop.stopAfterSuccessfulPr` absent (default **true**). |
| `GH_TOKEN` / `GITHUB_TOKEN` | Non-interactive **`gh`** authentication. |

### Harness, sandbox, and settlement-neutral variables

| Variable | Purpose |
|----------|---------|
| `ARAH_CHAIN` | Settlement layer to use when `--chain` is not passed (see [Settlement layer](#settlement-layer)). |
| `ARAH_SHOW_CHAIN` | `1` to print which layer and adapter each neutral entrypoint selected. |
| `ARAH_SANDBOX` | `auto` (default) / `podman` / `docker` / `bwrap` / `none`. |
| `ARAH_SANDBOX_IMAGE` | Container image for podman/docker (default `docker.io/library/debian:stable-slim`). |
| `ARAH_SANDBOX_CPUS` / `ARAH_SANDBOX_MEMORY` / `ARAH_SANDBOX_PIDS` | Per-trial resource caps. |
| `ARAH_BOOTSTRAP_EXTRA_HOSTS` | Colon-separated extra hosts for `bootstrap_repo.sh`'s clone allowlist. |
| `ARAH_METRIC_SCALE` | Integer scale for signed-integer ↔ float metric conversion; must match the scale the project was published with (default **1000000**). |
| `ARAH_PROJECT_ID` | Published **project id** for frontier sync; overrides **`miningLoop.onChainProjectId`** in `protocol.json` when set. |
| `ARAH_STAKE` | Optional stake count in **whole** reward-token units. Defaults to **`1`** when absent — settlement only requires `stake > 0`. |

### Adapter-specific environment variables

These configure one settlement layer's adapter and are not part of the primary flow. Set them only when that layer's reference doc tells you to.

| Variable | Layer | Purpose |
|----------|-------|---------|
| `ARAH_DEPLOYMENT_JSON` | `0g` | Path to `deployment.json` (default: bundled `contracts/0g-galileo-testnet/deployment.json`). |
| `ARAH_RPC_URL` | `0g` | Override RPC (default in deployment). |
| `ARAH_CHAIN_ID` | `0g` | Override chain id (default **16602**). |
| `ARAH_PROJECT_REGISTRY` / `ARAH_PROPOSAL_LEDGER` | `0g` | Override contract addresses. |
| `ARAH_WALLET_HOME` | `0g` | Override keystore dir (default `~/.autoresearch/wallets`). |
| `ARAH_WALLET_PASSPHRASE` | `0g` | Optional passphrase for non-interactive runs; prefer `--passphrase-file` so it's not in process env. |

> **Removed:** `ARAH_PRIVATE_KEY` is no longer read by mining scripts. Migrate
> any old `.env` files to a keystore (`scripts/wallet.py init`); the dotenv
> loader explicitly skips `ARAH_PRIVATE_KEY` even if it's in `.env`.

Install Python deps for the adapters once: **`pip install -r requirements-chain.txt`** (e.g. in a venv).

Install Node deps once from the skill root so artifact download works:

```bash
npm install
```

### Stop conditions (protocol-first)

1. **Per trial:** `execution.hardTimeoutSeconds` and `execution.stopCondition` — enforced only by **`run_baseline.sh`** via **`run_trial.sh`**. Never shorten these in the mine skill.
2. **Outer session:** optional **`miningLoop`** in `protocol.json` (also rendered in `program.md`). Query merged limits with **`read_mining_limits.py`** (see [`references/workflow.md`](references/workflow.md)).

## Machine layout (under target repo root)

```text
.autoresearch/mine/
  network_state.json
  trials.jsonl
  sidechat.jsonl
  runs/<trial_id>/stdout.log
```

Initialize with **`init_mine_workspace.sh`**. Seed **`network_state.json`** from `templates/network_state.manual.json` **or** let **`bootstrap_project.mjs`** write it from the published project's current best. Align with `validate_network_state.sh` after editing or syncing.

Optional **AXL sidechat** writes miner-to-miner field notes to **`sidechat.jsonl`**. This is advisory context only; the benchmark log, `trials.jsonl`, the published project record, and verifier reruns remain authoritative.

## Bundled resources

| Resource | Role |
|----------|------|
| `references/overview.md` | Short maintainer-facing map for this skill. |
| `references/workflow.md` | Phase 1 to Phase 2 workflow diagram and limits/frontier notes. |
| `references/contracts-sync.md` | Maintainer instructions for refreshing vendored deployment + ABI artifacts from `autoresearch-create`. |
| `references/vendor-harness.md` | Maintainer instructions for refreshing vendored harness scripts from `autoresearch-create`. |
| `references/github-verification-bridge.md` | Proposal-first GitHub PR binding, CI verification result shape, and settlement bridge semantics. |
| `references/onchain-mining-solana.md` | Miner setup, artifact download, and proposal-submit detail for the `solana` layer. |
| `references/onchain-mining-0g.md` | Miner setup, hash rules, and submit order for the `0g` layer. |
| `vendor/harness/` | Vendored `run_baseline.sh`, `run_measured_trials.sh`, `aggregate_samples.py`, `derive_trial_seed.py`, `_log.sh`, `_log.py`, `preview_metrics.py` trial harness. |
| `scripts/_resolve_create_scripts.sh` | Resolve harness directory (default `vendor/harness`, override via env). |
| `scripts/chain.mjs` | Settlement-layer resolution and the operation → adapter registry. The only file that maps `bootstrap` / `submitProposal` onto a concrete implementation. |
| `scripts/bootstrap_project.mjs` | **Fetch a published project and prepare a working tree.** Neutral entrypoint: `--project-id`, `--output-dir`, `--repo-root`, `--prepare-repo`, `--skip-existing`, `--chain`, `--show-chain`; other flags pass through to the adapter. |
| `scripts/submit_trial_proposal.py` | **Submit a winning trial as a proposal.** Archives the committed trial code, pairs it with the trial benchmark log, and dispatches to the adapter selected by `--chain`. |
| `scripts/read_mining_limits.py` | Print `max_trials`, `max_session_wall_seconds`, `max_stagnant_trials`, `stop_after_pr`, and optionally **`on_chain_project_id`** (if `miningLoop.onChainProjectId` or **`ARAH_PROJECT_ID`** is set). |
| `scripts/init_mine_workspace.sh` | Create `.autoresearch/mine` tree. |
| `scripts/bootstrap_repo.sh` | Clone or reuse repo from protocol `meta.repo`. |
| `scripts/prepare_hypothesis_branch.sh` | Create a dedicated branch for one mining hypothesis before editing. |
| `scripts/env_utils.py` | Load `.env` from the current working directory and provide the default stake. |
| `scripts/run_trial.sh` | Repeated-sample harness run → `run_measured_trials.sh`; per-trial logs and `samples.json` under `runs/<trial_id>/`. |
| `scripts/append_trial_record.py` | Append one validated JSON line to `trials.jsonl`. |
| `scripts/capture_trace.py` | Opt-in, miner-owned agent trajectory capture for one trial (`append` / `finalize` / `status` / `purge`). Off unless `ARAH_TRACE_ENABLED=1` or `--enable`; never uploads. |
| `scripts/axl_sidechat_send.py` | Optional AXL `/send` bridge: broadcast the latest trial row as a miner experience message. |
| `scripts/axl_sidechat_poll.py` | Optional AXL `/recv` bridge: drain inbound sidechat into `.autoresearch/mine/sidechat.jsonl`. |
| `scripts/compare_metric.py` | Numeric compare by direction with a required improvement margin (exit code only). |
| `scripts/preview_mining_context.sh` | Wrapper for bundled `preview_metrics.py`. |
| `scripts/list_mutable_paths.py` | List tracked paths matching allowed globs. |
| `scripts/revert_mutable_surface.sh` | `git checkout HEAD` on allowed paths only. |
| `scripts/commit_improvement.sh` | `git add` allowed paths + commit with fixed message. |
| `scripts/prepare_pr_branch.sh` | `git checkout -B mine/<bundle>/<date>-<trial>`. |
| `scripts/validate_network_state.sh` | Check `network_state.json` vs protocol. |
| `scripts/open_pr_with_evidence.sh` | `gh pr create` after metric and optional proposal-binding guard checks (`_open_pr_evidence.py`). |
| `schemas/trial_record.schema.json` | Trial row shape. |
| `schemas/github_bound_proposal.schema.json` | Machine-readable PR/proposal binding embedded in GitHub PR bodies. |
| `schemas/sidechat_message.schema.json` | Optional AXL side conversation row shape. |
| `schemas/network_state.schema.json` | `network_state.json` shape (manual or synced). |
| `requirements-chain.txt` | Python deps used by the settlement adapters only. |
| `prompts/*.md` | Agent contracts for bootstrap, loop, logging, git, PR. |

### Adapter-specific resources

Do not call these from the workflow; the neutral entrypoints select the right one. They are listed so the files are identifiable when a reference doc names them.

| Resource | Layer | Role |
|----------|-------|------|
| `scripts/bootstrap_from_solana.mjs` | `solana` | Bootstrap adapter: fetch the project account, download artifacts by their recorded storage ids, verify hashes, optionally unpack and init the workspace, and sync `network_state.json`. |
| `scripts/download_irys_artifacts.mjs` | `solana` | Lower-level artifact downloader by id/tag with SHA-256 verification. |
| `scripts/submit_proposal_solana.mjs` | `solana` | Submit adapter: builds/sends the proposal with code/log hashes and stake accounts. |
| `scripts/upload_trace_irys.mjs` | `solana` | Upload a captured trace to the layer's storage. |
| `contracts/solana-open-research/` | `solana` | Deployment metadata + full bundled Anchor IDL. |
| `scripts/bootstrap_from_registry.py` | `0g` | Bootstrap adapter: resolve by project id or token address, optionally download artifacts, unpack, init, write frontier state. |
| `scripts/download_0g_artifacts.mjs` | `0g` | Artifact downloader with Merkle-root verification. |
| `scripts/submit_proposal.py` | `0g` | Submit adapter: ledger `submit` + token approve / optional `buy`. |
| `scripts/sync_registry_frontier.py` | `0g` | Refresh `network_state.json` (`source: registry`) from the registry's current best. |
| `scripts/wallet.py` | `0g` | Mining wallet keystore: `init` / `address` / `status` / `sign` / `send` / `delete`. The only place a private key is decrypted. |
| `scripts/check_wallet.py` | `0g` | Preflight a wallet keystore: RPC, gas balance, token balance, allowance, missing-stake buy quote. |
| `scripts/chain_config.py` | `0g` | Resolve bundled deployment + env overrides. |
| `contracts/0g-galileo-testnet/` | `0g` | Vendored `deployment.json` + ABI artifacts. |

## Step-by-step

Run scripts from **`autoresearch-mine/scripts/`** (or invoke via absolute paths after skill install).

### 1. Identity preflight

Complete identity setup **before** bootstrap, artifact download, or any trial
work, so a winning trial can be proposed without stopping to ask.

1. Read the reference doc for the active settlement layer (see
   [Settlement layer](#settlement-layer)) and follow its preflight section.
2. Install any tooling the layer needs, create or reuse a dedicated mining
   identity for this project, and print its address and balance — do all of
   this yourself, do not delegate it to the user.
3. If the balance is zero or below what the layer's preflight requires, **stop
   before mining** and ask the user to fund the printed mining address.
4. Ask the user for the **reward-recipient** address and record it now. Keep it
   pointed at the user's main wallet, never the mining identity.

Stake is handled for you: the proposal submitter buys any missing stake from
the project's reward token immediately before submitting. Override the quoted
buy amount or disable the auto-buy only for diagnostic runs where submission is
expected to fail — both are layer-specific flags documented in the reference.

If the layer's preflight reports that the identity is not ready, report the
missing funding condition and stop rather than spending compute on trials.

### 2. Bootstrap workspace

**From a published project id:**

```bash
node scripts/bootstrap_project.mjs \
  --project-id <project_id> \
  --output-dir /path/to/mining-work/project \
  --prepare-repo
```

This resolves the project on the active settlement layer, downloads the
protocol / repo snapshot / benchmark / baseline artifacts, **verifies every
file's hash before it can be used for mining**, unpacks the repo snapshot,
initializes `.autoresearch/mine`, and prints the resolved protocol and repo
paths. Continue the loop with those paths.

Useful additions: `--repo-root <path>` to control where the working tree is
created, `--skip-existing` to reuse verified downloads, and `--show-chain` when
you need to see which adapter ran.

Some layers accept extra project identifiers (for example a reward-token
address) or extra bootstrap options; those flags pass straight through to the
adapter and are documented in that layer's reference doc.

If artifact download is not possible for a project, ask the user for
`protocol.json` and a repo checkout and pass those through instead — again, see
the reference doc for the flag names on that layer.

**From existing local files:**

```bash
export GIT_TERMINAL_PROMPT=0
./init_mine_workspace.sh /path/to/repo
```

### 3. Frontier (manual or synced)

**Manual:** edit `.autoresearch/mine/network_state.json` from `templates/network_state.manual.json`.

**Synced:** `bootstrap_project.mjs` writes `network_state.json` from the
published project's current best where the adapter supports it. Re-run bootstrap
(or the layer's refresh command from its reference doc) before comparing a trial
against "network best", then re-validate:

```bash
./validate_network_state.sh /path/to/protocol.json /path/to/repo
```

### 4. Validate frontier file

```bash
./validate_network_state.sh /path/to/protocol.json /path/to/repo
```

### 5. Preview metrics / mining limits

```bash
./preview_mining_context.sh /path/to/protocol.json
python3 ./read_mining_limits.py /path/to/protocol.json
```

### 6. Mining loop (agent-driven)

Follow **`prompts/mining_loop.md`**, **`prompts/git_policy.md`**, **`prompts/results_logging.md`**. For each trial:

```bash
./run_trial.sh /path/to/protocol.json /path/to/repo <trial_id>
# Parse AGGREGATE_METRIC= from stdout when exit 0. This is the reduction over
# measurement.sampling.measuredTrials runs, not a single measurement; the full
# sample is written to .autoresearch/mine/runs/<trial_id>/samples.json.
# Exit 4 means the sample was too dispersed to score — rerun, do not submit.

# Always pass --min-improvement-bips from measurement.minScoreImprovementBips
# (default 100). Without it, run-to-run noise counts as a discovery, and the
# verifier's independent re-measurement will not reproduce the gain.
./compare_metric.py --direction minimize --candidate 2.41 --baseline 2.50 \
  --min-improvement-bips 100
./append_trial_record.py --record-file /path/to/repo/.autoresearch/mine/trials.jsonl --json-file row.json
```

Compare against `network_best_metric` in `.autoresearch/mine/network_state.json`
when deciding whether to submit. `bootstrap_project.mjs` syncs that from the
published project, and it is the number the verifier will hold you to.

On improvement vs local best: **`commit_improvement.sh`**. Else: **`revert_mutable_surface.sh`**.

### 7. Automatic submit after beating the network best

If a trial beats the freshly synced network best, do not wait for manual
approval. After committing the improvement, call **`submit_trial_proposal.py`**
immediately. It creates `.autoresearch/mine/submissions/<trial_id>/repo-snapshot.tar`,
uses `.autoresearch/mine/runs/<trial_id>/stdout.log` as the benchmark log,
hashes both, and dispatches to the adapter for the layer named by `--chain`.

```bash
python3 ./submit_trial_proposal.py \
  --chain <layer> \
  --project-id <project_id> \
  --repo-root /path/to/repo \
  --trial-id <trial_id> \
  --claimed-metric 1.23 \
  --reward-recipient <user-main-wallet-address> \
  --yes
# plus the active layer's signing-identity flag — see its reference doc
```

Pass `--chain` explicitly: unlike `bootstrap_project.mjs`, this script reads
only `--chain` and `ARAH_CHAIN`, not `.autoresearch/chain.json`. It errors out
if the layer's required identity flag is missing, so read the reference doc
before the first live submit.

`--reward-recipient` must be the user's main wallet, not the mining identity:
that way mining-key compromise can only cost one trial's worth of stake + fees,
not accumulated rewards.

The submitter acquires any missing stake automatically before submitting. Use
`--no-auto-buy` only for diagnostic runs where submission is expected to fail
without existing stake. Use `--dry-run` to verify hashes and the settlement plan
without signing; the identity/plan flags that a dry run needs are layer-specific
and listed in that layer's reference doc, along with the hashing rule (SHA-256
of file bytes) and metric scale.

### 8. Optional PR

```bash
./prepare_pr_branch.sh /path/to/protocol.json /path/to/repo <trial_id>
# push branch if required by remote
./open_pr_with_evidence.sh /path/to/repo /path/to/protocol.json /path/to/repo/.autoresearch/mine/trials.jsonl
# or --allow-local-only-pr when network_best_metric is null (see prompts/pr_gate.md)
```

For proposal-first GitHub verification, open the PR only after
`submit_trial_proposal.py` writes `submission.json`:

```bash
./open_pr_with_evidence.sh \
  --require-proposal \
  --proposal-json /path/to/repo/.autoresearch/mine/submissions/<trial_id>/submission.json \
  /path/to/repo /path/to/protocol.json \
  /path/to/repo/.autoresearch/mine/trials.jsonl
```

The PR body includes an `openresearch-proposal` JSON block that GitHub Actions
and the settlement bridge parse directly.

### 9. Optional AXL sidechat

Run an AXL node locally and point the miner at its raw HTTP API:

```bash
export ARAH_AXL_ENABLED=1
export ARAH_AXL_API=http://127.0.0.1:9002
export ARAH_AXL_PEERS=peer_public_key_hex_1,peer_public_key_hex_2
```

Before a batch or between trials, drain inbound messages:

```bash
./axl_sidechat_poll.py --repo-root /path/to/repo
```

After appending a trial row, broadcast the latest miner experience:

```bash
./axl_sidechat_send.py \
  --record-file /path/to/repo/.autoresearch/mine/trials.jsonl \
  --peers "$ARAH_AXL_PEERS"
```

Use sidechat only for side conversation: experiment hints, failed-hypothesis memory, minor reviewer/proposer coordination, and warnings about flaky runs. Do not use sidechat as current-best state, proposal evidence, or validator evidence.

## Script exit codes

| Script | Codes |
|--------|--------|
| `_resolve_create_scripts.sh` | 0 success (prints dir); 1 missing `run_baseline.sh`. |
| `read_mining_limits.py` | 0; 1 error. |
| `init_mine_workspace.sh` | 0; 1 usage; 2 IO/template failure. |
| `bootstrap_repo.sh` | 0; 1 bad protocol; 2 git / path conflict. |
| `bootstrap_project.mjs` | Passes through the adapter's exit code; **1** if the adapter cannot be launched or the configured layer is unsupported. |
| `env_utils.py` | Helper module; no direct CLI. |
| `run_trial.sh` | Same as `run_measured_trials.sh`; **3** if harness dir missing; **4** if the sample was too dispersed to score. |
| `submit_trial_proposal.py` | 0 submitted; 1 args / dirty repo / missing trial log / submit failure. |
| `capture_trace.py` | 0 (also when capture is disabled); 1 bad args / IO / schema failure. |
| `append_trial_record.py` | 0; 1 validation; 2 IO. |
| `axl_sidechat_send.py` | 0 sent / disabled / no peers; 1 invalid input or every configured peer failed. |
| `axl_sidechat_poll.py` | 0 drained queue; 1 bad args / AXL receive failure / write failure. |
| `compare_metric.py` | 0 improved by at least `--min-improvement-bips`; 1 not improved; 2 bad args/NaN. |
| `preview_mining_context.sh` | 0; 1. |
| `revert_mutable_surface.sh` | 0; 1. |
| `commit_improvement.sh` | 0 commit; 1 nothing to commit; 2 git error. |
| `prepare_pr_branch.sh` | 0; 1. |
| `validate_network_state.sh` | 0; 1 mismatch. |
| `open_pr_with_evidence.sh` | 0 PR opened; 1 `gh` error; 2 args/file; **3** no `gh`; **4** guard failed. |

### Adapter-specific exit codes

Surfaced through the neutral entrypoints, which pass the adapter's status up unchanged.

| Script | Layer | Codes |
|--------|-------|-------|
| `bootstrap_from_solana.mjs` | `solana` | 0 bootstrapped; 1 args / RPC / artifact download / hash verification / unpack failure. |
| `download_irys_artifacts.mjs` | `solana` | 0 downloaded; 1 args / download / SHA-256 verification failure. |
| `submit_proposal_solana.mjs` | `solana` | 0 submitted; 1 args / balance / RPC / signing failure. |
| `bootstrap_from_registry.py` | `0g` | 0 bootstrapped; 1 args / RPC / token not found / download / unpack failure. |
| `download_0g_artifacts.mjs` | `0g` | 0 downloaded; 1 args / missing deps / download / root verification failure. |
| `check_wallet.py` | `0g` | 0 wallet can proceed; 1 missing key / RPC / gas / unresolved token / insufficient stake and auto-buy funds. |
| `sync_registry_frontier.py` | `0g` | 0; 1 RPC / validation / hash mismatch. |
| `submit_proposal.py` | `0g` | 0 submitted; 1 args / balance / RPC. |

## Out of scope (v1)

Verifier review / TEE / deep IPFS hosting automation — use **`autoresearch-create`** to publish projects and the settlement-layer reference docs for governance flows beyond miner **`submit`**.

## Final response

Report paths to `protocol.json`, repo root, `trials.jsonl`, last metric, and whether a PR was opened.
