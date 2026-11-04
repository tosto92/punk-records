import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../lib/viewer/app.js', import.meta.url), 'utf8');
const sessions = fs.readFileSync(new URL('../lib/sessions/sessions.html', import.meta.url), 'utf8');
const migrations = [
  {script: app.slice(0, app.indexOf('} catch {}') + 10), pairs: [
    ['previously-viz-theme', 'punk-records-viz-theme', 'dark'],
    ['previously-viz-detail-w', 'punk-records-viz-detail-w', '320']]},
  {script: sessions.slice(sessions.indexOf('// Import the known legacy preference'), sessions.indexOf('try { const s = JSON.parse')),
    pairs: [['previously-episodes', 'punk-records-sessions', '{"days":14}']]},
];

for (const {script, pairs} of migrations) test(`browser preferences migrate once: ${pairs[0][1]}`, () => {
  const values = new Map(pairs.map(([oldKey, , value]) => [oldKey, value]));
  values.set('foreign-setting', 'leave me');
  const localStorage = {getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  vm.runInNewContext(script, {localStorage});
  for (const [oldKey, key, value] of pairs) {
    assert.equal(values.get(key), value);
    assert.equal(values.has(oldKey), false);
    values.set(oldKey, 'stale');
  }
  vm.runInNewContext(script, {localStorage});
  for (const [oldKey, key, value] of pairs) {
    assert.equal(values.get(key), value, 'canonical preference wins over stale legacy data');
    assert.equal(values.has(oldKey), false);
  }
  assert.equal(values.get('foreign-setting'), 'leave me');
  assert.doesNotThrow(() => vm.runInNewContext(script, {localStorage: {getItem() { throw new Error('blocked'); }}}));
});
