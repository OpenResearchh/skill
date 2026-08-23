# Results logging (agent prompt)

Every completed trial must append **exactly one** JSON Lines row to `.autoresearch/mine/trials.jsonl` using:

```bash
python3 append_trial_record.py --record-file <repo>/.autoresearch/mine/trials.jsonl --json-file <row.json>
```

## Row contents

Match **`schemas/trial_record.schema.json`**. Required fields:

| Field | Notes |
|-------|--------|
| `schemaVersion` | `"1"` |
| `trial_id` | Unique id for this trial |
| `utc_timestamp` | ISO-8601 UTC |
| `protocol_bundle_id` | Copy `meta.protocolBundleId` |
| `run_ok` | True iff harness exit 0 **and** metric extracted |
| `primary_metric_name` | From protocol |
| `primary_metric_value` | Parsed float or `null` |
| `direction` | `minimize` or `maximize` |
| `beats_local_best` | Whether this trial won vs previous local best |
| `beats_network_best` | Whether metric beats `network_state.network_best_metric` (false if unknown) |
| `stdout_log_path` | Relative path under repo root, e.g. `.autoresearch/mine/runs/<id>/stdout.log` |
| `git_head_before` / `git_head_after` | SHAs or `null` |
| `harness_exit_code` | Integer exit code from `run_trial.sh` |
| `error` | Empty string if none |

Optional: `hypothesis` (string).

Optional git-artifact fields, filled in on a committed improvement:

| Field | Notes |
|-------|--------|
| `base_commit` | 40-hex commit this trial's work branched from |
| `head_commit` | 40-hex commit the trial produced (same as `git_head_after`) |
| `tree_hash` | 64-hex canonical tree commitment from `tree_hash.py` at `head_commit` |

These are what a proposal references, so recording them per trial is what lets
a submission be reconstructed from the log. Copy the values printed by
`submit_trial_proposal.py` rather than recomputing them, so the row and the
proposal cannot disagree. Leave them `null` on a reverted trial.

Never omit `stdout_log_path`.
