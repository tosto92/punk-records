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
const SKILL = path.join(ROOT, "skills", "previously");
const COMMAND = path.join(ROOT, "commands", "previously-save.md");
const EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];

// Throwaway HOME, stores and repo per test; agent dirs resolve inside HOME.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-agents-"));
  const repo = path.join(root, "repo"), home = path.join(root, "home");
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PREVIOUSLY_HOME", "PREVIOUSLY_CONFIG", "PREVIOUSLY_PLUGINS", "PREVIOUSLY_SKILLS"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home, PREVIOUSLY_HOME: path.join(root, "store"), PREVIOUSLY_CONFIG: path.join(root, "oc.json"),
    PREVIOUSLY_PLUGINS: path.join(root, "plugins"), PREVIOUSLY_SKILLS: path.join(root, "oc-skills"),
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
  for (const e of EVENTS) assert.deepEqual(commandsOf(settings, e), [hookCommand("claude", e)]);
  assert.equal(hookCommand("claude", "Stop"), "previously hook claude Stop");
  assert.equal(settings.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit");
  assert.match(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), /<!-- punk-records:start -->/);
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "skills", "punk-records")), path.join(ROOT, "skills", "punk-records"));
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "commands", "punk-records-save.md")), path.join(ROOT, "commands", "punk-records-save.md"));
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "skills", "previously")), SKILL);
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "skills", "previously-episodes")), path.join(ROOT, "skills", "previously-episodes"));
  assert.equal(fs.readlinkSync(path.join(repo, ".claude", "commands", "previously-save.md")), COMMAND);
  assert.equal(fs.existsSync(path.join(repo, "opencode.json")), false, "opencode not requested");
  assert.equal(fs.existsSync(path.join(repo, "AGENTS.md")), false, "AGENTS.md is for opencode/codex");
});

test("init upgrades owned legacy Claude and Codex entries without duplicate hooks or servers", (t) => {
  const { root, repo, read } = sandbox(t);
  const legacyBin = path.join(root, "node_modules", "previously-on-localhost", "bin", "previously");
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: {
    previously: { type: "stdio", command: "node", args: [legacyBin, "mcp"] },
    foreign: { command: "foreign" },
  } }));
  const hooks = Object.fromEntries(EVENTS.map((event) => [event,
    [{ hooks: [{ type: "command", command: `previously hook claude ${event}` }] }]]));
  hooks.Stop.push({ hooks: [{ type: "command", command: "punk-records hook claude Stop" }] });
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ hooks }));
  fs.writeFileSync(path.join(repo, ".codex", "config.toml"),
    `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = [${JSON.stringify(legacyBin)}, "mcp"]\n# previously:end\n`);
  fs.writeFileSync(path.join(repo, "AGENTS.md"),
    "before\n<!-- previously:start -->\nold hints\n<!-- previously:end -->\nafter\n");

  initRepo({ cwd: repo, agents: ["claude", "codex"] });
  const mcp = read(path.join(repo, ".mcp.json")).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ["foreign", "punk-records"]);
  assert.equal(mcp["punk-records"].args[0], BIN);
  const settings = read(path.join(repo, ".claude", "settings.json"));
  for (const event of EVENTS) assert.deepEqual(commandsOf(settings, event), [hookCommand("claude", event)]);
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
  const legacy = { type: "local", command: ["node", path.join(root, "previously-on-localhost", "bin", "previously"), "mcp"] };
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
    previously: { command: "node", args: [path.join(ROOT, "bin", "previously"), "mcp"] } } }));
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
  assert.deepEqual(commandsOf(merged, "Stop"), ["numbat stop", "previously hook claude Stop"]);
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
  assert.deepEqual(commandsOf(read(path.join(repo, ".claude", "settings.json")), "Stop"), ["previously hook claude Stop"]);
});

test("global init wires ~/.claude, backs up ~/.claude.json and links ~/.local/bin/previously", (t) => {
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
  assert.deepEqual(commandsOf(read(path.join(home, ".claude", "settings.json")), "Stop"), ["previously hook claude Stop"]);
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "skills", "previously")), SKILL);
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "commands", "previously-save.md")), COMMAND);
  assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "previously")), BIN);
  assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "punk-records")), BIN);
  assert.equal(fs.existsSync(path.join(repo, ".claude")), false, "global init leaves the repo alone");
  for (const p of touched) assert.ok(p.startsWith(home) || p.startsWith(process.env.PREVIOUSLY_HOME), `outside sandbox: ${p}`);
  assert.deepEqual(initRepo({ cwd: repo, explicit: "global", agents: ["claude"] }).touched, []);
});

test("global init replaces links left by the old npm package", (t) => {
  const { root, repo, home } = sandbox(t);
  const oldRoot = path.join(root, "node_modules", "previously-on-localhost");
  const links = [
    [path.join(home, ".local", "bin", "previously"), path.join(oldRoot, "bin", "previously"), BIN],
    [path.join(home, ".claude", "skills", "previously"), path.join(oldRoot, "skills", "previously"), SKILL],
    [path.join(root, "plugins", "previously.ts"), path.join(oldRoot, ".opencode", "plugins", "previously.ts"), path.join(ROOT, ".opencode", "plugins", "previously.ts")],
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
  assert.ok(fs.existsSync(path.join(root, "claude-cfg", "skills", "previously")));
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
  assert.match(fs.readFileSync(real, "utf8"), /previously hook claude Stop/);
});

test("foreign skill dirs are left alone; an @AGENTS.md CLAUDE.md gets no duplicate block", (t) => {
  const { repo } = sandbox(t);
  fs.mkdirSync(path.join(repo, ".claude", "skills", "previously"), { recursive: true });
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "@AGENTS.md\n");
  initRepo({ cwd: repo, agents: ["claude", "codex"] });
  assert.equal(fs.lstatSync(path.join(repo, ".claude", "skills", "previously")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /punk-records:start/);
});

test("--dry-run lists Claude files without writing them", (t) => {
  const { repo, home } = sandbox(t);
  const { touched } = initRepo({ cwd: repo, explicit: "global", agents: ["claude"], dryRun: true });
  assert.ok(touched.includes(path.join(home, ".claude", "settings.json")));
  assert.ok(touched.includes(path.join(home, ".local", "bin", "previously")));
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
  assert.equal(hooks.hooks.PostToolUse[0].matcher, MATCHERS.codex);
  const text = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
  assert.equal(text, `${toml}\n${block()}`);
  assert.equal(fs.readlinkSync(path.join(dir, "skills", "previously")), SKILL);
  assert.equal(fs.readlinkSync(path.join(home, ".local", "bin", "previously")), BIN);
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
  assert.deepEqual(groups[2].hooks.map((h) => h.command), ["previously hook codex PostToolUse"]);
});

test("Codex hook migration preserves foreign group and hook indices", (t) => {
  const { repo, home, read } = sandbox(t);
  const file = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { type: "command", command: "foreign stop" };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [
    { hooks: [{ type: "command", command: "punk-records hook codex Stop" }, foreign] },
    { hooks: [{ type: "command", command: "previously hook codex Stop" }] },
  ] } }));
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  const groups = read(file).hooks.Stop;
  assert.deepEqual(groups[0].hooks[1], foreign);
  assert.deepEqual(commandsOf(read(file), "Stop"), ["previously hook codex Stop", "foreign stop"]);
  assert.deepEqual(groups[1].hooks, []);
});

test("Claude hook identity stays the same across global and local upgrades", (t) => {
  const { repo, home, read } = sandbox(t);
  const global = path.join(home, ".claude", "settings.json");
  const local = path.join(repo, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.mkdirSync(path.dirname(local), { recursive: true });
  for (const first of ["global", "local"]) {
    const old = { hooks: { Stop: [{ hooks: [{ type: "command", command: "previously hook claude Stop" }] }] } };
    fs.writeFileSync(global, JSON.stringify(old));
    fs.writeFileSync(local, JSON.stringify(old));
    initRepo({ cwd: repo, explicit: first, agents: ["claude"] });
    assert.equal(commandsOf(read(global), "Stop")[0], commandsOf(read(local), "Stop")[0]);
    initRepo({ cwd: repo, explicit: first === "global" ? "local" : "global", agents: ["claude"] });
    assert.equal(commandsOf(read(global), "Stop")[0], commandsOf(read(local), "Stop")[0]);
  }
});

test("CODEX_HOME relocates Codex files", (t) => {
  const { root, repo, home } = sandbox(t);
  process.env.CODEX_HOME = path.join(root, "codex-home");
  initRepo({ cwd: repo, explicit: "global", agents: ["codex"] });
  for (const rel of ["hooks.json", "config.toml", path.join("skills", "previously")]) {
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
  assert.equal(fs.readlinkSync(path.join(repo, ".agents", "skills", "previously")), SKILL);
  assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /punk-records:start/);
  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), CODEX_PROJECT_HOOKS);
  if (CODEX_PROJECT_HOOKS) assert.deepEqual(commandsOf(read(path.join(repo, ".codex", "hooks.json")), "Stop"), ["previously hook codex Stop"]);
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
  assert.ok(fs.existsSync(path.join(repo, ".agents", "skills", "previously")));
  const warned = errors.mock.calls.map((c) => c.arguments[0]).filter((m) => /is not a directory/.test(m));
  assert.ok(warned.some((m) => m.includes(path.join(repo, ".codex"))), warned.join("\n"));
  assert.ok(warned.some((m) => m.includes(path.join(home, ".codex"))), warned.join("\n"));
});
