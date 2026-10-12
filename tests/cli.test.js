import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, execFileSync} from 'node:child_process';

test('Punk Records is the package and CLI name while the old CLI still runs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.name, 'punk-records');
  assert.equal(pkg.bin['punk-records'], 'bin/punk-records');
  assert.equal(pkg.bin.previously, 'bin/previously');
  for (const file of [pkg.bin['punk-records'], pkg.bin.previously]) {
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
  const cli = path.resolve(import.meta.dirname, '../bin/previously');
  const result = spawnSync(process.execPath, [cli, 'init', '--dry-ru'], {cwd: repo, encoding: 'utf8',
    env: {...process.env, PREVIOUSLY_HOME: path.join(repo, 'home'), PREVIOUSLY_PLUGINS: path.join(repo, 'plugins'),
      PREVIOUSLY_SKILLS: path.join(repo, 'skills'), PREVIOUSLY_CONFIG: path.join(repo, 'global.json')}});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag/);
  assert.deepEqual(fs.readdirSync(repo), before);
});

test('CLI saves and promotes without title then finds without build', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-live-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const cli = path.resolve(import.meta.dirname, '../bin/previously');
  const run = args => spawnSync(process.execPath, [cli, ...args], {cwd: home, env: {...process.env, PREVIOUSLY_HOME: home}, encoding: 'utf8'});
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
  const cli = path.resolve(import.meta.dirname, '../bin/previously');
  const env = {...process.env, HOME: path.join(repo, 'home'), PREVIOUSLY_HOME: path.join(repo, 'home'), PREVIOUSLY_PLUGINS: path.join(repo, 'plugins'),
    PREVIOUSLY_SKILLS: path.join(repo, 'skills'), PREVIOUSLY_CONFIG: path.join(repo, 'global.json')};
  const run = args => spawnSync(process.execPath, [cli, 'init', ...args], {cwd: repo, env, encoding: 'utf8'});

  assert.equal(run(['--opencode-api', 'v2', '--local']).status, 0);
  const v2 = JSON.parse(fs.readFileSync(path.join(repo, 'opencode.json'), 'utf8'));
  assert.equal(v2.mcp.servers['punk-records'].disabled, false);
  assert.equal(v2.mcp['previously'], undefined);
  const bad = run(['--opencode-api', 'v3', '--local']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /opencode-api/);
  assert.equal(run(['--nope']).status, 2);
});

test('--help lists every command, --version matches package.json, unknown commands point to help', () => {
  const cli = path.resolve(import.meta.dirname, '../bin/previously');
  const run = args => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
  const help = run(['--help']);
  assert.equal(help.status, 0);
  for (const cmd of ['init', 'ask', 'save', 'graph', 'build', 'check', 'scan', 'review', 'migrate', 'episodes', 'mcp', 'hook']) assert.match(help.stdout, new RegExp(`^  ${cmd}\\b`, 'm'));
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(run(['--version']).stdout.trim(), pkg.version);
  const bad = run(['nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command 'nope'.*--help/);
});
