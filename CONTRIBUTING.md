# Contributing

Thanks for helping. Ground rules:

- **Zero runtime dependencies.** Node standard library only (Python standard
  library for `sessions`). A dependency needs a very good reason.
- **Never block the agent.** The `punk-records hook` entrypoint always exits 0; a broken memory
  store must degrade to "no recall", not to a failed turn.
- **Never touch what isn't ours.** `init` merges into config files that belong
  to the user and to other tools: manage only our `punk-records` entries and
  owned legacy `previously` entries; preserve foreign entries.
- **Tests with every change.** `npm test` runs everything that needs no agent.
  Live agent smoke tests run when `CLAUDE_BIN` / `CODEX_BIN` (and the OpenCode
  variables in `tests/opencode-smoke.test.js`) point at real binaries.
- **Agent behaviour is verified, not assumed.** When a change relies on how
  Claude Code, Codex or OpenCode behave, update the operational compatibility
  guidance when its contract changes. Keep plans, investigations and execution
  reports outside tracked files.

Keep pull requests small and focused; describe how you tested them.
