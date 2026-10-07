import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {saveMemory} from '../lib/save.js';
import {loadMemories} from '../lib/build.js';
import {autoMemoryId} from '../lib/capture.js';

async function fixture(t, save = saveMemory) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-capture-'));
  const home = process.env.PREVIOUSLY_HOME, enabled = process.env.PREVIOUSLY_AUTOSAVE;
  process.env.PREVIOUSLY_HOME = cwd;
  delete process.env.PREVIOUSLY_AUTOSAVE;
  const api = await import('../lib/capture.js').catch(() => ({}));
  const capture = api.createCapture?.({cwd, save, load: loadMemories});
  t.after(() => {capture?.dispose(); if (home === undefined) delete process.env.PREVIOUSLY_HOME; else process.env.PREVIOUSLY_HOME = home;
    if (enabled === undefined) delete process.env.PREVIOUSLY_AUTOSAVE; else process.env.PREVIOUSLY_AUTOSAVE = enabled;
    fs.rmSync(cwd, {recursive: true, force: true});});
  return {cwd, capture, api, memories: () => loadMemories(cwd).memories};
}

test('capture isolates sessions and duplicate idles do not append', async t => {
  const {cwd, capture, memories} = await fixture(t);
  capture.prompt('session-A', 'fix A'); capture.prompt('session-B', 'fix B');
  capture.edit('session-A', ['a.js']); capture.edit('session-B', ['b.js']);
  await capture.idle('session-A'); await capture.idle('session-B'); await capture.idle('session-A');
  const a = memories().find(m => m.title === 'OpenCode session session-A');
  const b = memories().find(m => m.title === 'OpenCode session session-B');
  assert.deepEqual(a.files, ['a.js']); assert.equal(a.symptoms, 'fix A');
  assert.deepEqual(b.files, ['b.js']); assert.equal(b.symptoms, 'fix B');
  assert.equal(fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('failed save retains edits for retry', async t => {
  let fail = true;
  const {capture, memories} = await fixture(t, (input, options) => {
    if (fail) throw new Error('storage unavailable'); return saveMemory(input, options);
  });
  capture.edit('A', ['a.js']);
  await assert.rejects(() => capture.idle('A'), /storage unavailable/);
  assert.deepEqual(memories(), []);
  fail = false; await capture.idle('A');
  assert.deepEqual(memories()[0].files, ['a.js']);
});

test('edit arriving during save survives even for the same filename', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000});
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  let first = true;
  const {cwd, capture, memories} = await fixture(t, async (input, options) => {
    if (first) {first = false; await pending;} return saveMemory(input, options);
  });
  capture.edit('A', ['a.js']);
  const saving = capture.idle('A');
  capture.edit('A', ['a.js', 'b.js']);
  release(); await saving;
  t.mock.timers.tick(60000); await capture.idle('A');
  assert.deepEqual(memories()[0].files, ['a.js', 'b.js']);
  assert.equal(fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('debounce is per session, delayed idle flush is cancelled by new activity', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000});
  const {capture, memories} = await fixture(t);
  capture.edit('A', ['a.js']); await capture.idle('A');
  capture.edit('A', ['next.js']); await capture.idle('A');
  capture.edit('B', ['b.js']); await capture.idle('B');
  assert.equal(memories().length, 2);
  capture.prompt('A', 'busy again'); t.mock.timers.tick(60000);
  await Promise.resolve(); assert.deepEqual(memories().find(m => m.title.endsWith(' A')).files, ['a.js']);
  await capture.idle('A');
  assert.deepEqual(memories().find(m => m.title.endsWith(' A')).files, ['a.js', 'next.js']);
});

test('restart reuses full session identity while prompts change', async t => {
  const {cwd, capture, api, memories} = await fixture(t);
  capture.prompt('full-session-id', 'first prompt'); capture.edit('full-session-id', ['a.js']); await capture.idle('full-session-id');
  const id = memories()[0].memoryId; capture.dispose();
  const restarted = api.createCapture({cwd, save: saveMemory, load: loadMemories}); t.after(() => restarted.dispose());
  restarted.prompt('full-session-id', 'new prompt'); restarted.edit('full-session-id', ['b.js']); await restarted.idle('full-session-id');
  assert.equal(memories().length, 1); assert.equal(memories()[0].memoryId, id);
  assert.equal(memories()[0].symptoms, 'new prompt'); assert.equal(memories()[0].outcome, 'open');
});

test('50 edits trigger a batch and draft files are capped at 20 without losing pending edits', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000});
  const {cwd, capture, memories} = await fixture(t);
  capture.edit('A', Array.from({length: 50}, (_, i) => `f${i}.js`));
  await Promise.resolve(); await Promise.resolve();
  const lines = fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).files.length, 20);
  t.mock.timers.tick(60000); await capture.idle('A');
  t.mock.timers.tick(60000); await capture.idle('A');
  assert.equal(memories()[0].files.length, 50);
  assert.equal(fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8').trim().split('\n').every(l => JSON.parse(l).files.length <= 20), true);
});

test('disabled capture and deleted or disposed sessions never save', async t => {
  const {capture, memories} = await fixture(t);
  process.env.PREVIOUSLY_AUTOSAVE = '0'; capture.edit('A', ['a.js']); await capture.idle('A');
  delete process.env.PREVIOUSLY_AUTOSAVE;
  capture.edit('B', ['b.js']); capture.forget('B'); await capture.idle('B');
  capture.edit('C', ['c.js']); capture.dispose(); await capture.idle('C');
  assert.deepEqual(memories(), []);
});

test('logging failure after append does not retry a successful save', async t => {
  const {cwd, capture} = await fixture(t);
  t.mock.method(console, 'error', () => {throw new Error('logging unavailable');});
  capture.edit('A', ['a.js']); await capture.idle('A'); await capture.idle('A');
  assert.equal(fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('autoMemoryId returns the auto draft by title and ignores curated memories', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-autoid-'));
  execFileSync('git', ['init', '-q'], {cwd});
  const home = process.env.PREVIOUSLY_HOME;
  process.env.PREVIOUSLY_HOME = path.join(cwd, 'global');
  t.after(() => {
    if (home === undefined) delete process.env.PREVIOUSLY_HOME; else process.env.PREVIOUSLY_HOME = home;
    fs.rmSync(cwd, {recursive: true, force: true});
  });
  assert.equal(autoMemoryId(cwd, 'Codex session s1'), null);
  saveMemory({type: 'note', title: 'Codex session s1', tags: ['manual']}, {cwd});
  assert.equal(autoMemoryId(cwd, 'Codex session s1'), null);
  const {memoryId} = saveMemory({type: 'note', title: 'Codex session s1', symptoms: 'other', tags: ['auto']}, {cwd});
  assert.equal(autoMemoryId(cwd, 'Codex session s1'), memoryId);
});

test('capture preserves a renamed promotion with a cached ref and after restart', async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1000});
  const {cwd, capture, api, memories} = await fixture(t);
  capture.prompt('A', 'original problem'); capture.edit('A', ['a.js']); await capture.idle('A');
  const draft = memories()[0];
  t.mock.timers.tick(1);
  saveMemory({ref: draft.memoryId, title: 'Curated fix', type: 'solved', solution: 'verified fix'}, {cwd});
  const promoted = memories()[0];
  const before = fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8');
  t.mock.timers.tick(60000);
  capture.prompt('A', 'later problem'); capture.edit('A', ['b.js']); await capture.idle('A');
  assert.deepEqual(memories(), [promoted]);
  assert.equal(fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8'), before);
  capture.dispose();
  const restarted = api.createCapture({cwd});
  t.after(() => restarted.dispose());
  restarted.prompt('A', 'after restart'); restarted.edit('A', ['c.js']); await restarted.idle('A');
  assert.deepEqual(memories(), [promoted]);
  assert.equal(fs.readFileSync(path.join(cwd, 'events.jsonl'), 'utf8'), before);
});
