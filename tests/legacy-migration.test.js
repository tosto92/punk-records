import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initRepo} from '../lib/init.js';
import {globalDir, resolveScopes} from '../lib/paths.js';
import {migrateTomlEnv} from '../lib/legacy-migration.js';

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-migrate-'));
  const saved = {...process.env};
  for (const key of Object.keys(process.env)) if (/^(PREVIOUSLY_|PUNK_RECORDS_)/.test(key)) delete process.env[key];
  process.env.HOME = path.join(root, 'home');
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  t.after(() => {for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true});});
  return {root, cwd, old: path.join(process.env.HOME, '.local/share/previously'), current: globalDir()};
}

test('init migrates a global store and SQLite database, with a dry run and no-op repeat', t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true});
  for (const suffix of ['']) fs.writeFileSync(path.join(old, `episodes.db${suffix}`), `data${suffix}`);
  initRepo({cwd, explicit: 'global', agents: ['opencode'], dryRun: true});
  assert.ok(fs.existsSync(path.join(old, 'episodes.db'))); assert.ok(!fs.existsSync(current));
  initRepo({cwd, explicit: 'global', agents: ['opencode']});
  for (const suffix of ['']) assert.equal(fs.readFileSync(path.join(current, `sessions.db${suffix}`), 'utf8'), `data${suffix}`);
  assert.ok(!fs.existsSync(old));
  assert.deepEqual(initRepo({cwd, explicit: 'global', agents: ['opencode']}).touched, []);
});

test('store and database conflicts abort before creating config or modifying data', t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true}); fs.mkdirSync(current, {recursive: true});
  fs.writeFileSync(path.join(old, 'events.jsonl'), 'old'); fs.writeFileSync(path.join(current, 'events.jsonl'), 'new');
  assert.throws(() => initRepo({cwd, explicit: 'global', agents: ['opencode']}), /conflict/i);
  assert.equal(fs.readFileSync(path.join(old, 'events.jsonl'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(process.env.HOME, '.config')));
});

test('runtime ignores legacy env and marker; explicit local init migrates the selected legacy project', t => {
  const {cwd, root} = sandbox(t);
  process.env.PREVIOUSLY_HOME = path.join(root, 'old-custom');
  assert.notEqual(globalDir(), process.env.PREVIOUSLY_HOME);
  assert.throws(() => initRepo({cwd, explicit: 'local', agents: ['opencode']}), /PUNK_RECORDS_HOME/);
  delete process.env.PREVIOUSLY_HOME;
  fs.writeFileSync(path.join(cwd, '.previously'), ''); fs.mkdirSync(path.join(cwd, 'sub'));
  assert.equal(resolveScopes({}, cwd).repoRoot, null);
  initRepo({cwd: path.join(cwd, 'sub'), explicit: 'local', agents: ['opencode']});
  assert.ok(fs.existsSync(path.join(cwd, '.punk-records'))); assert.ok(!fs.existsSync(path.join(cwd, '.previously')));
});

test('literal generated hooks migrate while timeout, synthesis and foreign handlers survive', t => {
  const {cwd} = sandbox(t);
  const file = path.join(cwd, '.claude/settings.json'); fs.mkdirSync(path.dirname(file), {recursive: true});
  const hook = {type: 'command', command: 'env PREVIOUSLY_SYNTHESIS=1 previously hook claude Stop', timeout: 41, async: true};
  fs.writeFileSync(file, JSON.stringify({hooks: {Stop: [{hooks: [hook, {type: 'command', command: 'foreign stop'}]}]}}));
  initRepo({cwd, explicit: 'local', agents: ['claude']});
  const hooks = JSON.parse(fs.readFileSync(file)).hooks.Stop[0].hooks;
  assert.deepEqual(hooks, [{...hook, command: 'env PUNK_RECORDS_SYNTHESIS=1 punk-records hook claude Stop'}, {type: 'command', command: 'foreign stop'}]);
  assert.ok(fs.existsSync(`${file}.punk-records-bak`));
});

test('a nearer canonical project leaves an outer legacy marker untouched', t => {
  const {cwd, root} = sandbox(t);
  fs.writeFileSync(path.join(root, '.previously'), '');
  fs.writeFileSync(path.join(cwd, '.punk-records'), '');
  initRepo({cwd, explicit: 'local', agents: ['opencode']});
  assert.ok(fs.existsSync(path.join(root, '.previously')));
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')));
});

for (const suffix of ['-wal', '-shm', '-journal']) test(`init refuses legacy SQLite ${suffix} before moving the store`, t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true});
  fs.writeFileSync(path.join(old, 'episodes.db'), 'db');
  fs.writeFileSync(path.join(old, `episodes.db${suffix}`), 'sidecar');
  assert.throws(() => initRepo({cwd, explicit: 'global', agents: ['opencode']}), /close all agent sessions and checkpoint/);
  assert.ok(fs.existsSync(path.join(old, `episodes.db${suffix}`)));
  assert.ok(!fs.existsSync(current));
});

test('managed TOML environment migration leaves quoted values and comments unchanged', () => {
  const text = 'env = { PREVIOUSLY_HOME = "old", EXTRA = "PREVIOUSLY_HOME=value" } # PREVIOUSLY_HOME=comment\n';
  assert.equal(migrateTomlEnv(text, 'test'), text.replace('PREVIOUSLY_HOME =', 'PUNK_RECORDS_HOME ='));
  assert.equal(migrateTomlEnv('[mcp_servers.previously.env]\nPREVIOUSLY_HOME = "PREVIOUSLY_HOME=value" # PREVIOUSLY_HOME=comment', 'test'), '[mcp_servers.previously.env]\nPUNK_RECORDS_HOME = "PREVIOUSLY_HOME=value" # PREVIOUSLY_HOME=comment');
});

for (const quoted of ['"PREVIOUSLY_HOME"', '"PUNK_RECORDS_HOME"', "'PREVIOUSLY_HOME'", "'PUNK_RECORDS_HOME'", '"\\u0050UNK_RECORDS_HOME"']) test(`quoted managed TOML key ${quoted} refuses preflight`, t => {
  const {cwd} = sandbox(t);
  const file = path.join(cwd, '.codex/config.toml');
  fs.mkdirSync(path.dirname(file));
  const text = `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = ["/old/bin/previously", "mcp"]\nenv = { PREVIOUSLY_HOME = "same", ${quoted} = "same" }\n# previously:end\n`;
  fs.writeFileSync(file, text);
  assert.throws(() => initRepo({cwd, explicit: 'local', agents: ['codex']}), /quoted managed environment key/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.ok(!fs.existsSync(path.join(cwd, '.punk-records')));
  assert.ok(!fs.existsSync(path.join(cwd, 'memory')));
});

for (const value of ['same', 'different']) test(`dual managed TOML environment keys fail preflight (${value})`, t => {
  const {cwd} = sandbox(t);
  fs.mkdirSync(path.join(cwd, '.codex'));
  const file = path.join(cwd, '.codex/config.toml');
  const text = `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = ["/old/bin/previously", "mcp"]\nenv = { PREVIOUSLY_HOME = "same", PUNK_RECORDS_HOME = "${value}" }\n# previously:end\n`;
  fs.writeFileSync(file, text);
  assert.throws(() => initRepo({cwd, explicit: 'local', agents: ['codex']}), /duplicate\/conflicting/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.ok(!fs.existsSync(path.join(cwd, '.punk-records')));
});

test('foreign MCP conflicting environment is left alone while a global store migrates', t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true}); fs.writeFileSync(path.join(old, 'events.jsonl'), '');
  const file = path.join(process.env.HOME, '.config/opencode/opencode.json');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const config = {mcp: {'punk-records': {command: ['foreign'], env: {PREVIOUSLY_HOME: 'a', PUNK_RECORDS_HOME: 'b'}}}};
  fs.writeFileSync(file, JSON.stringify(config));
  initRepo({cwd, explicit: 'global', agents: ['opencode']});
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), config);
  assert.ok(fs.existsSync(current));
});

for (const platform of ['claude', 'opencode']) for (const conflict of [null, 'env', 'option']) test(`dual managed ${platform} MCP aliases ${conflict ?? 'merge environment'}`, t => {
  const {cwd} = sandbox(t);
  const bin = path.resolve('bin/punk-records');
  const entry = platform === 'claude' ? {command: 'node', args: [bin, 'mcp']} : {type: 'local', command: ['node', bin, 'mcp']};
  const aliases = {
    previously: {...entry, env: {PREVIOUSLY_SECURITY: '1'}, startup_timeout_sec: 20},
    'punk-records': {...entry, env: {PUNK_RECORDS_SYNTHESIS: '1'}, ...(conflict === 'env' ? {env: {PUNK_RECORDS_SECURITY: '0'}} : {}), ...(conflict === 'option' ? {startup_timeout_sec: 30} : {})},
  };
  const file = path.join(cwd, platform === 'claude' ? '.mcp.json' : 'opencode.json');
  const config = platform === 'claude' ? {mcpServers: aliases} : {mcp: aliases};
  fs.writeFileSync(file, JSON.stringify(config));
  const run = () => initRepo({cwd, explicit: 'local', agents: [platform]});
  if (conflict) {
    assert.throws(run, /conflicting managed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), config);
    assert.ok(!fs.existsSync(path.join(cwd, '.punk-records')));
  } else {
    run();
    const result = JSON.parse(fs.readFileSync(file));
    const servers = result.mcpServers ?? result.mcp;
    assert.equal(servers.previously, undefined);
    assert.deepEqual(servers['punk-records'].env, {PUNK_RECORDS_SECURITY: '1', PUNK_RECORDS_SYNTHESIS: '1'});
    assert.equal(servers['punk-records'].startup_timeout_sec, 20);
  }
});

test('init removes verified legacy links and preserves unrelated paths and existing executable aliases', t => {
  const {cwd} = sandbox(t);
  const root = path.resolve('.');
  const owned = path.join(cwd, '.claude/skills/previously');
  const foreign = path.join(cwd, '.claude/skills/previously-episodes');
  fs.mkdirSync(path.dirname(owned), {recursive: true});
  fs.symlinkSync(path.join(root, 'skills/previously'), owned);
  fs.mkdirSync(foreign);
  initRepo({cwd, explicit: 'local', agents: ['claude']});
  assert.equal(fs.lstatSync(owned, {throwIfNoEntry: false}), undefined);
  assert.ok(fs.statSync(foreign).isDirectory());
  const alias = path.join(process.env.HOME, '.local/bin/previously');
  fs.mkdirSync(path.dirname(alias), {recursive: true}); fs.symlinkSync(path.join(root, 'bin/punk-records'), alias);
  initRepo({cwd, explicit: 'global', agents: ['claude']});
  assert.ok(fs.lstatSync(alias).isSymbolicLink());
});

for (const format of ['json', 'toml', 'toml-table']) for (const key of ['PREVIOUSLY_HOME', 'PUNK_RECORDS_HOME']) for (const custom of [false, true]) test(`managed ${format} ${key} follows only the planned default-store move (custom=${custom})`, t => {
  const {cwd, old, current, root} = sandbox(t);
  fs.mkdirSync(old, {recursive: true});
  const events = '{"data":"preserve byte for byte"}\n'; fs.writeFileSync(path.join(old, 'events.jsonl'), events);
  const home = custom ? path.join(root, 'custom-store') : old;
  const bin = path.resolve('bin/punk-records');
  const file = format === 'json' ? path.join(process.env.HOME, '.claude.json') : path.join(process.env.HOME, '.codex/config.toml');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, format === 'json'
    ? JSON.stringify({mcpServers: {previously: {command: 'node', args: [bin, 'mcp'], env: {[key]: home}}}})
    : `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = [${JSON.stringify(bin)}, "mcp"]\n${format === "toml-table" ? `[mcp_servers.previously.env]\n${key} = ${JSON.stringify(home)}\nEXTRA = ${JSON.stringify(old)}` : `env = { ${key} = ${JSON.stringify(home)}, EXTRA = ${JSON.stringify(old)} }`}\n# previously:end\n`);
  initRepo({cwd, explicit: 'global', agents: [format === 'json' ? 'claude' : 'codex']});
  const expected = custom ? home : current;
  if (format === 'json') assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers['punk-records'].env.PUNK_RECORDS_HOME, expected);
  else {
    assert.ok(fs.readFileSync(file, 'utf8').includes(`PUNK_RECORDS_HOME = ${JSON.stringify(expected)}`));
    assert.ok(fs.readFileSync(file, 'utf8').includes(`EXTRA = ${JSON.stringify(old)}`));
  }
  assert.equal(fs.readFileSync(path.join(current, 'events.jsonl'), 'utf8'), events);
});

for (const suffix of ['-wal', '-shm', '-journal']) test(`moving the default store refuses canonical SQLite ${suffix}`, t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true});
  fs.writeFileSync(path.join(old, 'sessions.db'), 'database');
  fs.writeFileSync(path.join(old, `sessions.db${suffix}`), 'pending data');
  assert.throws(() => initRepo({cwd, explicit: 'global', agents: ['opencode']}), /close all agent sessions and checkpoint/);
  assert.equal(fs.readFileSync(path.join(old, `sessions.db${suffix}`), 'utf8'), 'pending data');
  assert.ok(!fs.existsSync(current));
  assert.ok(!fs.existsSync(path.join(process.env.HOME, '.config')));
});

test('explicit store override keeps its managed HOME and prevents the default-directory move', t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true}); fs.writeFileSync(path.join(old, 'events.jsonl'), 'original');
  process.env.PUNK_RECORDS_HOME = old;
  const file = path.join(process.env.HOME, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({mcpServers: {previously: {command: 'node', args: [path.resolve('bin/punk-records'), 'mcp'], env: {PREVIOUSLY_HOME: old}}}}));
  initRepo({cwd, explicit: 'global', agents: ['claude']});
  assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers['punk-records'].env.PUNK_RECORDS_HOME, old);
  assert.equal(fs.readFileSync(path.join(old, 'events.jsonl'), 'utf8'), 'original');
  assert.ok(!fs.existsSync(current));
});

for (const format of ['json', 'toml']) test(`local ${format} init keeps managed HOME when no default-store move is planned`, t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true});
  const file = path.join(cwd, format === 'json' ? '.mcp.json' : '.codex/config.toml');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const bin = path.resolve('bin/punk-records');
  fs.writeFileSync(file, format === 'json'
    ? JSON.stringify({mcpServers: {'punk-records': {command: 'node', args: [bin, 'mcp'], env: {PUNK_RECORDS_HOME: old}}}})
    : `# punk-records:start\n[mcp_servers.punk-records]\ncommand = "node"\nargs = [${JSON.stringify(bin)}, "mcp"]\nenv = { PUNK_RECORDS_HOME = ${JSON.stringify(old)} }\n# punk-records:end\n`);
  initRepo({cwd, explicit: 'local', agents: [format === 'json' ? 'claude' : 'codex']});
  if (format === 'json') assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers['punk-records'].env.PUNK_RECORDS_HOME, old);
  else assert.ok(fs.readFileSync(file, 'utf8').includes(`PUNK_RECORDS_HOME = ${JSON.stringify(old)}`));
  assert.ok(fs.existsSync(old)); assert.ok(!fs.existsSync(path.join(current, "events.jsonl")));
});

test('unsupported managed TOML refuses a planned store move before changing config or data', t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true}); fs.writeFileSync(path.join(old, 'events.jsonl'), 'original events');
  const file = path.join(process.env.HOME, '.codex/config.toml');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const text = `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = ["/old/bin/previously", "mcp"]\nenv = { PREVIOUSLY_HOME = ${JSON.stringify(old)} }\ncustom = """unsupported custom value"""\n# previously:end\n`;
  fs.writeFileSync(file, text);
  assert.throws(() => initRepo({cwd, explicit: 'global', agents: ['codex']}), /custom managed MCP block.*migrate.*before.*store/i);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(old, 'events.jsonl'), 'utf8'), 'original events');
  assert.ok(!fs.existsSync(current));
  assert.ok(!fs.existsSync(path.join(process.env.HOME, '.codex/hooks.json')));
});

for (const format of ['json', 'toml']) for (const suffix of ['/', '/.']) for (const mode of ['move', 'local', 'custom']) test(`normalized ${format} HOME ${suffix} (${mode})`, t => {
  const {cwd, old, current, root} = sandbox(t);
  fs.mkdirSync(old, {recursive: true}); fs.writeFileSync(path.join(old, 'events.jsonl'), 'original events');
  const home = (mode === 'custom' ? path.join(root, 'custom-store') : old) + suffix;
  const file = format === 'json' ? path.join(mode === 'local' ? cwd : process.env.HOME, mode === 'local' ? '.mcp.json' : '.claude.json') : path.join(mode === 'local' ? cwd : process.env.HOME, '.codex/config.toml');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const bin = path.resolve('bin/punk-records');
  fs.writeFileSync(file, format === 'json'
    ? JSON.stringify({mcpServers: {'punk-records': {command: 'node', args: [bin, 'mcp'], env: {PUNK_RECORDS_HOME: home}}}})
    : `# punk-records:start\n[mcp_servers.punk-records]\ncommand = "node"\nargs = [${JSON.stringify(bin)}, "mcp"]\nenv = { PUNK_RECORDS_HOME = ${JSON.stringify(home)} }\n# punk-records:end\n`);
  initRepo({cwd, explicit: mode === 'local' ? 'local' : 'global', agents: [format === 'json' ? 'claude' : 'codex']});
  const expected = mode === 'move' ? current : home;
  if (format === 'json') assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers['punk-records'].env.PUNK_RECORDS_HOME, expected);
  else assert.ok(fs.readFileSync(file, 'utf8').includes(`PUNK_RECORDS_HOME = ${JSON.stringify(expected)}`));
  assert.equal(fs.readFileSync(path.join(mode === 'local' ? old : current, 'events.jsonl'), 'utf8'), 'original events');
});

test('undecodable managed TOML HOME refuses store relocation without changing config or events', t => {
  const {cwd, old, current} = sandbox(t);
  fs.mkdirSync(old, {recursive: true}); fs.writeFileSync(path.join(old, 'events.jsonl'), 'original events');
  const file = path.join(process.env.HOME, '.codex/config.toml');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const home = `"\\U0000002f${old.slice(1)}"`;
  const text = `# previously:start\n[mcp_servers.previously]\ncommand = "node"\nargs = ["/old/bin/previously", "mcp"]\nenv = { PREVIOUSLY_HOME = ${home} }\n# previously:end\n`;
  fs.writeFileSync(file, text);
  assert.throws(() => initRepo({cwd, explicit: 'global', agents: ['codex']}), /cannot decode managed HOME.*before moving the default store/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(old, 'events.jsonl'), 'utf8'), 'original events');
  assert.ok(!fs.existsSync(current));
  assert.ok(!fs.existsSync(path.join(process.env.HOME, '.codex/hooks.json')));
});
