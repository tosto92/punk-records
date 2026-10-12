import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {handleHook, spoolPath, RECALL_OUTPUT} from '../lib/hook.js';
import {saveMemory} from '../lib/save.js';
import {loadMemories} from '../lib/build.js';
import {collectMemories, contextGraph} from '../lib/graph.js';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'previously');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'hooks');

// Fresh repo + isolated global store (spool lives there); autosave forced on.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-hook-'));
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], {cwd});
  const prev = {PREVIOUSLY_HOME: process.env.PREVIOUSLY_HOME, PREVIOUSLY_AUTOSAVE: process.env.PREVIOUSLY_AUTOSAVE};
  process.env.PREVIOUSLY_HOME = path.join(root, 'global');
  delete process.env.PREVIOUSLY_AUTOSAVE;
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

test('PREVIOUSLY_AUTOSAVE=0 keeps recall but writes no spool and no memory', async t => {
  const {cwd, memories} = fixture(t);
  saveMemory({type: 'solved', title: 'Zebra quartz deploy gotcha', symptoms: 'zebra quartz', solution: 'flag'}, {cwd});
  process.env.PREVIOUSLY_AUTOSAVE = '0';
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
