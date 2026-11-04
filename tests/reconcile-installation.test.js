import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/reconcile-installation.mjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile home '));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const env = {HOME: home, PATH: process.env.PATH};
  const write = (name, value = '') => {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, value);
    return file;
  };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {cwd: home, env, encoding: 'utf8'});
  return {home, env, write, run};
}

function snapshot(dir) {
  const result = {};
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), info = fs.lstatSync(file);
    result[name] = info.isSymbolicLink() ? {link: fs.readlinkSync(file)} : info.isDirectory() ? snapshot(file) : {text: fs.readFileSync(file, 'utf8'), mode: info.mode};
  }
  return result;
}

test('default preview writes nothing and does not print inherited values', t => {
  const f = fixture(t);
  f.write('.bashrc', "export PREVIOUSLY_SECURITY='1'\n");
  f.env.PREVIOUSLY_SECRET = 'sensitive-value';
  const before = snapshot(f.home), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview complete/);
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-value/);
  assert.deepEqual(snapshot(f.home), before);
});

test('isolated apply migrates stores, keeps profile values/mode and legacy alias; second apply is stable', t => {
  const f = fixture(t);
  const profile = f.write('.bashrc', "# preserve\nexport PREVIOUSLY_PYTHON='/some path/python'\nPREVIOUSLY_SECURITY=1 # keep\n");
  fs.chmodSync(profile, 0o640);
  f.write('.local/share/previously/events.jsonl');
  const old = f.write('old package/bin/previously', '#!/usr/bin/env node\n');
  f.write('old package/package.json', JSON.stringify({name: 'previously-on-localhost'}));
  fs.mkdirSync(path.join(f.home, '.local/bin'), {recursive: true});
  fs.symlinkSync(old, path.join(f.home, '.local/bin/punk-records'));
  fs.symlinkSync(old, path.join(f.home, '.local/bin/previously'));
  const repo = path.dirname(f.write('project with spaces/.previously'));
  const result = f.run('--apply', '--repo', repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(profile, 'utf8'), "# preserve\nexport PUNK_RECORDS_PYTHON='/some path/python'\nPUNK_RECORDS_SECURITY=1 # keep\n");
  assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
  assert.ok(fs.existsSync(path.join(f.home, '.local/share/punk-records/events.jsonl')));
  assert.ok(!fs.existsSync(path.join(f.home, '.local/share/previously')));
  assert.ok(fs.existsSync(path.join(repo, '.punk-records')));
  assert.equal(fs.readlinkSync(path.join(f.home, '.local/bin/punk-records')), path.join(root, 'bin/punk-records'));
  assert.equal(fs.readlinkSync(path.join(f.home, '.local/bin/previously')), old);
  const state = path.join(f.home, '.local/state/punk-records');
  const backup = path.join(state, fs.readdirSync(state)[0]);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(backup, '.bashrc')).mode & 0o777, 0o600);
  assert.match(JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'))).status, /^complete/);
  assert.equal(fs.statSync(path.join(backup, 'init-0.json')).mode & 0o777, 0o600);
  const hooks = fs.readFileSync(path.join(f.home, '.claude/settings.json'), 'utf8');
  const again = f.run('--apply', '--repo', repo);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(f.home, '.claude/settings.json'), 'utf8'), hooks);
});

test('environment/profile conflicts and unsupported syntax fail before changes', t => {
  for (const content of ['export PREVIOUSLY_SECURITY=1\nexport PUNK_RECORDS_SECURITY=0\n', 'if true; then export PREVIOUSLY_SECURITY=1; fi\n']) {
    const f = fixture(t);
    f.write('.bashrc', content);
    const before = snapshot(f.home), result = f.run('--apply');
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(f.home), before);
  }
  const f = fixture(t);
  f.env.PREVIOUSLY_SECURITY = '1'; f.env.PUNK_RECORDS_SECURITY = '0';
  const result = f.run('--apply');
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(f.home), {});
});

test('foreign executable, foreign executable link and symlink profile are refused without mutation', t => {
  for (const kind of ['executable', 'foreign link', 'profile']) {
    const f = fixture(t);
    if (kind === 'profile') fs.symlinkSync(f.write('real profile', 'export PREVIOUSLY_SECURITY=1\n'), path.join(f.home, '.bashrc'));
    else if (kind === 'foreign link') {
      const target = f.write('foreign/bin/punk-records', '#!/bin/sh\n');
      f.write('foreign/package.json', JSON.stringify({name: 'foreign'}));
      fs.mkdirSync(path.join(f.home, '.local/bin'), {recursive: true});
      fs.symlinkSync(target, path.join(f.home, '.local/bin/punk-records'));
    } else f.write('.local/bin/punk-records', '#!/bin/sh\n');
    const before = snapshot(f.home), result = f.run('--apply');
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(f.home), before);
  }
});

test('all selected init scopes preflight before applying anything', t => {
  const f = fixture(t);
  f.write('.bashrc', 'export PREVIOUSLY_SECURITY=1\n');
  const repo = path.dirname(f.write('broken project/.mcp.json', '{invalid'));
  const before = snapshot(f.home), result = f.run('--apply', '--repo', repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /init --local failed/);
  assert.deepEqual(snapshot(f.home), before);
});

test('registered selects configured projects but skips stale and memory-only entries', t => {
  const f = fixture(t);
  const configured = path.dirname(f.write('configured project/.previously'));
  const memoryOnly = path.dirname(path.dirname(f.write('memory only/.previously/events.jsonl')));
  f.write('memory only/.codex');
  f.write('memory only/.mcp.json', JSON.stringify({description: 'previously', mcpServers: {notes: {command: 'node', args: ['/srv/previously-on-localhost/notes.js']}}}));
  const commentOnly = path.dirname(path.dirname(f.write('comment only/.codex/config.toml', '# previously configured other service\n')));
  const hooked = path.dirname(f.write('hooked project/.mcp.json', JSON.stringify({mcpServers: {previously: {command: 'previously', args: ['mcp']}}})));
  const opencodeV2 = path.dirname(f.write('opencode v2 project/opencode.json', JSON.stringify({mcp: {servers: {'punk-records': {command: ['punk-records', 'mcp']}}}})));
  f.write('.local/share/previously/projects.txt', `${configured}\n${hooked}\n${opencodeV2}\n${memoryOnly}\n${commentOnly}\n${f.home}/missing\n`);
  const before = snapshot(f.home), result = f.run('--registered');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skip stale registration/);
  assert.match(result.stdout, /Skip registration without local configuration/);
  assert.match(result.stdout, /Preflight --local: .*configured project/);
  assert.match(result.stdout, /Preflight --local: .*hooked project/);
  assert.match(result.stdout, /Preflight --local: .*opencode v2 project/);
  assert.doesNotMatch(result.stdout, /Preflight --local: .*memory only/);
  assert.doesNotMatch(result.stdout, /Preflight --local: .*comment only/);
  assert.deepEqual(snapshot(f.home), before);
});

test('source path with spaces is used for init and aliases', t => {
  const f = fixture(t);
  const source = path.join(f.home, 'source with spaces');
  fs.mkdirSync(source);
  for (const name of ['package.json', 'bin', 'lib', 'skills', 'commands', '.opencode']) {
    const from = path.join(root, name);
    if (fs.existsSync(from)) fs.symlinkSync(from, path.join(source, name));
  }
  const result = f.run('--apply', '--source', source);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readlinkSync(path.join(f.home, '.local/bin/punk-records')), path.join(source, 'bin/punk-records'));
});

test('--details keeps preview read-only with normalized child environment', t => {
  const f = fixture(t);
  f.env.PREVIOUSLY_SECURITY = '0';
  const before = snapshot(f.home), result = f.run('--details');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.home), before);
});

test('preexisting profile and alias temporary files are never removed', t => {
  for (const kind of ['profile', 'alias']) {
    const f = fixture(t);
    const destination = kind === 'profile' ? f.write('.bashrc', 'PREVIOUSLY_SECURITY=0\n') : path.join(f.home, '.local/bin/punk-records');
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    const code = `import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(destination)} + '.punk-records-' + process.pid, 'keep');
      process.argv = [process.execPath, ${JSON.stringify(script)}, '--apply'];
      await import(${JSON.stringify(script)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {cwd: f.home, env: f.env, encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    const temporary = fs.readdirSync(path.dirname(destination)).find(name => name.startsWith(path.basename(destination) + '.punk-records-'));
    assert.ok(temporary);
    assert.equal(fs.readFileSync(path.join(path.dirname(destination), temporary), 'utf8'), 'keep');
  }
});
