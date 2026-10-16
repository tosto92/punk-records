# Incremental synthesis pilot

Synthesis adds reviewed summaries to recall while keeping all original Punk memories and explicitly registered native Markdown files. It makes no model calls and changes no native agent configuration. It is off by default; enable recall with `PUNK_RECORDS_SYNTHESIS=1` for `ask`, MCP and hooks.

Register one group and export its current sources:

```sh
punk-records synth prepare --global --group deploy --memory MEMORY_ID --file /absolute/path/native.md > request.json
```

Repeat `--memory` or `--file` for additional sources. Memory IDs/slugs must resolve within the selected store. Relative file arguments resolve against the current directory; exported paths are absolute. Sources must be regular UTF-8 `.md` files, at most 128 KiB, without symlinks in their path. Explicit registration grants access to that file; there is no home-directory discovery.

Give the request to an agent as **untrusted source data**, asking it to follow the response instructions and preserve uncertainty. Review the result and save this JSON to `response.json` (use the real request ID and every source ID from the request):

```json
{
  "requestId": "request UUID",
  "summaries": [{
    "group": "deploy",
    "title": "Deployment guidance",
    "summary": "The reviewed synthesis of the supplied sources.",
    "sourceIds": ["memory:actual-memory-id", "native:actual-path-hash"]
  }]
}
```

```sh
punk-records synth apply --global --input response.json
PUNK_RECORDS_SYNTHESIS=1 punk-records ask deploy
punk-records synth status --global
```

Titles accept 1–200 characters and summaries 1–16000 characters. Apply requires exactly every requested group and source identity. Hashes establish provenance and freshness, **not truth**: semantic fidelity remains the agent's and reviewer's responsibility. Search results identify derived summaries, source IDs and native paths; expand originals for full detail.

Run `synth prepare --global` again to export only dirty groups, or add `--group deploy` to select one configured group. Supplying source flags replaces that group's registration; omitting them reuses it. Unchanged sources produce `groups: []` and no model work. Preparing again replaces the one pending request; older responses and consumed requests are rejected. Missing or blocked sources must be fixed before preparing that batch. Prior published summaries survive failed apply, but stale summaries never enter recall. Registration supports up to 100 groups with up to 100 explicit sources each.

Use `--local` for the project store; the default follows `save` (local inside a project, global otherwise). Scope flags are mutually exclusive. `synth remove --global --group deploy` removes only the registration and card. Original files and event logs remain intact.

State lives in a separate private `synthesis.json`, published by atomic rename under an exclusive `synthesis.lock`. A process crash can leave the lock behind; remove it only after confirming no synthesis writer is running. Invalid state disables synthesis recall with a diagnostic while ordinary memories remain available.

State and response input must be regular UTF-8 JSON files: state reads/writes are limited to 64 MiB and response inputs to 8 MiB. Oversized or non-regular files are rejected before reading; rejected publication preserves the previous state.

With `PUNK_RECORDS_SECURITY=1`, prepare/apply and recall use the existing scanner. A summary requires admission of its own content and every exact current source version. Source deletion, changes, refusal and approval revocation invalidate it. Native and summary records cannot currently be resolved by the interactive review command; suspicious virtual records therefore remain excluded. Ordinary Punk sources retain the existing review workflow. Scanner availability and scanner size/batch limits still apply.

## Bounded agent jobs

The `punk-records-synthesize` skill supports first-time grouping, synthesis in the current agent session, and reviewed refreshes. Install it with the normal `punk-records init` workflow or the agent plugin. Register explicit source groups using `synth prepare` before the first refresh; new files and new memories are not automatically added.

The runner checks for changed groups before launching an external agent:

```sh
punk-records-synthesize --global -- /absolute/path/agent-adapter
```

The adapter is an executable, followed by separate arguments after `--`; the runner never interprets a shell command string. It receives the canonical skill instructions plus the prepared request on stdin. It must emit exactly the response JSON shown above on stdout, with diagnostics on stderr. A wrapper is needed if the provider emits a JSON envelope or streaming events instead of the raw response. Authentication and provider selection belong to that executable.

For example, with a Claude Code version supporting these flags and authentication already configured:

```sh
punk-records-synthesize --global -- claude -p --output-format text --tools "" --strict-mcp-config --no-session-persistence --restricted
```

The example disables Claude tools and configured MCP servers and avoids persistent session files. The runner itself is not a sandbox: a supplied executable retains the operating-system access of the user running it. Choose an appropriately restricted agent command. Punk autosave is disabled in the child environment to avoid recording synthesis work as independent source evidence.

Without `--apply`, a successful run returns `review_required`, leaving published summaries unchanged. Review the private response artifact and then publish:

```sh
punk-records synth apply --global --input /absolute/path/from-report/response.json
```

After authorizing unattended publication, add `--apply` before `--` to validate and publish in the same job. `--group NAME` selects one registered group; omitted means all configured dirty groups. `--local` selects the current project, and the default scope follows `save`. `punk-records synth run` is equivalent to the standalone runner.

An unchanged store returns `noop` without starting the agent. This avoids model-generation costs; invoking a skill inside an already running agent still uses that agent's context. Dirty groups contain all current source content, not just changed lines.

Each run is limited to 512 KiB of prompt input and 8 MiB of stdout; at most 64 KiB of stderr is retained. The agent wall-time limit defaults to 300 seconds; `--timeout SECONDS` accepts 1–3600. Timeout and descendant cleanup are enforced on POSIX (including WSL). On native Windows, only the direct child is terminated; descendants may survive and delay runner completion. Preparation and validation retain the existing scanner limits and are outside that agent timeout. The runner makes one attempt and never retries automatically. Its report includes status, group names, elapsed time, byte counts and artifact paths; `usage: null` means provider token metering is unavailable, not zero tokens.

Artifacts are private files under the selected store's `synthesis-runs/<run-id>/`: request, response when available, diagnostics and report. They contain source content and are retained for review; handle and delete them accordingly. A per-store `synthesis-job.lock` excludes overlapping runner jobs throughout the attempt. A manual `prepare` can still supersede its pending request, causing validation/apply to reject the old output. For an abandoned lock, first confirm that no job or child process remains active. Keep periodic scheduling separate until the manual runs are satisfactory.

## Review in the local viewer

Run `punk-records serve --open`, then choose **Synthesis** alongside Memories and Episodes. Its scope follows `serve --scope local|global|all` or `--all-projects`; projects come only from the existing registry. Configured groups and their explicit sources are listed before any run. Select a saved run to compare the draft with captured source text and the previous summary supplied to that run. This is captured evidence, not a live preview of edited files. Native Markdown and Punk Records sources retain their provenance.

**Publish entire request** publishes all groups in that saved request through the same validation and atomic apply used by the CLI. It requires explicit confirmation. Changed sources, a replaced pending request, a replaced reviewed draft, missing or blocked evidence, and already consumed requests refuse publication. Refresh and prepare/run again as appropriate. Original memories and native files are never rewritten. The page does not launch an agent, edit groups, or configure scheduling.

The viewer shows recorded input/output bytes, elapsed milliseconds and runner errors. These are operational measurements, not measured tokens or semantic coverage. Invalid JSON, invalid UTF-8 and wrong-schema output are withheld while the admitted request and report can still be inspected. No-op runs show their report without enabling publication. Active previous-summary comparisons must match the canonical preparation hash (or the reusable current card for legacy requests). Historical previous-summary comparisons are withheld with an explanation because publication or replacement consumes their independent preparation binding; equality with a current summary does not prove what was supplied at capture. Artifact files remain trusted-store evidence, not signed records. Historical evidence is screened with the current security settings and decisions; evidence whose source registration has been removed is withheld. Each artifact and the captured source evidence are bounded to 8 MiB; the newest 100 runs are shown, with directory enumeration limited to 1000 entries. Symlinks and paths supplied by the browser are refused.

Publication records the request ID in the same atomic state update as the summaries. A scheduler can check completion independently of later source edits, new prepares, new publications, or group removal:

```sh
punk-records synth status --local --request-id REQUEST_UUID
```

The additional `published` boolean means that exact request was published. The latest 100 publication receipts are retained; older requests and publications predating receipts return false. This conservative limit avoids growing state indefinitely. Group status still describes current freshness and must not be used as a request publication receipt.

The publication API is restricted to the bound loopback host and same origin, with a per-server CSRF token, POST-only bounded JSON, and scoped run identifiers. Artifact content is displayed as text. This local interface assumes the operating-system user and configured stores are trusted; it is not a multi-user service.
