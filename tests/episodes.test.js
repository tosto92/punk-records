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

  const api = JSON.parse(run(['api', '/api/session', `id=${sid.slice(0, 8)}`]).stdout);
  assert.equal(api.session.title, 'Zebra login');
  assert.match(JSON.parse(run(['api', '/api/data', 'q=zebra']).stdout).projects[0].project, /\/p\/demo/);
});

test('episodes without Python says so instead of crashing', () => {
  const res = spawnSync(process.execPath, [CLI, 'episodes'], {env: {...process.env, PREVIOUSLY_PYTHON: 'no-such-python-xyz'}, encoding: 'utf8'});
  assert.equal(res.status, 2);
  assert.match(res.stderr, /episodes needs Python 3\.9\+/);
});

test('resume commands quote paths and session IDs as single shell arguments', {skip: !hasPython && 'python3 not found'}, () => {
  const res = spawnSync('python3', ['-c', `
import importlib.util, shlex
spec = importlib.util.spec_from_file_location('episodes', 'lib/episodes/sessions.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
for tool in ('claude', 'codex'):
    cwd = "/tmp/my project/it's $HOME; echo unsafe"
    sid = "session id'; echo unsafe"
    r = {'tool': tool, 'cwd': cwd, 'id': sid}
    assert shlex.split(m.resume(r)) == ['cd', cwd, '&&', tool, '--resume' if tool == 'claude' else 'resume', sid]
`], {cwd: path.dirname(path.dirname(CLI)), encoding: 'utf8'});
  assert.equal(res.status, 0, res.stderr);
});

test('episode searches find intermediate prompts consistently without duplicate sessions', {skip: !hasPython && 'python3 not found'}, () => {
  const res = spawnSync('python3', ['-c', `
import importlib.util, sqlite3, time
spec = importlib.util.spec_from_file_location('episodes', 'lib/episodes/sessions.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
db = sqlite3.connect(':memory:'); db.row_factory = sqlite3.Row; db.executescript(m.SCHEMA)
now = time.mktime((*time.localtime()[:3], 12, 0, 0, 0, 0, -1))
for sid, title, branch in [('wanted', 'Auth title', 'feature/auth'), ('other', 'Unrelated', 'main'), ('old', 'Earlier', 'main')]:
    db.execute('INSERT INTO sessions(id,tool,cwd,project,title,branch) VALUES(?,?,?,?,?,?)',
               (sid, 'claude', '/p/demo', '/p/demo', title, branch))
for i, text in enumerate(['first', 'needle inside', 'needle again', 'last']):
    db.execute('INSERT INTO prompts VALUES(?,?,?)', ('wanted', now - 100 + i, text))
db.execute('INSERT INTO prompts VALUES(?,?,?)', ('other', now, 'unrelated prompt'))
db.execute('INSERT INTO prompts VALUES(?,?,?)', ('old', now - 5 * 86400, 'older unrelated prompt'))
for query in ('needle', 'Auth title', 'feature/auth'):
    assert [r['id'] for r in m.rows(db, query)] == ['wanted'], query
    timeline = m.timeline_rows(db, query, 7)
    assert [r['id'] for r in timeline] == ['wanted'], query
    assert timeline[0]['dn'] == 4
    projects = m.project_rows(db, query)
    assert len(projects) == 1, query
    assert projects[0]['last']['id'] == 'wanted', query
    assert projects[0]['days'] == 1, query
assert m.rows(db, 'absent') == []
assert m.timeline_rows(db, 'absent', 7) == []
assert m.project_rows(db, 'absent') == []
assert len(m.rows(db, '')) == 3
assert m.project_rows(db, '')[0]['last']['id'] == 'other'
assert m.project_rows(db, '')[0]['days'] == 2
`], {cwd: path.dirname(path.dirname(CLI)), encoding: 'utf8'});
  assert.equal(res.status, 0, res.stderr);
});
