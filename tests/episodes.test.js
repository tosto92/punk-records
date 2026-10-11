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
const env = {...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share'), PREVIOUSLY_HOME: path.join(home, 'store'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: ''};
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
for tool in ('claude', 'codex', 'opencode'):
    cwd = "/tmp/my project/it's $HOME; echo unsafe"
    sid = "session id'; echo unsafe"
    r = {'tool': tool, 'cwd': cwd, 'id': sid}
    assert shlex.split(m.resume(r)) == ['cd', cwd, '&&', tool, {'claude': '--resume', 'codex': 'resume', 'opencode': '--session'}[tool], sid]
`], {cwd: path.dirname(path.dirname(CLI)), encoding: 'utf8'});
  assert.equal(res.status, 0, res.stderr);
});

test('episodes imports OpenCode user prompts from its database and refreshes changed sessions', {skip: !hasPython && 'python3 not found'}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-opencode-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const data = path.join(home, 'data');
  fs.mkdirSync(path.join(data, 'opencode'), {recursive: true});
  const source = path.join(data, 'opencode', 'opencode.db');
  const setup = spawnSync('python3', ['-c', `
import sqlite3, sys, json, time
d = sqlite3.connect(sys.argv[1]); ts = int(time.time() * 1000)
d.executescript('''CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);''')
d.execute('INSERT INTO session VALUES(?,?,?,?)', ('ses_zebra', '/p/demo/.worktrees/fix', 'OpenCode zebra', ts))
for mid, role, parts in [('user', 'user', [{'type':'text','text':'fix zebra'}, {'type':'text','text':'login'}, {'type':'text','text':'hidden','synthetic':True}, {'type':'file','url':'private'}]), ('assistant', 'assistant', [{'type':'text','text':'assistant answer'}])]:
    d.execute('INSERT INTO message VALUES(?,?,?,?)', (mid, 'ses_zebra', ts, json.dumps({'role':role})))
    for i, part in enumerate(parts):
        d.execute('INSERT INTO part VALUES(?,?,?,?)', (mid + str(i), mid, 'ses_zebra', json.dumps(part)))
d.commit()
` , source], {encoding: 'utf8'});
  assert.equal(setup.status, 0, setup.stderr);
  const env = {...process.env, HOME: home, XDG_DATA_HOME: data, PREVIOUSLY_HOME: path.join(home, 'store'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: ''};
  const run = args => {
    const res = spawnSync(process.execPath, [CLI, 'episodes', ...args], {env, encoding: 'utf8'});
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  };
  const first = JSON.parse(run(['api', '/api/session', 'id=ses_zebra']));
  assert.equal(first.session?.tool, 'opencode');
  assert.equal(first.session.project, '/p/demo');
  assert.equal(first.session.title, 'OpenCode zebra');
  assert.equal(first.session.resume, 'cd /p/demo/.worktrees/fix && opencode --session ses_zebra');
  assert.deepEqual(first.prompts.map(p => p.text), ['fix zebra\nlogin']);
  assert.equal(JSON.parse(run(['api', '/api/session', 'id=ses_zebra'])).prompts.length, 1);
  const update = spawnSync('python3', ['-c', `
import sqlite3, sys, json
d = sqlite3.connect(sys.argv[1])
d.execute("UPDATE session SET title='Updated zebra', time_updated=time_updated+1000")
d.execute("INSERT INTO message SELECT 'next', id, time_updated, ? FROM session", (json.dumps({'role':'user'}),))
d.execute("INSERT INTO part VALUES('next', 'next', 'ses_zebra', ?)", (json.dumps({'type':'text','text':'follow up'}),))
d.commit()
`, source], {encoding: 'utf8'});
  assert.equal(update.status, 0, update.stderr);
  const updated = JSON.parse(run(['api', '/api/session', 'id=ses_zebra']));
  assert.equal(updated.session.title, 'Updated zebra');
  assert.deepEqual(updated.prompts.map(p => p.text), ['fix zebra\nlogin', 'follow up']);
  fs.renameSync(source, source + '.removed');
  assert.equal(JSON.parse(run(['api', '/api/session', 'id=ses_zebra'])).prompts.length, 2);
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
