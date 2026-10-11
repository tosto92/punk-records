---
name: previously-episodes
description: Look up the user's past Claude Code, Codex and OpenCode sessions ("episodes") across all projects - timeline, where they left off per project, the prompts of one session, and the exact resume command. Use when the user asks where they left off, what they worked on (today, yesterday, this week, on project X), to find a past session about a topic, or how to resume one.
---

# Previously on localhost — episodes

`previously episodes` keeps a SQLite index of every Claude Code, Codex and OpenCode
session: project, branch, title, the prompts the user typed, timestamps. Every
call syncs incrementally first, so it is always current. It only reads the
agents' own session files and OpenCode database and never modifies them. Output is plain text when piped.

If `previously` is not on PATH, use `node <absolute path to bin/previously> episodes`.

## Commands

| Need | Command |
|---|---|
| Recent episodes + resume command | `previously episodes [filter] -n 20` |
| Timeline day → project → episodes | `previously episodes timeline [filter] -d 7` |
| Per project: where the user left off | `previously episodes projects [filter]` |
| Every prompt of one episode | `previously episodes show <id-or-8-char-prefix>` |
| Web UI (the user runs it) | `previously serve` → http://127.0.0.1:4400/episodes |

`filter` is a case-insensitive substring matched on project path, title,
branch, and first/last prompt.

## Ad-hoc SQL

`sqlite3 -header -column ~/.local/share/previously/episodes.db "<query>"`
(the directory follows `PREVIOUSLY_HOME`). Run `previously episodes` once first
so the index is current.

- `sessions(id, tool, cwd, project, branch, title, file, file_mtime)`: `project`
  is `cwd` with worktree suffixes removed.
- `prompts(session_id, ts, text)`: `ts` is unix epoch seconds.
- view `v`: `sessions.*` plus `started, ended, n, first, last`.

Full-text search over prompts:

```sql
SELECT date(p.ts,'unixepoch','localtime') d, s.project, s.title, s.id
FROM prompts p JOIN sessions s ON s.id=p.session_id
WHERE p.text LIKE '%keyword%' ORDER BY p.ts DESC LIMIT 20;
```

## Recipes

- **Where did I leave off on X?** `previously episodes projects X`, then
  `previously episodes show <id>` on the latest episode. Summarize the last few
  prompts and give the resume command.
- **What did I do yesterday / this week?** `previously episodes timeline -d 2`
  (or `-d 7`); write a short per-project summary from titles and prompt counts
  instead of pasting the raw output.
- **Find the session where I talked about Y.** Run the full-text SQL above,
  then `previously episodes show` on the best hit.
- `show` lists only the user's prompts. For the agent's side, `sessions.file`
  is a JSONL transcript for Claude/Codex (read only its tail) or OpenCode's SQLite database.
- Always end with the exact resume command (`cd <cwd> && claude --resume <id>`
  or `codex resume <id>` or `opencode --session <id>`).
