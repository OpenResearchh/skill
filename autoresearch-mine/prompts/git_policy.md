# Git policy (agent prompt)

Map harness outcomes to git commands **only** via bundled scripts—do not run blanket `git checkout .` or `git add -A`.

| Outcome | Action |
|---------|--------|
| Trial succeeded and metric **strictly improves** local best (`compare_metric.py` exit 0 vs previous best) | `commit_improvement.sh <protocol.json> <repo_root> <trial_id> <metric_before> <metric_after>` |
| Trial failed, timeout, or metric not better | `revert_mutable_surface.sh <protocol.json> <repo_root>` |
| Edit accidentally touched forbidden paths | Revert manually to protocol scope before running the harness |
| Committed trial beats the network best | `push_candidate_branch.sh --repo-root <repo_root> --trial-id <trial_id> --miner-id <mining address>` |

**Forbidden:** modifying paths under `immutableHarness` or `mutableSurface.forbiddenGlobs`.

**Forbidden:** `git push --force`, rewriting published history, and opening pull
requests. The proposal references commits, so a rewritten history invalidates
the artifact a verifier is holding you to. `push_candidate_branch.sh` is the
only script here that writes to a remote, and it refuses both.
