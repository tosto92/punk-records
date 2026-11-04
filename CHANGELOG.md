# Changelog

## 0.1.0 — unreleased

First public release as Punk Records. New installs use Punk Records IDs and
paths. Installation migration recognizes the previous names; runtime uses only
the canonical commands and variables.

- Recall: eligible memories matching the prompt are injected automatically;
  activity drafts and raw native Markdown sources are excluded from automatic
  recall. Explicit CLI/MCP search defaults remain unchanged.
- Activity drafts can be saved from successfully observed file edits. They are
  not guaranteed for every session and do not capture investigation-only
  findings; saving a reusable outcome remains an agent action.
- `punk-records ask "<query>" --full` returns JSON; MCP `memory_find` accepts
  `full: true` for an explicit full result.
- `punk-records save / ask / build / check / graph / migrate`, MCP server
  (`memory_find`, `memory_save`, `memory_freshness`), skill and
  `/punk-records-save` command.
- `punk-records sessions`: index of past Claude Code and Codex sessions with
  resume commands, plus a local web page and skill.
- Plugins for Claude Code and Codex; `punk-records init` for every agent.
- Optional incremental synthesis of explicitly selected memories and native
  Markdown sources, with a dedicated skill and bounded agent runner. Drafts
  require review by default; published summary recall is opt-in.
- **Synthesis** in `punk-records serve`: inspect source groups and saved runs,
  compare drafts with captured evidence, and publish an entire request with
  freshness checks. Publication receipts support external review-first jobs.

- Complete rebrand: canonical hooks, OpenCode plugin, session browser and skills;
  safe init migration of owned legacy configuration and storage.
- Canonical security rule names and detection of forged current memory tags;
  old approval records do not implicitly authorize the new rule set.
