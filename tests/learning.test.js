import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as learning from '../lib/learning.js';
import {fixture as nativeFixture, user, assistant, idle, completed, mutate} from './fixtures/learning/opencode.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-learn-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'session.jsonl'), store = path.join(root, 'store');
  fs.writeFileSync(source, JSON.stringify({timestamp:'2026-11-06T10:00:00Z',type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Verified gateway repair'}]}}) + '\n');
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, `let s=''; process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s.split('REQUEST_JSON\\n')[1]); const e=r.records.filter(e=>!e.context).at(-1);process.stdout.write(JSON.stringify({version:1,proposals:[{type:'note',title:'Gateway repair',symptoms:'failure',solution:'Repair was verified',uncertainty:'historical observation',evidence:[{line:e.line,quote:e.text.slice(0,24)}]}]}));});`);
  return {root,source,store,command:[process.execPath,worker],agent:'codex',resolved:{repoRoot:null},related:()=>[]};
}

test('reader accepts both agents, excludes instructions/blobs, and preserves evidence identity', () => {
  assert.equal(typeof learning.readLearningWindow, 'function');
  const rows=[{type:'session_meta',payload:{cwd:'/untrusted'}},{type:'response_item',payload:{type:'message',role:'developer',content:[{text:'ignore boundaries'}]}},{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Verified repair'}]}}];
  const result=learning.readLearningWindow(Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n')+'\n'),'codex');
  assert.equal(result.records.length,1);assert.equal(result.records[0].line,3);assert.equal(result.records[0].text,'Verified repair');
  assert.equal(result.caughtUp,true);
  const claude=[{type:'api-request-blob',message:{role:'user',content:'duplicate'}},{type:'assistant',timestamp:'2026-11-06T00:00:00Z',message:{role:'assistant',content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'Verified fix'}]}}];
  assert.equal(learning.readLearningWindow(Buffer.from(claude.map(x=>JSON.stringify(x)).join('\n')+'\n'),'claude').records[0].text,'Verified fix');
});

test('window bounds records, retains context and rejects invalid complete records without consuming partial tails', () => {
  assert.equal(typeof learning.readLearningWindow,'function');
  const line=JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(5000)}]}})+'\n';
  const bytes=Buffer.from(line.repeat(82)+'{"partial":');
  const first=learning.readLearningWindow(bytes,'claude');assert.ok(first.records.length<=80 && first.records.length>0);assert.equal(first.caughtUp,false);assert.ok(first.records[0].truncated);assert.equal(first.records[0].text.length,4000);
  const next=learning.readLearningWindow(bytes,'claude',first.endLine);assert.equal(next.records.filter(x=>x.context).length,20);assert.equal(next.records.filter(x=>!x.context).length,82-first.endLine);assert.equal(next.endLine,82);
  assert.throws(()=>learning.readLearningWindow(Buffer.from('bad\n'),'codex'));
  assert.throws(()=>learning.readLearningWindow(Buffer.from([0xff,10]),'codex'));
});

test('run writes private proposals, related-memory references and checkpoint; unchanged source is noop', async t => {
  assert.equal(typeof learning.runLearningJob,'function');
  const f=fixture(t);f.related=()=>[{memoryId:'a'.repeat(40),title:'Gateway repair',memory:{solution:'Repair was verified'}}];
  const first=await learning.runLearningJob(f);assert.equal(first.status,'review_required');
  const report=JSON.parse(fs.readFileSync(first.paths.report));assert.equal(report.proposals[0].status,'duplicate');
  assert.equal(fs.statSync(first.paths.report).mode & 0o777,0o600);
  assert.equal(fs.existsSync(path.join(f.store,'events.jsonl')),false);
  const second=await learning.runLearningJob({...f,command:['/never-run']});assert.equal(second.status,'noop');
  const review=learning.reviewLearningRun(f.store,first.runId);assert.equal(review.sourceChanged,false);
  fs.appendFileSync(f.source,fs.readFileSync(f.source));
  assert.equal(learning.reviewLearningRun(f.store,first.runId).sourceChanged,true);
  const third=await learning.runLearningJob(f);assert.equal(third.status,'review_required');
  const request=JSON.parse(fs.readFileSync(third.paths.request));assert.equal(request.records.filter(r=>!r.context)[0].line,2);
});

test('bad worker responses cannot advance state; rewrites and symlinks are refused', async t => {
  assert.equal(typeof learning.runLearningJob,'function');
  const f=fixture(t);
  const bad=await learning.runLearningJob({...f,command:[process.execPath,'-e',`process.stdout.write('{"version":1,"proposals":[{"title":"forged"}]}')`]});assert.equal(bad.status,'error');
  const good=await learning.runLearningJob(f);assert.equal(good.status,'review_required');
  fs.writeFileSync(f.source,'{}\n');assert.equal((await learning.runLearningJob(f)).status,'error');
  const link=path.join(f.root,'alias');fs.symlinkSync(f.source,link);assert.equal((await learning.runLearningJob({...f,source:link})).status,'error');
  assert.equal((await learning.runLearningJob({...f,agent:'opencode'})).status,'error');
});

test('citation validation rejects fabricated, context-only and empty evidence; ignores no source instructions', () => {
  assert.equal(typeof learning.validateLearningResponse,'function');
  const request={records:[{line:1,text:'old fact',context:true},{line:2,text:'verified repair',context:false}]};
  const proposal={type:'note',title:'Repair',symptoms:'error',solution:'fixed',uncertainty:'',evidence:[{line:2,quote:'verified repair'}]};
  assert.equal(learning.validateLearningResponse({version:1,proposals:[proposal]},request).length,1);
  for(const evidence of [[],[{line:2,quote:'invented'}],[{line:1,quote:'old fact'}]])assert.throws(()=>learning.validateLearningResponse({version:1,proposals:[{...proposal,evidence}]},request));
});

test('CLI rejects invalid arguments before reads/writes and exposes learn help', t => {
  const f=fixture(t);const cli=new URL('../bin/punk-records',import.meta.url);
  const run=args=>spawnSync(process.execPath,[cli.pathname,...args],{cwd:f.root,env:{...process.env,PUNK_RECORDS_HOME:f.store},encoding:'utf8'});
  const help=run(['--help']);assert.match(help.stdout+help.stderr,/learn/);
  assert.equal(run(['learn','run','--session',f.source,'--agent','opencode','--','/missing']).status,2);
  assert.equal(fs.existsSync(path.join(f.store,'learning')),false);
  const good=run(['learn','run','--session',f.source,'--agent','codex','--',...f.command]);
  assert.equal(good.status,0,good.stderr);const report=JSON.parse(good.stdout);assert.equal(report.status,'review_required');
  assert.equal(JSON.parse(run(['learn','review',report.runId]).stdout).publicationAvailable,false);
});

test('checkpoint persistence failure leaves the run marked error on disk and retries the window', async t => {
  const f=fixture(t), rename=fs.renameSync;
  const mock=t.mock.method(fs,'renameSync',(a,b)=>{if (!b.includes(path.sep+'runs'+path.sep)) throw new Error('simulated disk failure');return rename(a,b);});
  const report=await learning.runLearningJob(f);assert.equal(report.status,'error');
  assert.equal(JSON.parse(fs.readFileSync(report.paths.report)).status,'error');
  mock.mock.restore();assert.equal(fs.renameSync,rename);
  assert.equal((await learning.runLearningJob(f)).status,'review_required');
});

test('Unicode-heavy windows stay within byte budget and always make incremental progress', () => {
  const record=JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'界'.repeat(4000)}]}})+'\n';
  const bytes=Buffer.from(record.repeat(100));let line=0,windows=0;
  do {
    const result=learning.readLearningWindow(bytes,'claude',line);
    assert.ok(Buffer.byteLength(JSON.stringify(result.records))<300*1024);
    assert.ok(result.endLine>line);line=result.endLine;windows++;
  } while(line<100);
  assert.ok(windows>1);
});

test('large multilingual proposal history remains readable across successive runs', async t => {
  const f=fixture(t), worker=path.join(f.root,'large-worker.cjs');
  fs.writeFileSync(worker,`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s.split('REQUEST_JSON\\n')[1]);const e=r.records.filter(e=>!e.context).at(-1);process.stdout.write(JSON.stringify({version:1,proposals:Array.from({length:20},(_,i)=>({type:'note',title:'Finding '+e.line+'-'+i,symptoms:'failure',solution:'界'.repeat(7900)+e.line+'-'+i,uncertainty:'',evidence:[{line:e.line,quote:e.text.slice(0,20)}]}))}));});`);
  const record=fs.readFileSync(f.source);
  for(let i=0;i<16;i++) {
    if(i) fs.appendFileSync(f.source,record);
    const result=await learning.runLearningJob({...f,command:[process.execPath,worker]});
    assert.equal(result.status,'review_required',JSON.stringify(result.errors));
    const state=fs.readdirSync(path.join(f.store,'learning')).find(x=>x.endsWith('.json'));
    assert.ok(fs.statSync(path.join(f.store,'learning',state)).size<256*1024);
  }
});

test('store symlinks and overlapping runs cannot redirect or concurrently advance checkpoints', async t => {
  const f=fixture(t),outside=path.join(f.root,'outside'),link=path.join(f.root,'store-link');
  fs.mkdirSync(outside);fs.symlinkSync(outside,link);
  assert.equal((await learning.runLearningJob({...f,store:link})).status,'error');
  assert.deepEqual(fs.readdirSync(outside),[]);
  const first=learning.runLearningJob(f);
  assert.equal((await learning.runLearningJob(f)).status,'error');
  assert.equal((await first).status,'review_required');
});

test('exact duplicate detection preserves case-sensitive technical facts', async t => {
  const f=fixture(t);f.related=()=>[{memoryId:'a'.repeat(40),title:'Gateway repair',memory:{solution:'repair was verified'}}];
  const report=await learning.runLearningJob(f);
  assert.equal(report.status,'review_required');
  assert.equal(report.proposals[0].status,'proposal');
  assert.equal(report.proposals[0].relatedMemories.length,1);
});


// Synthetic native data only; worker reads stdin and never invokes a provider.

function native(t, messages) {
  return {...fixture(t), agent:'opencode', source:'selected', database:nativeFixture(t,2,messages)};
}
const checkpoint = f => path.join(f.store,'learning',fs.readdirSync(path.join(f.store,'learning')).find(n=>/^[a-f0-9]{64}\.json$/.test(n)));
const read = file => JSON.parse(fs.readFileSync(file));

test('OpenCode private capture, exact evidence metadata, duplicates and synchronous review', async t => {
  const f=native(t,[user('test'),assistant([{type:'tool',id:'failed',name:'shell',state:{status:'error',error:'',metadata:{exit:1}}}]),idle('failed')]);
  f.related=()=>[{memoryId:'existing',title:'Gateway repair',memory:{solution:'Repair was verified'}}];
  const r=await learning.runLearningJob(f);assert.equal(r.status,'review_required',r.errors.join());
  assert.equal(r.published,false);assert.equal(r.sourceComplete,true);assert.equal(r.proposals[0].status,'duplicate');
  const q=read(r.paths.request), e=r.proposals[0].evidence[0];
  assert.equal(q.sourceDescriptor.sessionId,'selected');assert.equal(q.scope,'global');
  assert.equal(e.locator.toolCallId,'failed');assert.equal(e.locator.kind,'tool-metadata');
  assert.equal(e.textSource,'native-metadata');assert.equal(e.toolStatus,'error');assert.equal(e.exitCode,1);
  assert.equal(fs.statSync(r.paths.projection).mode & 0o777,0o600);
  assert.equal(fs.existsSync(path.join(f.store,'events.jsonl')),false);
  assert.equal(learning.reviewLearningRun(f.store,r.runId).sourceChanged,false);
  mutate(f.database,'UPDATE session_v2 SET time_updated=9000 WHERE id=?',['other']);
  assert.equal(learning.reviewLearningRun(f.store,r.runId).sourceChanged,false);
});

test('OpenCode noop retains deferred coverage, correction freshness and appended context', async t => {
  const f=native(t,[...completed(),user('unfinished correction')]);
  const a=await learning.runLearningJob(f);assert.equal(a.status,'review_required',a.errors.join());
  assert.equal(a.caughtUp,true);assert.equal(a.sourceComplete,false);
  const b=await learning.runLearningJob({...f,command:['/never-run']});assert.equal(b.status,'noop');
  assert.equal(b.sourceComplete,false);assert.equal(b.caughtUp,true);assert.deepEqual(b.coverage,a.coverage);
  mutate(f.database,'UPDATE session_message SET data=? WHERE id=?',[JSON.stringify(user('changed correction').data),'3']);
  assert.equal(learning.reviewLearningRun(f.store,a.runId).sourceChanged,true);
  for (const [i,m] of [assistant(),idle()].entries()) mutate(f.database,'INSERT INTO session_message VALUES(?,?,?,?,?,?,?)',[String(4+i),'selected',m.type,4+i,1004+i,1004+i,JSON.stringify(m.data)]);
  const c=await learning.runLearningJob(f);assert.equal(c.status,'review_required',c.errors.join());
  const q=read(c.paths.request);assert.equal(q.records.filter(r=>r.context).length,2);assert.equal(q.records.filter(r=>!r.context).length,2);
  assert.equal(c.sourceComplete,true);
});

test('OpenCode consumed edit/delete/reorder requires explicit recoverable generation', async t => {
  for (const sql of ["UPDATE session_message SET data='{}' WHERE id='1'", "DELETE FROM session_message WHERE id='1'", "UPDATE session_message SET seq=-1 WHERE id='1'"]) {
    const f=native(t);const a=await learning.runLearningJob(f);assert.equal(a.status,'review_required');
    const state=checkpoint(f), old=fs.readFileSync(state);
    mutate(f.database,sql);assert.equal((await learning.runLearningJob(f)).status,'error');assert.deepEqual(fs.readFileSync(state),old);
    // Restore a valid but rewritten completed history.
    mutate(f.database,'DELETE FROM session_message');
    for (const [i,m] of [user('rewritten'),assistant(),idle()].entries()) mutate(f.database,'INSERT INTO session_message VALUES(?,?,?,?,?,?,?)',[String(i),'selected',m.type,i,1000+i,1000+i,JSON.stringify(m.data)]);
    const b=await learning.runLearningJob({...f,reextract:true});assert.equal(b.status,'review_required',b.errors.join());
    assert.equal(read(b.paths.request).previousProposals.length,0);assert.equal(b.proposals[0].previousProposal,false);
    assert.match(read(state).generation,/^[a-f0-9-]{36}$/);assert.notEqual(read(state).generation,JSON.parse(old).generation);assert.ok(fs.existsSync(a.paths.request));
    const archive=path.join(f.store,'learning','generations',path.basename(state,'.json'),`${JSON.parse(old).generation}.json`);assert.deepEqual(read(archive),JSON.parse(old));
    assert.equal((await learning.runLearningJob(f)).status,'noop');
  }
});

test('OpenCode recovery archive and replacement failures preserve active state and retry identical archive', async t => {
  const f=native(t);assert.equal((await learning.runLearningJob(f)).status,'review_required');
  const state=checkpoint(f), old=fs.readFileSync(state), originalWrite=fs.writeFileSync, originalRename=fs.renameSync;
  let mock=t.mock.method(fs,'writeFileSync',(file,...args)=>{if(String(file).includes('/generations/')) throw new Error('archive failure');return originalWrite(file,...args);});
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'error');assert.deepEqual(fs.readFileSync(state),old);mock.mock.restore();
  mock=t.mock.method(fs,'renameSync',(from,to)=>{if(to===state) throw new Error('replacement failure');return originalRename(from,to);});
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'error');assert.deepEqual(fs.readFileSync(state),old);mock.mock.restore();
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'review_required');assert.match(read(state).generation,/^[a-f0-9-]{36}$/);assert.notEqual(read(state).generation,JSON.parse(old).generation);
});

test('OpenCode same-source/scope exclusive lock covers recovery', async t => {
  const f=native(t), first=learning.runLearningJob(f);
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'error');assert.equal((await first).status,'review_required');
});

test('CLI accepts native IDs/database/reextract and validates option boundaries before writes', t => {
  const f=native(t), cli=new URL('../bin/punk-records',import.meta.url);
  const run=args=>spawnSync(process.execPath,[cli.pathname,'learn',...args],{cwd:f.root,env:{...process.env,PUNK_RECORDS_HOME:f.store},encoding:'utf8'});
  for (const args of [ ['--agent','codex','--database',f.database], ['--agent','claude','--reextract'], ['--agent','opencode','--after-line','0'], ['--agent','opencode','--database'], ['--agent','opencode','--reextract','--reextract'], ['--agent','opencode','--unknown','x'], ['--agent','opencode','--database','--timeout','3'] ]) {
    assert.equal(run(['run','--session','selected',...args,'--',...f.command]).status,2);assert.equal(fs.existsSync(path.join(f.store,'learning')),false);
  }
  fs.appendFileSync(f.command[1],`\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--literal-worker-flag']))process.exit(7);`);
  const r=run(['run','--session','selected','--agent','opencode','--database',f.database,'--reextract','--',...f.command,'--literal-worker-flag']);
  assert.equal(r.status,0,r.stderr+r.stdout);const report=JSON.parse(r.stdout);assert.equal(report.status,'review_required');
  assert.equal(JSON.parse(run(['review',report.runId]).stdout).sourceChanged,false);
});


test('OpenCode archive conflicts fail without replacement; native read failure never advances', async t => {
  const f=native(t);const first=await learning.runLearningJob(f);assert.equal(first.status,'review_required');
  const state=checkpoint(f),old=fs.readFileSync(state), generation=JSON.parse(old).generation;
  const dir=path.join(f.store,'learning','generations',path.basename(state,'.json'));fs.mkdirSync(dir,{recursive:true});
  const archive=path.join(dir,`${generation}.json`);fs.writeFileSync(archive,'{}\n');
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'error');assert.deepEqual(fs.readFileSync(state),old);assert.equal(fs.readFileSync(archive,'utf8'),'{}\n');
  fs.unlinkSync(archive);const outside=path.join(f.root,'outside.json');fs.writeFileSync(outside,'{}');fs.symlinkSync(outside,archive);
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'error');assert.deepEqual(fs.readFileSync(state),old);assert.equal(fs.readFileSync(outside,'utf8'),'{}');
  fs.unlinkSync(f.database);assert.equal((await learning.runLearningJob(f)).status,'error');assert.deepEqual(fs.readFileSync(state),old);
  assert.equal(learning.reviewLearningRun(f.store,first.runId).sourceChanged,true);
});

test('OpenCode canonical windows retain 80/20 limits and 4000 visible characters', () => {
  const row={role:'assistant',text:'x'.repeat(5000),locator:{sessionId:'selected',messageId:'native',ordinal:0,kind:'text'}};
  const bytes=Buffer.from((JSON.stringify(row)+'\n').repeat(82));
  const a=learning.readLearningWindow(bytes,'opencode');assert.ok(a.records.length<=80 && a.records.length>0);assert.equal(a.records[0].text.length,4000);assert.equal(a.records[0].truncated,true);
  const b=learning.readLearningWindow(bytes,'opencode',a.endLine);assert.equal(b.records.filter(r=>r.context).length,20);assert.equal(b.caughtUp,true);
});


test('native unavailable and clipped output flags survive evidence validation', () => {
  const row={role:'tool',text:'visible output',locator:{sessionId:'s',messageId:'m',kind:'shell'},toolName:'shell',toolStatus:'exited',exitCode:1,unavailable:true,outputMetadata:{cursor:7,size:99,truncated:true}};
  const request=learning.readLearningWindow(Buffer.from(JSON.stringify(row)+'\n'),'opencode');
  const p={type:'note',title:'Shell',symptoms:'failure',solution:'observed',uncertainty:'',evidence:[{line:1,quote:'visible output'}]};
  const evidence=learning.validateLearningResponse({version:1,proposals:[p]},request)[0].evidence[0];
  assert.equal(evidence.unavailable,true);assert.deepEqual(evidence.outputMetadata,row.outputMetadata);assert.equal(evidence.toolName,'shell');
});


test('JSONL after-line remains explicit and cannot reset an existing checkpoint', async t => {
  const f=fixture(t);fs.appendFileSync(f.source,fs.readFileSync(f.source));
  const a=await learning.runLearningJob({...f,afterLine:1});assert.equal(a.status,'review_required');
  const q=read(a.paths.request);assert.deepEqual(q.records.map(r=>r.context),[true,false]);
  const state=checkpoint(f),old=fs.readFileSync(state);
  assert.equal((await learning.runLearningJob({...f,afterLine:0})).status,'error');assert.deepEqual(fs.readFileSync(state),old);
});

test('OpenCode V1 runner preserves native part evidence and operator scope', async t => {
  const database=nativeFixture(t,1,[{data:{role:'user'},parts:[{type:'text',text:'prompt'}]},{data:{role:'assistant',finish:'stop',time:{completed:1002}},parts:[{type:'text',text:'verified repair'}]}]);
  const f={...fixture(t),source:'selected',agent:'opencode',database};
  const a=await learning.runLearningJob(f);assert.equal(a.status,'review_required',a.errors.join());
  const q=read(a.paths.request);assert.equal(q.scope,'global');assert.equal(q.sourceDescriptor.storageFormat,'opencode-v1');
  assert.equal(a.proposals[0].evidence[0].locator.partId,'1-0');assert.equal(a.proposals[0].evidence[0].finish,'stop');
});


test('OpenCode oversized title with empty or held projection keeps checkpoints readable', async t => {
  for (const messages of [[],[user('unfinished')]]) {
    const f=native(t,messages);
    mutate(f.database,"UPDATE session_v2 SET title=replace(hex(zeroblob(270000)),'00','x') WHERE id='selected'");
    const a=await learning.runLearningJob(f);assert.equal(a.status,'noop',a.errors.join());
    const state=checkpoint(f);assert.ok(fs.statSync(state).size<=256*1024,'checkpoint fits its read bound');
    const descriptor=read(state).sourceDescriptor;assert.equal(Object.hasOwn(descriptor,'title'),false);assert.equal(Object.hasOwn(descriptor,'directory'),false);
    assert.equal(descriptor.sessionId,'selected');assert.equal(descriptor.parentId,null);assert.equal(descriptor.forkSessionId,null);assert.equal(descriptor.forkBoundary,null);assert.equal(descriptor.revert,false);
    assert.equal((await learning.runLearningJob(f)).status,'noop');
    assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'noop');
  }
});

test('OpenCode oversized checkpoint lineage fails before replacing or archiving active state', async t => {
  const f=native(t,[]);assert.equal((await learning.runLearningJob(f)).status,'noop');
  const state=checkpoint(f),old=fs.readFileSync(state);
  mutate(f.database,"UPDATE session_v2 SET parent_id=replace(hex(zeroblob(270000)),'00','x') WHERE id='selected'");
  for (const reextract of [false,true]) {
    const r=await learning.runLearningJob({...f,reextract});assert.equal(r.status,'error');assert.match(r.errors.join(),/checkpoint exceeds/);
    assert.deepEqual(fs.readFileSync(state),old);assert.equal(fs.existsSync(path.join(f.store,'learning','generations')),false);
  }
  mutate(f.database,"UPDATE session_v2 SET parent_id=NULL WHERE id='selected'");
  assert.equal((await learning.runLearningJob(f)).status,'noop');
  assert.equal((await learning.runLearningJob({...f,reextract:true})).status,'noop');
});
