# Miner-owned agent trajectories

A mining run produces more than a metric. The sequence of prompts, model
replies, tool calls, and tool results that led to an improvement is itself a
research artifact — and it belongs to the miner who generated it, not to the
protocol, the project owner, or anyone downstream.

This skill can capture that sequence, store it on the miner's own disk, and —
only when the miner explicitly asks — publish it to Irys tagged with the
miner's public key and a license the miner picks.

## Design in one paragraph

Capture is **off by default**. `scripts/capture_trace.py` no-ops with exit 0
unless `ARAH_TRACE_ENABLED=1` is exported or `--enable` is passed. When it is
on, events are redacted with a best-effort secret filter and appended to
`.autoresearch/mine/traces/<trial_id>/events.jsonl`. `finalize` hashes that
bundle and writes `trace.json` conforming to
[`schemas/trace_record.schema.json`](../schemas/trace_record.schema.json).
Nothing leaves the machine at that point. Upload is a **separate, explicit
command** — `scripts/upload_trace_irys.mjs --yes` — and refuses to run without
`--yes`. The mining loop never calls the uploader.

## What is captured

Only what the miner hands to `capture_trace.py append`. There is no hook, no
interception of the agent's process, no background collector. Each event is one
JSON object:

| Field | Meaning |
|-------|---------|
| `seq` | 1-based position in the trial's trace |
| `ts` | UTC capture timestamp |
| `type` | `prompt`, `model_reply`, `tool_call`, `tool_result`, or `note` |
| `role` | optional speaker label (`user`, `assistant`, `system`) |
| `tool_name` | optional tool name for `tool_call` / `tool_result` |
| `text` | the redacted text |
| `chars` | length of the stored text |
| `redactions` / `redaction_labels` | how many pattern hits were replaced, and which |
| `metadata` | optional free-form JSON the miner attaches |

The finalized `trace.json` adds the trial id, agent name and version, model
identifier, event count, bundle SHA-256 and byte size, the redaction summary,
the owner pubkey, the license, and the upload status.

Long events are truncated at `--max-chars` (default 200000, override with
`ARAH_TRACE_MAX_CHARS`) so a runaway tool result cannot fill the disk.

## Redaction limits

The redaction pass replaces text matching these shapes with
`[REDACTED:<label>]`:

- `pem-block` — `-----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----`
- `api-key-sk-ant` / `api-key-sk` — `sk-ant-…` and `sk-…` API keys
- `github-token` — `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` prefixed tokens
- `github-pat` — `github_pat_…` fine-grained tokens
- `aws-access-key-id` — `AKIA` + 16 uppercase alphanumerics
- `jwt` — `eyJ…`-headed three-part tokens
- `solana-keypair-array` — 64-byte JSON integer arrays (raw keypair files)

**This is pattern matching, not a guarantee.** It is a seatbelt, not a vault.
It will not catch:

- passwords, database URLs, or bearer tokens with no recognizable prefix
- credentials in an unusual encoding, split across lines, or base64-wrapped
- private repository source, customer data, or internal hostnames
- anything the miner pastes that simply does not look like a secret

`finalize` re-scans the stored bundle and reports
`redaction.residual_hits_by_pattern`. A non-empty value means secret-shaped
text survived and the bundle needs manual review. Either way: **read the
bundle yourself before you upload it.** Once uploaded to Irys the bytes are
public and, on the mainnet network, permanent.

`--no-redact` exists for miners who want verbatim local capture. It stores raw
text and records `redaction.enabled: false`. Do not combine it with an upload
unless you have read every line.

## Ownership and licensing

The miner chooses the license at `finalize` time and it is carried through to
the Irys tags:

| Tag | Value |
|-----|-------|
| `App-Name` | `OpenResearch AutoResearch` |
| `Artifact-Role` | `minerTrace` |
| `SHA-256` | lowercase hex of the bundle bytes |
| `Owner` | the miner's base58 public key |
| `License` | the miner's SPDX identifier, or `unlicensed-private` |
| `Trial-Id` | the trial the trace belongs to |
| `Schema-Version` | `1` |

Suggested license ids, from most permissive to least:

| Id | Effect |
|----|--------|
| `CC0-1.0` | public domain dedication; anyone may train on or redistribute the trace |
| `CC-BY-4.0` | reuse with attribution to the owner pubkey |
| `CC-BY-SA-4.0` | reuse with attribution, derivatives share alike |
| `CC-BY-NC-4.0` | attribution, non-commercial reuse only |
| `ODC-By-1.0` | database-oriented attribution license |
| `MIT` / `Apache-2.0` | familiar if the trace is mostly code |
| `unlicensed-private` | **default** — no reuse rights granted |

Any other SPDX-shaped identifier is accepted; the uploader warns that it is
outside the suggested set and uploads it as given.

`unlicensed-private` is the default so that a miner who finalizes without
thinking about licensing does not accidentally grant rights. Note what it does
and does not do: it asserts that no reuse rights are granted, but it does not
make the upload private. Irys objects are publicly readable. If a trace should
not be readable by anyone, do not upload it — keep it local, or delete it.

The `Owner` tag is an assertion signed by the uploading wallet, not a
protocol-enforced property right. It is the durable, machine-checkable claim
that this trajectory came from this miner. Use the same miner pubkey you use
for proposals if you want traces and proposals to be attributable to one
identity; use a different key if you would rather not link them.

## Usage

```bash
export ARAH_TRACE_ENABLED=1
export ARAH_TRACE_OWNER="$(solana address -k ~/.config/solana/arah-mine-<project_id>.json)"

# During the trial, after each agent turn:
python3 scripts/capture_trace.py append \
  --repo-root /path/to/repo --trial-id <trial_id> \
  --type prompt --role user --text "tune the batch scheduler"

python3 scripts/capture_trace.py append \
  --repo-root /path/to/repo --trial-id <trial_id> \
  --type tool_result --tool-name run_trial --text-file /path/to/stdout.log

# End of trial:
python3 scripts/capture_trace.py finalize \
  --repo-root /path/to/repo --trial-id <trial_id> \
  --agent my-coding-agent --model my-model \
  --license CC-BY-4.0
```

Inspect before publishing (works whether or not capture is enabled):

```bash
python3 scripts/capture_trace.py status --repo-root /path/to/repo --trial-id <trial_id>
node scripts/upload_trace_irys.mjs --repo-root /path/to/repo --trial-id <trial_id> --dry-run
```

Publish, explicitly:

```bash
node scripts/upload_trace_irys.mjs \
  --repo-root /path/to/repo \
  --trial-id <trial_id> \
  --keypair ~/.config/solana/arah-mine-<project_id>.json \
  --yes
```

The uploader verifies the bundle SHA-256 against `trace.json` before spending
anything, funds the Irys node only for the exact byte count, writes
`upload_trace_irys.json` next to the bundle, and updates `trace.json`'s
`upload` block to `uploaded` (or `failed`, with the error).

Irys upload requires `@irys/upload` and `@irys/upload-solana`. Run
`npm install` at the skill repository root once if they are missing.

## Deleting local traces

Traces are plain files under the target repo. They are the miner's to remove at
any time, before or after an upload.

```bash
# One trial:
python3 scripts/capture_trace.py purge --repo-root /path/to/repo --trial-id <trial_id> --yes

# Every trace in this repo:
python3 scripts/capture_trace.py purge --repo-root /path/to/repo --all --yes

# Equivalent, by hand:
rm -rf /path/to/repo/.autoresearch/mine/traces
```

`purge` works whether or not capture is enabled, and prints the directories it
would remove if `--yes` is omitted.

Deleting locally does **not** retract an upload. Irys objects cannot be
unpublished; a mainnet upload is permanent and a devnet upload persists for the
devnet retention window. Treat `--yes` as irreversible.

Keep `.autoresearch/` out of commits — it holds run logs, trials, and now
traces, none of which belong in the target repository's history.

## Exit codes

| Script | Codes |
|--------|-------|
| `capture_trace.py append` | 0 appended **or** capture disabled; 1 bad args / IO. |
| `capture_trace.py finalize` | 0 finalized **or** capture disabled; 1 bad args / no events / bad license / IO. |
| `capture_trace.py status` | 0; 1 bad args / IO. |
| `capture_trace.py purge` | 0 deleted; 1 missing `--yes` or IO. |
| `upload_trace_irys.mjs` | 0 uploaded or `--dry-run`; 1 missing `--yes` / hash mismatch / missing deps / upload failure. |
