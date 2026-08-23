# Mining loop (agent prompt)

You run the **outer mining loop** without asking the human between trials.

## Before each batch of iterations

1. If mining against a Solana project, confirm Solana bootstrap already completed: CLI installed, dedicated miner keypair created, miner public key funded with native SOL from the faucet, and reward-recipient wallet address recorded. Do not start a batch if any of those are missing. Use Irys artifacts and Solana submission only; do not call legacy 0G `check_wallet.py`, `sync_registry_frontier.py`, or `submit_proposal.py` for Solana projects.
2. If mining against a legacy 0G on-chain project, confirm the wallet preflight has already passed with **`check_wallet.py --wallet-id <id>`** for the project id or token address. Do not spend trials on a legacy on-chain project without an initialized mining-wallet keystore that can sign and has gas. If the keystore is missing, ask the user to run `python3 scripts/wallet.py init --id <id>` and fund the printed address; use `ARAH_STAKE` when present (whole-token count, since ProjectToken `decimals() == 0`), otherwise the default `1`.
3. If mining against a legacy 0G on-chain project: when **`read_mining_limits.py`** prints **`on_chain_project_id=…`** (from **`miningLoop.onChainProjectId`** or env **`ARAH_PROJECT_ID`**), refresh **`network_state.json`** with **`sync_registry_frontier.py`** using that id—same **`--metric-scale`** as `createProject`—so comparisons use the current registry best.
3. If **`ARAH_AXL_ENABLED=1`**, poll sidechat once with `axl_sidechat_poll.py --repo-root <repo_root>` and use `.autoresearch/mine/sidechat.jsonl` only as advisory context for hypotheses.
4. Run `read_mining_limits.py <protocol.json>` and parse `KEY=value` lines:
   - `max_trials`, `max_session_wall_seconds` (-1 = no cap), `max_stagnant_trials` (-1 = no stagnation stop), `stop_after_pr` (read as "stop after a successful submission" — miners no longer open PRs).
5. Track: trial count (every completed append to `trials.jsonl`), session wall time from first `run_trial.sh` start, consecutive non-improvements (increment when no new **local** best; reset on commit that improves local best).

## Each iteration

1. Propose a hypothesis; edit **only** paths allowed by `mutableSurface.allowedGlobs` in `protocol.json` (see `program.md` “What you CAN do”).
2. Record `git_head_before` from `git rev-parse HEAD` in `repo_root`.
3. Run `run_trial.sh <protocol.json> <repo_root> <trial_id>` from `autoresearch-mine/scripts/`.
4. Parse **`BASELINE_METRIC=<float>`** from the script stdout on success (same token as `run_baseline.sh`).
5. If mining against a legacy 0G on-chain project, refresh **`network_state.json`** again with **`sync_registry_frontier.py`** immediately before comparing; this avoids submitting against stale registry state. For Solana projects, keep using the manual/local frontier until `sync_solana_frontier` exists.
6. Compare numerically using **`compare_metric.py`** — never compare floats in prose.
7. If improved vs last local best: run `commit_improvement.sh <protocol.json> <repo_root> <trial_id> <before> <after>`; else run `revert_mutable_surface.sh <protocol.json> <repo_root>`.
8. If the metric beats `network_state.network_best_metric`, publish the winning commit before submitting: `push_candidate_branch.sh --repo-root <repo_root> --trial-id <trial_id> --miner-id <mining address>`. The commits are the artifact, so a proposal whose commit is not fetchable cannot be verified. The script never force-pushes and re-running it on the same commit is a no-op, so it is safe to call unconditionally after `commit_improvement.sh`.
9. Then create the on-chain proposal immediately with **`submit_trial_proposal.py`**, passing `--project-id` or `--token-address`, `--repo-root`, `--trial-id`, `--claimed-metric`, and `--reward-recipient` (the user's main wallet, never the mining identity).
   - **Live submissions need `--legacy-artifact`.** The default git mode records `base_commit` / `head_commit` / `tree_hash` and exits **3**, because no deployed contract stores a git ref yet. Run it first anyway: the payload it writes is the record of what this candidate committed to.
   - Legacy mode on a 0G project: add `--wallet-id <id>`, `--auto-buy`, `--passphrase-file <path>` when the keystore passphrase is not in the environment, and `--budget 0.05og` (or similar) to cap what `--auto-buy` may spend on the bonding curve.
   - Legacy mode on a Solana project: upload the code archive and benchmark log to permanent storage first, then pass `--chain solana --solana-keypair <path> --solana-code-irys-id <id> --solana-benchmark-log-irys-id <id> --yes`. The submitter checks the miner project-token balance and buys missing stake with native SOL before `submit`; pass `--solana-buy-lamports` only to override the quote.
   - Only pass `--stake` when overriding `ARAH_STAKE` / the default stake of `1`. Use the dry-run flags first when validating account maps.
10. Build a JSON object for **`append_trial_record.py`** (see `prompts/results_logging.md`) and append one line to `trials.jsonl`. On a committed improvement, include `base_commit`, `head_commit`, and `tree_hash` — the same values `submit_trial_proposal.py` printed.
11. If **`ARAH_AXL_ENABLED=1`**, broadcast the latest trial with `axl_sidechat_send.py --record-file <repo_root>/.autoresearch/mine/trials.jsonl --peers "$ARAH_AXL_PEERS"`.

Do **not** open a pull request. Verifiers merge accepted work; the candidate branch from step 8 is how it becomes fetchable, not a request to merge it.

## AXL sidechat rules

- Treat `.autoresearch/mine/sidechat.jsonl` as a side conversation, never as settlement evidence or network frontier state.
- Do not block mining if AXL send/poll fails; record the failure in the final report and continue unless the user explicitly made AXL mandatory.
- Do not copy code from sidechat blindly. Use it for experiment ideas, warnings, failed-hypothesis memory, and reviewer/miner coordination.

## Per-trial time limits

Do **not** override `execution.hardTimeoutSeconds` or `execution.stopCondition`. The harness (`run_trial.sh` → `run_baseline.sh`) reads them from `protocol.json`.

## Stop the outer loop when any fires

- Trial count ≥ `max_trials`
- Session wall ≥ `max_session_wall_seconds` if that value is **≥ 0**
- Stagnant trials ≥ `max_stagnant_trials` if that value is **≥ 0**
- Successful proposal submit when `stop_after_pr` is true
- Successful on-chain proposal submit for a network-best improvement, unless the user explicitly configured the run to continue mining after submit
- Unrecoverable script failure (report once and exit)
