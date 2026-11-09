import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as learning from '../lib/learning.js';

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
