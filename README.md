# Previously on localhost

> Previously, on your repo…

Session memory for coding agents. Before each turn the agent gets a **recap**
of what past sessions learned in this project, the way a TV show opens with
"previously on…". Works with Claude Code, Codex and OpenCode. Node only, zero
dependencies, no LLM calls, no API key.

| Show term | What it is |
|---|---|
| recap | memories injected automatically when a prompt matches |
| spoiler | a saved memory: the fix, the decision, the attempt that failed |
| cliffhanger | the draft saved automatically at the end of a turn |

## Use

```sh
previously init --global          # hooks, MCP server and skill for every agent
previously init                   # in a repo: project memory under memory/
previously save --type solved --title "…" --symptoms "…" --solution "…"
previously ask "<symptoms or file names>"
previously graph                  # browse memories in a local web viewer
```

Memories are an append-only `events.jsonl`: per repo in `memory/` (commit it to
share with your team) and global in `~/.local/share/previously`.

See `docs/` for the verified behaviour of each agent.

## Test

```sh
node --test
```

## License

MIT, see `LICENSE`. The web viewer in `lib/viewer/` is third-party MIT code
and keeps its own license file.
