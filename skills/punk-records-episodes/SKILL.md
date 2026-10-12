---
name: punk-records-episodes
description: Use when the user asks where they left off, what they worked on (today, yesterday, this week, or on a project), wants to find a past Claude Code, Codex or OpenCode session, or needs its resume command.
---

# Punk Records — episodes

`punk-records episodes` keeps a SQLite index of every Claude Code, Codex and OpenCode
session: project, branch, title, the prompts the user typed, timestamps. Every
call syncs incrementally first, so it is always current. It only reads the
agents' own session files and OpenCode database and never modifies them. Output is plain text when piped.

If `punk-records` is not on PATH, use `node <absolute path to bin/punk-records> episodes`.

## Commands

| Need | Command |
|---|---|
| Recent episodes + resume command | `punk-records episodes [filter] -n 20` |
| Timeline day → project → episodes | `punk-records episodes timeline [filter] -d 7` |
| Per project: where the user left off | `punk-records episodes projects [filter]` |
| Every prompt of one episode | `punk-records episodes show <id-or-8-char-prefix>` |
| Web UI (the user runs it) | `punk-records serve` → http://127.0.0.1:4400/episodes |

`filter` is a case-insensitive substring matched on project path, title,
branch, and first/last prompt.

## Ad-hoc SQL

`sqlite3 -header -column ~/.local/share/punk-records/episodes.db "<query>"`
(use `~/.local/share/previously` for an existing store; `PUNK_RECORDS_HOME` and legacy `PREVIOUSLY_HOME` override the directory). Run `punk-records episodes` once first
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

- **Where did I leave off on X?** `punk-records episodes projects X`, then
  `punk-records episodes show <id>` on the latest episode. Summarize the last few
  prompts and give the resume command.
- **What did I do yesterday / this week?** `punk-records episodes timeline -d 2`
  (or `-d 7`); write a short per-project summary from titles and prompt counts
  instead of pasting the raw output.
- **Find the session where I talked about Y.** Run the full-text SQL above,
  then `punk-records episodes show` on the best hit.
- `show` lists only the user's prompts. For the agent's side, `sessions.file`
  is a JSONL transcript for Claude/Codex (read only its tail) or OpenCode's SQLite database.
- Always end with the exact resume command (`cd <cwd> && claude --resume <id>`
  or `codex resume <id>` or `opencode --session <id>`).
