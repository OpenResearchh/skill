---
name: autoresearch-create
description: Create an OpenResearch experiment protocol from a GitHub repository or local checkout. Builds a discovery prompt bundle, emits a DiscoveryDraft JSON, asks the protocol questionnaire, finalizes protocol.json, renders program.md, runs a baseline, then asks the user whether to publish an eligible project to the configured settlement layer. Use when the user asks to create/start/bootstrap an autoresearch or OpenResearch project from a repo.
---

# autoresearch-create

Create an OpenResearch project contract from an existing repository. The output is a versioned experiment-loop protocol bundle:

- `protocol.json`: canonical machine-readable contract
- `program.md`: optional agent-facing render of the same contract
- discovery and baseline artifacts retained for auditability

Use the bundled experiment-protocol toolkit in this skill directory. Do not modify the bundled resource files while creating a project.

## Bundled resources

- `scripts/build_discovery_bundle.py`: clone or scan a repo and produce the LLM discovery bundle.
- `prompts/discovery_system.md` and `prompts/discovery_user.md`: discovery prompt contract.
- `protocol.schema.json`: schema for both `discoveryDraft` and finalized `protocol` documents.
- `questionnaire/universal.md` and `questionnaire/by_archetype/*.md`: human questions needed to finalize a protocol.
- `archetypes.yaml`: archetype taxonomy and defaults.
- `eligibility_rubric.md`: rules for `eligible`, `needs_harness`, and `ineligible`.
- `scripts/render_program_md.py` and `templates/program.md.j2`: render `program.md` from finalized `protocol.json`.
- `scripts/preview_metrics.py`: print a focused benchmark review block from `protocol.json` for the Step 5b approval gate.
- `scripts/run_baseline.sh`: run setup plus the primary command from `protocol.json` and parse the baseline metric.
- `scripts/run_measured_trials.sh`: repeated-sample wrapper around `run_baseline.sh`; prints `AGGREGATE_METRIC=` and writes the full sample. Used by the mine skill's trial harness.
- `scripts/publish_project.mjs`: **the publish entrypoint.** Resolves the active settlement layer and delegates to that layer's adapter. Accepts `--chain <name>`, `--show-chain`, and forwards every other flag to the adapter unchanged.
- `scripts/chain.mjs`: settlement-layer resolution and the operation → adapter registry. The only file that maps `publishProject` onto a concrete implementation.
- `references/onchain-solana.md`: setup, identity, storage, and publish detail for the `solana` settlement layer.
- `references/onchain-0g-galileo.md`: setup, identity, storage, and publish detail for the `0g` settlement layer.
- `workflow.md`: detailed phase diagram. Read it when the user asks for process detail.

### Adapter-specific resources

Do not call these directly from the workflow; `publish_project.mjs` selects the right one. They are listed so the files are identifiable when a reference doc names them.

- `scripts/publish_project_solana.mjs`, `scripts/local_solana_wallet_publish.mjs`, `scripts/irys_storage.mjs`, `scripts/solana_open_research.mjs`, `contracts/solana-open-research/*`: the `solana` adapter, its browser-wallet signing page, artifact-storage helper, client helpers, and bundled deployment metadata plus full Anchor IDL.
- `scripts/publish_project_0g.mjs`, `scripts/publish_project_0g_lib.mjs`, `contracts/0g-galileo-testnet/*`: the `0g` adapter, its shared input-preparation library, and bundled deployment metadata plus ABI artifacts.

## Step 1: Collect inputs

Ask for the target repository:

- GitHub URL, or
- absolute or relative path to an existing local checkout.

If the user provides a URL, the script clones into `./.autoresearch/repos/<owner>-<name>` relative to the user's current working directory by default. Pass `--clone-dir <path>` to override, or `--ephemeral` to clone into a system temp dir that is deleted on exit. If the default path already contains a git repo, it is reused (no re-clone).

Ask where to write the protocol authoring bundle. Default: `<repo-or-clone>/.autoresearch/create`.

## Step 2: Build discovery bundle

Run one of these from the skill directory:

For a Git URL (uses default clone dir `./.autoresearch/repos/<owner>-<name>`):

```bash
python3 scripts/build_discovery_bundle.py <git-url> --output-dir <output-dir>
```

Override the clone destination with `--clone-dir <path>` or use `--ephemeral` for a throwaway clone.

For an existing checkout:

```bash
python3 scripts/build_discovery_bundle.py --existing-repo <repo-path> --output-dir <output-dir>
```

Expected outputs:

- `<output-dir>/discovery_system.md`
- `<output-dir>/discovery_user_filled.md`
- `<output-dir>/bundle_meta.json`

If the script fails, stop and report the exact failure. Do not fabricate discovery data.

## Step 3: Produce DiscoveryDraft JSON

Read `<output-dir>/discovery_system.md` as the discovery system prompt and `<output-dir>/discovery_user_filled.md` as the user prompt. Follow them exactly and emit a single JSON object with:

- `schemaKind: "discoveryDraft"`
- `protocolVersion: "1.0"`
- all required fields described by `protocol.schema.json`

Write the JSON to:

```text
<output-dir>/discovery_draft.json
```

Validate the draft against `protocol.schema.json` if a JSON Schema validator is available. At minimum, parse it as JSON and manually check the schema-required keys. If validation fails, fix the draft from source evidence or stop with the validation error.

## Step 4: Ask questionnaire

Read `questionnaire/universal.md` and ask only the questions needed to fill missing or uncertain fields in the final protocol. Use the DiscoveryDraft `blockers` to focus the interview.

Then select the archetype:

1. Start from `discovery_draft.json` field `meta.archetypeGuess`.
2. Confirm or correct it with the user.
3. Read the matching `questionnaire/by_archetype/<archetype>.md` file and ask its relevant addendum questions.

Keep answers in `<output-dir>/questionnaire_answers.md`.

## Step 5: Finalize protocol.json

Merge:

- `discovery_draft.json`
- questionnaire answers
- `archetypes.yaml`
- `eligibility_rubric.md`

Write the finalized protocol to:

```text
<output-dir>/protocol.json
```

Rules:

- `schemaKind` must be `"protocol"`.
- `protocolVersion` must be `"1.0"`.
- The document must match `protocol.schema.json`.
- `meta.eligibility` must be justified by `eligibility_rubric.md`.
- Do not mark `eligible` unless the repo has one runnable command, one scalar metric, bounded resources, non-overlapping mutable/immutable surfaces, and an achievable baseline policy.
- Use `needs_harness` when the project intent is valid but a wrapper, benchmark script, metric printer, fixture, or load generator must be added before baseline.
- Use `ineligible` when the repo cannot support a bounded scalar experiment loop.

## Step 5b: Benchmark review (HARD APPROVAL GATE)

The primary metric is the optimization target for every downstream experiment run. A wrong name, wrong direction, or a regex that does not match real output silently corrupts the entire research loop. **Do not skip this step.**

Run:

```bash
python3 scripts/preview_metrics.py <output-dir>/protocol.json
```

This prints a focused review block: primary metric (name, direction, extract pattern, example stdout), execution command and timeout, baseline policy, and any secondary metrics. It also flags missing or weak fields.

Then ask the user, in plain language and one question at a time:

1. Is the metric **name** the right thing to optimize for this project?
2. Is the **direction** (minimize / maximize) correct?
3. Will the **regex pattern** actually match what the command prints? Compare against the example stdout fragment shown.
4. Is the **baseline policy** realistic on the user's hardware?
5. Are the secondary metrics (if any) the right supporting signals?

Only proceed to Step 6 after the user **explicitly** confirms the benchmark. If anything is wrong, return to Step 5 and update `protocol.json`, then re-run the preview. Do not paraphrase the metric to the user from memory — always show them the preview output.

## Step 6: Render program.md

Only after Step 5b approval, render the agent-facing handoff:

```bash
python3 scripts/render_program_md.py <output-dir>/protocol.json
```

The rendered `program.md` opens with a prominent **Benchmark** section that mirrors the approved metric definition. Show this section to the user one more time and confirm it matches what they approved before handing the document off downstream.

If Jinja2 is missing, install the bundled optional tooling in the user's environment only after stating the command:

```bash
python3 -m pip install -r requirements-tools.txt
```

Expected output:

```text
<output-dir>/program.md
```

## Step 7: Baseline dry run or measured run

If `meta.eligibility` is `eligible`, offer a baseline dry run first:

```bash
scripts/run_baseline.sh <output-dir>/protocol.json <repo-path> --dry-run
```

If the user approves a measured baseline:

```bash
scripts/run_baseline.sh <output-dir>/protocol.json <repo-path> --log <output-dir>/baseline_run.log
```

On success, capture `BASELINE_METRIC=<value>` and update or report the baseline artifact according to `protocol.json` fields `measurement.baselinePolicy` and `provenance`.

## Step 8: Ask to publish

Publishing is the handoff that lets other people discover and contribute to the open research project. After a measured baseline succeeds, make publishing the default next step for eligible projects.

Only ask to publish after:

- `meta.eligibility` is `eligible`
- Step 5b benchmark approval is complete
- `program.md` has been rendered or intentionally skipped
- a measured baseline has succeeded

Ask the user directly:

```text
The baseline is complete. Do you want me to publish this project now?
```

Do not publish anything until the user approves and the identity requirements below are satisfied.

### Settlement layer

`scripts/publish_project.mjs` is the only publish entrypoint this workflow uses. It resolves the active settlement layer, then hands the work to that layer's adapter. Resolution order, first match wins:

1. `--chain <name>` on the command line
2. `ARAH_CHAIN` in the environment
3. `.autoresearch/chain.json` in the working directory, e.g. `{"chain":"solana"}`
4. the built-in default

Supported names are `solana` and `0g`; `solana` is the default. Pass `--show-chain` (or set `ARAH_SHOW_CHAIN=1`) to print which layer and adapter were selected — do that first whenever a publish fails in a way that looks layer-specific. Any flag `publish_project.mjs` does not recognize is forwarded to the adapter unchanged, so layer-specific options stay reachable without appearing in this workflow.

### Identity and funding

Publishing requires an identity on the active settlement layer that can sign the registration and pay for it, plus for artifact storage when uploading. The default signing path is a temporary localhost page: the CLI prints a `http://127.0.0.1:<port>/...` URL, the user connects their existing wallet in the browser, and that wallet — never this skill — signs and pays.

**Do not ask the user for a private key, seed phrase, or API key.** A headless signing path exists for automation; use it only when the user explicitly opts in, and read the reference first because it changes what the publish can do.

Read the reference for the active layer before preparing the publish, and follow its setup steps exactly:

- `solana` → `references/onchain-solana.md`
- `0g` → `references/onchain-0g-galileo.md`

Each reference covers the network defaults, the one-time deployment bootstrap, the artifact-storage flow and its retention caveats, the headless signing opt-in, and the layer-specific flags that pass through the entrypoint.

### Publish inputs

Prepare arguments from the approved protocol and baseline artifacts:

- `--protocol-json`, `--repo-snapshot-file`, `--benchmark-file`, `--baseline-metrics-file`: the four artifacts recorded with the project. The adapter hashes the raw file bytes; how the layer stores those hashes is in the reference doc.
- `--baseline-aggregate-score`: the agreed signed integer representation of the approved primary metric. Ask the user to confirm scaling for decimal metrics, or pass `--baseline-metric <decimal> --metric-scale <integer>` and let the CLI scale deterministically.
- `--upload-artifacts`: upload the four artifacts to the active layer's storage so miners and verifiers can retrieve exactly what was published. Prefer this. Publishing hashes that point at nothing retrievable requires an explicit opt-out flag documented in the reference; only use it if the user asks for it deliberately.
- `--token-name`, `--token-symbol`, `--base-price`, `--slope`, `--miner-pool-cap`: reward-token parameters. Ask the user if not already specified. The units of `--base-price` and `--slope` are layer-specific; see the reference doc.

Preferred command shape:

```bash
node scripts/publish_project.mjs \
  --protocol-json <output-dir>/protocol.json \
  --repo-snapshot-file <repo-snapshot-artifact> \
  --benchmark-file <benchmark-artifact> \
  --baseline-metrics-file <output-dir>/baseline_run.log \
  --baseline-aggregate-score <integer-score> \
  --token-name "<name>" \
  --token-symbol <symbol> \
  --base-price <integer> \
  --slope <integer> \
  --miner-pool-cap <token-units> \
  --upload-artifacts \
  --yes
```

Use `--dry-run` first when values are uncertain: the adapter validates inputs and writes a plan file next to the protocol bundle instead of settling anything.

After a successful publish, record the project id, the settlement reference (transaction id/hash), the publishing identity, and the storage manifest next to the protocol authoring bundle.

## Final response

Report:

1. path to `protocol.json`
2. path to `program.md`, if rendered
3. path to `baseline_run.log`, if run
4. project id, reward-token identifier, and settlement reference, if published
5. eligibility state and blockers, if any
6. next action: review `protocol.json`, add harness if `needs_harness`, proceed to baseline, or ask to publish if `eligible` and baseline succeeded
