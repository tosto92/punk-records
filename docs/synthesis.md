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
