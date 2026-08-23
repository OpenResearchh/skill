# Stellar OpenResearch mining

This is the miner reference for the default `stellar` settlement layer.
`bootstrap_project.mjs` and `submit_trial_proposal.py` select it unless
`--chain`, `ARAH_CHAIN`, or `.autoresearch/chain.json` says otherwise.

Read `../autoresearch-create/references/onchain-stellar.md` for network IDs,
GitRef hashing, and scoring. This file covers miner-specific setup.

## Identity

Prepare a dedicated miner secret **before** bootstrap. Do not ask the user for
a seed phrase. Ask them only to fund the printed public key (testnet friendbot)
and for a reward-recipient address.

```bash
node scripts/stellar_open_research.mjs init-identity \
  --out ~/.config/stellar/arah-mine-<project_id>.secret
node scripts/stellar_open_research.mjs address \
  --secret-key-file ~/.config/stellar/arah-mine-<project_id>.secret
```

Stake is the project's `minimum_stake` in the chosen SEP-41 token (stroops when
the token is native XLM). The miner must hold that balance; OpenResearch does
not buy stake on a bonding curve.

## Bootstrap

```bash
node scripts/bootstrap_project.mjs \
  --project-id <id> \
  --output-dir /path/to/mining-work/project \
  --repo-url https://github.com/owner/repo.git \
  --prepare-repo
```

The adapter:

1. Reads `get_project`.
2. Checks out the live incumbent GitRef (current best when `current_best.present`,
   otherwise baseline).
3. Verifies `tree_hash` and `protocol_hash` with the Stellar client.
4. Initializes `.autoresearch/mine`.
5. Writes `network_state.json` with `source: "stellar"`. Genesis projects seed
   `network_best_metric` from `baseline_score`, never from a missing current-best.

`--from-baseline` starts from the published baseline instead of current best.

## Submit

Push the candidate first (`push_candidate_branch.sh`). Then:

```bash
python3 scripts/submit_trial_proposal.py \
  --project-id <id> \
  --repo-root <repo> \
  --trial-id <trial_id> \
  --claimed-metric <decimal> \
  --reward-recipient G... \
  --stellar-secret-key-file ~/.config/stellar/arah-mine-<id>.secret \
  --yes
```

Git mode is live on Stellar. Do not pass `--legacy-artifact`. `base_commit` must
equal the live incumbent commit or the contract returns `BaseCommitMismatch`.

Compare trials with:

```bash
./compare_metric.py --direction <dir> --candidate <n> --baseline <n> \
  --protocol <protocol.json>
```

The helper defaults to 100 bips and treats an exact-threshold improvement as
sufficient (`<=` minimize / `>=` maximize when bips > 0).

## Identity link (optional)

```bash
python3 scripts/link_identity.py \
  --handle <github> \
  --address G... \
  --secret-key-file ~/.config/stellar/arah-mine-<id>.secret \
  --submit --yes
```

The binding is metadata only. It does not redirect rewards.
