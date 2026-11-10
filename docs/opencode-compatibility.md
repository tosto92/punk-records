# OpenCode API compatibility

Punk Records ships one plugin entry point, `.opencode/plugins/punk-records.ts`, that
exports a single default object: `{ id: "punk-records", server, setup }`.
The loader filename stays stable so an upgrade cannot load two copies of the plugin.

- `server(input)` serves OpenCode V1. It receives `{ directory }` and returns the
  hook map (`chat.message`, `experimental.chat.system.transform`,
  `tool.execute.after`, `event`).
- `setup(ctx)` serves OpenCode V2. It receives the plugin context and returns a
  cleanup function.

Both adapters share the same recall, save and capture code in `lib/`. The
adapters differ only in how they observe turns:

| Concern | V1 (`server`) | V2 (`setup`) |
| --- | --- | --- |
| Prompt text | `chat.message` | `ctx.session.hook("prompt")` |
| Recall injection | `experimental.chat.system.transform`, plain string in `system[]` | `ctx.session.hook("context")`, `{type:"text", text}` in `system[]` |
| Edited files | `tool.execute.after`, `args.filePath`, result `metadata.filepath` / `metadata.filediff.file` | `ctx.tool.hook("execute.after")`, `input.path`, result `output.target` / `output.files[].file` |
| Patch files | `apply_patch`, result `metadata.files[].file` | `patch`, result `output.files[].file` |
| Turn boundary | `session.idle` event | `ctx.session.wait({sessionID}, {signal})` in the background |
| Session scope | `session.created` `properties.info.directory` | `ctx.session.get({sessionID})` → `location.directory` |

The V2 write tool really does take `path` and report `output.target`, which is
why the tool-to-file mapping accepts both shapes rather than assuming the V1 one.

## Selecting the API

`punk-records init --opencode-api v1|v2` (default `v1`) decides the configuration layout:

- V1: `mcp["punk-records"]` with `enabled: true`.
- V2: `mcp.servers["punk-records"]` with `disabled: false`.

The version number is never guessed. If the existing `opencode.json` cannot be
parsed, or uses the opposite layout, init stops with an explicit error before
writing anything — foreign servers such as Graft are never converted silently.

## Runtime checks

`tests/opencode-smoke.test.js` is opt-in; ordinary `node --test tests/*.test.js`
skips runtime cases unless their binary paths are supplied. Each case isolates
config, data, credentials, caches and memory; the fake provider listens only on
loopback. V1 prepares pinned SDK dependencies using npm, without install scripts.

```sh
rtk proxy env \
  OPENCODE_V1_MIN_BIN=/absolute/path/to/opencode-v1-minimum \
  OPENCODE_V1_BIN=/absolute/path/to/opencode-v1 \
  OPENCODE_V2_MIN_BIN=/absolute/path/to/opencode-v2-minimum \
  OPENCODE_V2_BIN=/absolute/path/to/opencode-v2 \
  node --test tests/opencode-smoke.test.js
```

The cases alternate local and global installation to check both file-link and
MCP configuration layouts. Allow time for cold V1 dependency preparation.
