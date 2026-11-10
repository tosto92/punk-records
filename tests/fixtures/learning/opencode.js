import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../../..');
const json = value => JSON.stringify(value);
export function python(code, args = []) {
  const p = spawnSync('python3', ['-c', code, ...args], {cwd: root, encoding: 'utf8', maxBuffer: 45 << 20});
  assert.equal(p.status, 0, p.stderr);
  return p.stdout;
}
export function fixture(t, version = 2, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-opencode-capture-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const database = path.join(dir, 'opencode.db');
  python(`import sys,json,sqlite3
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL')
v=int(sys.argv[2]); messages=json.loads(sys.argv[3])
if v==2:
 c.executescript('CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,title TEXT,parent_id TEXT,time_updated INTEGER,fork_session_id TEXT,fork_boundary TEXT,revert TEXT); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,data TEXT);')
 c.executemany('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?)',[(s,'/synthetic/project',s,None,1000,None,None,None) for s in ['selected','other']])
 for i,m in enumerate(messages):
  c.execute('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)',(m.get('id',str(i)),m.get('session_id','selected'),m['type'],m.get('seq',i),1000+i,1000+i,json.dumps(m['data'])))
else:
 c.executescript('CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,parent_id TEXT,time_updated INTEGER,revert TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT);')
 c.executemany('INSERT INTO session VALUES(?,?,?,?,?,?)',[(s,'/synthetic/project',s,None,1000,None) for s in ['selected','other']])
 for i,m in enumerate(messages):
  mid=m.get('id',str(i)); c.execute('INSERT INTO message VALUES(?,?,?,?)',(mid,m.get('session_id','selected'),1000+i,json.dumps(m['data'])))
  for j,p in enumerate(m.get('parts',[])): c.execute('INSERT INTO part VALUES(?,?,?,?)',(mid+'-'+str(j),mid,m.get('session_id','selected'),json.dumps(p)))
c.commit()`, [database, String(version), json(messages ?? completed())]);
  return database;
}
export const user = text => ({type:'user', data:{text,files:[],time:{created:1000}}});
export const assistant = (content = [{type:'text',text:'verified ✓'}]) => ({type:'assistant', data:{content,finish:'stop',time:{created:1001,completed:1002}}});
export const idle = (outcome = 'succeeded') => ({type:'idle',data:{outcome,time:{created:1003}}});
export const completed = () => [user('fix café'),assistant(),idle()];
export function mutate(database, sql, params = []) {
  python('import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit()', [database,sql,json(params)]);
}
