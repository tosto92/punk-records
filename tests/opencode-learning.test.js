import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {python,fixture,user,assistant,idle,completed,mutate} from './fixtures/learning/opencode.js';

const root = path.resolve(import.meta.dirname, '..');
const bridge = path.join(root, 'lib/sessions/opencode_learning.py');
const load = () => import('../lib/opencode-learning.js');
const json = value => JSON.stringify(value);
async function capture(database, sessionId='selected') { return (await load()).captureOpenCodeSession({database,sessionId}); }
const records = c => c.bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('V2 capture uses embedded content, exact selection, native locators and deterministic bytes across directory aliases', async t => {
  const original=fixture(t,2,[...completed(),{...user('PRIVATE_OTHER'),session_id:'other'}]);
  const alias=path.join(path.dirname(original),'database-alias');
  fs.symlinkSync(path.dirname(original),alias,'dir');
  const database=path.join(alias,path.basename(original));
  const c=await capture(database);
  assert.equal(c.coverage.sourceComplete,true);
  assert.deepEqual(records(c).map(r=>r.text),['fix café','verified ✓']);
  assert.deepEqual(records(c)[1].locator,{sessionId:'selected',messageId:'1',kind:'text',ordinal:0});
  assert.equal(c.descriptor.database,fs.realpathSync(database));
  assert.equal(c.descriptor.storageFormat,'opencode-v2');
  assert.deepEqual((await capture(database)).bytes,c.bytes);
  assert.deepEqual(await capture(original),c);
  assert.equal(records(await capture(database,'other')).length,0);
});
test('V1 completed turns match visible V2 content and retain native part locators', async t => {
  const database=fixture(t,1,[{data:{role:'user',time:{created:1000}},parts:[{type:'text',text:'fix café'}]}, {data:{role:'assistant',finish:'stop',time:{created:1001,completed:1002}},parts:[{type:'text',text:'verified ✓'}]}]);
  const c=await capture(database);
  assert.equal(c.coverage.sourceComplete,true);
  assert.deepEqual(records(c).map(r=>r.text),['fix café','verified ✓']);
  assert.equal(records(c)[1].locator.partId,'1-0');
});
test('V2 omits reasoning/synthetic/attachments and preserves tool exit/error', async t => {
  const database=fixture(t,2,[user('test'),assistant([{type:'reasoning',text:'REASONING_SENTINEL'}, {type:'text',text:'SYNTHETIC_SENTINEL',synthetic:true}, {type:'file',url:'/never/read'}, {type:'tool',id:'call-1',name:'shell',state:{status:'completed',content:[{type:'text',text:'Exited with code 1'}],metadata:{exit:1}}}, {type:'tool',id:'call-2',name:'read',state:{status:'error',error:'Permission denied'}}]),idle('failed')]);
  const c=await capture(database), rows=records(c);
  assert.equal(c.coverage.sourceComplete,true);
  assert.doesNotMatch(c.bytes.toString(),/SENTINEL|never\/read/);
  assert.equal(rows[1].exitCode,1); assert.equal(rows[1].toolStatus,'completed');
  assert.equal(rows[1].locator.toolCallId,'call-1');
  assert.equal(rows[2].toolStatus,'error'); assert.match(rows[2].text,/Permission denied/);
  assert.equal(rows[2].outcome,'failed');
});
test('V2 completed synthetic probe turns retain corrections and shell exit 1', async t => {
  const probe=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/learning/opencode-v2.json')));
  const c=await capture(fixture(t,2,probe.messages));
  assert.equal(c.coverage.sourceComplete,true);
  assert.match(c.bytes.toString(),/SYNTHETIC_FIX_A/); assert.match(c.bytes.toString(),/SYNTHETIC_FIX_B/);
  assert.doesNotMatch(c.bytes.toString(),/REASONING_SENTINEL/);
  assert.equal(records(c).find(r=>r.exitCode===1).toolStatus,'completed');
});
test('unfinished corrections change revision but not eligible bytes; other sessions change neither', async t => {
  const database=fixture(t,2,[...completed(),user('unfinished correction'),assistant([{type:'tool',id:'pending',name:'shell',state:{status:'running'}}])]);
  const a=await capture(database); assert.equal(a.coverage.sourceComplete,false); assert.equal(a.coverage.heldMessages,2);
  mutate(database,'UPDATE session_message SET data=? WHERE id=?',[json(user('changed correction').data),'3']);
  const b=await capture(database); assert.notEqual(b.sourceRevision,a.sourceRevision); assert.deepEqual(b.bytes,a.bytes);
  mutate(database,'UPDATE session_v2 SET time_updated=9000 WHERE id=?',['other']);
  const c=await capture(database); assert.equal(c.sourceRevision,b.sourceRevision); assert.deepEqual(c.bytes,b.bytes);
});
test('idle outcomes and steered prompts are one execution; pending tools conflict with idle', async t => {
  for (const outcome of ['succeeded','failed','interrupted']) {
    const c=await capture(fixture(t,2,[user('first'),user('steered'),assistant(),idle(outcome)]));
    assert.equal(c.coverage.sourceComplete,true); assert.equal(records(c).length,3);
    assert.equal(records(c)[0].outcome,outcome);
  }
  for (const tail of [[user('next'),assistant()], [user('next'),assistant([{type:'tool',id:'x',name:'shell',state:{status:'pending'}}]),idle()]]) {
    const c=await capture(fixture(t,2,[...completed(),...tail]));
    assert.equal(c.coverage.sourceComplete,false); assert.deepEqual(records(c).map(r=>r.text),['fix café','verified ✓']);
  }
});
test('V1 requires explicit terminal completion and preserves non-success finish', async t => {
  for (const finish of ['stop','length','content-filter','tool-calls','unknown',null]) {
    const database=fixture(t,1,[{data:{role:'user'},parts:[{type:'text',text:'prompt'}]}, {data:{role:'assistant',finish,time:{completed:1002}},parts:[{type:'text',text:'answer'}]}]);
    const c=await capture(database); assert.equal(c.coverage.sourceComplete,['stop','length','content-filter'].includes(finish));
    if (c.coverage.sourceComplete) assert.equal(records(c)[1].finish,finish);
  }
  const database=fixture(t,1,[{data:{role:'user'},parts:[{type:'text',text:'prompt'}]}, {data:{role:'assistant',finish:'stop',time:{}},parts:[{type:'text',text:'answer'}]}]);
  assert.equal((await capture(database)).bytes.length,0);
});
test('malformed JSON, unknown records, dangling parts and ambiguous order fail redacted', async t => {
  for (const [sql,params,error] of [
    ['UPDATE session_message SET data=? WHERE id=?',['{SECRET_BAD_JSON','1'],/JSON/],
    ['UPDATE session_message SET type=? WHERE id=?',['future-kind','1'],/unsupported/],
    ['UPDATE session_message SET seq=0 WHERE id=?',['1'],/order/],
    ['INSERT INTO session_part VALUES(?,?,?,?,?,?)',['absent','selected',0,'text',null,'{}'],/relationship/],
  ]) {
    const db=fixture(t); mutate(db,sql,params);
    await assert.rejects(capture(db),err=>{assert.doesNotMatch(err.message,/SECRET/);return error.test(err.message);});
  }
});
test('part projections match embedded content or hold execution; forks/reverts/location hold', async t => {
  const database=fixture(t);
  mutate(database,'INSERT INTO session_part VALUES(?,?,?,?,?,?)',['1','selected',0,'text',null,json({type:'text',text:'verified ✓'})]);
  assert.equal((await capture(database)).coverage.sourceComplete,true);
  mutate(database,'UPDATE session_part SET data=?',[json({type:'text',text:'different'})]);
  assert.equal((await capture(database)).bytes.length,0);
  for (const field of ['fork_session_id','fork_boundary','revert']) {
    const db=fixture(t); mutate(db,`UPDATE session_v2 SET ${field}=? WHERE id=?`,['history','selected']);
    const c=await capture(db); assert.equal(c.coverage.sourceComplete,false);assert.equal(c.bytes.length,0);
  }
  const c=await capture(fixture(t,2,[{type:'location-switched',data:{directory:'/changed'}},...completed()]));
  assert.equal(c.coverage.sourceComplete,false);assert.match(c.coverage.reason,/location/);
});
test('V2 metadata instructions are excluded and native shell terminal states are preserved', async t => {
  const events=['agent-switched','model-switched','system','skill','synthetic','compaction'].map(type=>({type,data:{text:'PRIVATE_INSTRUCTION'}}));
  const shell={type:'shell',data:{status:'exited',exit:1,time:{created:1000,completed:1001},output:{output:'native shell failed',cursor:2,size:20,truncated:false}}};
  const c=await capture(fixture(t,2,[...events,user('run'),shell,idle('failed')]));
  assert.equal(c.coverage.sourceComplete,true);assert.doesNotMatch(c.bytes.toString(),/PRIVATE_INSTRUCTION/);
  assert.equal(records(c)[1].exitCode,1);assert.equal(records(c)[1].toolStatus,'exited');
});
test('V2 is authoritative for duplicate IDs even with malformed data', async t => {
  const database=fixture(t);
  python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript("CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER); INSERT INTO session VALUES('selected','/legacy','legacy',1);");c.commit()`,[database]);
  assert.equal((await capture(database)).descriptor.storageFormat,'opencode-v2');
  mutate(database,'UPDATE session_message SET data=? WHERE id=?',['{','1']);
  await assert.rejects(capture(database),/JSON/);
});
test('selected-session limits ignore unrelated database size and enforce JSON/row/projection budgets', async t => {
  const database=fixture(t);
  python("import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);c.execute('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)',('large','other','user',99,1,1,json.dumps({'text':'x'*(33<<20)})));c.commit()",[database]);
  assert.equal((await capture(database)).coverage.sourceComplete,true);
  mutate(database,'UPDATE session_message SET session_id=? WHERE id=?',['selected','large']);
  await assert.rejects(capture(database),/JSON.*limit|limit.*JSON/);
  const db=fixture(t);
  python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executemany('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)',((str(i),'selected','system',i,1,1,'{}') for i in range(4,100005)));c.commit()`,[db]);
  await assert.rejects(capture(db),/row.*limit/);
});
test('missing database/session/Python, symlinks and unknown schema fail actionable', async t => {
  const database=fixture(t);
  await assert.rejects(capture(database,'missing'),/session.*not found/);
  await assert.rejects(capture(database+'.missing'),/database/);
  fs.symlinkSync(database,database+'.link'); await assert.rejects(capture(database+'.link'),/symlink|regular/);
  const previous=process.env.PUNK_RECORDS_PYTHON;
  try {process.env.PUNK_RECORDS_PYTHON='missing-python-punk'; await assert.rejects(capture(database),/Python/);}
  finally {if(previous===undefined) delete process.env.PUNK_RECORDS_PYTHON;else process.env.PUNK_RECORDS_PYTHON=previous;}
  mutate(database,'ALTER TABLE session_message RENAME COLUMN seq TO unsupported');
  await assert.rejects(capture(database),/schema/);
});
test('native shared interfaces import by path and enumerate unique descriptors/prompts', t => {
  const database=fixture(t);
  const output=python(`import importlib.util,sqlite3,sys,json
s=importlib.util.spec_from_file_location('opencode_learning',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c=sqlite3.connect(sys.argv[2]);ds=list(m.native_sessions(c));d=next(d for d in ds if d['sessionId']=='selected');print(json.dumps([ds,list(m.native_prompts(c,d))]))`,[bridge,database]);
  const [descriptors,prompts]=JSON.parse(output);assert.equal(descriptors.length,2);assert.deepEqual(prompts.map(p=>p.text),['fix café']);assert.equal(prompts[0].ts,1);
});

test('WAL capture reads one transaction while a separate writer changes selected rows', t => {
  const database=fixture(t);
  const output=python(`import importlib.util,sqlite3,sys,json
s=importlib.util.spec_from_file_location('capture',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
original=sqlite3.connect;writer=original(sys.argv[2]);seen=[];changed=False
def connect(*args,**kwargs):
 c=original(*args,**kwargs)
 def trace(sql):
  global changed
  seen.append(sql)
  if sql.startswith('SELECT * FROM session_message') and not changed:
   changed=True
   writer.execute("UPDATE session_v2 SET time_updated=9000 WHERE id='selected'")
   writer.execute("UPDATE session_message SET data=? WHERE id='0'",(json.dumps({'text':'new writer prompt'}),));writer.commit()
 c.set_trace_callback(trace);return c
m.sqlite3.connect=connect
capture=m.capture_session(sys.argv[2],'selected')
assert changed and 'BEGIN' in seen and 'PRAGMA query_only=ON' in seen
assert capture['descriptor']['updatedAt']==1000
assert capture['records'][0]['text']=='fix café'
assert writer.execute('SELECT time_updated FROM session_v2 WHERE id=?',('selected',)).fetchone()[0]==9000
print(json.dumps(capture['coverage']))`,[bridge,database]);
  assert.equal(JSON.parse(output).sourceComplete,true);
});
test('canonical revision ignores JSON key order and exact capture ignores unrelated unsupported V1 schema', async t => {
  const database=fixture(t), first=await capture(database);
  mutate(database,'UPDATE session_message SET data=? WHERE id=?',[json({time:{completed:1002,created:1001},finish:'stop',content:[{text:'verified ✓',type:'text'}]}),'1']);
  const second=await capture(database);assert.equal(second.sourceRevision,first.sourceRevision);assert.deepEqual(second.bytes,first.bytes);
  python("import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE session(id TEXT,unrelated TEXT)');c.commit()",[database]);
  assert.deepEqual((await capture(database)).bytes,first.bytes);
});
test('projection expansion is bounded independently of selected source JSON', async t => {
  const database=fixture(t);
  python(`import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]);parts=[{'type':'text','text':'x'*300} for _ in range(90000)]
c.execute("UPDATE session_message SET data=? WHERE id='1'",(json.dumps({'content':parts,'time':{'completed':1002}}),));c.commit()`,[database]);
  await assert.rejects(capture(database),/projection.*limit/);
});
test('V1 explicit completed error seals failed execution and compaction summaries never enter evidence', async t => {
  const database=fixture(t,1,[{data:{role:'user'},parts:[{type:'text',text:'prompt'}]}, {data:{role:'assistant',error:{name:'APIError',data:{message:'failure'}},time:{completed:1002}},parts:[{type:'text',text:'attempt failed'}]}, {data:{role:'assistant',summary:true,finish:'stop',time:{completed:1004}},parts:[{type:'text',text:'PRIVATE_SUMMARY'}]}]);
  const c=await capture(database);assert.equal(c.coverage.sourceComplete,true);assert.doesNotMatch(c.bytes.toString(),/PRIVATE_SUMMARY/);assert.equal(records(c)[1].outcome,'failed');
});
test('all terminal shell states retain output; running shell and unfinished-only user stay held', async t => {
  for (const status of ['exited','timeout','killed','running']) {
    const shell={type:'shell',data:{status,time:status==='running'?{created:1000}:{created:1000,completed:1001},output:{output:'shell evidence',truncated:true}}};
    const c=await capture(fixture(t,2,[user('run'),shell,idle('interrupted')]));
    assert.equal(c.coverage.sourceComplete,status!=='running');
    if(status!=='running') assert.equal(records(c)[1].toolStatus,status);
  }
  const c=await capture(fixture(t,2,[user('unfinished')]));assert.equal(c.bytes.length,0);assert.equal(c.coverage.heldMessages,1);
});
test('malformed visible shapes and V1 cross-session JSON identities fail without raw payloads', async t => {
  for(const content of [[null],[{type:'future',text:'PRIVATE_RAW'}],[{type:'text',text:{secret:'PRIVATE_RAW'}}]]) {
    const c=fixture(t,2,[user('test'),assistant(content),idle()]);await assert.rejects(capture(c),err=>!err.message.includes('PRIVATE_RAW')&&/unsupported/.test(err.message));
  }
  const database=fixture(t,1,[{data:{role:'user',sessionID:'different'},parts:[{type:'text',text:'prompt'}]}]);
  await assert.rejects(capture(database),/relationship/);
});

test('user part projections are held, V2 summaries are omitted, and empty/unknown schemas fail explicitly', async t => {
  const database=fixture(t);
  mutate(database,'INSERT INTO session_part VALUES(?,?,?,?,?,?)',['0','selected',0,'text',null,json({type:'text',text:'fix café'})]);
  const c=await capture(database);assert.equal(c.coverage.sourceComplete,false);assert.equal(c.bytes.length,0);assert.match(c.coverage.reason,/projection/);
  const summary={...assistant([{type:'text',text:'PRIVATE_V2_SUMMARY'}])};summary.data.summary=true;
  const summaryCapture=await capture(fixture(t,2,[user('run'),summary,idle()]));
  assert.equal(summaryCapture.coverage.sourceComplete,true);assert.doesNotMatch(summaryCapture.bytes.toString(),/PRIVATE_V2_SUMMARY/);
  const empty=path.join(path.dirname(database),'empty.db');python('import sqlite3,sys\nsqlite3.connect(sys.argv[1]).close()',[empty]);
  await assert.rejects(capture(empty),/schema/);
});

test('shell output metadata is retained while revert payloads stay out of descriptors', async t => {
  const shell={type:'shell',data:{status:'exited',exit:1,time:{completed:1001},output:{output:'last chunk',cursor:5,size:50,truncated:true,path:'/PRIVATE_ATTACHMENT'}}};
  const c=await capture(fixture(t,2,[user('run'),shell,idle('failed')]));
  assert.deepEqual(records(c)[1].outputMetadata,{cursor:5,size:50,truncated:true});
  assert.doesNotMatch(c.bytes.toString(),/PRIVATE_ATTACHMENT/);
  const db=fixture(t);mutate(db,"UPDATE session_v2 SET revert=? WHERE id='selected'",[json({messageID:'0',diff:'PRIVATE_REVERT_PAYLOAD'})]);
  const held=await capture(db);assert.equal(held.coverage.sourceComplete,false);assert.doesNotMatch(json(held),/PRIVATE_REVERT_PAYLOAD/);
});

test('empty-output failed tools and native shells retain located metadata for text windows', async t => {
  const cases = [
    [2, [user('run'),assistant([{type:'tool',id:'empty-call',name:'shell',state:{status:'completed',content:[],metadata:{exit:1}}}]),idle('failed')]],
    [2, [user('run'),{type:'shell',data:{status:'exited',exit:1,time:{completed:1002},output:{output:''}}},idle('failed')]],
    [1, [{data:{role:'user'},parts:[{type:'text',text:'run'}]}, {data:{role:'assistant',finish:'stop',time:{completed:1002}},parts:[{type:'tool',callID:'empty-call',tool:'shell',state:{status:'completed',output:'',metadata:{exit:1}}}]}]],
  ];
  for(const [version,messages] of cases) {
    const c=await capture(fixture(t,version,messages)), tool=records(c).find(r=>r.role==='tool');
    assert.equal(c.coverage.sourceComplete,true);
    assert.ok(tool,'native failed command survives empty output');
    assert.equal(tool.exitCode,1);assert.match(tool.toolStatus,/completed|exited/);
    assert.equal(tool.textSource,'native-metadata');assert.match(tool.locator.kind,/-metadata$/);
    assert.match(tool.text,/native tool metadata/);assert.match(tool.text,/exit=1/);
    assert.ok(tool.text.trim(),'text-only evidence windows can retain this record');
    assert.doesNotMatch(tool.text,/success|stdout|verified/i);
    assert.equal(tool.locator.sessionId,'selected');assert.equal(tool.locator.messageId,'1');
    if(tool.toolStatus==='completed') assert.equal(tool.locator.toolCallId,'empty-call');
  }
});
test('selected session metadata is budgeted before hydration and shares the native JSON budget', t => {
  const database=fixture(t);
  mutate(database,"UPDATE session_v2 SET revert=? WHERE id='selected'",['x'.repeat(4096)]);
  python(`import importlib.util,sys,sqlite3
s=importlib.util.spec_from_file_location('capture',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.MAX_JSON=512
original=sqlite3.connect;seen=[]
def connect(*args,**kwargs):
 c=original(*args,**kwargs);c.set_trace_callback(seen.append);return c
m.sqlite3.connect=connect
try: m.capture_session(sys.argv[2],'selected')
except ValueError as error: assert 'JSON limit' in str(error),str(error)
else: raise AssertionError('oversized selected metadata accepted')
assert not any(sql.startswith('SELECT * FROM session_v2') for sql in seen),seen
`,[bridge,database]);
  mutate(database,"UPDATE session_v2 SET revert=NULL,title=? WHERE id='selected'",['x'.repeat(200)]);
  python(`import importlib.util,sys
s=importlib.util.spec_from_file_location('capture',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.MAX_JSON=400
try: m.capture_session(sys.argv[2],'selected')
except ValueError as error: assert 'native JSON limit' in str(error),str(error)
else: raise AssertionError('combined metadata/message budget accepted')`,[bridge,database]);
});
test('projected metadata tail holds suffix after a completed prefix', async t => {
  const database=fixture(t,2,[...completed(),{type:'system',data:{text:'PRIVATE_METADATA_TAIL'}}]);
  mutate(database,'INSERT INTO session_part VALUES(?,?,?,?,?,?)',['3','selected',0,'text',null,json({type:'text',text:'PRIVATE_PROJECTION'})]);
  const c=await capture(database);
  assert.equal(c.coverage.sourceComplete,false);assert.equal(c.coverage.heldMessages,1);
  assert.deepEqual(c.coverage.deferredFrom,{sessionId:'selected',messageId:'3'});
  assert.match(c.coverage.reason,/unreconciled.*projection/);
  assert.deepEqual(records(c).map(r=>r.text),['fix café','verified ✓']);
  assert.doesNotMatch(c.bytes.toString(),/PRIVATE/);
});


test('compacted tool validates native exit type before dropping unavailable output', async t => {
  const tool={type:'tool',id:'invalid',name:'shell',state:{status:'completed',compacted:true,metadata:{exit:'1'}}};
  await assert.rejects(capture(fixture(t,2,[user('run'),assistant([tool]),idle()])),/exit code/);
});
