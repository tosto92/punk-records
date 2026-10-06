---
name: previously
description: Save and recall reusable session knowledge with Previously on localhost. Use when a session fixes a bug, makes a technical decision, finds a workaround, learns a repo gotcha, or hears a lasting user preference; also use when facing an error, unfamiliar code, or asking "have we seen this before".
---

# Previously on localhost

Cross-session memory for coding agents. Two habits: **recall first**, **save what generalizes**.

## Recall (do this first)

When you face an error, unfamiliar subsystem, or a "have we seen this" moment,
search before exploring from scratch:

```bash
previously ask "<symptoms + file names>" --limit 5
```

If `previously` is not on PATH use `node <absolute path to bin/previously>`, or the MCP tool
`memory_find({ query, limit, scope })`.

Good queries include error text AND involved files (file overlap is weighted).
Results are labeled `[repo]` (this project) or `[global]` (user-level, all repos).
Each hit shows solution + `covers: file:line` hints (best-effort, may be stale).

Session auto-recall may already inject top hits — still run `previously ask` yourself
when the injected hits miss.

## Save (when it generalizes)

Save when the session produced something a future session would reuse:

- a non-trivial bug was fixed (symptoms + fix, plus what did NOT work);
- a technical choice was made between alternatives (why this one);
- a workaround for a broken environment/tool was found;
- the user stated a lasting preference or method;
- a repo-specific gotcha was learned the hard way.

Do NOT save: trivial one-offs, what is already recorded (ask first),
secrets/credentials, or play-by-play of the session.

Write memories as facts, never as orders to a future agent: recalled memories are
injected into later sessions automatically. A tool or permission limit is a fact
like any other ("deleting ES indices is blocked in auto mode; the user decides and
runs it"), not instructions for how an agent should work around it.

One memory per reusable unit. Fields that matter most:

```bash
previously save --type solved \
  --title "<short summary>" \
  --symptoms "<how to recognize this next time>" \
  --solution "<what worked>" \
  --attempt "<what failed (repeatable)>]" \
  --files "<involved paths>" \
  --tags "<keywords>"
```

`--type`: `solved` | `attempt_failed` | `decision` | `note`.
Scope: repo-local is the default (project facts). A project is a git repo or,
without git, a folder marked by `previously init --local` (it writes `.previously`). `--global` for methods and
preferences valid in every repo. MCP equivalent: `memory_save({...})`.

`--outcome` is `open` | `partial` | `ok`; omit it and a complete `solved` becomes
`ok`, anything else stays `open`. Only `ok` memories get the small ranking bonus.

To update instead of creating a memory, pass `--ref <slug|memoryId>` and leave out
`--title`/`--type`: omitted fields are inherited from the target.

## Drafts

Every agent session auto-saves one draft (`tags: [auto]`, `outcome: open`) listing
the files it wrote, titled `<Agent> session <id>` where Agent is `OpenCode`,
`Claude Code` or `Codex`. Drafts surface in recall but never outrank curated
memories. Promote a good draft into a real memory instead of writing from scratch.
The ref is the draft's slug—`previously ask` prints it—formed from the title by lowercasing
and replacing non-alphanumerics with `-`: `opencode-session-<id>`, `claude-code-session-<id>`,
or `codex-session-<id>`.

```bash
previously save --ref claude-code-session-<sessionID> --type solved --solution "<what worked>"
```

Ignore bad drafts; they are cheap.

## Live read vs derived files

`previously ask` reads the event log directly: a memory you just saved is searchable
immediately, with no build step and no writes. `previously build` only regenerates the
derived Markdown/index (for browsing and sharing); `previously check` reports staleness.

Events written before persistent memory IDs can be upgraded with `previously migrate`:
it prints a preview, needs `--apply --expected-source <sha256>` to write, and takes
`--refs <file.json>` when a legacy title is ambiguous. Stop other writers first —
the checksum is not a lock.
