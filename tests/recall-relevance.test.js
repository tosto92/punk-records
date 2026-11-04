import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recallBlock} from '../lib/recall.js';
import {saveMemory} from '../lib/save.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/recall-relevance.json', import.meta.url)));

for (const split of ['tuning', 'heldout']) test(`recall relevance benchmark (${split})`, t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-relevance-'));
  const env = {PUNK_RECORDS_HOME: path.join(cwd, 'global'), PUNK_RECORDS_SECURITY: '0', PUNK_RECORDS_SYNTHESIS: '0'};
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.writeFileSync(path.join(cwd, '.punk-records'), '');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(cwd, {recursive: true, force: true});
  });
  const ids = new Map(fixture.memories.map(({label, ...memory}) => [label,
    saveMemory({type: 'solved', ...memory}, {cwd, scope: 'global'}).memoryId]));
  const metrics = {split, cases: 0, none: 0, useful: 0, ambiguous: 0, noise: 0, lostUseful: 0, usefulWithDistractors: 0, ambiguousInjected: 0};
  const failures = [];
  for (const item of fixture.cases.filter(item => item.split === split)) {
    const block = recallBlock(item.prompt, cwd);
    const hits = [...block.matchAll(/^\[(?:repo|global)\] ([a-f0-9]{40}) — /gm)].map(match => match[1]);
    metrics.cases++; metrics[item.expected]++;
    if (item.expected === 'none') {
      if (hits.length) {metrics.noise++; failures.push(item.id);}
    } else if (item.expected === 'useful') {
      const expected = item.memoryLabels.map(label => ids.get(label));
      if (expected.some(id => !hits.includes(id))) {metrics.lostUseful++; failures.push(item.id);}
      if (hits.some(id => !expected.includes(id))) {metrics.usefulWithDistractors++; failures.push(item.id);}
    } else if (hits.length) metrics.ambiguousInjected++;
  }
  t.diagnostic(JSON.stringify(metrics));
  // Heldout failures stay aggregate during baseline; they never choose the filter.
  assert.equal(failures.length, 0, split === 'heldout' ? 'heldout mismatches: inspect only after freezing the filter' : failures.join(', '));
});
