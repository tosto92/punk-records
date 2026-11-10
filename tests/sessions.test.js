import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {fixture, python, mutate, user, assistant, idle} from './fixtures/learning/opencode.js';

const CLI = path.resolve(import.meta.dirname, '../bin/punk-records');
const hasPython = spawnSync('python3', ['--version']).status === 0;

test('sessions ignores legacy environment and directories during ordinary runtime', {skip: !hasPython && 'python3 not found'}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-records-home-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const legacy = path.join(home, '.local/share/previously');
  fs.mkdirSync(legacy, {recursive: true});
  const result = spawnSync('python3', ['-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('sessions', 'lib/sessions/sessions.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.DB)
`], {cwd: path.dirname(path.dirname(CLI)), env: {...process.env, HOME: home, PUNK_RECORDS_HOME: '', PREVIOUSLY_HOME: legacy}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(home, '.local/share/punk-records/sessions.db'));
});

test('sessions indexes a Claude Code session and shows its prompts', {skip: !hasPython && 'python3 not found'}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-records-sessions-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const sid = '0b5e1d2c-0000-4000-8000-000000000001';
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'projects', '-p-demo'), {recursive: true});
  fs.writeFileSync(path.join(claude, 'history.jsonl'),
    JSON.stringify({sessionId: sid, timestamp: Date.now(), display: 'fix the zebra login bug', project: '/p/demo/.worktrees/feat'}) + '\n' +
    JSON.stringify({sessionId: sid, timestamp: Date.now(), display: '/clear', project: '/p/demo'}) + '\n');
  fs.writeFileSync(path.join(claude, 'projects', '-p-demo', `${sid}.jsonl`),
    JSON.stringify({aiTitle: 'Zebra login', gitBranch: 'feat', cwd: '/p/demo/.worktrees/feat'}) + '\n');
const env = {...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local/share'), PUNK_RECORDS_HOME: path.join(home, 'store'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: ''};
  const run = args => spawnSync(process.execPath, [CLI, 'sessions', ...args], {env, encoding: 'utf8'});

  const recent = run([]);
  assert.equal(recent.status, 0, recent.stderr);
  assert.match(recent.stdout, /\/p\/demo \[feat\]/, 'worktree rolls up into its project');
  assert.match(recent.stdout, /title: Zebra login/);
  assert.match(recent.stdout, new RegExp(`claude --resume ${sid}`));
  assert.doesNotMatch(recent.stdout, /\/clear/, 'slash commands are not prompts');
  assert.ok(fs.existsSync(path.join(home, 'store', 'sessions.db')));

  const show = run(['show', sid.slice(0, 8)]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /fix the zebra login bug/);
  assert.match(run(['--help']).stdout, /punk-records sessions timeline/);

  const api = JSON.parse(run(['api', '/api/session', `id=${sid.slice(0, 8)}`]).stdout);
  assert.equal(api.session.title, 'Zebra login');
  assert.match(JSON.parse(run(['api', '/api/data', 'q=zebra']).stdout).projects[0].project, /\/p\/demo/);
});

test('sessions without Python says so instead of crashing', () => {
  const res = spawnSync(process.execPath, [CLI, 'sessions'], {env: {...process.env, PUNK_RECORDS_PYTHON: 'no-such-python-xyz'}, encoding: 'utf8'});
  assert.equal(res.status, 2);
  assert.match(res.stderr, /sessions needs Python 3\.9\+/);
});

test('resume commands quote paths and session IDs as single shell arguments', {skip: !hasPython && 'python3 not found'}, () => {
  const res = spawnSync('python3', ['-c', `
import importlib.util, shlex
spec = importlib.util.spec_from_file_location('sessions', 'lib/sessions/sessions.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
for tool in ('claude', 'codex', 'opencode'):
    cwd = "/tmp/my project/it's $HOME; echo unsafe"
    sid = "session id'; echo unsafe"
    r = {'tool': tool, 'cwd': cwd, 'id': sid}
    assert shlex.split(m.resume(r)) == ['cd', cwd, '&&', tool, {'claude': '--resume', 'codex': 'resume', 'opencode': '--session'}[tool], sid]
`], {cwd: path.dirname(path.dirname(CLI)), encoding: 'utf8'});
  assert.equal(res.status, 0, res.stderr);
});

test('sessions imports OpenCode user prompts from its database and refreshes changed sessions', {skip: !hasPython && 'python3 not found'}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-records-opencode-'));
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
  const env = {...process.env, HOME: home, XDG_DATA_HOME: data, PUNK_RECORDS_HOME: path.join(home, 'store'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: ''};
  const run = args => {
    const res = spawnSync(process.execPath, [CLI, 'sessions', ...args], {env, encoding: 'utf8'});
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

test('session searches find intermediate prompts consistently without duplicate sessions', {skip: !hasPython && 'python3 not found'}, () => {
  const res = spawnSync('python3', ['-c', `
import importlib.util, sqlite3, time
spec = importlib.util.spec_from_file_location('sessions', 'lib/sessions/sessions.py')
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

test('sessions discovers V2 visible interactions, searches intermediate prompts and refreshes corrections', {skip: !hasPython && 'python3 not found'}, t => {
  const source = fixture(t, 2, [user('first request'), assistant(), user('needle intermediate'),
    {...user('hidden synthetic'), data:{text:'hidden synthetic', synthetic:true}},
    {...user('hidden ignored'), data:{text:'hidden ignored', ignored:true}}, user('/clear'), user('last request')]);
  const home = path.dirname(source);
  fs.mkdirSync(path.join(home, 'opencode'));
  fs.renameSync(source, path.join(home, 'opencode/opencode.db'));
  const database = path.join(home, 'opencode/opencode.db');
  mutate(database, "UPDATE session_v2 SET directory='/p/demo/.worktrees/fix' WHERE id='selected'");
  const env = {...process.env, HOME:home, XDG_DATA_HOME:home, PUNK_RECORDS_HOME:path.join(home,'store'), CLAUDE_CONFIG_DIR:'', CODEX_HOME:''};
  const run = args => {
    const result = spawnSync(process.execPath, [CLI,'sessions',...args], {env,encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run(['api','/api/session','id=selected']);
  assert.equal(first.session?.tool, 'opencode');
  assert.equal(first.session.project, '/p/demo');
  assert.equal(first.session.resume, 'cd /p/demo/.worktrees/fix && opencode --session selected');
  assert.deepEqual(first.prompts.map(p=>p.text), ['first request','needle intermediate','last request']);
  assert.deepEqual(first.prompts.map(p=>p.ts), [1,1.002,1.006]);
  assert.deepEqual(run(['api','/api/session','id=selected']), first);
  assert.equal(run(['api','/api/data','q=needle&days=36500']).projects[0].last.id, 'selected');
  mutate(database, "UPDATE session_message SET data=? WHERE id='2'", [JSON.stringify(user('corrected request').data)]);
  mutate(database, 'UPDATE session_v2 SET time_updated=time_updated+1000');
  const corrected = run(['api','/api/session','id=selected']);
  assert.deepEqual(corrected.prompts.map(p=>p.text), ['first request','corrected request','last request']);
  assert.equal(run(['api','/api/data','q=needle&days=36500']).projects.length, 0);
});

test('sessions upgrades old caches once and prefers migrated V2 at equal native update time', {skip: !hasPython && 'python3 not found'}, t => {
  const source = fixture(t, 1, [{data:{role:'user'}, parts:[{type:'text',text:'legacy prompt'}]}]);
  const cache = path.join(path.dirname(source), 'sessions.db');
  python(`import importlib.util,sqlite3,sys,pathlib
spec=importlib.util.spec_from_file_location('sessions','lib/sessions/sessions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.DB=pathlib.Path(sys.argv[2]);m.OPENCODE=pathlib.Path(sys.argv[1])
m.CLAUDE=m.CODEX=pathlib.Path(sys.argv[2]+'.absent')
c=sqlite3.connect(m.DB)
c.executescript(m.SCHEMA.replace(', source_format TEXT',''))
for sid,tool in [('claude-old','claude'),('codex-old','codex'),('selected','opencode')]:
 c.execute('INSERT INTO sessions(id,tool,cwd,project,file_mtime) VALUES(?,?,?,?,?)',(sid,tool,'/old','/old',1000))
 c.execute('INSERT INTO prompts VALUES(?,?,?)',(sid,1,'cached '+sid))
c.commit();c.close()
original=m._reader.native_sessions
def checked(connection):
 assert connection.in_transaction
 assert connection.execute('PRAGMA query_only').fetchone()[0]==1
 yield from original(connection)
m._reader.native_sessions=checked
d=m.open_db()
assert [r['text'] for r in m.session_prompts(d,'selected')[1]]==['legacy prompt'], 'null-format row must refresh'
assert d.execute("SELECT source_format FROM sessions WHERE id='selected'").fetchone()[0]=='opencode-v1'
for sid in ['claude-old','codex-old']:
 assert m.session_prompts(d,sid)[1][0]['text']=='cached '+sid
d.close()
s=sqlite3.connect(m.OPENCODE)
s.executescript('CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,data TEXT);')
s.execute("INSERT INTO session_v2 VALUES('selected','/new','V2 title',1000)")
s.execute("INSERT INTO session_message VALUES('v2','selected','user',0,2000,?)", ('{"text":"authoritative V2"}',))
s.commit();s.close()
d=m.open_db()
assert len([r for r in m.rows(d,'') if r['id']=='selected'])==1
assert [r['text'] for r in m.session_prompts(d,'selected')[1]]==['authoritative V2']
assert d.execute("SELECT source_format FROM sessions WHERE id='selected'").fetchone()[0]=='opencode-v2'
assert [r[1] for r in d.execute('PRAGMA table_info(sessions)')].count('source_format')==1
before=d.total_changes
m.sync_opencode(d)
assert d.total_changes==before, 'unchanged formats and update times must skip writes'
d.close()
d=m.open_db();d.close()
`, [source,cache]);
});

test('unsupported OpenCode storage fails actionably without deleting cached history', {skip: !hasPython && 'python3 not found'}, t => {
  const source = fixture(t, 2);
  python(`import importlib.util,sqlite3,sys,pathlib
spec=importlib.util.spec_from_file_location('sessions','lib/sessions/sessions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.OPENCODE=pathlib.Path(sys.argv[1])
d=sqlite3.connect(':memory:');d.executescript(m.SCHEMA)
d.execute("INSERT INTO sessions(id,tool) VALUES('selected','opencode')")
d.execute("INSERT INTO prompts VALUES('selected',1,'cached history')");d.commit()
s=sqlite3.connect(m.OPENCODE);s.execute('DROP TABLE session_message');s.commit();s.close()
try:
 m.sync_opencode(d)
except ValueError as e:
 assert 'unsupported OpenCode schema' in str(e) and 'supported native database' in str(e), str(e)
else:
 raise AssertionError('unsupported storage accepted')
assert d.execute('SELECT text FROM prompts').fetchall()==[('cached history',)]
`, [source]);
});


test('V1 index retains visible text around slash-command, synthetic and ignored parts', {skip: !hasPython && 'python3 not found'}, t => {
  const source = fixture(t, 1, [{data:{role:'user'}, parts:[
    {type:'text',text:'/clear'}, {type:'text',text:' first request '},
    {type:'text',text:'hidden synthetic',synthetic:true}, {type:'text',text:'hidden ignored',ignored:true},
    {type:'text',text:'/compact'}, {type:'text',text:' second request '}
  ]}, {data:{role:'user'}, parts:[{type:'text',text:' trailing command '}, {type:'text',text:'/clear'}]}]);
  python(`import importlib.util,sqlite3,sys,pathlib
spec=importlib.util.spec_from_file_location('sessions','lib/sessions/sessions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.OPENCODE=pathlib.Path(sys.argv[1])
d=sqlite3.connect(':memory:');d.executescript(m.SCHEMA)
m.sync_opencode(d)
assert d.execute('SELECT text FROM prompts ORDER BY ts').fetchall()==[('first request\\nsecond request',),('trailing command',)]
`, [source]);
});


test('V1 prompt indexing scans parts once while retaining ordered visible user text', {skip: !hasPython && 'python3 not found'}, () => {
  python(`import importlib.util
spec=importlib.util.spec_from_file_location('sessions','lib/sessions/sessions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CountedParts(list):
 visits=0
 def __iter__(self):
  for part in super().__iter__():
   self.visits+=1
   yield part
messages=[{'id':str(i),'time_created':1000+i,'data':{'role':'user'}} for i in range(40)]
messages.append({'id':'assistant','time_created':2000,'data':{'role':'assistant'}})
parts=CountedParts()
for message in messages:
 for data in [{'type':'text','text':' first '+message['id']+' '}, {'type':'text','text':'/clear'}, {'type':'text','text':'hidden','synthetic':True}, {'type':'text','text':'hidden','ignored':True}, {'type':'text','text':' last '}]:
  parts.append({'message_id':message['id'],'data':data})
m._reader.selected_rows=lambda connection,desc,**options:(messages,parts)
prompts=list(m._reader.native_prompts(None,{'storageFormat':'opencode-v1'}))
assert prompts==[{'ts':(1000+i)/1000,'text':'first '+str(i)+'\\nlast'} for i in range(40)]
assert parts.visits==len(parts), f'parts visited {parts.visits} times for {len(parts)} rows'
parts[0]['data']['text']=123
try:
 list(m._reader.native_prompts(None,{'storageFormat':'opencode-v1'}))
except ValueError as error:
 assert str(error)=='unsupported native prompt text'
else:
 raise AssertionError('invalid visible text accepted')
`);
});


test('large excluded assistant payload does not block prompt discovery or unrelated cached agents', {skip: !hasPython && 'python3 not found'}, t => {
  for (const version of [1,2]) {
    const source=fixture(t,version,version===1 ? [{data:{role:'user'},parts:[{type:'text',text:'small visible prompt'}]},{data:{role:'assistant'},parts:[]}] : [user('small visible prompt'),assistant(),idle()]);
    python(`import importlib.util,sqlite3,sys,pathlib,json
spec=importlib.util.spec_from_file_location('sessions','lib/sessions/sessions.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.OPENCODE=pathlib.Path(sys.argv[1]);v=int(sys.argv[2]);s=sqlite3.connect(m.OPENCODE)
large=json.dumps({'type':'reasoning','text':'x'*(33<<20)})
if v==1:
 s.execute('INSERT INTO part VALUES(?,?,?,?)',('large','1','selected',large))
else:
 s.execute('UPDATE session_message SET data=? WHERE id=?',(json.dumps({'content':[json.loads(large)]}),'1'))
s.commit();s.close()
d=sqlite3.connect(':memory:');d.row_factory=sqlite3.Row;d.executescript(m.SCHEMA)
for agent in ['claude','codex']:
 d.execute('INSERT INTO sessions(id,tool) VALUES(?,?)',(agent,agent));d.execute('INSERT INTO prompts VALUES(?,?,?)',(agent,1,'cached '+agent))
m.sync_opencode(d)
assert [r['text'] for r in m.session_prompts(d,'selected')[1]]==['small visible prompt']
for agent in ['claude','codex']:
 assert m.session_prompts(d,agent)[1][0]['text']=='cached '+agent
try:
 m._reader.capture_session(str(m.OPENCODE),'selected')
except ValueError as e:
 assert '32 MiB' in str(e), str(e)
else:
 raise AssertionError('oversized full capture accepted')
`,[source,String(version)]);
  }
});
