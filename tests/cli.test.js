import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, execFileSync} from 'node:child_process';

test('Punk Records is the only package CLI name', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.name, 'punk-records');
  assert.equal(pkg.bin['punk-records'], 'bin/punk-records');
  assert.deepEqual(Object.keys(pkg.bin), ['punk-records', 'punk-records-synthesize', 'brainbrain', 'brainbrain-synthesize']);
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '../bin/previously')), false);
  for (const file of [pkg.bin['punk-records']]) {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', file), '--help'], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Punk Records — session memory for coding agents/m);
    assert.match(result.stdout, /^usage: punk-records /m);
  }
});

test('init rejects its first unknown flag before any writes', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-flags-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q'], {cwd: repo});
  const before = fs.readdirSync(repo);
  const cli = path.resolve(import.meta.dirname, '../bin/punk-records');
  const result = spawnSync(process.execPath, [cli, 'init', '--dry-ru'], {cwd: repo, encoding: 'utf8',
    env: {...process.env, PUNK_RECORDS_HOME: path.join(repo, 'home'), PUNK_RECORDS_PLUGINS: path.join(repo, 'plugins'),
      PUNK_RECORDS_SKILLS: path.join(repo, 'skills'), PUNK_RECORDS_CONFIG: path.join(repo, 'global.json')}});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag/);
  assert.deepEqual(fs.readdirSync(repo), before);
});

test('CLI saves and promotes without title then finds without build', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-live-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cli = path.resolve(import.meta.dirname, '../bin/punk-records');
  const run = args => spawnSync(process.execPath, [cli, ...args], {cwd: home, env: {...process.env, PUNK_RECORDS_HOME: home}, encoding: 'utf8'});
  const first = run(['save', '--global', '--type', 'note', '--title', 'cli zebra']);
  assert.equal(first.status, 0);
  const saved = JSON.parse(first.stdout);
  assert.match(saved.memoryId, /^[0-9a-f]{40}$/);
  assert.equal(run(['save', '--global', '--ref', saved.slug, '--type', 'solved', '--solution', 'restart', '--outcome', 'ok']).status, 0);
  const found = run(['ask', 'cli zebra', '--scope', 'global']);
  assert.equal(found.status, 0);
  assert.match(found.stdout, /restart/);
  assert.match(found.stdout, new RegExp(saved.memoryId));
  assert.match(found.stdout, /\(ok,/);
  assert.equal(fs.existsSync(path.join(home, 'index.json')), false);
});

test('init writes the chosen API format and rejects an unknown one', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-init-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q'], {cwd: repo});
  const cli = path.resolve(import.meta.dirname, '../bin/punk-records');
  const env = {...process.env, HOME: path.join(repo, 'home'), PUNK_RECORDS_HOME: path.join(repo, 'home'), PUNK_RECORDS_PLUGINS: path.join(repo, 'plugins'),
    PUNK_RECORDS_SKILLS: path.join(repo, 'skills'), PUNK_RECORDS_CONFIG: path.join(repo, 'global.json')};
  const run = args => spawnSync(process.execPath, [cli, 'init', ...args], {cwd: repo, env, encoding: 'utf8'});

  assert.equal(run(['--opencode-api', 'v2', '--local']).status, 0);
  const v2 = JSON.parse(fs.readFileSync(path.join(repo, 'opencode.json'), 'utf8'));
  assert.equal(v2.mcp.servers['punk-records'].disabled, false);
  assert.equal(v2.mcp['punk-records'], undefined);
  const bad = run(['--opencode-api', 'v3', '--local']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /opencode-api/);
  assert.equal(run(['--nope']).status, 2);
});

test('--help lists every command, --version matches package.json, unknown commands point to help', () => {
  const cli = path.resolve(import.meta.dirname, '../bin/punk-records');
  const run = args => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
  const help = run(['--help']);
  assert.equal(help.status, 0);
  for (const cmd of ['init', 'ask', 'save', 'graph', 'build', 'check', 'scan', 'review', 'migrate', 'sessions', 'mcp', 'hook']) assert.match(help.stdout, new RegExp(`^  ${cmd}\\b`, 'm'));
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(run(['--version']).stdout.trim(), pkg.version);
  assert.equal(run(['episodes']).status, 2);
  const bad = run(['nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command 'nope'.*--help/);
});


test('the CLI supports full before or after query and preserve default output', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-full-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const env = {...process.env, PUNK_RECORDS_HOME: home,
    PUNK_RECORDS_SECURITY: '0', PUNK_RECORDS_SYNTHESIS: '0'};
  for (const alias of ['punk-records']) {
    const cli = path.resolve(import.meta.dirname, '../bin', alias);
    const run = args => spawnSync(process.execPath, [cli, ...args], {cwd: home, env, encoding: 'utf8'});
    const saved = run(['save', '--global', '--type', 'solved', '--title', 'cli zebra', '--solution', 'one\ntwo\nthree\nTAIL-CONDITION']);
    assert.equal(saved.status, 0, saved.stderr);
    const memoryId = JSON.parse(saved.stdout).memoryId;
    const ordinary = run(['ask', 'zebra']);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.doesNotMatch(ordinary.stdout, /TAIL-CONDITION/);
    for (const args of [['ask', '--full', 'zebra'], ['ask', 'zebra', '--full']]) {
      const result = run(args); assert.equal(result.status, 0, result.stderr);
      const hits = JSON.parse(result.stdout);
      assert.equal(hits[0].memory.memoryId, memoryId);
      assert.match(hits[0].memory.solution, /TAIL-CONDITION/);
    }
    assert.equal(run(['ask', 'unmatched-query', '--full']).stdout, '[]\n');
    assert.equal(run(['ask', 'unmatched-query']).stdout, '');
    for (const args of [['ask', '--full'], ['ask', 'zebra', '--unknown']]) assert.equal(run(args).status, 2);
    assert.match(run(['--help']).stdout, /ask <query>.*\[--full\]/);
  }
});

for (const dryRun of [true, false]) test(`CLI init reconciles covered Claude project hooks (${dryRun ? 'dry-run' : 'normal'})`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-claude-coverage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); execFileSync('git', ['init', '-q'], {cwd: repo});
  const global = path.join(home, '.claude', 'settings.json'), local = path.join(repo, '.claude', 'settings.json');
  const configs = [[global, {hooks: {UserPromptSubmit: [{hooks: [{type: 'command', command: 'env PUNK_RECORDS_SYNTHESIS=1 punk-records hook claude UserPromptSubmit'}]}]}}],
    [local, {hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{hooks: [{type: 'command', command: `punk-records hook claude ${event}`}]}]]))}]];
  const localConfig = configs[1][1], foreignGroup = {hooks: [{type: 'command', command: 'foreign recall', timeout: 7}]};
  localConfig.permissions = {allow: ['Bash(ls)']};
  localConfig.hooks.PreToolUse = [{matcher: 'custom', hooks: [{type: 'command', command: 'foreign pre-tool'}]}];
  localConfig.hooks.UserPromptSubmit.unshift(foreignGroup);
  for (const [file, config] of configs) { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(config)); }
  const snapshot = () => fs.readdirSync(root, {recursive: true}).sort().map(rel => {
    const file = path.join(root, rel); return [rel, fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null];
  });
  const before = snapshot();
  const run = (args = []) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/punk-records'), 'init', '--local', '--agents', 'claude', ...args],
    {cwd: repo, encoding: 'utf8', env: {...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.dirname(global), PUNK_RECORDS_HOME: path.join(root, 'store')}});
  const result = run(dryRun ? ['--dry-run'] : []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.claude\/settings\.json/);
  assert.equal(fs.readFileSync(global, 'utf8'), JSON.stringify(configs[0][1]));
  if (dryRun) assert.deepEqual(snapshot(), before);
  else {
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), {...localConfig,
      hooks: {...localConfig.hooks, UserPromptSubmit: [foreignGroup, {hooks: []}]}});
    const reconciled = snapshot(), repeated = run();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.doesNotMatch(repeated.stdout, /\.claude\/settings\.json/);
    assert.deepEqual(snapshot(), reconciled);
  }
});
