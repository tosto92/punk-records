import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync, spawn} from 'node:child_process';
import {handleHook, spoolPath, RECALL_OUTPUT} from '../lib/hook.js';
import {WORKFLOW_GUIDANCE} from '../lib/workflow.js';
import {saveMemory} from '../lib/save.js';
import {loadMemories} from '../lib/build.js';
import {collectMemories, contextGraph} from '../lib/graph.js';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'punk-records');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'hooks');

// Fresh repo + isolated global store (spool lives there); autosave forced on.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-hook-'));
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], {cwd});
  const keys = ['PUNK_RECORDS_HOME', 'PUNK_RECORDS_AUTOSAVE'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  delete process.env.PUNK_RECORDS_HOME;
  delete process.env.PUNK_RECORDS_AUTOSAVE;
  process.env.PUNK_RECORDS_HOME = path.join(root, 'global');
  delete process.env.PUNK_RECORDS_AUTOSAVE;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, {recursive: true, force: true});
  });
  const memories = () => loadMemories(path.join(cwd, 'memory')).memories;
  const cli = (agent, event, input) => spawnSync(process.execPath, [BIN, 'hook', agent, event],
    {cwd, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: process.env});
  return {root, cwd, memories, cli};
}
const ev = (cwd, extra = {}) => ({session_id: 'sess-1', cwd, ...extra});
const write = (cwd, file) => ev(cwd, {tool_name: 'Write', tool_input: {file_path: file, content: 'x'}});
const fixturePayload = (name, cwd) => ({
  ...JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8').replaceAll('/REPO', cwd)),
  session_id: 'sess-1', cwd,
});

test('UserPromptSubmit returns additionalContext only when a memory is relevant', async t => {
  const {cwd} = fixture(t);
  assert.equal(await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'zebra quartz deploy'})), null);
  saveMemory({type: 'solved', title: 'Zebra quartz deploy gotcha', symptoms: 'zebra quartz deploy fails', solution: 'Use the PLATYPUS flag'}, {cwd});
  const out = await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'zebra quartz deploy'}));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /^<punk-records>[\s\S]*Zebra quartz deploy gotcha/);
  const codex = await handleHook('codex', 'UserPromptSubmit', ev(cwd, {prompt: 'zebra quartz deploy'}));
  assert.equal(codex !== null, RECALL_OUTPUT.codex);
});

test('prompt, writes and Stop save one auto draft; a later Stop accumulates on it', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'fix the login bug'}));
  await handleHook('claude', 'PostToolUse', write(cwd, path.join(cwd, 'a.js')));
  await handleHook('claude', 'PostToolUse', ev(cwd, {tool_name: 'Edit', tool_input: {file_path: 'b.js'}}));
  await handleHook('claude', 'PostToolUse', ev(cwd, {tool_name: 'Bash', tool_input: {command: 'touch z.js'}}));
  await handleHook('claude', 'PostToolUse', write(cwd, '/etc/outside.js'));
  await handleHook('claude', 'Stop', ev(cwd, {stop_hook_active: false}));
  let all = memories();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'Claude Code session sess-1');
  assert.deepEqual(all[0].tags, ['auto']);
  assert.deepEqual([...all[0].files].sort(), ['a.js', 'b.js']);
  assert.match(all[0].symptoms, /fix the login bug/);
  assert.equal(fs.existsSync(spoolPath('claude', 'sess-1')), false);

  await handleHook('claude', 'PostToolUse', write(cwd, 'c.js'));
  await handleHook('claude', 'Stop', ev(cwd));
  all = memories();
  assert.equal(all.length, 1);
  assert.deepEqual([...all[0].files].sort(), ['a.js', 'b.js', 'c.js']);
});

test('a failed tool call records nothing', async t => {
  const {cwd} = fixture(t);
  await handleHook('claude', 'PostToolUse', {...write(cwd, 'a.js'), tool_response: {success: false}});
  await handleHook('claude', 'PostToolUse', {...write(cwd, 'b.js'), tool_response: {error: 'EACCES'}});
  assert.equal(fs.existsSync(spoolPath('claude', 'sess-1')), false);
});

test('Claude and Codex Stops preserve promoted memories and show them without drafts', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1000});
  const {cwd, memories} = fixture(t);
  for (const agent of ['claude', 'codex']) {
    await handleHook(agent, 'UserPromptSubmit', ev(cwd, {prompt: 'original problem'}));
    await handleHook(agent, 'PostToolUse', fixturePayload(`${agent}-PostToolUse`, cwd));
    await handleHook(agent, 'Stop', ev(cwd));
    const draft = memories().find(m => m.title.startsWith(agent === 'claude' ? 'Claude Code' : 'Codex'));
    t.mock.timers.tick(1);
    saveMemory({ref: draft.memoryId, type: 'solved', solution: 'verified fix'}, {cwd});
    const promoted = memories().find(m => m.memoryId === draft.memoryId);
    const file = path.join(cwd, 'memory', 'events.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    t.mock.timers.tick(1);
    await handleHook(agent, 'UserPromptSubmit', ev(cwd, {prompt: 'later unrelated problem'}));
    await handleHook(agent, 'PostToolUse', fixturePayload(`${agent}-PostToolUse`, cwd));
    await handleHook(agent, 'Stop', ev(cwd));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(memories().find(m => m.memoryId === draft.memoryId), promoted);
    assert.equal(contextGraph([promoted]).nodes[0].type, 'solved');
    assert.ok(collectMemories({repoRoot: cwd}, 'local', {drafts: false}).some(m => m.memoryId === draft.memoryId));
  }
});

test('Codex payloads captured from the real CLI produce a Codex draft', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('codex', 'UserPromptSubmit', fixturePayload('codex-UserPromptSubmit', cwd));
  await handleHook('codex', 'PostToolUse', fixturePayload('codex-PostToolUse', cwd));
  await handleHook('codex', 'Stop', fixturePayload('codex-Stop', cwd));
  const [draft] = memories();
  assert.equal(draft.title, 'Codex session sess-1');
  assert.ok(draft.files.includes('hello.txt'), JSON.stringify(draft.files));
});

test('Claude payloads captured from the real CLI produce a Claude Code draft', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'UserPromptSubmit', fixturePayload('claude-UserPromptSubmit', cwd));
  await handleHook('claude', 'PostToolUse', fixturePayload('claude-PostToolUse', cwd));
  await handleHook('claude', 'Stop', fixturePayload('claude-Stop', cwd));
  const [draft] = memories();
  assert.equal(draft.title, 'Claude Code session sess-1');
  assert.ok(draft.files.includes('hello.txt'), JSON.stringify(draft.files));
});

test('PUNK_RECORDS_AUTOSAVE=0 keeps recall but writes no spool and no memory', async t => {
  const {cwd, memories} = fixture(t);
  saveMemory({type: 'solved', title: 'Zebra quartz deploy gotcha', symptoms: 'zebra quartz', solution: 'flag'}, {cwd});
  process.env.PUNK_RECORDS_AUTOSAVE = '0';
  const out = await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'zebra quartz deploy'}));
  assert.ok(out, 'recall still answers');
  await handleHook('claude', 'PostToolUse', write(cwd, 'a.js'));
  await handleHook('claude', 'Stop', ev(cwd));
  assert.equal(fs.existsSync(spoolPath('claude', 'sess-1')), false);
  assert.equal(memories().length, 1);
});

test('a failed save puts the batch back for the next Stop', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'a.js'));
  await assert.rejects(handleHook('claude', 'Stop', ev(cwd), {save: () => { throw new Error('disk full'); }}), /disk full/);
  assert.match(fs.readFileSync(spoolPath('claude', 'sess-1'), 'utf8'), /"a\.js"/);
  await handleHook('claude', 'Stop', ev(cwd));
  assert.deepEqual(memories()[0].files, ['a.js']);
  assert.deepEqual(fs.readdirSync(path.dirname(spoolPath('claude', 'sess-1'))), []);
});

test('restore appends to a spool written while the failed save ran', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'a.js'));
  const save = async () => { await handleHook('claude', 'PostToolUse', write(cwd, 'b.js')); throw new Error('boom'); };
  await assert.rejects(handleHook('claude', 'Stop', ev(cwd), {save}), /boom/);
  await handleHook('claude', 'Stop', ev(cwd));
  assert.deepEqual([...memories()[0].files].sort(), ['a.js', 'b.js']);
});

test('duplicate concurrent Stops (global + repo hooks) save exactly one draft', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'a.js'));
  await handleHook('claude', 'PostToolUse', write(cwd, 'a.js'));
  await Promise.all([handleHook('claude', 'Stop', ev(cwd)), handleHook('claude', 'Stop', ev(cwd))]);
  assert.equal(memories().length, 1);
  assert.deepEqual(memories()[0].files, ['a.js']);
});

test('Stop deletes spool files untouched for over 7 days', async t => {
  const {cwd} = fixture(t);
  const old = spoolPath('codex', 'old-session');
  fs.mkdirSync(path.dirname(old), {recursive: true});
  fs.writeFileSync(old, '{"t":"edit","file":"x.js"}\n');
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  await handleHook('claude', 'PostToolUse', write(cwd, 'a.js'));
  await handleHook('claude', 'Stop', ev(cwd));
  assert.equal(fs.existsSync(old), false);
});

test('CLI exits 0 and prints nothing on malformed or hostile input', t => {
  const {root, cli} = fixture(t);
  const cases = [
    ['claude', 'Stop', '{not json'],
    ['claude', 'Stop', ''],
    ['nope', 'Stop', {session_id: 's', cwd: root}],
    ['claude', 'Nope', {session_id: 's', cwd: root}],
    ['__proto__', 'Stop', {session_id: 's', cwd: root}],
    ['claude', 'PostToolUse', {session_id: '../../escape', cwd: root, tool_name: 'Write', tool_input: {file_path: 'a.js'}}],
    ['claude', 'PostToolUse', {session_id: 's', cwd: root, tool_name: 'constructor', tool_input: {}}],
    ['claude', 'UserPromptSubmit', {session_id: 's', cwd: path.join(root, 'missing-dir'), prompt: 'x'.repeat(100000)}],
  ];
  for (const [agent, event, input] of cases) {
    const r = cli(agent, event, input);
    assert.equal(r.status, 0, `${agent} ${event}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${agent} ${event}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'escape.jsonl')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'global', 'spool')), ['claude-s.jsonl']);
  const [line] = fs.readFileSync(path.join(root, 'global', 'spool', 'claude-s.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(line).text.length, 500);
});

test('CLI prints the recall JSON on stdout', t => {
  const {cwd, cli} = fixture(t);
  saveMemory({type: 'solved', title: 'Zebra quartz deploy gotcha', symptoms: 'zebra quartz', solution: 'flag'}, {cwd});
  const r = cli('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'zebra quartz deploy'}));
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Zebra quartz/);
});

test('recall still works when the spool dir is unusable', async t => {
  const {cwd, root} = fixture(t);
  t.mock.method(console, 'error', () => {});
  saveMemory({type: 'solved', title: 'Zebra quartz deploy gotcha', symptoms: 'zebra quartz deploy fails', solution: 'Use the PLATYPUS flag'}, {cwd});
  fs.mkdirSync(path.join(root, 'global'), {recursive: true});
  fs.writeFileSync(path.join(root, 'global', 'spool'), 'not a dir');
  const out = await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'zebra quartz deploy'}));
  assert.match(out.hookSpecificOutput.additionalContext, /Zebra quartz deploy gotcha/);
  assert.equal(console.error.mock.callCount(), 1);
});

for (const source of ['startup', 'resume', 'clear', 'compact']) {
  test(`Claude SessionStart ${source} emits static guidance without store access`, async t => {
    const {root, cwd, cli} = fixture(t);
    const previous = process.env.PUNK_RECORDS_AUTOSAVE;
    process.env.PUNK_RECORDS_AUTOSAVE = '0';
    t.after(() => { if (previous === undefined) delete process.env.PUNK_RECORDS_AUTOSAVE; else process.env.PUNK_RECORDS_AUTOSAVE = previous; });
    const stale = path.join(root, 'global', 'spool', 'stale.jsonl');
    fs.mkdirSync(path.dirname(stale), {recursive: true});
    fs.writeFileSync(stale, 'untouched sentinel');
    fs.utimesSync(stale, new Date(0), new Date(0));
    const snapshot = () => fs.readdirSync(root, {recursive: true}).sort().map(name => {
      const file = path.join(root, name);
      const stat = fs.statSync(file);
      return [name, stat.mtimeMs, stat.isFile() ? fs.readFileSync(file, 'hex') : null];
    });
    const before = snapshot();
    const fail = () => { throw new Error('SessionStart must not access memories'); };
    const input = ev(cwd, {source, hook_event_name: 'SessionStart'});
    const out = await handleHook('claude', 'SessionStart', input, {load: fail, save: fail});
    assert.equal(out?.hookSpecificOutput.hookEventName, 'SessionStart');
    const guidance = out.hookSpecificOutput.additionalContext;
    assert.equal(guidance, WORKFLOW_GUIDANCE);
    assert.ok(guidance.length <= 1000);
    assert.match(guidance, /--full/);
    assert.doesNotMatch(guidance, /<punk-records>/);
    const res = cli('claude', 'SessionStart', input);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), out);
    assert.deepEqual(snapshot(), before);
    assert.equal(await handleHook('codex', 'SessionStart', input, {load: fail, save: fail}), null);
  });
}

test('SessionStart rejects unsupported source and invalid session', async t => {
  const {cwd} = fixture(t);
  for (const input of [ev(cwd, {source: 'unexpected'}), {source: 'startup', session_id: '../bad'}]) {
    assert.equal(await handleHook('claude', 'SessionStart', input), null);
  }
});


async function interruptedStop(t, cwd, committed = false) {
  const script = `import {handleHook} from ${JSON.stringify(new URL('../lib/hook.js', import.meta.url).href)};
    import {saveMemory} from ${JSON.stringify(new URL('../lib/save.js', import.meta.url).href)};
    await handleHook('claude', 'Stop', ${JSON.stringify(ev(cwd))}, {save: (...args) => {
      ${committed ? 'saveMemory(...args);' : ''}
      process.stdout.write('claimed'); return new Promise(() => setInterval(() => {}, 1000));
    }});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error('Stop did not claim batch'));}, 10000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', () => {clearTimeout(timer); reject(new Error('Stop exited before barrier'));});
    child.stdout.once('data', () => {clearTimeout(timer); resolve();});
  });
  await new Promise(resolve => {child.once('close', resolve); child.kill('SIGKILL');});
  return `${spoolPath('claude', 'sess-1')}.flushing.${child.pid}`;
}

for (const committed of [false, true]) test(`Stop reconciles a killed process ${committed ? 'after' : 'before'} commit without duplicate events`, async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'recovered.js'));
  const orphan = await interruptedStop(t, cwd, committed);
  assert.ok(fs.existsSync(orphan));
  await handleHook('claude', 'Stop', ev(cwd));
  assert.deepEqual(memories().map(m => m.files), [['recovered.js']]);
  assert.equal(fs.existsSync(orphan), false);
  await handleHook('claude', 'Stop', ev(cwd));
  assert.equal(fs.readFileSync(path.join(cwd, 'memory', 'events.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('Stop preserves ambiguous old orphans instead of aging them out', async t => {
  const {cwd} = fixture(t);
  const spool = spoolPath('claude', 'sess-1'), orphan = `${spool}.flushing.2147483647`;
  fs.mkdirSync(path.dirname(spool), {recursive: true});
  const content = JSON.stringify({t: 'edit', file: 'legacy.js'}) + '\n';
  fs.writeFileSync(orphan, content);
  const past = new Date(Date.now() - 8 * 86400000); fs.utimesSync(orphan, past, past);
  await handleHook('claude', 'Stop', ev(cwd));
  assert.equal(fs.readFileSync(orphan, 'utf8'), content);
});

test('orphan recovery does not overwrite a newer prompt or consume a different project batch', async t => {
  const {root, cwd, memories} = fixture(t);
  await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'old context'}));
  await handleHook('claude', 'PostToolUse', write(cwd, 'old.js'));
  const orphan = await interruptedStop(t, cwd);
  const other = path.join(root, 'other'); fs.mkdirSync(other); execFileSync('git', ['init', '-q'], {cwd: other});
  await handleHook('claude', 'Stop', ev(other));
  assert.ok(fs.existsSync(orphan));
  assert.equal(loadMemories(path.join(other, 'memory')).memories.length, 0);
  await handleHook('claude', 'UserPromptSubmit', ev(cwd, {prompt: 'new context'}));
  await handleHook('claude', 'PostToolUse', write(cwd, 'new.js'));
  await handleHook('claude', 'Stop', ev(cwd));
  assert.equal(memories()[0].symptoms, 'new context');
  // The old prompt conflicts with the current memory and remains available for manual reconciliation.
  await handleHook('claude', 'Stop', ev(cwd));
  assert.ok(fs.existsSync(orphan));
  assert.equal(memories()[0].symptoms, 'new context');
});


test('recovery preserves live, malformed and promoted batches', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'pending.js'));
  const spool = spoolPath('claude', 'sess-1'), live = `${spool}.flushing.${process.pid}`;
  fs.renameSync(spool, live);
  await handleHook('claude', 'Stop', ev(cwd));
  assert.ok(fs.existsSync(live)); assert.equal(memories().length, 0);
  const malformed = `${spool}.flushing.2147483647`;
  fs.renameSync(live, malformed); fs.appendFileSync(malformed, '{incomplete');
  await handleHook('claude', 'Stop', ev(cwd));
  assert.ok(fs.existsSync(malformed)); assert.equal(memories().length, 0);
  fs.rmSync(malformed);
  await handleHook('claude', 'PostToolUse', write(cwd, 'pending.js'));
  const orphan = await interruptedStop(t, cwd, true);
  saveMemory({ref: memories()[0].memoryId, type: 'solved', solution: 'Reviewed solution'}, {cwd});
  const before = fs.readFileSync(path.join(cwd, 'memory', 'events.jsonl'), 'utf8');
  await handleHook('claude', 'Stop', ev(cwd));
  assert.ok(fs.existsSync(orphan));
  assert.equal(fs.readFileSync(path.join(cwd, 'memory', 'events.jsonl'), 'utf8'), before);
});

test('recovery failure retains a claimed batch for a later process', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'pending.js'));
  await interruptedStop(t, cwd);
  await handleHook('claude', 'Stop', ev(cwd), {save: () => {throw new Error('disk unavailable');}});
  const names = fs.readdirSync(path.dirname(spoolPath('claude', 'sess-1')));
  assert.equal(names.length, 1); assert.match(names[0], /\.flushing\./);
  assert.match(fs.readFileSync(path.join(path.dirname(spoolPath('claude', 'sess-1')), names[0]), 'utf8'), /pending.js/);
  assert.equal(memories().length, 0);
});


test('concurrent recovery extends a compatible draft once without losing prior files', async t => {
  const {cwd, memories} = fixture(t);
  await handleHook('claude', 'PostToolUse', write(cwd, 'first.js'));
  await handleHook('claude', 'Stop', ev(cwd));
  await handleHook('claude', 'PostToolUse', write(cwd, 'second.js'));
  await interruptedStop(t, cwd);
  let entered, release;
  const saving = new Promise(resolve => {entered = resolve;});
  const barrier = new Promise(resolve => {release = resolve;});
  const first = handleHook('claude', 'Stop', ev(cwd), {save: async (...args) => {
    entered(); await barrier; return saveMemory(...args);
  }});
  try { await saving; await handleHook('claude', 'Stop', ev(cwd)); }
  finally { release(); await first; }
  assert.deepEqual(memories().map(m => m.files), [['first.js', 'second.js']]);
  assert.equal(fs.readFileSync(path.join(cwd, 'memory', 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
});
