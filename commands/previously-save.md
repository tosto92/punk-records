---
description: Save a reusable session outcome to Punk Records via `punk-records save`
---

You are saving a memory with Punk Records. Collect from the user (or infer from the session, and confirm):

- **type** — `solved` | `attempt_failed` | `decision` | `note`
- **title** — short slug-like summary (required for a new memory, omitted when updating)
- **symptoms** — what was observed (errors, behavior)
- **solution** — what fixed it / what was decided
- **attempt** — failed approaches (repeatable; include at least one if relevant)
- **files** — files/paths involved (repeatable, comma-split)
- **tags** — comma-separated keywords
- **outcome** — `open` | `partial` | `ok` (optional)

Then run:

```bash
punk-records save \
  --type "<t>" \
  --title "<s>" \
  --symptoms "<s>" \
  --solution "<s>" \
  --attempt "<a>" \
  --files "<f1>,<f2>" \
  --tags "<a,b>"
```

If `punk-records` is not on PATH, use `node <absolute path to bin/punk-records>` with the same flags, or
the MCP tool `memory_save`. Same for recall: `punk-records ask "<question>"` or `memory_find`.

## Update an existing memory

Omit `--title` and `--type`; identify the memory with `--ref <slug|memoryId>`.
Omitted fields are inherited from the target, so adding a solution later is enough:

```bash
punk-records save --ref <slug> --type solved --solution "<what worked>" --outcome ok
```

## Promote an automatic draft

Idle sessions leave a draft titled `<Agent> session <id>` with `tags: auto` and
`outcome: open` (Agent: OpenCode, Claude Code or Codex). The ref is the draft's slug—`punk-records ask` prints it—formed by lowercasing and replacing non-alphanumerics with `-`. Promote it instead of writing a new memory:

```bash
punk-records save --ref opencode-session-<id> --type solved --solution "<what worked>"
```

## After saving

`punk-records ask` reads the event log live, so the new memory is findable immediately.
`punk-records build` only refreshes the derived Markdown/index for browsing and sharing;
`punk-records check` reports staleness. Legacy pre-identity events can be upgraded with
`punk-records migrate` (preview by default, `--apply --expected-source <sha256>` to write,
`--refs <file.json>` to resolve ambiguous titles). Stop other writers before applying.
