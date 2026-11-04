import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initRepo, hookCommand, CODEX_PROJECT_HOOKS } from "../lib/init.js";
import { MATCHERS } from "../lib/hook-tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "punk-records");
const SKILL = path.join(ROOT, "skills", "punk-records");
const COMMAND = path.join(ROOT, "commands", "punk-records-save.md");
const EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];
const CLAUDE_EVENTS = ["SessionStart", ...EVENTS];

// Throwaway HOME, stores and repo per test; agent dirs resolve inside HOME.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-agents-"));
  const repo = path.join(root, "repo"), home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PUNK_RECORDS_HOME", "PUNK_RECORDS_CONFIG", "PUNK_RECORDS_PLUGINS", "PUNK_RECORDS_SKILLS"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home, PUNK_RECORDS_HOME: path.join(root, "store"), PUNK_RECORDS_CONFIG: path.join(root, "oc.json"),
    PUNK_RECORDS_PLUGINS: path.join(root, "plugins"), PUNK_RECORDS_SKILLS: path.join(root, "oc-skills"),
  });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, home, read: (p) => JSON.parse(fs.readFileSync(p, "utf8")) };
}
const commandsOf = (config, event) => (config.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));

test('synthesis skills and compatibility links resolve for every agent', t => {
  const {repo,home,root} = sandbox(t);
  initRepo({cwd:repo});
  initRepo({cwd:repo,explicit:'global'});
  const bases = [path.join(repo,'.claude','skills'),path.join(repo,'.agents','skills'),path.join(root,'oc-skills'),path.join(home,'.claude','skills'),path.join(home,'.codex','skills')];
  for (const base of bases) for (const name of ['punk-records-synthesize','brainbrain','brainbrain-synthesize']) {
    assert.equal(fs.realpathSync(path.join(base,name)),path.join(ROOT,'skills',name));
    assert.match(fs.readFileSync(path.join(base,name,'SKILL.md'),'utf8'),new RegExp(`name: ${name}\\n`));
  }
  for (const name of ['punk-records-synthesize','brainbrain','brainbrain-synthesize']) assert.equal(fs.realpathSync(path.join(home,'.local','bin',name)),path.join(ROOT,'bin',name));
});

for (const name of ['punk-records','previously']) for (const environment of ['env = { PUNK_RECORDS_SYNTHESIS = "1", PUNK_RECORDS_SECURITY = "1", EXTRA = "literal $&" }',`[mcp_servers.${name}.env]\nPUNK_RECORDS_SYNTHESIS = "1"\nPUNK_RECORDS_SECURITY = "1"\nEXTRA = "literal $&"`]) {
  test(`Codex init preserves ${name} managed environment ${environment.startsWith('env') ? 'inline' : 'table'} and custom fields`, t => {
    const {repo} = sandbox(t), config = path.join(repo,'.codex','config.toml');
    fs.mkdirSync(path.dirname(config));
    fs.writeFileSync(config,`model = "keep"\n# ${name}:start\n[mcp_servers.${name}]\ncommand = "node"\nargs = ["/old/bin/${name}", "mcp"]\nstartup_timeout_sec = 20\n${environment}\n# ${name}:end\n`);
    initRepo({cwd:repo,agents:['codex']});
    const result = fs.readFileSync(config,'utf8');
    assert.match(result,/model = "keep"/); assert.match(result,/startup_timeout_sec = 20/);
    assert.match(result,/PUNK_RECORDS_SYNTHESIS = "1"/); assert.match(result,/PUNK_RECORDS_SECURITY = "1"/);
    assert.ok(result.includes('EXTRA = "literal $&"'));
    assert.ok(result.includes(JSON.stringify(BIN))); assert.doesNotMatch(result,/mcp_servers\.previously|# previously:/);
    assert.equal(initRepo({cwd:repo,agents:['codex']}).touched.includes('.codex/config.toml'),false);
    assert.equal(fs.existsSync(path.join(repo,'.agents','skills','punk-records-synthesize','SKILL.md')),true);
  });
}

test('Codex init preserves unfamiliar managed TOML with warning while installing skills', t => {
  const {repo} = sandbox(t), config = path.join(repo,'.codex','config.toml');
  fs.mkdirSync(path.dirname(config));
  const original = '# punk-records:start\n[mcp_servers.punk-records]\ncommand = "custom-wrapper"\nargs = ["--custom"]\nenv = { PUNK_RECORDS_SECURITY = "1" }\n# punk-records:end\n';
  fs.writeFileSync(config,original);
  const warnings=[]; t.mock.method(console,'error',line=>warnings.push(line));
  initRepo({cwd:repo,agents:['codex']});
  assert.equal(fs.readFileSync(config,'utf8'),original); assert.ok(warnings.some(line=>/managed.*left alone/.test(line)));
  assert.equal(fs.existsSync(path.join(repo,'.agents','skills','punk-records-synthesize','SKILL.md')),true);
});

test("repo init wires Claude Code: MCP, hooks, CLAUDE.md, skill, command", (t) => {
  const { repo, read } = sandbox(t);
  initRepo({ cwd: repo, agents: ["claude"] });
  assert.deepEqual(read(path.join(repo, ".mcp.json")).mcpServers["punk-records"], { type: "stdio", command: "node", args: [BIN, "mcp"] });
  const settings = read(path.join(repo, ".claude", "settings.json"));
  for (const e of CLAUDE_EVENTS) assert.deepEqual(commandsOf(settings, e), [hookCommand("claude", e)]);
  assert.equal(hookCommand("claude", "Stop"), "punk-records hook claude Stop");
  assert.equal(settings.hooks.SessionStart[0].matcher, undefined);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].timeout, 10);
  assert.equal(settings.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit");
  assert.match(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), /<!-- punk-records:start -->/);
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "skills", "punk-records")), path.join(ROOT, "skills", "punk-records"));
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "commands", "punk-records-save.md")), path.join(ROOT, "commands", "punk-records-save.md"));
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "skills", "punk-records")), SKILL);
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "skills", "punk-records-sessions")), path.join(ROOT, "skills", "punk-records-sessions"));
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "commands", "punk-records-save.md")), COMMAND);
  assert.equal(fs.existsSync(path.join(repo, "opencode.json")), false, "opencode not requested");
  assert.equal(fs.existsSync(path.join(repo, "AGENTS.md")), false, "AGENTS.md is for opencode/codex");
});

test("init upgrades MCP aliases and Codex while preserving duplicate Claude hooks", (t) => {
  const { root, repo, read } = sandbox(t);
  const legacyBin = path.join(root, "node_modules", "previously-on-localhost", "bin", "punk-records");
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: {
    previously: { type: "stdio", command: "node", args: [legacyBin, "mcp"] },
    foreign: { command: "foreign" },
  } }));
  const hooks = Object.fromEntries(EVENTS.map((event) => [event,
    [{ hooks: [{ type: "command", command: `punk-records hook claude ${event}` }] }]]));
  hooks.Stop.push({ hooks: [{ type: "command", command: "punk-records hook claude Stop" }] });
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ hooks }));
  fs.writeFileSync(path.join(repo, ".codex", "config.toml"),
    `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = [${JSON.stringify(legacyBin)}, "mcp"]\n# previously:end\n`);
  fs.writeFileSync(path.join(repo, "AGENTS.md"),
    "before\n<!-- previously:start -->\nold hints\n<!-- previously:end -->\nafter\n");

  const warnings = []; t.mock.method(console, "error", line => warnings.push(line));
  initRepo({ cwd: repo, agents: ["claude", "codex"] });
  const mcp = read(path.join(repo, ".mcp.json")).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ["foreign", "punk-records"]);
  assert.equal(mcp["punk-records"].args[0], BIN);
  const settings = read(path.join(repo, ".claude", "settings.json"));
  for (const event of CLAUDE_EVENTS) assert.deepEqual(commandsOf(settings, event), event === "Stop" ? [hookCommand("claude", event), "punk-records hook claude Stop"] : [hookCommand("claude", event)]);
  assert.ok(warnings.some(line => line.includes(path.join(repo, ".claude", "settings.json")) && /Stop.*duplicate|duplicate.*Stop/.test(line)));
  assert.match(fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.punk-records\]/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8"), /# previously:|\[mcp_servers\.previously\]/);
  const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, /^before\n<!-- punk-records:start -->/);
  assert.match(agents, /<!-- punk-records:end -->\nafter\n$/);
  assert.doesNotMatch(agents, /<!-- previously:start -->/);
  assert.deepEqual(initRepo({ cwd: repo, agents: ["claude", "codex"] }).touched, []);
});

test("init upgrades owned OpenCode MCP entries in both API formats", (t) => {
  const { root, repo, read } = sandbox(t);
  const legacy = { type: "local", command: ["node", path.join(root, "previously-on-localhost", "bin", "punk-records"), "mcp"] };
  const file = path.join(repo, "opencode.json");
  for (const api of ["v1", "v2"]) {
    fs.writeFileSync(file, JSON.stringify(api === "v1"
      ? { mcp: { previously: legacy, foreign: { command: ["other"] } } }
      : { mcp: { servers: { previously: legacy, foreign: { command: ["other"] } } } }));
    initRepo({ cwd: repo, agents: ["opencode"], opencodeApi: api });
    const mcp = read(file).mcp;
    const servers = api === "v1" ? mcp : mcp.servers;
    assert.deepEqual(Object.keys(servers).sort(), ["foreign", "punk-records"]);
    assert.deepEqual(servers["punk-records"].command, ["node", BIN, "mcp"]);
  }
});

test("init leaves an unrelated legacy MCP entry untouched", (t) => {
  const { repo, read } = sandbox(t);
  const file = path.join(repo, ".mcp.json");
  for (const foreign of [{ command: "node", args: ["/opt/unrelated/bin/previously", "mcp"] }, { command: "foreign", args: 42 }]) {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { previously: foreign } }));
    initRepo({ cwd: repo, agents: ["claude"] });
    assert.deepEqual(read(file).mcpServers.previously, foreign);
    assert.equal(read(file).mcpServers["punk-records"].args[0], BIN);
  }
});

test("init preserves a foreign canonical Claude MCP entry", (t) => {
  const { repo, read } = sandbox(t);
  const file = path.join(repo, ".mcp.json");
  const foreign = { command: "foreign", args: ["mcp"] };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { "punk-records": foreign,
    previously: { command: "node", args: [path.join(ROOT, "bin", "punk-records"), "mcp"] } } }));
  initRepo({ cwd: repo, agents: ["claude"] });
  assert.deepEqual(read(file).mcpServers["punk-records"], foreign);
  assert.ok(read(file).mcpServers.previously);
});

test("init preserves foreign MCP entries in both OpenCode layouts", (t) => {
  const { repo, read } = sandbox(t);
  const file = path.join(repo, "opencode.json");
  const foreign = { type: "local", command: ["node", "/opt/unrelated/bin/punk-records", "mcp"] };
  const unrelated = { type: "local", command: ["node", "/opt/unrelated/bin/previously", "mcp"] };
  for (const api of ["v1", "v2"]) {
    const servers = { "punk-records": foreign, previously: unrelated };
    fs.writeFileSync(file, JSON.stringify({ mcp: api === "v1" ? servers : { servers } }));
    initRepo({ cwd: repo, agents: ["opencode"], opencodeApi: api });
    assert.deepEqual(api === "v1" ? read(file).mcp : read(file).mcp.servers, servers);
  }
});

test("Claude hooks merge with foreign hooks and a second run touches nothing", (t) => {
  const { repo, read } = sandbox(t);
  const file = path.join(repo, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { permissions: { allow: ["Bash(ls)"] }, hooks: {
    Stop: [{ hooks: [{ type: "command", command: "numbat stop" }] }],
    PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "x" }] }] } };
  fs.writeFileSync(file, JSON.stringify(foreign, null, 4));
  initRepo({ cwd: repo, agents: ["claude"] });
  const merged = read(file);
  assert.deepEqual(merged.permissions, foreign.permissions);
  assert.deepEqual(merged.hooks.PreToolUse, foreign.hooks.PreToolUse);
  assert.deepEqual(commandsOf(merged, "Stop"), ["numbat stop", "punk-records hook claude Stop"]);
  const bytes = fs.readFileSync(file, "utf8");
  assert.deepEqual(initRepo({ cwd: repo, agents: ["claude"] }).touched, []);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("a malformed Claude config aborts init before any write", (t) => {
  const { root, repo } = sandbox(t);
  for (const [rel, body] of [[".claude/settings.json", '{"hooks": {"Stop": {"not": "an array"}}}'],
    [".claude/settings.json", '{"hooks": []}'], [".mcp.json", '{"mcpServers": []}'], [".claude/settings.json", "{oops"]]) {
    fs.rmSync(path.join(repo, ".claude"), { recursive: true, force: true });
    fs.rmSync(path.join(repo, ".mcp.json"), { force: true });
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
    const before = fs.readdirSync(repo).sort();
    assert.throws(() => initRepo({ cwd: repo, agents: ["claude"] }), /^Error: punk-records: /);
    assert.deepEqual(fs.readdirSync(repo).sort(), before, rel);
    assert.equal(fs.readFileSync(path.join(repo, rel), "utf8"), body);
    assert.equal(fs.existsSync(path.join(root, "store")), false);
  }
});

test("an empty settings file counts as an empty object", (t) => {
  const { repo, read } = sandbox(t);
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "\n");
  initRepo({ cwd: repo, agents: ["claude"] });
  assert.deepEqual(commandsOf(read(path.join(repo, ".claude", "settings.json")), "Stop"), ["punk-records hook claude Stop"]);
});

test("global init wires ~/.claude, backs up ~/.claude.json and links ~/.local/bin/punk-records", (t) => {
  const { repo, home, read } = sandbox(t);
  const cj = path.join(home, ".claude.json");
  const original = JSON.stringify({ numStartups: 3, mcpServers: { graft: { type: "stdio", command: "graft", args: ["mcp"] } } });
  fs.writeFileSync(cj, original, { mode: 0o600 });
  const { touched } = initRepo({ cwd: repo, explicit: "global", agents: ["claude"] });
  const after = read(cj);
  assert.equal(after.numStartups, 3);
  assert.ok(after.mcpServers.graft);
  assert.deepEqual(after.mcpServers["punk-records"].args, [BIN, "mcp"]);
  assert.equal(fs.readFileSync(`${cj}.punk-records-bak`, "utf8"), original);
  assert.equal(fs.statSync(cj).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${cj}.punk-records-bak`).mode & 0o777, 0o600);
  assert.deepEqual(commandsOf(read(path.join(home, ".claude", "settings.json")), "Stop"), ["punk-records hook claude Stop"]);
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "skills", "punk-records")), SKILL);
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "commands", "punk-records-save.md")), COMMAND);
  assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "punk-records")), BIN);
  assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "punk-records")), BIN);
  assert.equal(fs.existsSync(path.join(repo, ".claude")), false, "global init leaves the repo alone");
  for (const p of touched) assert.ok(p.startsWith(home) || p.startsWith(process.env.PUNK_RECORDS_HOME), `outside sandbox: ${p}`);
  assert.deepEqual(initRepo({ cwd: repo, explicit: "global", agents: ["claude"] }).touched, []);
});

test("global init replaces links left by the old npm package", (t) => {
  const { root, repo, home } = sandbox(t);
  const oldRoot = path.join(root, "node_modules", "previously-on-localhost");
  const links = [
    [path.join(home, ".local", "bin", "punk-records"), path.join(oldRoot, "bin", "punk-records"), BIN],
    [path.join(home, ".claude", "skills", "punk-records"), path.join(oldRoot, "skills", "punk-records"), SKILL],
    [path.join(root, "plugins", "punk-records.ts"), path.join(oldRoot, ".opencode", "plugins", "punk-records.ts"), path.join(ROOT, ".opencode", "plugins", "punk-records.ts")],
  ];
  for (const [dest, old] of links) {
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.symlinkSync(old, dest);
  }
  initRepo({cwd: repo, explicit: "global", agents: ["claude", "opencode"]});
  for (const [dest, , current] of links) assert.equal(fs.readlinkSync(dest), current);
});

test("CLAUDE_CONFIG_DIR relocates settings, skills and .claude.json", (t) => {
  const { root, repo, home } = sandbox(t);
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-cfg");
  initRepo({ cwd: repo, explicit: "global", agents: ["claude"] });
  assert.ok(fs.existsSync(path.join(root, "claude-cfg", "settings.json")));
  assert.ok(fs.existsSync(path.join(root, "claude-cfg", ".claude.json")));
  assert.ok(fs.existsSync(path.join(root, "claude-cfg", "skills", "punk-records")));
  assert.equal(fs.existsSync(path.join(home, ".claude.json")), false);
});

test("a symlinked settings file is written through, not replaced", (t) => {
  const { root, repo, home } = sandbox(t);
  const real = path.join(root, "dotfiles-settings.json");
  fs.writeFileSync(real, "{}");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.symlinkSync(real, path.join(home, ".claude", "settings.json"));
  initRepo({ cwd: repo, explicit: "global", agents: ["claude"] });
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "settings.json")), real);
  assert.match(fs.readFileSync(real, "utf8"), /punk-records hook claude Stop/);
});

test("foreign skill dirs are left alone; an @AGENTS.md CLAUDE.md gets no duplicate block", (t) => {
  const { repo } = sandbox(t);
  fs.mkdirSync(path.join(repo, ".claude", "skills", "punk-records"), { recursive: true });
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "@AGENTS.md\n");
  initRepo({ cwd: repo, agents: ["claude", "codex"] });
  assert.equal(fs.lstatSync(path.join(repo, ".claude", "skills", "punk-records")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /punk-records:start/);
});

test("--dry-run lists Claude files without writing them", (t) => {
  const { repo, home } = sandbox(t);
  const { touched } = initRepo({ cwd: repo, explicit: "global", agents: ["claude"], dryRun: true });
  assert.ok(touched.includes(path.join(home, ".claude", "settings.json")));
  assert.ok(touched.includes(path.join(home, ".local", "bin", "punk-records")));
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.existsSync(path.join(home, ".local")), false);
});

test("CLI --agents limits platforms and rejects unknown names", (t) => {
  const { repo } = sandbox(t);
  const run = (args) => spawnSync(process.execPath, [BIN, "init", ...args], { cwd: repo, env: process.env, encoding: "utf8" });
  assert.equal(run(["--agents", "claude", "--local"]).status, 0);
  assert.equal(fs.existsSync(path.join(repo, "opencode.json")), false);
  assert.ok(fs.existsSync(path.join(repo, ".mcp.json")));
  for (const bad of [["--agents", "claude,vim"], ["--agents"], ["--agents", ""], ["--agents", "--local"]]) {
    const r = run(bad);
    assert.equal(r.status, 2, bad.join(" "));
    assert.match(r.stderr, /agents/);
  }
});

const block = () => `# punk-records:start\n[mcp_servers.punk-records]\ncommand = "node"\nargs = [${JSON.stringify(BIN)}, "mcp"]\n# punk-records:end\n`;

test("global init wires Codex: hooks.json, config.toml block, skill", (t) => {
  const { repo, home, read } = sandbox(t);
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const toml = 'model = "gpt-5"\n\n[mcp_servers.graft]\ncommand = "graft"\nargs = ["mcp"]\n';
  fs.writeFileSync(path.join(dir, "config.toml"), toml);
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  const hooks = read(path.join(dir, "hooks.json"));
  for (const e of EVENTS) assert.deepEqual(commandsOf(hooks, e), [hookCommand("codex", e)]);
  assert.equal(hooks.hooks.SessionStart, undefined);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, MATCHERS.codex);
  const text = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  assert.equal(text, `${toml}\n${block()}`);
  assert.equal(fs.readlinkSync(path.join(dir, "skills", "punk-records")), SKILL);
  assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "punk-records")), BIN);
  assert.deepEqual(initRepo({ cwd: repo, explicit: "global", agents: ["codex"] }).touched, []);
});

test("foreign Codex hook groups keep their indices; ours is appended last", (t) => {
  const { repo, home, read } = sandbox(t);
  const file = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { hooks: { PostToolUse: [
    { matcher: ".*", hooks: [{ type: "command", command: "numbat post" }] },
    { matcher: "apply_patch", hooks: [{ type: "command", command: "graft post-edit" }] }] } };
  fs.writeFileSync(file, JSON.stringify(foreign));
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  const groups = read(file).hooks.PostToolUse;
  assert.deepEqual(groups.slice(0, 2), foreign.hooks.PostToolUse);
  assert.deepEqual(groups[2].hooks.map((h) => h.command), ["punk-records hook codex PostToolUse"]);
});

test("Codex hook migration preserves foreign group and hook indices", (t) => {
  const { repo, home, read } = sandbox(t);
  const file = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { type: "command", command: "foreign stop" };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [
    { hooks: [{ type: "command", command: "punk-records hook codex Stop" }, foreign] },
    { hooks: [{ type: "command", command: "punk-records hook codex Stop" }] },
  ] } }));
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  const groups = read(file).hooks.Stop;
  assert.deepEqual(groups[0].hooks[1], foreign);
  assert.deepEqual(commandsOf(read(file), "Stop"), ["punk-records hook codex Stop", "foreign stop"]);
  assert.deepEqual(groups[1].hooks, []);
});

test("Claude local re-init reconciles overlap after a global upgrade", (t) => {
  const { repo, home, read } = sandbox(t);
  const global = path.join(home, ".claude", "settings.json");
  const local = path.join(repo, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.mkdirSync(path.dirname(local), { recursive: true });
  for (const first of ["global", "local"]) {
    const old = { hooks: { Stop: [{ hooks: [{ type: "command", command: "punk-records hook claude Stop" }] }] } };
    fs.writeFileSync(global, JSON.stringify(old));
    fs.writeFileSync(local, JSON.stringify(old));
    initRepo({ cwd: repo, explicit: first, agents: ["claude"] });
    assert.deepEqual(commandsOf(read(global), "Stop"), ["punk-records hook claude Stop"]);
    assert.deepEqual(commandsOf(read(local), "Stop"), first === "global" ? ["punk-records hook claude Stop"] : []);
    initRepo({ cwd: repo, explicit: first === "global" ? "local" : "global", agents: ["claude"] });
    assert.deepEqual(commandsOf(read(global), "Stop"), ["punk-records hook claude Stop"]);
    assert.deepEqual(commandsOf(read(local), "Stop"), []);
  }
});

test("CODEX_HOME relocates Codex files", (t) => {
  const { root, repo, home } = sandbox(t);
  process.env.CODEX_HOME = path.join(root, "codex-home");
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  for (const rel of ["hooks.json", "config.toml", path.join("skills", "punk-records")]) {
    assert.ok(fs.existsSync(path.join(root, "codex-home", rel)), rel);
  }
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
});

test("a stale previously block is replaced in place; content around it survives", (t) => {
  const { repo, home } = sandbox(t);
  const cfg = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'a = 1\n\n# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = ["/old/bin/previously", "mcp"]\n# previously:end\n\n[other]\nk = 2\n');
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  assert.equal(fs.readFileSync(cfg, "utf8"), `a = 1\n\n${block()}\n[other]\nk = 2\n`);
});

test("a foreign [mcp_servers.previously] table is left alone; a broken previously block aborts init", (t) => {
  const { repo, home } = sandbox(t);
  const cfg = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const foreign = '[mcp_servers."previously"]\ncommand = "custom"\n';
  fs.writeFileSync(cfg, foreign);
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  assert.equal(fs.readFileSync(cfg, "utf8"), foreign);

  for (const broken of ['x = 1\n# previously:start\n[mcp_servers.previously]\n', 'x = 1\n# previously:end\n# previously:start\n',
    '# previously:start\n# previously:end\n# previously:start\n# previously:end\n']) {
    fs.writeFileSync(cfg, broken);
    fs.rmSync(path.join(home, ".codex", "hooks.json"), { force: true });
    assert.throws(() => initRepo({ cwd: repo, explicit: "global", agents: ["codex"] }), /previously:start/);
    assert.equal(fs.readFileSync(cfg, "utf8"), broken);
    assert.equal(fs.existsSync(path.join(home, ".codex", "hooks.json")), false);
  }
});

test("repo init wires Codex config, skill, AGENTS.md and (per F1) project hooks", (t) => {
  const { repo, read } = sandbox(t);
  initRepo({ cwd: repo, agents: ["codex"] });
  assert.equal(fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8"), block());
  assert.equal(fs.readlinkSync(path.join(repo, ".agents", "skills", "punk-records")), SKILL);
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /punk-records:start/);
  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), CODEX_PROJECT_HOOKS);
  if (CODEX_PROJECT_HOOKS) assert.deepEqual(commandsOf(read(path.join(repo, ".codex", "hooks.json")), "Stop"), ["punk-records hook codex Stop"]);
  assert.equal(fs.existsSync(path.join(repo, ".claude")), false);
});

test("repo init skips project Codex hooks when the global hooks.json already runs ours", (t) => {
  const { repo, home } = sandbox(t);
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  initRepo({ cwd: repo, agents: ["codex"] });
  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), false);
  assert.match(fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.punk-records\]/);
  assert.ok(fs.existsSync(path.join(home, ".codex", "hooks.json")));
});

test("repo init also skips project Codex hooks with a canonical global command", (t) => {
  const { repo, home } = sandbox(t);
  const file = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "punk-records hook codex Stop" }] }] } }));
  initRepo({ cwd: repo, agents: ["codex"] });
  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), false);
});

test("adding Codex hooks prints the approval note once", (t) => {
  const { repo } = sandbox(t);
  const errors = t.mock.method(console, "error", () => {});
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  assert.equal(errors.mock.calls.filter((c) => /approve them: start codex and use \/hooks/.test(c.arguments[0])).length, 1);
  errors.mock.resetCalls();
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  assert.equal(errors.mock.calls.filter((c) => /\/hooks/.test(c.arguments[0])).length, 0);
});

for (const [name, foreign] of [
  ["an inline table under [mcp_servers]", '[mcp_servers]\npreviously = { command = "node", args = ["x"] }\n'],
  ["a top-level dotted key", 'mcp_servers.previously.command = "node"\n'],
  ["a dotted key inside [mcp_servers]", '[mcp_servers]\npreviously.command = "node"\n'],
]) {
  test(`foreign previously as ${name} leaves config.toml untouched`, (t) => {
    const { repo, home } = sandbox(t);
    const dir = path.join(home, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.toml"), foreign);
    initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
    assert.equal(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), foreign);
    assert.equal(fs.existsSync(path.join(dir, "hooks.json")), true);
  });
}

test("a commented-out previously line is not foreign", (t) => {
  const { repo, home } = sandbox(t);
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const toml = '# previously = old\n';
  fs.writeFileSync(path.join(dir, "config.toml"), toml);
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  assert.equal(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), `${toml}\n${block()}`);
});

test("a fresh ~/.claude.json is created 0600", (t) => {
  const { repo, home } = sandbox(t);
  initRepo({ cwd: repo, explicit: "global", agents: ["claude"] });
  assert.equal(fs.statSync(path.join(home, ".claude.json")).mode & 0o777, 0o600);
});

test("a file where a config dir should be skips that target with a warning, not a crash", (t) => {
  const { repo, home } = sandbox(t);
  fs.writeFileSync(path.join(repo, ".codex"), "");
  fs.chmodSync(path.join(repo, ".codex"), 0o555);
  fs.writeFileSync(path.join(home, ".codex"), "");
  const errors = t.mock.method(console, "error", () => {});
  initRepo({ cwd: repo, agents: ["claude", "codex"] });
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  assert.equal(fs.statSync(path.join(repo, ".codex")).isFile(), true, "blocking file left alone");
  assert.equal(fs.statSync(path.join(home, ".codex")).isFile(), true);
  assert.ok(fs.existsSync(path.join(repo, ".claude", "settings.json")), "unblocked targets still installed");
  assert.ok(fs.existsSync(path.join(repo, ".agents", "skills", "punk-records")));
  const warned = errors.mock.calls.map((c) => c.arguments[0]).filter((m) => /is not a directory/.test(m));
  assert.ok(warned.some((m) => m.includes(path.join(repo, ".codex"))), warned.join("\n"));
  assert.ok(warned.some((m) => m.includes(path.join(home, ".codex"))), warned.join("\n"));
});

test('Claude SessionStart malformed config aborts before writes', t => {
  const {root, repo} = sandbox(t);
  fs.mkdirSync(path.join(repo, '.claude'));
  const config = path.join(repo, '.claude', 'settings.json');
  fs.writeFileSync(config, JSON.stringify({hooks: {SessionStart: {}}}));
  const before = fs.readFileSync(config, 'utf8');
  const tree = fs.readdirSync(root, {recursive: true}).sort();
  assert.throws(() => initRepo({cwd: repo, agents: ['claude']}), /hooks.SessionStart.*array/);
  assert.deepEqual(fs.readdirSync(root, {recursive: true}).sort(), tree);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(repo, 'memory')), false);
  assert.equal(fs.existsSync(path.join(repo, 'CLAUDE.md')), false);
});

test('local instruction guidance matches static workflow and retains absolute CLI fallback', async t => {
  const {WORKFLOW_GUIDANCE} = await import('../lib/workflow.js');
  const {repo} = sandbox(t);
  initRepo({cwd: repo, agents: ['claude']});
  const text = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
  assert.ok(text.includes(WORKFLOW_GUIDANCE));
  assert.ok(WORKFLOW_GUIDANCE.length <= 1000);
  assert.ok(text.includes(`node ${BIN} ask`));
});

const claudeConfig = () => ({hooks: Object.fromEntries(CLAUDE_EVENTS.map(event => [event,
  [{...(event === 'PostToolUse' ? {matcher: MATCHERS.claude} : {}), hooks: [{type: 'command', command: hookCommand('claude', event), timeout: 10}]}]]))});
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value)); };
const snapshotFiles = root => Object.fromEntries(fs.readdirSync(root, {recursive: true}).map(rel => [rel, path.join(root, rel)])
  .filter(([, file]) => fs.lstatSync(file).isFile()).map(([rel, file]) => [rel, fs.readFileSync(file, 'utf8')]));

for (const dryRun of [true, false]) test(`observed global synthesis wrapper prunes the project bare duplicate (${dryRun ? 'dry-run' : 'normal'})`, t => {
  const {root, repo, home, read} = sandbox(t);
  const global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  writeJson(global, {hooks: {UserPromptSubmit: [{hooks: [{type: 'command', command: 'env PUNK_RECORDS_SYNTHESIS=1 punk-records hook claude UserPromptSubmit'}]}]}});
  writeJson(local, claudeConfig());
  const before = snapshotFiles(root); t.mock.method(console, 'error', () => {});
  const {touched} = initRepo({cwd: repo, explicit: 'local', agents: ['claude'], dryRun});
  assert.ok(touched.includes('.claude/settings.json'));
  assert.equal(fs.readFileSync(global, 'utf8'), before[path.relative(root, global)]);
  if (dryRun) assert.deepEqual(snapshotFiles(root), before);
  else {
    assert.deepEqual(commandsOf(read(local), 'UserPromptSubmit'), []);
    for (const event of ['SessionStart', 'PostToolUse', 'Stop']) assert.deepEqual(commandsOf(read(local), event), [hookCommand('claude', event)]);
    const bytes = fs.readFileSync(local, 'utf8');
    assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
    assert.equal(fs.readFileSync(local, 'utf8'), bytes);
  }
});

for (const sharedPath of ['same path', 'symlink']) test(`Claude local init preserves global coverage through a ${sharedPath}`, t => {
  const {repo, home, read} = sandbox(t), local = path.join(repo, '.claude', 'settings.json');
  if (sharedPath === 'same path') process.env.CLAUDE_CONFIG_DIR = path.dirname(local);
  const global = sharedPath === 'same path' ? local : path.join(home, '.claude', 'settings.json');
  writeJson(global, claudeConfig());
  if (sharedPath === 'symlink') {
    fs.mkdirSync(path.dirname(local), {recursive: true});
    fs.symlinkSync(global, local);
  }
  const before = fs.readFileSync(global, 'utf8');
  t.mock.method(console, 'error', () => {});
  for (const dryRun of sharedPath === 'same path' ? [true, false, true, false] : [false, true, false, true]) {
    const {touched} = initRepo({cwd: repo, explicit: 'local', agents: ['claude'], dryRun});
    assert.equal(fs.readFileSync(global, 'utf8'), before, 'local init must preserve the shared global file');
    assert.equal(touched.includes('.claude/settings.json'), false, 'shared global callbacks are not redundant local copies');
    for (const event of CLAUDE_EVENTS) assert.deepEqual(commandsOf(read(global), event), [hookCommand('claude', event)]);
    if (sharedPath === 'symlink') assert.equal(fs.readlinkSync(local), global);
  }
});

for (const prefix of ['previously', 'punk-records', 'env PUNK_RECORDS_SYNTHESIS=1 previously', 'env PUNK_RECORDS_SYNTHESIS=1 punk-records']) {
  test(`Claude local coverage is per event and preserves global ${prefix}`, t => {
    const {root, repo, read} = sandbox(t);
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'relocated-claude');
    const global = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
    const config = {customDisabled: true, hooks: {UserPromptSubmit: [{matcher: '*', hooks: [{type: 'command', command: `${prefix} hook claude UserPromptSubmit`, timeout: 73}]}]}};
    writeJson(global, config); const before = fs.readFileSync(global, 'utf8');
    initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
    const local = read(path.join(repo, '.claude', 'settings.json'));
    assert.deepEqual(commandsOf(local, 'UserPromptSubmit'), []);
    for (const event of ['SessionStart', 'PostToolUse', 'Stop']) assert.deepEqual(commandsOf(local, event), [hookCommand('claude', event)]);
    assert.equal(fs.readFileSync(global, 'utf8'), before);
    const localFile = path.join(repo, '.claude', 'settings.json'), oldLocal = claudeConfig();
    oldLocal.hooks.UserPromptSubmit.push({hooks: [{type: 'command', command: 'punk-records hook claude UserPromptSubmit'}]});
    writeJson(localFile, oldLocal);
    initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
    assert.deepEqual(commandsOf(read(localFile), 'UserPromptSubmit'), []);
    for (const event of ['SessionStart', 'PostToolUse', 'Stop']) assert.deepEqual(read(localFile).hooks[event], oldLocal.hooks[event]);
    assert.equal(fs.readFileSync(global, 'utf8'), before);
    initRepo({cwd: repo, explicit: 'global', agents: ['claude']});
    config.hooks.UserPromptSubmit[0].hooks[0].command = config.hooks.UserPromptSubmit[0].hooks[0].command.replace(/\bpreviously\b/, "punk-records");
    assert.deepEqual(read(global).hooks.UserPromptSubmit, config.hooks.UserPromptSubmit);
    assert.equal(read(global).customDisabled, true);
    assert.deepEqual(commandsOf(read(global), 'UserPromptSubmit'), [`${prefix.replace(/\bpreviously\b/, "punk-records")} hook claude UserPromptSubmit`]);
  });
}

for (const [label, event, group, extra, stillCovers] of [
  ['partial matcher', 'UserPromptSubmit', {matcher: 'only-this'}, {}],
  ['partial tool matcher', 'PostToolUse', {matcher: 'Write'}, {}],
  ['async', 'UserPromptSubmit', {}, {async: true}],
  ['conditional session', 'SessionStart', {}, {if: 'tool_name == "Write"'}],
  ['conditional tool', 'PostToolUse', {matcher: MATCHERS.claude}, {if: 'tool_input.file_path =~ /src/'}],
  ['unknown wrapper', 'Stop', {}, {command: 'sh -c "punk-records hook claude Stop"'}],
  ['quoted executable wrapper', 'Stop', {}, {command: 'node "/opt/punk-records/bin/previously" hook claude Stop'}],
  ['unknown env prefix', 'Stop', {}, {command: 'env EXTRA=secret-not-logged PUNK_RECORDS_SYNTHESIS=1 punk-records hook claude Stop'}],
  ['non-command type', 'Stop', {}, {type: 'prompt'}],
  ['custom group field', 'Stop', {customGroup: 'keep'}, {}, true],
  ['custom handler field', 'Stop', {}, {customHandler: 'keep'}, true],
  ['group condition', 'Stop', {if: 'custom condition'}, {}],
  ['invalid timeout', 'Stop', {}, {timeout: 'not-a-number'}],
]) test(`Claude ${label} is ambiguous and preserves existing execution coverage`, t => {
  const {repo, home, read} = sandbox(t);
  const global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  const original = {...group, hooks: [{type: 'command', command: hookCommand('claude', event), timeout: 81, ...extra}, {type: 'command', command: 'foreign', timeout: 99}]};
  writeJson(global, {hooks: {[event]: [original]}});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(commandsOf(read(local), event), [], 'ambiguous global coverage must not be bypassed locally');
  assert.ok(warnings.some(line => line.includes(global) && line.includes(event) && /ambiguous/.test(line)), warnings.join('\n'));
  writeJson(local, {hooks: {...claudeConfig().hooks, [event]: [original]}});
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(read(local).hooks[event], [original]);
  assert.ok(warnings.every(line => !line.includes('secret-not-logged')));
  const before = fs.readFileSync(local, 'utf8');
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.equal(fs.readFileSync(local, 'utf8'), before);
  if (stillCovers) {
    fs.rmSync(global);
    assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
    assert.equal(fs.readFileSync(local, 'utf8'), before, 'custom annotations must not cause a second local callback without global coverage');
  }
  writeJson(global, claudeConfig());
  const customized = {...original, hooks: [original.hooks[0]]};
  writeJson(local, {hooks: {...claudeConfig().hooks, [event]: [customized]}});
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(read(local).hooks[event], [customized], 'global coverage must not remove customized local handlers');
});

for (const [upstream, localPrefix, pruned] of [
  ['previously', 'env PUNK_RECORDS_SYNTHESIS=1 punk-records', false],
  ['punk-records', 'env PUNK_RECORDS_SYNTHESIS=1 previously', false],
  ['env PUNK_RECORDS_SYNTHESIS=1 previously', 'env PUNK_RECORDS_SYNTHESIS=1 punk-records', true],
]) test(`Claude synthesis semantics: ${upstream} covering ${localPrefix}`, t => {
  const {repo, home, read} = sandbox(t), global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  writeJson(global, claudeConfig());
  const upstreamConfig = read(global);
  upstreamConfig.hooks.UserPromptSubmit[0].hooks[0].command = `${upstream} hook claude UserPromptSubmit`;
  writeJson(global, upstreamConfig);
  const localConfig = claudeConfig();
  localConfig.hooks.UserPromptSubmit[0].hooks[0].command = `${localPrefix} hook claude UserPromptSubmit`;
  writeJson(local, localConfig);
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(commandsOf(read(local), 'UserPromptSubmit'), pruned ? [] : [`${localPrefix.replace(/\bpreviously\b/, "punk-records")} hook claude UserPromptSubmit`]);
  if (!pruned) assert.ok(warnings.some(line => line.includes(local) && line.includes(global) && line.includes('UserPromptSubmit') && /preserved/.test(line)));
  const before = fs.readFileSync(local, 'utf8');
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
  assert.equal(fs.readFileSync(local, 'utf8'), before);
});

test('Claude reconciliation preserves the entire ambiguous event including safe handlers', t => {
  const {repo, home, read} = sandbox(t), local = path.join(repo, '.claude', 'settings.json');
  writeJson(path.join(home, '.claude', 'settings.json'), claudeConfig());
  const owned = {type: 'command', command: 'punk-records hook claude Stop'}, foreign = {type: 'command', command: 'foreign', timeout: 71};
  const stop = [{hooks: [foreign]}, {hooks: [owned]}, {hooks: [foreign, owned]}, {hooks: [owned, foreign]}, {customGroup: 'keep', hooks: [owned]}];
  writeJson(local, {customSetting: 'keep', hooks: {...claudeConfig().hooks, Stop: stop, PreToolUse: [{matcher: 'custom', hooks: [foreign]}]}});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  const result = read(local);
  assert.deepEqual(result.hooks.Stop, stop);
  assert.deepEqual(result.hooks.PreToolUse, [{matcher: 'custom', hooks: [foreign]}]);
  assert.equal(result.customSetting, 'keep');
  assert.ok(warnings.some(line => line.includes(local) && line.includes('Stop') && /preserved/.test(line)));
  const before = fs.readFileSync(local, 'utf8');
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
  assert.equal(fs.readFileSync(local, 'utf8'), before);
});

for (const first of ['local', 'global']) test(`Claude ${first}-first install converges without global init sweeping projects`, t => {
  const {root, repo, home, read} = sandbox(t), global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  const otherRepo = path.join(root, 'other-repo'); fs.mkdirSync(otherRepo);
  execFileSync('git', ['init', '-q'], {cwd: otherRepo});
  initRepo({cwd: otherRepo, explicit: 'local', agents: ['claude']});
  const otherBefore = snapshotFiles(otherRepo);
  initRepo({cwd: repo, explicit: first, agents: ['claude']});
  if (first === 'local') {
    const localBefore = snapshotFiles(repo);
    initRepo({cwd: repo, explicit: 'global', agents: ['claude']});
    assert.deepEqual(snapshotFiles(repo), localBefore);
  }
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(snapshotFiles(otherRepo), otherBefore);
  for (const event of CLAUDE_EVENTS) {
    assert.deepEqual(commandsOf(read(global), event), [hookCommand('claude', event)]);
    assert.deepEqual(commandsOf(fs.existsSync(local) ? read(local) : {}, event), []);
  }
  const before = snapshotFiles(root);
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
  assert.deepEqual(initRepo({cwd: repo, explicit: 'global', agents: ['claude']}).touched, []);
  assert.deepEqual(snapshotFiles(root), before);
});

for (const matcher of [undefined, '', '*', MATCHERS.claude]) test(`Claude PostToolUse global matcher ${JSON.stringify(matcher)} supplies coverage`, t => {
  const {repo, home, read} = sandbox(t);
  writeJson(path.join(home, '.claude', 'settings.json'), {hooks: {PostToolUse: [{...(matcher === undefined ? {} : {matcher}), hooks: [{type: 'command', command: hookCommand('claude', 'PostToolUse')}]}]}});
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(commandsOf(read(path.join(repo, '.claude', 'settings.json')), 'PostToolUse'), []);
});

test('Claude malformed global group prevents pruning even alongside a usable global handler', t => {
  const {repo, home} = sandbox(t), global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  const config = claudeConfig(); config.hooks.Stop.push({hooks: 'invalid'});
  writeJson(global, config); writeJson(local, claudeConfig());
  const before = fs.readFileSync(local, 'utf8'), warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')).hooks.Stop, JSON.parse(before).hooks.Stop);
  assert.ok(warnings.some(line => line.includes(global) && line.includes('Stop') && /ambiguous/.test(line)));
});

test('Claude disabled global hooks warn and prevent unconditional local handlers', t => {
  const {repo, home} = sandbox(t), global = path.join(home, '.claude', 'settings.json');
  writeJson(global, {disableAllHooks: true, ...claudeConfig()});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  const local = path.join(repo, '.claude', 'settings.json');
  assert.equal(fs.existsSync(local), false);
  assert.ok(warnings.some(line => line.includes(global) && /disableAllHooks.*does not override|does not override.*disableAllHooks/.test(line)));
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
  assert.equal(fs.existsSync(local), false);
});

for (const bad of ['malformed', 'unreadable']) test(`Claude ${bad} read-only global config warns and local install completes`, t => {
  const {repo, home, read} = sandbox(t), global = path.join(home, '.claude', 'settings.json');
  if (bad === 'malformed') { fs.mkdirSync(path.dirname(global), {recursive: true}); fs.writeFileSync(global, '{secret-not-logged'); }
  else fs.mkdirSync(global, {recursive: true});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  for (const event of CLAUDE_EVENTS) assert.deepEqual(commandsOf(read(path.join(repo, '.claude', 'settings.json')), event), [hookCommand('claude', event)]);
  assert.ok(warnings.some(line => line.includes(global) && CLAUDE_EVENTS.every(event => line.includes(event)) && /warning/.test(line)));
  assert.ok(warnings.every(line => !line.includes('secret-not-logged')));
  const local = path.join(repo, '.claude', 'settings.json'), before = fs.readFileSync(local, 'utf8');
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
  assert.equal(fs.readFileSync(local, 'utf8'), before);
});

test('Claude duplicate bare and synthesis entries preserve order, custom fields and dry-run bytes', t => {
  const {root, repo, read} = sandbox(t), local = path.join(repo, '.claude', 'settings.json');
  const config = claudeConfig();
  config.hooks.Stop = [{hooks: [{type: 'command', command: 'env PUNK_RECORDS_SYNTHESIS=1 punk-records hook claude Stop', timeout: 31}, {type: 'command', command: 'foreign'}]},
    {hooks: [{type: 'command', command: 'punk-records hook claude Stop', timeout: 47}]}];
  writeJson(local, config); const before = snapshotFiles(root), warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude'], dryRun: true});
  assert.deepEqual(snapshotFiles(root), before);
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(read(local), config);
  assert.equal(fs.readFileSync(local, 'utf8'), before[path.relative(root, local)]);
  assert.ok(warnings.some(line => line.includes(local) && line.includes('Stop') && /duplicate/.test(line)));
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
});

test('Claude mixed plugin setup warns only about visible configuration', t => {
  const {repo, home} = sandbox(t), global = path.join(home, '.claude', 'settings.json');
  writeJson(global, {enabledPlugins: {'punk-records@marketplace': true, 'unrelated@marketplace': true}});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.ok(warnings.some(line => line.includes(global) && /visible.*plugin|plugin.*visible/.test(line)));
});

for (const pluginScope of ['global', 'local']) test(`Claude visible ${pluginScope} plugin ambiguity preserves local handlers despite standalone coverage`, t => {
  const {repo, home} = sandbox(t), global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  writeJson(global, {...claudeConfig(), ...(pluginScope === 'global' ? {enabledPlugins: {'punk-records@marketplace': true}} : {})});
  writeJson(local, {...claudeConfig(), ...(pluginScope === 'local' ? {enabledPlugins: {'previously@marketplace': true}} : {})});
  const before = fs.readFileSync(local, 'utf8'), warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.equal(fs.readFileSync(local, 'utf8'), before);
  assert.ok(warnings.some(line => /visible.*plugin|plugin.*visible/.test(line)));
});

test('Claude disabled local config retains one usable handler per event across repeated init', t => {
  const {repo, read} = sandbox(t), local = path.join(repo, '.claude', 'settings.json');
  writeJson(local, {disableAllHooks: true, ...claudeConfig()});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  const before = fs.readFileSync(local, 'utf8');
  assert.deepEqual(initRepo({cwd: repo, explicit: 'local', agents: ['claude']}).touched, []);
  assert.equal(fs.readFileSync(local, 'utf8'), before);
  for (const event of CLAUDE_EVENTS) assert.deepEqual(commandsOf(read(local), event), [hookCommand('claude', event)]);
  assert.ok(warnings.some(line => line.includes(local) && line.includes('SessionStart') && /disableAllHooks/.test(line)));
  writeJson(path.join(process.env.HOME, '.claude', 'settings.json'), claudeConfig());
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.equal(fs.readFileSync(local, 'utf8'), before);
});

test('Claude malformed global write target aborts before any writes', t => {
  const {root, repo, home} = sandbox(t), global = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(global), {recursive: true}); fs.writeFileSync(global, '{secret-not-logged');
  const before = snapshotFiles(root);
  assert.throws(() => initRepo({cwd: repo, explicit: 'global', agents: ['claude']}), error =>
    error.message.includes(global) && error.message.includes('not valid JSON') && !error.message.includes('secret-not-logged'));
  assert.deepEqual(snapshotFiles(root), before);
});

test('non-Claude init does not inspect global Claude settings', t => {
  const {repo, home} = sandbox(t), global = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(global, {recursive: true});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  initRepo({cwd: repo, explicit: 'local', agents: ['codex']});
  assert.ok(warnings.every(line => !line.includes(global)));
});


for (const agent of ['claude', 'codex']) for (const explicit of ['local', 'global']) {
  test(`${agent} ${explicit} keeps 10-second defaults and synthesis handlers without changing budgets`, t => {
    const {root, repo, home, read} = sandbox(t);
    const file = path.join(explicit === 'global' ? home : repo, `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
    const events = agent === 'claude' ? CLAUDE_EVENTS : EVENTS;
    const options = {cwd: repo, explicit, agents: [agent]};
    t.mock.method(console, 'error', () => {});
    initRepo(options);
    for (const event of events) assert.equal(read(file).hooks[event][0].hooks[0].timeout, 10);
    for (const prefix of ['previously', 'punk-records', 'env PUNK_RECORDS_SYNTHESIS=1 previously', 'env PUNK_RECORDS_SYNTHESIS=1 punk-records']) {
      const config = {unrelated: {keep: true}, hooks: Object.fromEntries(events.map(event => [event, [{hooks: [
        {type: 'command', command: 'numbat hook', timeout: 10},
        {type: 'command', command: `${prefix} hook ${agent} ${event}`, timeout: 10},
        {type: 'command', command: 'graft hook', timeout: 10},
      ]}]]))};
      writeJson(file, config); const before = snapshotFiles(root);
      initRepo({...options, dryRun: true}); assert.deepEqual(snapshotFiles(root), before);
      initRepo(options);
      const actual = read(file);
      for (const event of events) {
        config.hooks[event][0].hooks[1].command = `${prefix.startsWith('env ') ? 'env PUNK_RECORDS_SYNTHESIS=1 ' : ''}${hookCommand(agent, event)}`;
      }
      assert.deepEqual(actual, config);
      const stable = fs.readFileSync(file, 'utf8');
      assert.deepEqual(initRepo(options).touched, []);
      assert.equal(fs.readFileSync(file, 'utf8'), stable);
    }
  });

  test(`${agent} ${explicit} preserves custom budgets and ambiguous hook definitions`, t => {
    const {repo, home, read} = sandbox(t);
    const file = path.join(explicit === 'global' ? home : repo, `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
    const options = {cwd: repo, explicit, agents: [agent]};
    const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
    initRepo(options);
    const baseline = read(file);
    for (const [label, group, hook, top] of [
      ...[5, 30, 45, 60].map(timeout => [`custom ${timeout}`, {}, {timeout}, {}]),
      ['async', {}, {async: true}, {}], ['condition', {}, {if: 'custom'}, {}],
      ['group condition', {if: 'custom'}, {}, {}], ['matcher', {matcher: 'custom'}, {}, {}],
      ['group metadata', {custom: 'keep'}, {}, {}], ['handler metadata', {}, {custom: 'keep'}, {}],
      ['handler disabled', {}, {disabled: true}, {}], ['disabled', {}, {}, {disableAllHooks: true}],
      ['unknown command', {}, {command: `env EXTRA=secret-not-logged punk-records hook ${agent} Stop`}, {}],
    ]) {
      const original = {...group, hooks: [{type: 'command', command: `punk-records hook ${agent} Stop`, timeout: 10, ...hook}]};
      const config = {...baseline, ...top, hooks: {...baseline.hooks, Stop: [original]}};
      writeJson(file, config); warnings.length = 0;
      initRepo(options);
      assert.deepEqual(read(file).hooks.Stop, [original], label);
      if (!label.startsWith('custom')) assert.ok(warnings.some(line => line.includes(file) && /Stop.*ambiguous|ambiguous.*Stop/.test(line)), label);
      assert.ok(warnings.every(line => !line.includes('secret-not-logged')));
      const stable = fs.readFileSync(file, 'utf8'); initRepo(options);
      assert.equal(fs.readFileSync(file, 'utf8'), stable, label);
    }
  });
}


for (const agent of ['claude', 'codex']) test(`${agent} global init leaves registered project hooks untouched`, t => {
  const {root, repo} = sandbox(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(other); execFileSync('git', ['init', '-q'], {cwd: other});
  const file = path.join(other, `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
  writeJson(file, {hooks: {Stop: [{hooks: [{type: 'command', command: `punk-records hook ${agent} Stop`, timeout: 10}]}]}});
  fs.mkdirSync(process.env.PUNK_RECORDS_HOME, {recursive: true});
  fs.writeFileSync(path.join(process.env.PUNK_RECORDS_HOME, 'projects.txt'), other + '\n');
  const before = snapshotFiles(other);
  initRepo({cwd: repo, explicit: 'global', agents: [agent]});
  assert.deepEqual(snapshotFiles(other), before);
});

for (const timeout of [5, 30, 45, 60]) test(`Claude global coverage preserves a local custom ${timeout}-second handler`, t => {
  const {repo, home, read} = sandbox(t), file = path.join(repo, '.claude', 'settings.json');
  writeJson(path.join(home, '.claude', 'settings.json'), claudeConfig());
  const config = claudeConfig(); config.hooks.Stop[0].hooks[0].timeout = timeout;
  writeJson(file, config); t.mock.method(console, 'error', () => {});
  initRepo({cwd: repo, explicit: 'local', agents: ['claude']});
  assert.deepEqual(read(file).hooks.Stop, config.hooks.Stop);
});


test('Codex retains indices before customized or synthesis handlers', t => {
  const {repo, home, read} = sandbox(t), file = path.join(home, '.codex', 'hooks.json');
  const baseline = {type: 'command', command: 'punk-records hook codex Stop', timeout: 10};
  for (const later of [{...baseline, timeout: 45}, {...baseline, command: 'env PUNK_RECORDS_SYNTHESIS=1 punk-records hook codex Stop'}]) {
    const group = {hooks: [{...baseline}, {...baseline}, later]};
    writeJson(file, {hooks: {Stop: [group]}});
    t.mock.method(console, 'error', () => {});
    initRepo({cwd: repo, explicit: 'global', agents: ['codex']});
    assert.deepEqual(read(file).hooks.Stop, [group]);
  }
});


for (const upstream of [false, true]) test(`Claude mixed safe and ambiguous local event is unchanged with global coverage ${upstream}`, t => {
  const {repo, home, read} = sandbox(t), file = path.join(repo, '.claude', 'settings.json');
  if (upstream) writeJson(path.join(home, '.claude', 'settings.json'), claudeConfig());
  const stop = [{hooks: [{type: 'command', command: 'punk-records hook claude Stop', timeout: 10}]},
    {hooks: [{type: 'command', command: 'punk-records hook claude Stop', timeout: 10, async: true}]}];
  writeJson(file, {hooks: {...claudeConfig().hooks, Stop: stop}});
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  for (const dryRun of [true, false, false]) {
    initRepo({cwd: repo, explicit: 'local', agents: ['claude'], dryRun});
    assert.deepEqual(read(file).hooks.Stop, stop);
  }
  assert.ok(warnings.some(line => line.includes(file) && /Stop.*ambiguous/.test(line)));
});


test('Claude mixed safe and ambiguous global event leaves a safe local 10-second handler unchanged', t => {
  const {repo, home, read} = sandbox(t), global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  const upstream = claudeConfig();
  upstream.hooks.Stop.push({hooks: [{type: 'command', command: 'punk-records hook claude Stop', timeout: 10, async: true}]});
  writeJson(global, upstream);
  const config = claudeConfig(); config.hooks.Stop[0].hooks[0].timeout = 10;
  writeJson(local, config);
  const warnings = []; t.mock.method(console, 'error', line => warnings.push(line));
  for (const dryRun of [true, false, false]) {
    initRepo({cwd: repo, explicit: 'local', agents: ['claude'], dryRun});
    assert.deepEqual(read(local).hooks.Stop, config.hooks.Stop);
  }
  assert.ok(warnings.some(line => line.includes(global) && /Stop.*ambiguous/.test(line)));
});
