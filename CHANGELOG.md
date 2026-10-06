# Changelog

## 0.1.0 — unreleased

First public release.

- Recap: memories matching the prompt are injected before each turn
  (Claude Code, Codex, OpenCode).
- Cliffhangers: an automatic draft at the end of each turn, listing the files
  the session edited.
- `previously save / ask / build / check / graph / migrate`, MCP server
  (`memory_find`, `memory_save`, `memory_freshness`), skill and
  `/previously-save` command.
- `previously episodes`: index of past Claude Code and Codex sessions with
  resume commands, plus a local web page and skill.
- Plugins for Claude Code and Codex; `previously init` for every agent.
