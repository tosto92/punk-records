# Changelog

## 0.1.0 — unreleased

First public release as Punk Records. New installs use Punk Records IDs and
paths; the `previously` command and existing memory stores remain compatible.

- Recall: memories matching the prompt are injected before each turn
  (Claude Code, Codex, OpenCode).
- Automatic draft at the end of each turn, listing the files
  the session edited.
- `punk-records save / ask / build / check / graph / migrate`, MCP server
  (`memory_find`, `memory_save`, `memory_freshness`), skill and
  `/punk-records-save` command (legacy `/previously-save` alias).
- `punk-records episodes`: index of past Claude Code and Codex sessions with
  resume commands, plus a local web page and skill.
- Plugins for Claude Code and Codex; `punk-records init` for every agent.
