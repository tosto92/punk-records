import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {saveMemory} from '../lib/save.js';
import {loadMemories} from '../lib/build.js';
import {securityFixture, writeSecurityStore, attack, benign} from './helpers/security.js';

// The OpenCode plugin is TypeScript (OpenCode runs it under Bun); Node loads it only with type stripping (22.18+).
const TS = {skip: !process.features?.typescript && 'this Node cannot import .ts (type stripping needs Node 22.18+)'};

// Contracts pinned to @opencode-ai/plugin 1.18.34 and @opencode/plugin/core 2.0.18.
// V2 native write: input.path, completed result.output.target; edit/patch output.files[].file.
async function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-plugin-'));
  execFileSync('git', ['init', '-q'], {cwd});
  const enabled = process.env.PUNK_RECORDS_AUTOSAVE, home = process.env.PUNK_RECORDS_HOME;
  delete process.env.PUNK_RECORDS_AUTOSAVE;
  // Recall also searches the global store; keep real user memories out of the fixture.
  process.env.PUNK_RECORDS_HOME = path.join(cwd, 'global');
  t.after(() => {if (enabled === undefined) delete process.env.PUNK_RECORDS_AUTOSAVE; else process.env.PUNK_RECORDS_AUTOSAVE = enabled;
    if (home === undefined) delete process.env.PUNK_RECORDS_HOME; else process.env.PUNK_RECORDS_HOME = home; fs.rmSync(cwd, {recursive: true, force: true});});
  const module = await import('../.opencode/plugins/punk-records.ts').catch(() => ({}));
  return {cwd, module, plugin: module.default, memories: () => loadMemories(path.join(cwd, 'memory')).memories};
}
const afterV1 = (hooks, sid, file, tool = 'write') => hooks['tool.execute.after'](
  {tool, sessionID: sid, callID: 'call', args: {filePath: file, content: 'text'}},
  {title: file, output: 'Written successfully.', metadata: tool === 'edit' ? {filediff: {file, additions: 1, deletions: 0, patch: ''}} : {filepath: file, exists: false}});
const idleV1 = (hooks, sid) => hooks.event({event: {type: 'session.idle', properties: {sessionID: sid}}});
const promptV2 = (sid, text) => ({sessionID: sid, messageID: 'message', prompt: {text}, delivery: 'steer'});
const afterV2 = (sid, file) => ({tool: 'write', sessionID: sid, messageID: 'message', agent: 'build', id: 'call',
  input: {path: file, content: 'text'}, status: 'completed', result: {output: {operation: 'write', target: file, resource: file, existed: false}, content: 'Created successfully.'}});

function context(cwd) {
  const hooks = {}, waits = new Map(), registrations = [], listeners = [];
  const hook = async (name, fn) => {hooks[name] = fn; const registration = {disposed: false, async dispose() {this.disposed = true;}}; registrations.push(registration); return registration;};
  const ctx = {location: {directory: cwd, project: {id: 'project', directory: cwd, canonical: cwd}},
    session: {hook, async get({sessionID}) {return {id: sessionID, location: {directory: sessionID === 'foreign' ? path.dirname(cwd) : cwd}};},
      wait({sessionID}, {signal}) {assert.equal(typeof signal.aborted, 'boolean'); return new Promise((resolve, reject) => {
        waits.set(sessionID, {resolve, signal}); signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});});}},
    tool: {hook}, event: {async *subscribe({signal}) {while (!signal.aborted) {
      const event = await new Promise(resolve => {listeners.push(resolve); signal.addEventListener('abort', () => resolve(null), {once: true});});
      if (event) yield event;
    }}}};
  return {ctx, hooks, waits, registrations, emit(event) {listeners.shift()?.(event);}};
}
async function settle() {for (let i = 0; i < 8; i++) await Promise.resolve();}

test('native V1 apply_patch and V2 patch capture every affected file', TS, async t => {
  const {cwd, plugin, memories} = await fixture(t);
  const files = ['added.js', 'changed.js', 'deleted.js'].map(file => ({file: path.join(cwd, file), patch: '', additions: 1, deletions: 1, status: 'modified'}));
  const v1 = await plugin.server({directory: cwd});
  await v1['tool.execute.after']({tool: 'apply_patch', sessionID: 'V1', args: {patchText: 'patch'}},
    {title: 'patch', output: 'Success', metadata: {files}});
  await idleV1(v1, 'V1');
  assert.deepEqual(memories().find(m => m.title.endsWith(' V1'))?.files, ['added.js', 'changed.js', 'deleted.js']);
  const {ctx, hooks, waits} = context(cwd);
  const cleanup = await plugin.setup(ctx); t.after(cleanup);
  await hooks['execute.after']({tool: 'patch', sessionID: 'V2', status: 'completed', input: {patchText: 'patch'},
    result: {output: {files, applied: files.map(f => ({type: 'update', resource: f.file, target: f.file}))}}});
  assert.equal(waits.has('V2'), true);
  waits.get('V2').resolve(); await settle();
  assert.deepEqual(memories().find(m => m.title.endsWith(' V2'))?.files, ['added.js', 'changed.js', 'deleted.js']);
});

test('direct entrypoint registers one plugin; V1 sessions and hooks are isolated', TS, async t => {
  const {cwd, module, plugin, memories} = await fixture(t);
  assert.equal(plugin.id, 'punk-records');
  assert.deepEqual(Object.keys(module), ['default']);
  const hooks = await plugin.server({directory: cwd});
  await hooks['chat.message']({sessionID: 'A'}, {parts: [{type: 'text', text: 'fix A'}]});
  await hooks['chat.message']({sessionID: 'B'}, {parts: [{type: 'text', text: 'fix B'}]});
  await hooks.event({event: {type: 'file.edited', properties: {file: path.join(cwd, 'unattributed.js')}}});
  await afterV1(hooks, 'A', path.join(cwd, 'a.js')); await afterV1(hooks, 'B', path.join(cwd, 'b.js'), 'edit');
  await idleV1(hooks, 'A'); await idleV1(hooks, 'B'); await idleV1(hooks, 'A');
  assert.deepEqual(memories().find(m => m.title.endsWith(' A')).files, ['a.js']);
  assert.deepEqual(memories().find(m => m.title.endsWith(' B')).files, ['b.js']);
  assert.equal(memories().find(m => m.title.endsWith(' A')).symptoms, 'fix A');
  assert.equal(memories().length, 2);
  const other = await plugin.server({directory: cwd}); await idleV1(other, 'C');
  assert.equal(memories().length, 2);
});

test('V1 recall injects strings and does not capture shell, foreign or deleted sessions', TS, async t => {
  const {cwd, plugin, memories} = await fixture(t);
  const saved = saveMemory({type: 'solved', title: 'auth fix', solution: 'rotate token'}, {cwd});
  const hooks = await plugin.server({directory: cwd});
  await hooks['chat.message']({sessionID: 'A'}, {parts: [{type: 'text', text: 'auth fix'}]});
  const output = {system: []}; await hooks['experimental.chat.system.transform']({sessionID: 'A'}, output);
  assert.equal(typeof output.system[0], 'string'); assert.match(output.system[0], /rotate token/);
  assert.ok(output.system[0].length <= 1500);
  assert.ok(output.system[0].endsWith('\n</punk-records>'));
  assert.ok(output.system[0].includes(saved.memoryId));
  await afterV1(hooks, 'A', path.join(cwd, 'shell.js'), 'bash');
  await hooks.event({event: {type: 'session.created', properties: {info: {id: 'foreign', directory: path.dirname(cwd)}}}});
  await afterV1(hooks, 'foreign', path.join(cwd, 'foreign.js')); await idleV1(hooks, 'foreign');
  await afterV1(hooks, 'deleted', path.join(cwd, 'deleted.js'));
  await hooks.event({event: {type: 'session.deleted', properties: {info: {id: 'deleted', directory: cwd}}}});
  await idleV1(hooks, 'deleted'); await idleV1(hooks, 'A');
  assert.equal(memories().length, 1);
});

test('V2 uses native completed tool output and background wait; context uses text objects', TS, async t => {
  const {cwd, plugin, memories} = await fixture(t);
  const saved = saveMemory({type: 'solved', title: 'auth fix', solution: 'rotate token'}, {cwd});
  const {ctx, hooks, waits, registrations} = context(cwd);
  const cleanup = await plugin.setup(ctx); t.after(cleanup);
  await hooks.prompt(promptV2('A', 'auth fix')); await hooks.prompt(promptV2('B', 'fix B'));
  const output = {sessionID: 'A', system: [], messages: [], options: {}, tools: {}, agent: 'build', model: {providerID: 'local', id: 'test'}};
  await hooks.context(output);
  assert.equal(output.system[0].type, 'text'); assert.match(output.system[0].text, /rotate token/);
  assert.ok(output.system[0].text.endsWith('\n</punk-records>'));
  assert.ok(output.system[0].text.includes(saved.memoryId));
  await hooks['execute.after'](afterV2('A', path.join(cwd, 'a.js')));
  await hooks['execute.after'](afterV2('B', path.join(cwd, 'b.js')));
  assert.equal(waits.size, 2); assert.equal(memories().length, 1);
  waits.get('A').resolve(); await settle();
  assert.deepEqual(memories().find(m => m.title.endsWith(' A')).files, ['a.js']);
  assert.equal(memories().some(m => m.title.endsWith(' B')), false);
  await cleanup(); assert.equal(waits.get('B').signal.aborted, true);
  assert.equal(registrations.every(r => r.disposed), true);
});

test('V2 rejects failed tools and foreign sessions; deletion cancels pending waits', TS, async t => {
  const {cwd, plugin, memories} = await fixture(t);
  const {ctx, hooks, waits, emit} = context(cwd);
  const cleanup = await plugin.setup(ctx); t.after(cleanup);
  await hooks['execute.after']({...afterV2('A', path.join(cwd, 'failed.js')), status: 'error', result: undefined, error: {message: 'failed'}});
  await hooks['execute.after'](afterV2('foreign', path.join(cwd, 'foreign.js')));
  assert.equal(waits.size, 0); assert.deepEqual(memories(), []);
  await hooks['execute.after'](afterV2('A', path.join(cwd, 'a.js')));
  emit({type: 'session.deleted', location: {directory: cwd}, data: {sessionID: 'A'}}); await settle();
  assert.equal(waits.get('A').signal.aborted, true);
  assert.deepEqual(memories(), []);
});

test('autosave kill switch applies to V1 and V2', TS, async t => {
  const {cwd, plugin, memories} = await fixture(t); process.env.PUNK_RECORDS_AUTOSAVE = '0';
  const v1 = await plugin.server({directory: cwd}); await afterV1(v1, 'A', path.join(cwd, 'a.js')); await idleV1(v1, 'A');
  const {ctx, hooks, waits} = context(cwd); const cleanup = await plugin.setup(ctx); t.after(cleanup);
  await hooks['execute.after'](afterV2('B', path.join(cwd, 'b.js')));
  assert.equal(waits.size, 0); assert.deepEqual(memories(), []);
});

test('both OpenCode wrappers exclude quarantined payloads and continue on scanner failure', TS, async t => {
  const f = securityFixture(t);
  writeSecurityStore(path.join(f.repo, 'memory'), [attack, benign], 'repo');
  const {default: plugin} = await import('../.opencode/plugins/punk-records.ts');
  const logs = []; t.mock.method(console, 'error', line => logs.push(line));
  const v1 = await plugin.server({directory: f.repo});
  await v1['chat.message']({sessionID: 'A'}, {parts: [{type: 'text', text: 'deploy'}]});
  const {ctx, hooks} = context(f.repo); const cleanup = await plugin.setup(ctx); t.after(cleanup);
  await hooks.prompt(promptV2('A', 'deploy'));
  const check = async expected => {
    const old = {system: []}; await v1['experimental.chat.system.transform']({sessionID: 'A'}, old);
    const next = {sessionID: 'A', system: [], messages: [], options: {}, tools: {}, agent: 'build', model: {providerID: 'local', id: 'test'}};
    await hooks.context(next);
    for (const output of [old, next]) {
      assert.doesNotMatch(JSON.stringify(output), /quarantined|QUARANTINED|Ignore/);
      assert.equal(output.system.length, expected);
      if (expected) assert.match(JSON.stringify(output), /restart safely/);
    }
  };
  await check(1);
  process.env.PUNK_RECORDS_PYTHON = path.join(f.root, 'missing'); await check(0);
  assert.equal(logs.length, 4);
});
