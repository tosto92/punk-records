# Claude Code and Codex hooks

Install shared hooks and skills with:

```sh
punk-records init --global --agents claude,codex
```

For a project initialized before the global installation, run `punk-records init`
from that project to reconcile redundant local handlers. Use `--dry-run` to inspect
the changes first. Custom or ambiguous handlers can require manual reconciliation.

## Codex

- **F1 — Project configuration:** project `.codex/hooks.json` hooks depend on the
  project configuration being trusted.
- **F2 — Duplicate delivery:** matching global and project handlers can both run;
  keep one managed registration per event.
- **F3 — Recall context:** `UserPromptSubmit` uses
  `hookSpecificOutput.additionalContext` for automatic recall. A successful hook
  process does not prove that the model used its output.
- **F4 — File edits:** the supported event is `apply_patch`, with the patch in
  `tool_input.command` and relative paths resolved against the event's `cwd`.
- **F5 — Hook trust:** new or changed commands can require approval in Codex's
  `/hooks` interface. Initialization does not approve commands or rewrite trust.

## Claude Code

Automatic recall uses `UserPromptSubmit`. `SessionStart` supplies static workflow
guidance. Supported successful edit events feed draft capture; `Stop` attempts
the save. A session without recorded supported edits does not produce a useful
activity draft automatically. Shell writes may not be recorded as file edits.

Global initialization configures the current user. Local initialization reconciles
only the selected project; it does not scan every repository or remove arbitrary
third-party hooks. Keep custom timeouts and wrappers under explicit review.

## Runtime checks

Run the opt-in smoke tests with explicit client paths in an isolated environment:

```sh
CLAUDE_BIN=/absolute/path/claude CODEX_BIN=/absolute/path/codex node --test tests/agent-smoke.test.js
```

The tests create temporary configurations and use model calls. Passing confirms
the tested client behavior, not universal compatibility with future releases.
OpenCode plugin compatibility is documented in [its own guide](opencode-compatibility.md);
native session learning has separate [acquisition and coverage rules](deferred-learning.md).
