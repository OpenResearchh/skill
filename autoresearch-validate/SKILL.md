---
name: autoresearch-validate
description: Verify OpenResearch mining proposals, settle them, and merge the accepted work. Fetch the candidate commit from git and verify its canonical tree hash, rerun the project's own harness in a sandbox, apply deterministic static gates, then approve, reject, or release — and merge approved proposals into the project repository, because the on-chain verifier allowlist is also the merge authority. Fully unattended loop with append-only review records over a pluggable settlement layer. Use when operating a verifier node or rerunning benchmark proofs.
---

# autoresearch-validate

Operate an **unattended verifier** over published projects. Every outcome is settled on the project's settlement layer; nothing on GitHub decides anything. GitHub is where accepted work becomes discoverable, and the verifier is the one who puts it there.

When the user says something like **"start autoresearch validating `<project>`"**,
treat `<project>` as the project reference, resolve it, print the project
summary for confirmation, check the verifier identity and its registration,
then run:

```bash
node scripts/validate_loop.mjs \
  --project-id <project_id> \
  --identity <keystore id or key file> \
  --yes
```

The loop claims each proposal first; only after the claim succeeds does it fetch
the candidate commit, restore the project's own harness over the submitted tree,
rerun the benchmark, upload verifier metrics or reject evidence, and
approve/reject/release. After a successful approve it merges the work.

**Self-contained:** Bundled harness under [`vendor/harness/`](vendor/harness/), contracts under [`contracts/`](contracts/), and local fixtures under [`fixtures/`](fixtures/) are included so the skill can run after installation without sibling skill folders.

## Artifacts are git commits

**Git is the artifact store.** A proposal points at a commit in the project
repository rather than at an uploaded archive, and the frontier advances by
recording a new head commit. There is nothing to pack, upload, or unpack, and
there is no "artifact fetch failed" state sitting in the settlement path.

Two independent checks fix the bytes a verifier scores:

1. **The commit id.** Git is content-addressed. Fetching an object by its id and
   having git accept it *is* the integrity check, so a host cannot serve
   different code than the proposal committed to.
2. **The canonical tree hash.** Git commit ids are SHA-1 and this system has
   value attached to them, so [`scripts/tree_hash.py`](scripts/tree_hash.py)
   computes a second, independent SHA-256 commitment over git's own object
   model — `sha256("openresearch/tree/v1\n" || per-path len:path, mode,
   sha256(blob))`. A SHA-1 collision alone is then not enough to swap the code.
   It is deliberately **not** a hash of `git archive` output, which varies with
   git version and gitattributes and would fail every honest proposal.
   Submodules and non-blob entries are rejected rather than hashed.

The chain stores `sha256("host/owner/repo")` — a commitment, not a location — so
the remote URL comes from `--repo-url`, `ARAH_PROJECT_REPO`, or the project's
own hash-pinned `protocol.json` (`meta.repo.cloneUrl`). The verifier recomputes
the digest and refuses to fetch if it does not match what the project or
proposal committed to. Only `https`, `ssh`, and scp-style remotes are allowed;
`file://`, `git://`, and `ext::` are refused because they are unauthenticated or
execute a command.

The **trusted harness is the tree at the project's pinned commit**, not a copy
carried inside the submission, and `protocol.json` from that tree is checked
against the SHA-256 the chain records for it.

Projects published before the migration are still verifiable: pass
`--artifact-mode irys` (or leave `auto`, which falls back automatically when no
commit is recorded) to download and hash-verify the tarballs instead. That path
still runs the tar-safety guard that rejects absolute paths, `..` traversal, and
non-regular entries before extraction.

## Merge authority

**One allowlist, two powers.** The address permitted to settle a proposal
on-chain is the same address permitted to merge it. There is no separate bot
identity holding write credentials, and therefore no actor whose compromise
moves code without also being on the verifier allowlist. There is no settlement
bridge and no off-chain result submitter.

After a successful on-chain approve, the loop runs
[`scripts/merge_approved_proposal.mjs`](scripts/merge_approved_proposal.mjs):

- It **re-reads the head sha immediately before merging** and abandons the merge
  if it moved. A branch name is mutable; merging a repointed branch would put
  code on the frontier that no verifier ever scored.
- It **never squashes**. The miner's commits and their authorship are the
  contribution record. It merges through the merge API, which always writes a
  merge commit; when `--pull-number` is used the merge method is `merge` and
  never `squash` or `rebase`.
- **Approval is final; the merge is not a settlement input.** On-chain state is
  already committed and the miner is already paid by the time the merge runs. A
  conflict, a moved head, or a project repo owned by a third party the verifier
  cannot write to is reported as **approved-but-unmerged** (`merged_commit:
  null` in the review record) and never fails or reverts the settlement.
  Settlement that a GitHub outcome can undo is worse than settlement with no
  merge commit to point at.
- It requires **`--yes`** for a live merge and supports **`--dry-run`**.

The merged commit is printed as `mergedCommit` for `record_merge`, which is
audit-only. Rejected proposals are never mirrored — only accepted work is
merged; rejections are events.

Pass `--no-merge` to settle on-chain only. Without a credential the loop warns
once and continues, reporting every approval as approved-but-unmerged.

## Security: the merge credential and the sandbox

**The verifier process runs untrusted miner code AND holds a GitHub write
token. Those two must never meet.**

- **The token must never be reachable from inside the sandbox.** A token visible
  to the submission's own build or benchmark turns "run untrusted code" into
  "hand the project repository to whoever wrote the submission". The loop strips
  `ARAH_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
  `GITHUB_PAT` from the environment of every harness invocation.
- **Least privilege.** The token needs **contents: write on the project
  repository only** — plus `pull_requests: write` only if you merge through
  `--pull-number`. It needs nothing else. Use a fine-grained token scoped to
  that single repository, not a classic `repo` token and not an organization-
  wide one.
- **Never hand the token to git.** `merge_approved_proposal.mjs` talks to the
  REST API only; no credential is placed in a remote URL, a credential helper,
  or a git subprocess environment, so it cannot leak into a fetched tree or a
  `.git/config` left behind in a workspace.
- Prefer **`--github-token-file`** over an environment variable, and keep the
  file outside every directory a submission is checked out into.
- If you run the verifier on shared infrastructure, treat the merge credential
  as equal in blast radius to the settlement key: whoever holds both can move
  code, and being on the allowlist is what makes that legitimate.

## Prerequisites

- `jq`, `bash`, `python3`, `git` on PATH (harness and artifact fetch); `python3 -m pip install -r requirements-chain.txt` and `npm install` (from the repo root or `autoresearch-validate` root) for the settlement adapters.
- A **GitHub token with `contents: write` on the project repository only**, to merge approved proposals. Pass it as `--github-token-file`. Optional — `--no-merge` settles on-chain and leaves approvals unmerged. Read [Security](#security-the-merge-credential-and-the-sandbox) before configuring it.
- A sandbox runtime — **`podman`** (preferred), **`docker`**, or **`bwrap`**. Verifiers re-run untrusted miner code, so the harness refuses to execute it without a sandbox unless `ARAH_SANDBOX=none ARAH_SANDBOX_ALLOW_UNSAFE=1` is set explicitly (do not do this in production).
- A funded **verifier identity** on the active settlement layer, and that identity must be **registered as a verifier**. See [Identity and funding](#identity-and-funding).
- On the **legacy tarball path only** (`--artifact-mode irys`, or a project that records no commit), where the layer does not publish proposal artifacts itself: **exactly one** of **`ARAH_ARTIFACT_INDEX`** (local JSON file) or **`ARAH_ARTIFACT_INDEX_URL`** (HTTP GET) — maps each code hash to downloadable artifacts (see [`schemas/artifact_index.schema.json`](schemas/artifact_index.schema.json)). `schemaVersion: "2"` lets index entries declare `sandbox_image_digest` and `network_policy_used`; the validator pins the harness to those exact values for the run, eliminating false rejects from sandbox / network drift between miner and verifier.

## Settlement layer

`scripts/validate_loop.mjs` is the only review-and-settle entrypoint this skill uses. It resolves the active settlement layer and hands the work to that layer's adapter. Resolution order, first match wins:

1. `--chain <name>` on the command line
2. `ARAH_CHAIN` in the environment
3. `.autoresearch/chain.json` in the working directory, e.g. `{"chain":"solana"}`
4. the built-in default

Supported names are `solana` and `0g`; `solana` is the default. Pass **`--show-chain`** (or set **`ARAH_SHOW_CHAIN=1`**) to print which layer and adapter were selected — do that first whenever the loop fails in a way that looks layer-specific. Unknown flags are forwarded to the adapter unchanged, so layer-specific options (alternate project identifiers, endpoint overrides, workspace paths) stay reachable without appearing here.

Layer detail lives in the reference docs, not here:

- `solana` → [`references/onchain-verify-solana.md`](references/onchain-verify-solana.md)
- `0g` → [`references/onchain-verify-0g.md`](references/onchain-verify-0g.md)

## Identity and funding

Verifying needs an identity on the active settlement layer that can sign settlement actions and pay their fees.

- Pass it as **`--identity <ref>`**; `validate_loop.mjs` translates that to whatever the active adapter expects (a keystore id on one layer, a key file path on another). The reference doc for the layer names the exact form and any companion flag such as a passphrase file.
- The identity **must be registered as a verifier** on that layer. If it is not, stop and report that directly — do not attempt to review proposals. The loop checks this before sending anything.
- The identity must have enough balance to pay settlement fees.
- Where a layer's adapter needs a local signing key, it stays in a passphrase-encrypted keystore that only that adapter's wallet helper decrypts. No settlement script reads `ARAH_PRIVATE_KEY`. Never ask the user for a private key or seed phrase.

Follow the active layer's reference doc for the exact identity setup, registration check, and funding steps before starting the loop.

## Unattended rules

- Export **`GIT_TERMINAL_PROMPT=0`** for git-enabled harness steps.
- Do **not** prompt the operator mid-loop; stop on the proposal cap, empty queue, or fatal endpoint/key errors.
- **`prompts/*.md`** are **non-authoritative** (documentation only).

## Environment variables

### Settlement-neutral

| Variable / argument | Purpose |
|----------|---------|
| `--identity <ref>` (CLI) | Verifier identity for the active settlement layer |
| `ARAH_CHAIN` | Settlement layer to use when `--chain` is not passed |
| `ARAH_SHOW_CHAIN` | `1` to print which layer and adapter `validate_loop.mjs` selected |
| `ARAH_PROJECT_REPO` | Project git remote to fetch commits from and merge into, when not passed as `--repo-url` |
| `ARAH_PROJECT_COMMIT` | Override the project's pinned commit (the trusted harness/protocol source) |
| `ARAH_GITHUB_TOKEN` (or `GITHUB_TOKEN` / `GH_TOKEN`) | Merge credential. **Prefer `--github-token-file`**; see [Security](#security-the-merge-credential-and-the-sandbox). Stripped from every harness environment. |
| `ARAH_ARTIFACT_INDEX` **or** `ARAH_ARTIFACT_INDEX_URL` | Artifact manifest, for the legacy tarball path where the layer needs one (see schema) |

### Metrics / protocol

| Variable | Purpose |
|----------|---------|
| `ARAH_METRIC_SCALE` | Signed-integer scale for decimal metrics (default **1000000**; must match the scale the project was published with) |
| `ARAH_PROTOCOL_SUBPATH` | Path to `protocol.json` inside the project tree or extracted tarball (default **`.autoresearch/publish/protocol.json`**) |
| `ARAH_EXTRA_PERMIT_GLOBS` | Extra `:`-separated glob permits for `verify_static_gates.py` |

### Sandbox / records / limits

| Variable | Purpose |
|----------|---------|
| `ARAH_SANDBOX` / `ARAH_SANDBOX_ALLOW_UNSAFE` | Sandbox runtime selection; `none` requires the explicit unsafe override |
| `ARAH_VERIFY_RECORD_ROOT` | Repo root where **`.autoresearch/verify/reviews.jsonl`** is appended (default: skill root directory) |
| `VALIDATE_MAX_PROPOSALS` | Cap on proposals processed per run (default **50**, overridable by `--max-proposals` where the adapter supports it) |
| `ARAH_ARTIFACT_FETCH_TIMEOUT` | HTTP timeout seconds (default **120**) |

### Adapter-specific

These configure one settlement layer's adapter and are not part of the primary flow. Set them only when that layer's reference doc tells you to.

| Variable | Layer | Purpose |
|----------|-------|---------|
| `AUTORESEARCH_CREATE_SCRIPTS` | `solana` | Directory containing the client helper modules (`solana_open_research.mjs`, `irys_storage.mjs`); defaults to sibling `autoresearch-create/scripts`. |
| `ARAH_DEPLOYMENT_JSON` | `0g` | Path to `deployment.json` (default: bundled `contracts/0g-galileo-testnet/deployment.json`) |
| `ARAH_RPC_URL` | `0g` | RPC endpoint |
| `ARAH_CHAIN_ID` | `0g` | Default **16602** |
| `ARAH_PROPOSAL_LEDGER` / `ARAH_PROJECT_REGISTRY` / `ARAH_VERIFIER_REGISTRY` | `0g` | Address overrides |
| `ARAH_WALLET_PASSPHRASE` | `0g` | Passphrase source for the verifier keystore; prefer `--passphrase-file` |
| `ARAH_SKIP_PROTOCOL_HASH_COMPARE` | `0g` | If `1`/`true`/`yes`, skip SHA-256(protocol.json) vs the registry's recorded protocol hash |
| `ARAH_CLAIMABLE_STATUS_CODES` | `0g` | Comma-separated claimable `status` integers (overrides [`constants/status_enum.json`](constants/status_enum.json)) |

## Machine layout

| Path | Role |
|------|------|
| `.autoresearch/verify/reviews.jsonl` | Append-only review records |
| `.autoresearch/verify/runs/<review_id>/stdout.log` | Harness stdout |
| `templates/chain_cursor.json` | Optional future event-indexer cursor |

Initialize with **`scripts/init_verify_workspace.sh <repo_root>`**.

## Bundled resources

| Resource | Role |
|----------|------|
| `vendor/harness/` | Vendored `run_baseline.sh`, `run_measured_trials.sh`, `aggregate_samples.py`, `derive_trial_seed.py` trial harness (sync with create/mine) |
| `scripts/chain.mjs` | Settlement-layer resolution and the operation → adapter registry. The only file that maps `validateLoop` onto a concrete implementation. |
| `scripts/validate_loop.mjs` | **Review pending proposals and settle them.** Neutral entrypoint: `--project-id`, `--identity`, `--once`, `--dry-run`, `--yes`, `--chain`, `--show-chain`; other flags pass through to the adapter. |
| `scripts/tree_hash.py` | Canonical SHA-256 commitment over a git tree. `--repo-root --commit [--verify HEX]`; the SHA-1 hardening that lets a commit id carry value |
| `scripts/git_artifacts.mjs` | Fetch a commit by id from an allowed remote, check it out detached and clean, and verify its tree hash. The one place that knows how to do this, so miner and verifier cannot drift |
| `scripts/merge_approved_proposal.mjs` | Merge an approved proposal into the project repo and print `mergedCommit` for `record_merge`. Re-checks the head sha, never squashes, reports approved-but-unmerged instead of failing |
| `scripts/restore_trusted_harness.py` | Overwrite every protocol-immutable path in the submitted tree with the project's own harness (a checkout at the project's pinned commit), and report any path that diverged (divergence on an immutable path is tampering) |
| `scripts/verify_static_gates.py` | Forbidden globs + permit lists + red-flag regex |
| `scripts/run_verify_trial.sh` | Repeated-sample harness run under `.autoresearch/verify/runs/<review_id>/`; writes `samples.json` |
| `scripts/verify_exploit_claim.py` | Attack-track review: bind an exploit claim to a protocol/diff, gate touched paths, measure base vs patched with the repeated-trial harness, and evaluate the declared witness |
| `scripts/artifact_resolve.py` | Download tarball + verify code hash; verify the miner benchmark log against its recorded hash |
| `scripts/append_review_record.py` | Append one review row to `.autoresearch/verify/reviews.jsonl` |
| `scripts/metrics_hash.py` | SHA-256 → 32-byte hex |
| `scripts/parse_baseline_metric.py` | Parse `BASELINE_METRIC=` from a harness log |
| `references/onchain-verify-solana.md` | Verifier setup, artifact resolution, and settlement detail for the `solana` layer |
| `references/onchain-verify-0g.md` | Verifier setup, hash + economics notes, and the legacy pipeline ordering for the `0g` layer |
| `references/onchain-mining-0g.md` | Miner submit-path context needed when interpreting `0g` proposals |
| `references/exploit-review.md` | How to review attack-track exploit claims |
| `fixtures/build_synthetic_fixture.py` | Builds local fixture data for `scripts/run_tests.sh` |

### Adapter-specific resources

Do not call these from the workflow; `validate_loop.mjs` selects the right one. They are listed so the files are identifiable when a reference doc names them.

| Resource | Layer | Role |
|----------|-------|------|
| `scripts/run_validate_loop_solana.mjs` | `solana` | Validator daemon: resolve project, check CLI + verifier account, poll proposals, claim first, fetch trusted project artifacts, verify, upload metrics/evidence, settle, then merge approved work. `--repo-url`, `--artifact-mode`, `--github-token-file`, `--no-merge`. |
| `scripts/resolve_proposal_artifacts_solana.mjs` | `solana` | Fetch the proposal's candidate commit from the project remote and verify its canonical tree hash. `--artifact-mode irys` falls back to downloading and hash-verifying the tarball. |
| `scripts/fetch_project_artifacts_solana.mjs` | `solana` | Materialize the **project's own** protocol + benchmark harness from its pinned commit (protocol pinned to the on-chain SHA-256), so scoring never uses inputs taken from the submission. Falls back to the hash-verified, tar-guarded archive path. |
| `scripts/settle_proposal_solana.mjs` | `solana` | `claim-review`, `release-review`, `approve`, `reject`, `expire`, `claim-reward`. |
| `scripts/upload_irys_file_solana.mjs` | `solana` | Upload verifier metrics/evidence and print the storage id used by settlement. |
| `contracts/solana-open-research/` | `solana` | Deployment metadata + full bundled Anchor IDL. |
| `scripts/run_validate_loop.py` | `0g` | End-to-end unattended pipeline. |
| `scripts/watch_proposals.py` | `0g` | Print claimable proposal ids. |
| `scripts/check_verifier_eligibility.py` | `0g` | `isVerifier` query. |
| `scripts/claim_review.py`, `finalize_approve.py`, `finalize_reject.py`, `release_review.py`, `expire_proposal.py` | `0g` | Individual ledger settlement calls. |
| `scripts/wallet.py` | `0g` | Verifier wallet keystore. The only place a private key is decrypted. |
| `scripts/chain_config.py` | `0g` | Resolve deployment + env. |
| `contracts/0g-galileo-testnet/` | `0g` | `deployment.json` + ABIs (`ProposalLedger`, `ProjectRegistry`, `VerifierRegistry`, `ProjectToken`). |

## Pipeline ordering (normative)

This is the order `validate_loop.mjs` drives. Adapters differ in where artifact
resolution sits relative to the claim and in which settlement call implements
each step; the reference doc for the active layer records those differences.

1. Resolve the project from `--project-id` (or the layer's alternate identifier).
2. Print project identity — project id, reward token, current best, settlement
   target — before live mode; require **`--yes`** to proceed.
3. Check the verifier identity: readable, its address, and its balance.
4. Check verifier registration. If the identity is not registered, print
   "not registered as verifier" and stop **with no settlement sent**.
5. Poll for pending proposals on the project with `stake > 0`.
6. **Claim the review first.** If the claim fails, skip that proposal — another
   verifier already holds it.
7. Fetch the proposal's **candidate commit** from the project remote and verify
   its canonical tree hash. A resolve failure is a **skip**, not a reject;
   record `artifact_resolve_failed`. (Legacy projects: download the tarball by
   its recorded id and verify its hash instead.)
8. Materialize the **project's own** `protocol.json` and benchmark harness from
   the project's **pinned commit**, verifying the tree hash and the on-chain
   SHA-256 of `protocol.json`. Never read the protocol, the harness, or the
   metric extraction out of the submission being judged — that would let
   whoever wrote the submission decide how it is scored.
9. Restore the trusted harness over every protocol-immutable path in the
   submitted tree (`restore_trusted_harness.py`). Divergence on an immutable
   path is tampering → upload evidence and **reject**.
10. Run **`verify_static_gates.py`**. Fail → upload evidence and **reject**.
11. Rerun the benchmark in the sandbox with **`run_verify_trial.sh`**. This is a
    repeated sample, not one run; the aggregate and the full sample land in
    `samples.json`.
12. Convert the verifier's **own** aggregate metric to a score:
    `maximize => scaled(metric)`, `minimize => -scaled(metric)`, with
    `ARAH_METRIC_SCALE` semantics (`1e6` default).
13. Approve if the verified score beats the project's current best by at least
    `measurement.minScoreImprovementBips` (default 100). Upload the verifier
    metrics first, then **approve** with the verified score. The miner's claimed
    score is recorded but never gates the outcome: comparing the two would
    reject honest work whenever the verifier's host differs from the miner's,
    and a claim the verifier cannot reproduce is worth nothing regardless of
    what it says.
14. Outcomes:
    - **Improvement clears the margin** → **approve**, with the verifier metrics
      as the recorded metrics artifact.
    - **Harness tampered / static-gate fail / no improvement over the current
      best** → **reject** with an evidence file (slashing — these are
      unambiguous miner-side faults).
    - **Harness exit ≠ 0 / sample too dispersed to score / metric not
      parseable** → **release the review** (NOT reject). These signals are
      ambiguous: they could be miner-side, but they could also be verifier-side
      (no sandbox runtime, image divergence, a noisy host, `networkPolicy=full`
      without `ARAH_ALLOW_FULL_NETWORK=1`). Slashing on those signals is unsafe;
      let another verifier try. If every verifier fails, the proposal eventually
      expires.
15. **After** the approve transaction lands — and only then — merge the
    candidate commit into the project repo and report `mergedCommit` for
    `record_merge`. The head sha is re-read immediately before the merge; the
    merge is never a squash. Any merge failure is recorded as
    approved-but-unmerged and **must not** change, retry, or revert the
    settlement.

Steps 13 and 14 are the settlement rule and must not be weakened: the incumbent
is the project's current best when one is set and the **baseline** otherwise
(a zero incumbent at genesis accepts anything positive on maximize projects and
rejects every real improvement on minimize projects), the comparison at the
threshold is **inclusive** because the margin is documented as the *minimum*
required improvement, and the reject/release split above is what keeps honest
mining profitable.

## Script exit codes (selected)

| Script | Codes |
|--------|-------|
| `validate_loop.mjs` | Passes through the adapter's exit code; **1** if the adapter cannot be launched or the configured layer is unsupported |
| `artifact_resolve.py` | 0 ok; 1 IO/validation; 2 missing index entry |
| `tree_hash.py` | 0 hash printed (and matched `--verify`); 2 usage error or not a git repo; **3** `--verify` mismatch; **4** tree contains an unhashable entry (submodule or unknown mode) |
| `merge_approved_proposal.mjs` | 0 merged; 2 usage or configuration error (nothing attempted); **3** approved but not merged — a reported, non-fatal outcome |
| `restore_trusted_harness.py` | 0 restored, nothing diverged; 2 usage error, unreadable trusted input, or trusted root not at `--expect-commit`; **3** an immutable path diverged (treat as tampering) |
| `verify_static_gates.py` | 0 pass; 3 forbidden; 4 not permitted; 5 red flag |
| `run_verify_trial.sh` | Same as `run_measured_trials.sh`; **3** if the harness dir is missing; **4** if the sample was too dispersed to score |

### Adapter-specific exit codes

| Script | Layer | Codes |
|--------|-------|-------|
| `run_validate_loop_solana.mjs` | `solana` | 0 loop finished; 1 args / endpoint / identity / not registered as verifier |
| `check_verifier_eligibility.py` | `0g` | 0 verifier; 2 not verifier |
| `watch_proposals.py` | `0g` | 0 |
| `run_validate_loop.py` | `0g` | 0 loop finished; 1 RPC / missing key |

## Out of scope

TEE attestation automation (the allowlist is intended to become the set of
attested verifier enclaves; design for it, do not build it now), artifact-storage
upload daemons for the legacy path (operators supply **`ARAH_ARTIFACT_INDEX`**
where the layer needs one), mirroring rejected proposals as pull requests, and
any settlement path that does not require a verifier to have re-run the
benchmark.

## Final response

Report **`reviews.jsonl`** path, last proposal ids processed, whether settlement
was sent (`--dry-run` if applicable), and for each approval whether it was
merged or is approved-but-unmerged and why.
