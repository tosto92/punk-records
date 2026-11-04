import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeFixture, evaluate, calibrate, runCli } from '../scripts/evaluate-recall.mjs';
import * as actualRankers from '../lib/automatic-ranking.js';

const fixture = () => ({memories: [{label: 'a', title: 'secret memory', solution: 'private solution'}, {label: 'b', title: 'other', solution: ''}], cases: [
  {id: 'hit', prompt: 'secret prompt', expected: 'useful', memoryLabels: ['a']},
  {id: 'noise', prompt: 'negative', expected: 'none', memoryLabels: []},
  {id: 'unclear', prompt: 'ambiguous', expected: 'ambiguous', memoryLabels: []},
]});
const current = (candidates) => new Map(candidates.map(c => [c, 2]));
const candidate = candidates => candidates.map(c => ({memoryId: c.memoryId, score: 2, admitted: c.memoryId === 'a', reasons: ['evidence']}));
const rankers = {rankCurrent: current, rankCandidate: candidate, DEFAULT_PARAMETERS: {threshold: 1}, PARAMETER_GRID: [{threshold: 2}, {threshold: 1}]};

test('Map and diagnostic adapters use identical candidates, metrics, and private reports', () => {
  const {candidates, cases} = normalizeFixture(fixture());
  let seen;
  const baseline = evaluate(candidates, cases, (cs, q) => { seen = cs; return current(cs, q); });
  const result = evaluate(candidates, cases, (cs, q) => { assert.equal(cs, seen); return candidate(cs, q); });
  assert.deepEqual(baseline.metrics.negativeInjections, {count: 1, denominator: 1});
  assert.deepEqual(result.metrics.usefulMisses, {count: 0, denominator: 1});
  assert.equal(baseline.metrics.usefulWithDistractors.count, 1);
  assert.equal(result.metrics.usefulWithDistractors.count, 0);
  assert.equal(result.metrics.top3ExpectedCoverage.count, 1);
  assert.equal(result.metrics.ambiguousInjections.count, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('schema rejects duplicate identifiers, unknown labels, and malformed fields', () => {
  for (const change of [f => f.memories.push(f.memories[0]), f => f.cases[0].memoryLabels.push('missing'), f => f.cases.push(f.cases[0]), f => f.cases[0].expected = 'maybe', f => f.memories[0].tags = [3]]) {
    const f = fixture(); change(f); assert.throws(() => normalizeFixture(f));
  }
});

test('sort matches score, outcome, date, slug and caps at three without filling rejections', () => {
  const cs = ['z', 'b', 'a', 'c'].map(memoryId => ({memoryId, slug: memoryId, outcome: 'ok', updated: '2026-01-01'}));
  const cases = [{id: 'one', prompt: 'x', expected: 'none', memoryLabels: []}];
  assert.deepEqual(evaluate(cs, cases, current).cases[0].returned.map(r => r.memoryId), ['a', 'b', 'c']);
  assert.deepEqual(evaluate(cs, cases, candidate).cases[0].returned.map(r => r.memoryId), ['a']);
});

test('calibration reports every finite grid point and resolves ties conservatively', () => {
  const f = normalizeFixture(fixture());
  const result = calibrate(f.candidates, f.cases, rankers);
  assert.equal(result.gridResults.length, 2);
  assert.deepEqual(result.selectedParameters, {threshold: 2});
  assert.throws(() => calibrate(f.candidates, f.cases, {...rankers, PARAMETER_GRID: [{threshold: Infinity}]}));
  const conservative = calibrate(f.candidates, f.cases, {...rankers, DEFAULT_PARAMETERS: {minEvidence: 2, idfCap: 3}, PARAMETER_GRID: {minEvidence: [2, 3], idfCap: [3, 4]}});
  assert.equal(conservative.gridResults.length, 4);
  assert.deepEqual(conservative.selectedParameters, {minEvidence: 3, idfCap: 3});
});

test('actual ranker smoke and useful-miss denominator; lexical reason suffixes are private', () => {
  const f = normalizeFixture(fixture());
  assert.equal(evaluate(f.candidates, f.cases, actualRankers.rankCurrent).cases.length, 3);
  assert.equal(evaluate(f.candidates, f.cases, (cs, q) => actualRankers.rankCandidate(cs, q, actualRankers.DEFAULT_PARAMETERS)).cases.length, 3);
  const misses = evaluate(f.candidates, f.cases, () => []);
  assert.deepEqual(misses.metrics.usefulMisses, {count: 1, denominator: 1});
  assert.deepEqual(misses.metrics.top3ExpectedCoverage, {count: 0, denominator: 1});
  const redacted = evaluate(f.candidates, f.cases, cs => [{memoryId: cs[0].memoryId, score: 1, admitted: true, reasons: ['lexicalUnknown:secret']}]);
  assert.deepEqual(redacted.cases[0].returned[0].reasons, ['lexicalUnknown']);
  assert.ok(!JSON.stringify(redacted).includes('secret'));
});

test('CLI validates before output, rejects calibration validation without reading it, and supports private paths with spaces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall runner '));
  try {
    const input = path.join(dir, 'fixture with spaces.json'), output = path.join(dir, 'report.json');
    fs.writeFileSync(input, JSON.stringify(fixture())); fs.writeFileSync(output, 'keep');
    for (const args of [['--unknown'], ['--fixture', input, '--calibrate', '--validation', '/missing'], ['--fixture', input, '--parameters', path.join(dir, 'missing')]]) {
      await assert.rejects(runCli([...args, '--out', output], rankers));
      assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
    }
    await assert.rejects(runCli(['--fixture', input, '--calibrate', '--validation', '/never-read'], rankers), /cannot be used during calibration/);
    fs.writeFileSync(input, '{');
    await assert.rejects(runCli(['--fixture', input, '--out', output], rankers), /valid JSON/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
    fs.writeFileSync(input, JSON.stringify(fixture()));
    const parameters = path.join(dir, 'parameters.json');
    fs.writeFileSync(parameters, '{"threshold": "Infinity"}');
    await assert.rejects(runCli(['--fixture', input, '--parameters', parameters, '--out', output], rankers));
    await runCli(['--fixture', input, '--out', output], rankers);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.fixtureSha256.length, 64);
    assert.equal(report.sourceSha256.length, 64);
    assert.equal(report.frequencyAssetSha256.length, 64);
    assert.equal(report.parametersSha256.length, 64);
    assert.ok(!JSON.stringify(report).includes('secret'));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('output aliases through symlinked directories cannot replace any input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall aliases '));
  try {
    const physical = path.join(dir, 'physical'), alias = path.join(dir, 'alias');
    fs.mkdirSync(physical); fs.symlinkSync(physical, alias, 'dir');
    const input = path.join(physical, 'fixture.json'), parameters = path.join(physical, 'parameters.json'), validation = path.join(physical, 'validation.json');
    fs.writeFileSync(input, JSON.stringify(fixture()));
    fs.writeFileSync(parameters, JSON.stringify(rankers.DEFAULT_PARAMETERS));
    fs.writeFileSync(validation, JSON.stringify({cases: [{id: 'validation-only', prompt: 'private validation', expected: 'none', memoryLabels: []}]}));
    const before = new Map([input, parameters, validation].map(file => [file, fs.readFileSync(file)]));
    const entries = fs.readdirSync(physical);
    for (const target of [input, parameters, validation]) {
      await assert.rejects(runCli(['--fixture', input, '--parameters', parameters, '--validation', validation,
        '--out', path.join(alias, path.basename(target))], rankers), /output must not overwrite an input/);
      for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
      assert.deepEqual(fs.readdirSync(physical), entries);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
