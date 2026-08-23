# OpenResearch Contract Spec

Authoritative design brief for the smart-contract workspace. Supersedes
`contract-api.md`, `architecture.md`, and the storage sections of
`migration-map.md` in this folder. Written after the decision to keep the chain
canonical and use GitHub as a discovery surface rather than a settlement input.

---

## 1. The model in one paragraph

The chain is the only source of truth for what is proposed, what is accepted,
who owns a contribution, and what the current best is. Miners work locally in
git. Verifiers on an on-chain allowlist re-run the benchmark, settle the
proposal on-chain, and — because they are the same set — merge the accepted
work on GitHub. GitHub is where the work becomes discoverable and where
contributors get public credit. Nothing on GitHub decides anything. If GitHub
disappeared, the protocol would keep working and no canonical state would be
lost.

## 2. Authority

| Actor | Can do | Cannot do |
|---|---|---|
| Researcher | Publish a project, set the benchmark and margin | Settle, merge |
| Miner | Submit a proposal with stake, link an identity | Settle, merge |
| Verifier (allowlisted) | Claim, approve, reject, release, **merge on GitHub** | Publish, change the margin |
| Anyone | Expire a stale claim, read everything | Everything else |

**One allowlist, two powers.** The address permitted to settle a proposal
on-chain is the same address permitted to merge it on GitHub. There is no
separate bot identity holding write credentials, and therefore no actor whose
compromise moves money without also being on the allowlist.

Today the allowlist is a plain set of addresses. It is intended to become the
set of TEE-attested verifier enclaves. That upgrade adds an attestation field
to the verifier record; it does not change any instruction signature. Design
for it now, do not build it now.

## 3. Storage decision

**Git is the storage. There is no separate storage layer in the critical path.**

Rationale: git is already content-addressed and already replicated to every
miner and verifier that ever touched the project. A commit SHA is an integrity
guarantee, not a location. Adding a permanent-storage dependency in front of
that buys durability we largely already have, and costs an upload step, a
gateway dependency, and a class of "artifact fetch failed" states in the
settlement path.

What the chain stores per artifact:

| Field | Type | Meaning |
|---|---|---|
| `repo` | `BytesN<32>` | `sha256("<host>/<owner>/<repo>")`, host-agnostic |
| `commit` | `BytesN<20>` | Git commit SHA-1 |
| `tree_hash` | `BytesN<32>` | `sha256` of the canonical archive of the tree at `commit` |

`tree_hash` is **not** there to prove the host served the right commit — git
already guarantees that, because fetching an object by its id and having git
accept it is itself the integrity check. Its actual job is **SHA-1 hardening**:
git commit ids are SHA-1, and this system has money attached. A second,
independent SHA-256 commitment means a SHA-1 collision alone is not enough to
swap the code a proposal points at.

Because both sides must compute it identically, define it over git's own object
model rather than over an archive:

```
tree_hash = sha256( "openresearch/tree/v1\n" ||
                    for each path in the tree, sorted by full path bytes:
                        len(path) || ":" || path || "\n" ||
                        octal_mode  || "\n" ||
                        sha256(blob contents) || "\n" )
```

Do **not** hash a `git archive` tarball. That output varies with git version and
with `export-subst` / `export-ignore` gitattributes, so a miner and a verifier
on different machines can produce different bytes for the same commit and every
proposal fails verification. Symlinks hash as their target path; submodules and
any non-blob, non-tree entry are rejected at submit time rather than hashed.

**Do not use `BytesN<32>` for a commit SHA.** Git commits are SHA-1, 20 bytes.
Reserve a `hash_algo: u8` discriminant on the artifact struct so git's eventual
SHA-256 migration does not require a state migration.

Optional, off the critical path: a project may record an `archive_uri_hash`
pointing at a permanent mirror. Nothing in settlement reads it. Add it only if
a project asks for permanence guarantees beyond git.

## 4. Artifact form: a branch, not a snapshot

A proposal references `base_commit` and `head_commit`. **The commits are the
artifact.** This is what preserves authorship and history, and it is what makes
git-as-storage work — there is nothing to pack, upload, or unpack.

Consequences the contract must respect:

- The frontier advances by recording a new `head_commit`, not by replacing a blob.
- A verifier scores the tree at `head_commit`, having confirmed `tree_hash`.
- Merge preserves the miner's commits and authorship. Do not squash; the commit
  history is the contribution record.

## 5. State

```rust
pub type ProjectId = u64;
pub type ProposalId = u64;

#[contracttype]
pub enum Direction { Maximize, Minimize }

#[contracttype]
pub enum ProposalStatus { Submitted, Claimed, Approved, Rejected, Released, Expired }

#[contracttype]
pub struct GitRef {
    pub repo: BytesN<32>,        // sha256("host/owner/repo")
    pub commit: BytesN<20>,      // SHA-1
    pub tree_hash: BytesN<32>,   // sha256 of canonical archive at commit
    pub hash_algo: u8,           // 0 = sha1 commits; reserved for git sha256
}

#[contracttype]
pub struct Project {
    pub id: ProjectId,
    pub creator: Address,
    pub protocol_hash: BytesN<32>,     // sha256 of protocol.json
    pub baseline: GitRef,
    pub baseline_score: i128,
    pub current_best: Option<GitRef>,  // None until a proposal is approved
    pub current_best_score: i128,
    pub current_best_miner: Option<Address>,
    pub direction: Direction,
    pub min_improvement_bips: u32,     // consensus rule, not a hint
    pub metric_scale: u32,             // decimal -> integer scale, default 1_000_000
    pub frozen: bool,                  // set when an exploit is confirmed
    pub protocol_epoch: u32,
    pub token: Address,
}

#[contracttype]
pub struct Proposal {
    pub id: ProposalId,
    pub project_id: ProjectId,
    pub protocol_epoch: u32,           // stamped at submit
    pub miner: Address,
    pub reward_recipient: Address,
    pub candidate: GitRef,
    pub base_commit: BytesN<20>,
    pub claimed_score: i128,           // recorded, never gates settlement
    pub verified_score: i128,
    pub stake: i128,
    pub status: ProposalStatus,
    pub reviewer: Option<Address>,
    pub review_lock_until: u64,
    pub merged_commit: Option<BytesN<20>>,
}

#[contracttype]
pub struct Verifier {
    pub address: Address,
    pub active: bool,
    pub attestation: Option<BytesN<32>>,  // reserved for TEE measurement
}
```

Identity binding, optional and revocable, keyed by address:

```rust
pub struct Identity { pub handle: String, pub platform: u8 }  // 0 = github
```

## 6. Instructions

| Instruction | Auth | Notes |
|---|---|---|
| `initialize(admin)` | deployer | once |
| `add_verifier(addr)` / `remove_verifier(addr)` | admin | the allowlist |
| `create_project(args)` | creator | sets baseline, direction, margin, scale |
| `submit(project_id, candidate, base_commit, claimed_score, stake, reward_recipient)` | miner | escrows stake, stamps epoch |
| `claim_review(proposal_id)` | verifier | sets `review_lock_until` |
| `approve(proposal_id, verified_score)` | claiming verifier | **enforces §7**; advances frontier; returns stake; mints reward |
| `reject(proposal_id, reason_code)` | claiming verifier | slashes stake |
| `release_review(proposal_id)` | claiming verifier | returns to `Submitted`, no penalty |
| `expire(proposal_id)` | anyone | after `review_lock_until` |
| `record_merge(proposal_id, merged_commit)` | claiming verifier | after approve; optional, audit only |
| `link_identity(handle, platform)` | miner | optional, revocable |
| `unlink_identity()` | miner | |
| `amend_protocol(project_id, protocol_hash, baseline, baseline_score)` | creator | bumps epoch, unfreezes, resets frontier |

Deliberately absent: any instruction that lets an off-chain result be settled
without a verifier having re-run the benchmark. There is no bridge.

## 7. Settlement rule — enforce this on-chain

This is the most important part of the spec. It is currently enforced only in
client code, which means a buggy or dishonest verifier can advance the frontier
with a number it did not earn.

```rust
// Aggregate score is oriented so that greater is always better:
//   maximize -> score =  metric * scale
//   minimize -> score = -metric * scale
// so one comparison covers both directions.

let incumbent = match project.current_best {
    Some(_) => project.current_best_score,
    None    => project.baseline_score,      // genesis: baseline is the frontier
};

let margin = (incumbent.abs() as u128 * bips as u128 / 10_000) as i128;

let ok = if bips == 0 {
    verified_score > incumbent            // no margin: must strictly beat
} else {
    verified_score >= incumbent + margin   // margin is the MINIMUM improvement
};
require(ok, Error::InsufficientImprovement);
```

Three details that have already caused bugs client-side:

1. **Incumbent falls back to the baseline** when no proposal has been approved.
   Using a zero `current_best_score` at genesis is wrong in both directions:
   maximize projects would accept anything positive, and minimize projects
   (whose scores are negative) would reject every real improvement.
2. **The comparison is inclusive at the threshold.** The margin is documented as
   the minimum required improvement, so improving by exactly the margin must
   pass. With `bips == 0` the threshold collapses to the incumbent and the
   comparison must stay strict, otherwise matching the baseline counts as a win.
3. **`claimed_score` never gates settlement.** It is recorded for audit. The
   verifier's own measurement decides. Comparing the two rejects honest work
   whenever two hosts differ.

## 8. Reject vs release — do not conflate

| Situation | Action | Stake |
|---|---|---|
| Static gate failure, harness tampering, confirmed gaming | `reject` | slashed |
| Verified score does not clear the threshold | `reject` | slashed |
| Harness would not run, metric unparseable, sample too noisy | `release_review` | returned |
| Verifier went away | `expire` | returned |

Only reproducible miner fault costs stake. Anything that could be a property of
the verifier's own machine releases. Getting this wrong makes honest mining
unprofitable, which is the failure mode that kills the network quietly.

## 9. Events

The GitHub mirror is an indexer. Every event must carry enough to project
without extra RPC calls — under-specified events are the most common way this
kind of design ends up slow and fragile.

```
project_created(project_id, creator, baseline: GitRef, baseline_score, direction, bips)
proposal_submitted(proposal_id, project_id, miner, candidate: GitRef, base_commit, claimed_score, stake)
review_claimed(proposal_id, verifier, lock_until)
proposal_approved(proposal_id, project_id, miner, reward_recipient, verified_score,
                  previous_best_score, candidate: GitRef, reward_amount)
proposal_rejected(proposal_id, verifier, reason_code, stake_slashed)
proposal_released(proposal_id, verifier, reason_code)
frontier_advanced(project_id, new_best: GitRef, new_best_score, miner)
merge_recorded(proposal_id, merged_commit)
identity_linked(address, platform, handle)
project_frozen(project_id, reason_code) / protocol_amended(project_id, new_epoch)
```

## 10. Explicitly out of scope

- No settlement bridge, no trusted off-chain result submitter.
- No PR number in contract state. The mirror correlates by `proposal_id`.
- No rejected-proposal mirroring. Only accepted work is merged; rejections are
  events. A wall of bot-authored rejected PRs would destroy the discovery value
  the mirror exists for.
- No permanent-storage dependency in settlement.

## 11. Open items for the contracts team

1. **Reward curve.** Carried over from the bonding-curve model; not re-decided here.
2. **Slash split.** What fraction of a slashed stake burns vs goes to the verifier pool.
3. **`review_lock_until` duration.** Must exceed a realistic benchmark run; protocol-configurable is likely right.
4. **Merge failure.** A verifier approves on-chain, then the GitHub merge fails
   (conflict, upstream rejects it). On-chain state is already final and the miner
   is already paid. Recommended: leave it — `record_merge` stays `None` and the
   mirror shows it as approved-but-unmerged. Confirm you agree, because the
   alternative is settlement that can be undone, which is worse.
5. **Upstream repos.** When the project repo belongs to a third party, verifiers
   cannot merge. The protocol still pays. Confirm that on-chain approval is the
   payout trigger and upstream merge is best-effort.
