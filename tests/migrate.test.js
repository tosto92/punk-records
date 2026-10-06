import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fingerprint} from '../lib/fingerprint.js';
import * as build from '../lib/build.js';

const event = {v: 1, ts: '2026-10-02T00:00:00Z', type: 'note', title: 'legacy', symptoms: 'A', repo: '', ref: null, outcome: 'open'};

test('mixed migration preserves V2 presentation and legacy update semantics', async t => {
  const memoryId = fingerprint(event);
  const {dir} = fixture(t, [event,
    {...event, v: 2, memoryId, ref: memoryId, title: 'renamed', symptoms: 'new symptoms', type: 'decision', ts: '2026-10-02T01:00:00Z'},
    {...event, ref: 'legacy', solution: 'fix', ts: '2026-10-02T02:00:00Z'}]);
  const before = build.loadMemories(dir).memories;
  const {migrateScope} = await import('../lib/migrate.js');
  migrateScope(dir, {apply: true, expectedSource: migrateScope(dir).sourceHash});
  assert.deepEqual(build.loadMemories(dir).memories, before);
});
function fixture(t, events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-migrate-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'events.jsonl');
  const raw = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, raw);
  return {dir, file, raw};
}

test('migration previews, backs up exact bytes and is idempotent', async t => {
  const {dir, file, raw} = fixture(t, [event, {...event, ref: 'legacy', solution: 'fix', ts: '2026-10-02T01:00:00Z'}]);
  const api = await import('../lib/migrate.js').catch(() => ({}));
  const preview = api.migrateScope(dir);
  assert.equal(preview.mappings.length, 2);
  assert.deepEqual(preview.unresolved, []);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.deepEqual(fs.readdirSync(dir), ['events.jsonl']);
  const applied = api.migrateScope(dir, {apply: true, expectedSource: preview.sourceHash});
  assert.equal(fs.readFileSync(applied.backupPath, 'utf8'), raw);
  const migrated = fs.readFileSync(file, 'utf8');
  assert.equal(migrated.trim().split('\n').every(line => JSON.parse(line).v === 2), true);
  assert.equal(build.loadMemories(dir).memories[0].solution, 'fix');
  assert.equal(api.migrateScope(dir, {apply: true, expectedSource: api.migrateScope(dir).sourceHash}).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), migrated);
});

test('ambiguous migration requires explicit valid target and unchanged source', async t => {
  const {dir, file, raw} = fixture(t, [event, {...event, symptoms: 'B'}, {...event, ref: 'legacy', solution: 'fix A'}]);
  const api = await import('../lib/migrate.js').catch(() => ({}));
  const preview = api.migrateScope(dir);
  assert.equal(preview.unresolved.length, 1);
  assert.throws(() => api.migrateScope(dir, {apply: true, expectedSource: preview.sourceHash}), /unresolved/);
  assert.throws(() => api.migrateScope(dir, {apply: true, expectedSource: preview.sourceHash, refs: {'3': 'a'.repeat(40)}}), /unknown/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  const result = api.migrateScope(dir, {apply: true, expectedSource: preview.sourceHash, refs: {'3': fingerprint(event)}});
  assert.equal(result.changed, true);
  assert.equal(build.loadMemories(dir).memories.find(m => m.memoryId === fingerprint(event)).solution, 'fix A');
  assert.throws(() => api.migrateScope(dir, {apply: true, expectedSource: preview.sourceHash}), /changed/);
});

test('CLI migrate defaults to preview and rejects stale apply', t => {
  const {dir, file, raw} = fixture(t, [event]);
  const cli = path.resolve(import.meta.dirname, '../bin/previously');
  const options = {env: {...process.env, PREVIOUSLY_HOME: dir}, encoding: 'utf8'};
  const run = spawnSync(process.execPath, [cli, 'migrate', '--global', '--dry-run'], options);
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).mappings.length, 1);
  const bad = spawnSync(process.execPath, [cli, 'migrate', '--global', '--apply', '--expected-source', 'stale'], options);
  assert.equal(bad.status, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
