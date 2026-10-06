import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {search, formatHits} from '../lib/ask.js';

function writeScope(dir, memories) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'events.jsonl'), memories.map(m => JSON.stringify({v: 1, type: 'note',
    ts: '2026-10-02T00:00:00Z', scope: 'global', repo: '', tags: [], files: [], outcome: 'open',
    symptoms: '', solution: '', ...m})).join('\n') + '\n');
}
function fixture(t, memories) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ask-'));
  const previous = process.env.PREVIOUSLY_HOME;
  process.env.PREVIOUSLY_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PREVIOUSLY_HOME; else process.env.PREVIOUSLY_HOME = previous; fs.rmSync(home, {recursive: true, force: true}); });
  writeScope(home, memories);
  return {home, resolved: {repoRoot: null}};
}

test('title match outranks solution-only match; tie-break is updated desc, slug asc', t => {
  const {home, resolved} = fixture(t, [
    {title: 'Auth bug fix', ts: '2026-10-05T00:00:00Z'},
    {title: 'Something else', solution: 'auth token rotate', ts: '2026-10-01T00:00:00Z'},
    {title: 'Auth old', ts: '2026-09-01T00:00:00Z'},
    {title: 'Auth beta'}, {title: 'Auth alpha'},
  ]);
  const titles = search({query: 'auth', limit: 50, resolved}).map(h => h.title);
  assert.deepEqual(titles, ['Auth bug fix', 'Auth alpha', 'Auth beta', 'Auth old', 'Something else']);
  const repo = path.join(home, 'repo');
  writeScope(path.join(repo, 'memory'), [{title: 'Auth local note', scope: 'repo'}]);
  const localHits = search({query: 'auth', scope: 'local', resolved: {...resolved, repoRoot: repo}});
  assert.equal(localHits.length, 1);
  assert.equal(localHits[0].scope, 'repo');
  assert.match(formatHits(localHits), /^\[repo\] /);
});

test('tag and file overlap add +2 each; outcome ok adds +1', t => {
  const {resolved} = fixture(t, [
    {title: 'Auth plain'}, {title: 'Auth tagged', tags: ['auth']},
    {title: 'Auth filed', files: ['auth.js']}, {title: 'Auth ok', outcome: 'ok'},
  ]);
  const byTitle = Object.fromEntries(search({query: 'auth', resolved}).map(h => [h.title, h]));
  assert.equal(byTitle['Auth plain'].score, 3);
  assert.equal(byTitle['Auth tagged'].score, 5);
  assert.equal(byTitle['Auth filed'].score, 5);
  assert.equal(byTitle['Auth ok'].score, 4);
});

test('outside a git repo scope all returns global-only', t => {
  const {resolved} = fixture(t, [{title: 'Auth global'}]);
  assert.deepEqual(search({query: 'auth', scope: 'all', resolved}).map(h => h.scope), ['global']);
  assert.deepEqual(search({query: 'auth', scope: 'local', resolved}), []);
});

test('hit shape and formatHits retain scope, crux and covers', t => {
  const {resolved} = fixture(t, [{title: 'Auth crash', outcome: 'ok',
    symptoms: 'line one\nline two\n\nline three\n', solution: 'line four\nline five', files: ['src/auth.js:12']}]);
  const hits = search({query: 'auth', resolved});
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.scope, 'global');
  assert.match(h.slug, /^auth-crash--[a-f0-9]{40}$/);
  assert.match(h.memoryId, /^[a-f0-9]{40}$/);
  assert.equal(h.title, 'Auth crash');
  assert.equal(h.outcome, 'ok');
  assert.equal(h.updated, '2026-10-02T00:00:00Z');
  assert.equal(h.covers, 'src/auth.js:12');
  assert.equal(h.crux, 'line four\nline one\nline five');
  const lines = formatHits(hits).split('\n');
  assert.equal(lines[0], `[global] ${h.slug} — Auth crash (ok, 2026-10-02T00:00:00Z)`);
  assert.deepEqual(lines.slice(1, 4), ['line four', 'line one', 'line five']);
  assert.equal(lines[4], 'covers: src/auth.js:12');
});

test('successful unrelated memories are not hits, including empty queries', t => {
  const {resolved} = fixture(t, [{title: 'Auth fixed', outcome: 'ok'}]);
  assert.deepEqual(search({query: 'utterly-unmatched-query', resolved}), []);
  assert.deepEqual(search({query: '', resolved}), []);
});

test('crux fills remaining space from solution, or symptoms without solution', t => {
  const {resolved} = fixture(t, [
    {title: 'No symptoms', solution: 'first\nsecond\nthird\nfourth'},
    {title: 'No solution', symptoms: 'one\n\ntwo\nthree\nfour'},
    {title: 'Short solution', solution: 'fix', symptoms: 'symptom1\nsymptom2\nsymptom3'},
  ]);
  assert.equal(search({query: 'symptoms', resolved})[0].crux, 'first\nsecond\nthird');
  assert.equal(search({query: 'No solution', resolved}).find(h => h.title === 'No solution').crux, 'one\ntwo\nthree');
  assert.equal(search({query: 'Short', resolved})[0].crux, 'fix\nsymptom1\nsymptom2');
});
