# PR gate (agent prompt)

Open a PR **only** when submission criteria are met and the repo reflects the winning commit.
For GitHub-distributed settlement PRs, use the proposal-first bridge: submit the
proposal first, then open the PR with the resulting `submission.json`.

## Before `open_pr_with_evidence.sh`

1. Re-run `validate_network_state.sh <protocol.json> <repo_root>` if you changed protocol or network state.
2. Re-read `.autoresearch/mine/network_state.json`. Default rule: PR only if `network_best_metric` is **not** `null` and your trial metric **strictly improves** it (`compare_metric.py` vs that baseline).
3. If `network_best_metric` is `null`, **`open_pr_with_evidence.sh` refuses** unless you pass **`--allow-local-only-pr`** and the trial has **`beats_local_best: true`** (risk of noisy upstream PRs).

## Command

```bash
open_pr_with_evidence.sh [--allow-local-only-pr] <repo_root> <protocol.json> <trial_json_or_trials.jsonl>
```

Use the trial row JSON file or the full `trials.jsonl` (last line used).

For settlement-bearing PRs:

```bash
open_pr_with_evidence.sh \
  --require-proposal \
  --proposal-json <repo_root>/.autoresearch/mine/submissions/<trial_id>/submission.json \
  <repo_root> <protocol.json> <trial_json_or_trials.jsonl>
```

The proposal-bound gate also checks:

- `submission.json.trial_id` matches the trial record.
- `submission.json.git_head` matches `trial.git_head_after`.
- current `git rev-parse HEAD` matches `submission.github.head_sha`.
- `proposal.proposal_id` and `proposal.stake` are present.
- `artifacts.code_hash` matches the submitted `repo-snapshot.tar`.
- GitHub owner/repo/base/head binding is present.

## Requirements

- **`gh`** installed and authenticated (`GH_TOKEN` / `GITHUB_TOKEN` for CI).
- Current branch pushed if your fork/remote requires it (`gh pr create` needs a remote branch).

When **`network_state.source`** is **`registry`**, the frontier reflects **`ProjectRegistry.currentBestAggregateScore`** (re-sync before judging “beats network”). GitHub PR overlap with other miners remains a social merge layer—on-chain **`submit`** is separate (see **`submit_proposal.py`**).

In GitHub verification bridge mode, the PR is no longer just social evidence:
it carries the machine-readable `openresearch-proposal` block that CI and the
settlement bridge consume. Do not hand-edit that block after opening the PR
except through automation that also re-validates the head SHA and proposal id.
