import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '../bin/previously');
const hasPython = spawnSync('python3', ['--version']).status === 0;

test('episodes indexes a Claude Code session and shows its prompts', {skip: !hasPython && 'python3 not found'}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-episodes-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const sid = '0b5e1d2c-0000-4000-8000-000000000001';
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'projects', '-p-demo'), {recursive: true});
  fs.writeFileSync(path.join(claude, 'history.jsonl'),
    JSON.stringify({sessionId: sid, timestamp: Date.now(), display: 'fix the zebra login bug', project: '/p/demo/.worktrees/feat'}) + '\n' +
    JSON.stringify({sessionId: sid, timestamp: Date.now(), display: '/clear', project: '/p/demo'}) + '\n');
  fs.writeFileSync(path.join(claude, 'projects', '-p-demo', `${sid}.jsonl`),
    JSON.stringify({aiTitle: 'Zebra login', gitBranch: 'feat', cwd: '/p/demo/.worktrees/feat'}) + '\n');
  const env = {...process.env, HOME: home, PREVIOUSLY_HOME: path.join(home, 'store'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: ''};
  const run = args => spawnSync(process.execPath, [CLI, 'episodes', ...args], {env, encoding: 'utf8'});

  const recent = run([]);
  assert.equal(recent.status, 0, recent.stderr);
  assert.match(recent.stdout, /\/p\/demo \[feat\]/, 'worktree rolls up into its project');
  assert.match(recent.stdout, /title: Zebra login/);
  assert.match(recent.stdout, new RegExp(`claude --resume ${sid}`));
  assert.doesNotMatch(recent.stdout, /\/clear/, 'slash commands are not prompts');
  assert.ok(fs.existsSync(path.join(home, 'store', 'episodes.db')));

  const show = run(['show', sid.slice(0, 8)]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /fix the zebra login bug/);
  assert.match(run(['--help']).stdout, /previously episodes timeline/);
});

test('episodes without Python says so instead of crashing', () => {
  const res = spawnSync(process.execPath, [CLI, 'episodes'], {env: {...process.env, PREVIOUSLY_PYTHON: 'no-such-python-xyz'}, encoding: 'utf8'});
  assert.equal(res.status, 2);
  assert.match(res.stderr, /episodes needs Python 3\.9\+/);
});
