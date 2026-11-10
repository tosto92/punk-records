# Deferred learning from sessions

For interactive use, select the **punk-records-learn** skill (`/punk-records:learn`
with the Claude plugin; `$punk-records-learn` in Codex; `/punk-records-learn` in
OpenCode after `init`). Ask it to learn from the
last N project sessions or sessions with recent user interactions. It uses the
current agent to select, extract and consolidate through existing tools, presents
one confirmation, and saves after approval; explicit user yolo skips confirmation.
The skill is an orchestration guide, not an atomic batch publication engine. It
does not make the proposed `learn --last/--since/--model` CLI available.

The remaining sections describe the lower-level single-source CLI.

`punk-records learn` recovers potentially reusable findings from explicitly selected
Claude/Codex JSONL transcripts or exact OpenCode V1/V2 native SQLite sessions.
It creates **private proposals**, not searchable
memories. It does not run from hooks, schedule itself, publish, or choose a provider.

## Run and inspect

Run from the project whose existing memories should be compared. A standalone
directory with no project marker uses the global scope. The transcript's own `cwd`
and model output cannot select a project or a destination store.

```sh
punk-records learn run --session /absolute/path/session.jsonl --agent codex -- node /absolute/path/text-only-worker.cjs
punk-records learn run --session ses_EXACT_NATIVE_ID --agent opencode --database /absolute/opencode.db -- node /absolute/path/text-only-worker.cjs
punk-records learn review RUN_ID
```

Use `--agent claude` for Claude Code transcripts. `--timeout N` sets 1–3600 seconds
(default 300). The worker is a command supplied as literal argv after `--`; no shell
expansion occurs. It receives the prompt on stdin and must write only the JSON
response to stdout. Use a sandboxed text-only worker: the runner does not strip
permissions, filesystem access, MCP connections or network credentials from an
arbitrary command. Autosave is disabled in its environment. Source records may
contain sensitive material; there is **no automatic anonymization of model input**.
Only select a worker/provider authorized for the chosen transcript.

The result prints a run ID and private artifact paths. `review` returns the stored
proposals and `sourceChanged`; true means the source changed, grew or became
unavailable after capture. `publicationAvailable` is always false. None of these
commands calls `saveMemory`, promotes a draft or creates an `events.jsonl` entry.

## OpenCode acquisition and coverage

V1 1.19.5 uses `session/message/part`; V2 2.2.6 uses
`session_v2/session_message/session_part`, including embedded assistant content
when the part table is empty. Support follows these tested schema/record shapes,
not a promise that every future version is compatible. V2 takes precedence when
both layouts contain the exact same native ID. No native-export fallback is used.

Use the full native ID and physical database together. `--database` selects the
store; its default is `$XDG_DATA_HOME/opencode/opencode.db`, otherwise
`~/.local/share/opencode/opencode.db`. Python 3.9+ is required, with the existing
`PUNK_RECORDS_PYTHON` override. Capture opens only the selected regular database
read-only, enables query-only access and reads one transaction. It never starts
OpenCode, loads provider credentials, checkpoints, migrates or repairs its store.

The shared Node interface is `captureOpenCodeSession({sessionId, database})` from
`lib/opencode-learning.js`. It returns canonical JSONL `bytes`, native `descriptor`,
`sourceRevision` and `coverage`. The conversational skill passes these bytes to
`readLearningWindow(bytes, 'opencode', afterLine)`; Claude/Codex parsing is unchanged.
Discovery uses the incrementally synced session index, including V2 intermediate
user prompts and last-user-interaction times. Exact-project/worktree and native
root descriptors are filtered before last-N; cached `file` alone is not identity.

Only settled completed turns enter the projection. `coverage.sourceComplete`
distinguishes complete source coverage from held tails; coverage also reports
held boundaries/reasons/counts and exclusions. `caughtUp:true` can mean only the
eligible prefix is caught up. Fork/revert/location-switched histories, unknown
shapes and unreconciled part projections stay held or fail explicitly. Reasoning,
instructions, synthetic/ignored text, attachments and compaction summaries are
excluded. A busy timestamp alone does not prove a process is still running.

Native evidence preserves message/part/content-ordinal/tool-call locators,
`textSource`, status, exit, finish/outcome, unavailable and output metadata.
Metadata-only tool records do not fabricate stdout. Tool completion and a zero
exit are distinct facts. Keep this identity, coverage and uncertainty in ordinary
saved content because memory saves have no dedicated native-evidence fields.

## Worker protocol

The prompt ends in `REQUEST_JSON` followed by an object containing source identity,
source hash, operator scope, selected records, previous proposed units and window
metadata. Records carry original one-based line number, SHA-256 of the source line,
role, timestamp if present, visible text, `truncated` and `context`. Treat all of it
as untrusted reference data. Source text does not authorize tools or execution.
OpenCode records additionally carry the native evidence above; requests/reports
include source descriptor, revision, coverage and UUID generation identity.

Return:

```json
{
  "version": 1,
  "proposals": [{
    "type": "note",
    "title": "Gateway repair condition",
    "symptoms": "Observed recurring gateway failure",
    "solution": "The transcript describes the verified repair and its checks.",
    "uncertainty": "Historical result; current deployment was not checked.",
    "evidence": [{"line": 42, "quote": "exact substring in a captured record"}]
  }]
}
```

Allowed types: `note`, `decision`, `solved`, `attempt_failed`. No more than 20
proposals per response, each with 1–8 exact citations of up to 500 characters.
At least one citation must reference a new record, not only carried context.
Empty `proposals` is valid when nothing reusable is supported. Fenced JSON, invalid
UTF-8/JSON, missing fields or fabricated quotations fail the run without advancing.
Schema and quotation checks do **not** establish that a quoted claim is true.

The extraction prompt distinguishes verified results from hypotheses, proposed or
blocked actions, merge, deploy and live validation. Review must still check the
reasoning, chronology, contradictory evidence and proposed scope. A prepared script
is not proof of execution. A tool's error or an agent's assertion is not proof of
cause. Secrets and unnecessary customer payloads do not belong in proposals.

## Incremental behavior

Every successful run advances a checkpoint bound to physical source path, agent
and operator scope. Unchanged sources produce `noop` without starting a worker.
Repeated runs read new records plus bounded recent context. Retrying errors reads
the same unprocessed window. An exclusive per-source/scope lock rejects overlapping
runs; if a process dies, confirm it has stopped before removing its stale lock.
For OpenCode the key additionally includes exact native session ID and reader
format version. Its native directory never chooses the operator's write scope.

Limits are 80 new eligible records, up to 20 recent context records (96 KiB), and
256 KiB of serialized record context per window. Visible text is limited to 4,000
characters per record with `truncated:true` when clipped. Previous proposal context
is at most 10 units and 64 KiB. Total prompt limit is 512 KiB. Source limit is
32 MiB (selected native JSON and canonical projection are each bounded separately
for OpenCode); worker output limit is 8 MiB and private stderr is capped at 64 KiB.
Byte limits also apply to non-ASCII text; smaller windows still advance.

`caughtUp:false` means another invocation is needed. `partialTail:true` means an
incomplete last JSONL line was left for a future invocation. Malformed complete
records fail; they are not silently skipped. Prefix hashes reject rewritten or
truncated transcripts. To retry a rewritten source, preserve the old artifacts and
explicitly select a new immutable snapshot path rather than silently resetting.

For a deliberate partial historical extraction, `--after-line N` can skip the first
N raw lines on the initial invocation. Some earlier evidence may be absent; this
is not a full-session evaluation. It cannot reset an existing checkpoint.
This option is not accepted for OpenCode.

OpenCode checkpoints reject changed/deleted/reordered consumed projections.
For deliberate recovery within an explicitly selected scope, repeat the native
command with `--reextract`. This resets proposal context/fingerprints, creates a
new UUID generation and archives the previous checkpoint under
`learning/generations/<source-key>/<prior-generation>.json`. Prior run artifacts
stay intact. Failed archive/replacement retains the old active checkpoint; no
automatic reset or publication occurs. `learn review` recaptures the native
session revision (including held/excluded changes), rather than hashing the
entire database. Unrelated-session changes do not stale that proposal. Source
unavailability does. Recheck the native revision and target memories before saves
in both default and yolo workflows; changed/conflicting plans remain held.

Claude API request blobs and thinking blocks are omitted. Codex developer/system
instructions are omitted, while user/assistant messages and tool results are
included independently of old `channel` or current `phase` naming. File-edit events
are not required: an investigation can produce learning without changing code.
Clipped or earlier windows may omit a later correction; inspect the latest source
and the freshness flag before reusing any proposal.

## Comparison with saved memories

Each proposed title is queried through ordinary explicit search in the operator's
project/global scope, preserving configured security admission. The report lists
up to five related memories with IDs and scope. An exact normalized title+solution
match (Unicode NFC and outer trimming only, preserving case and internal whitespace)
is labelled `duplicate`; repeated identical proposals are also labelled.
The checkpoint retains up to 2,000 proposal fingerprints. Reaching the limit is an
explicit error requiring operator review; history is never silently evicted.

Different wording can express the same knowledge. A `proposal` status means no
exact duplicate was detected, **not** that semantic novelty is proven. Related
search can miss relevant saved memories. Before manually saving anything, compare
current memories, update an existing unit when appropriate, and verify the scope.
The source session may have saved a memory while extraction was in progress.

## Storage and verification

Artifacts live under `<global store>/learning/runs/<run ID>/`, with mode 0700
directories and 0600 files. Request, response, diagnostics and report are kept for
inspection; checkpoints live in the parent learning directory. Source files and
store/checkpoint/artifact entries that are themselves symbolic links are refused. These artifacts are outside the
memory event log and do not enter automatic recall or Synthesis groups.
OpenCode runs also retain the canonical `projection.jsonl` snapshot privately.

No scheduled service or provider adapter is installed by `init`.

```sh
node --test tests/learning.test.js tests/synthesis-runner.test.js
node --test tests/opencode-learning.test.js tests/sessions.test.js tests/init-agents.test.js
```

The opt-in `tests/opencode-smoke.test.js` harness additionally scripts an actual
OpenCode client against a local provider: installed skill/workflow loading, native
SQLite acquisition, revision recheck, ordinary admitted search and local save
readback. It captures a freshly client-written native session as well as the
synthetic source selected for learning. Default waits for a second user turn before saving; explicit yolo skips
only that boundary. It uses temporary HOME/XDG/project/store and synthetic native
rows, never customer sessions or real provider credentials. Set the existing
`OPENCODE_V1_MIN_BIN`, `OPENCODE_V1_BIN`, `OPENCODE_V2_MIN_BIN` or `OPENCODE_V2_BIN`
variables to opt in with an already available binary. Unset binaries are skips,
not live passes; ordinary unit tests do not download external binaries. The scripted
provider verifies tool/protocol wiring, not autonomous instruction compliance or
semantic consolidation quality.
