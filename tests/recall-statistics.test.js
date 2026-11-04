import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as statistics from '../scripts/recall-statistics.mjs';
import {normalizeFixture, evaluate, runCli} from '../scripts/evaluate-recall.mjs';

const memories = [
  {label: 'a', title: 'quartz quartz zebra', projectId: 'p1', sessionId: 's1'},
  {label: 'b', title: 'zebra', projectId: 'p2', sessionId: 's2'},
];
const cases = [{id: 'one', prompt: 'quartz', expected: 'useful', memoryLabels: ['a']}];
const fixture = () => normalizeFixture({memories, cases});

test('empirical clarity uses document term presence; score dispersion is not NQC', () => {
  assert.equal(typeof statistics.retrievalStatistics, 'function');
  const {candidates} = fixture();
  const result = statistics.retrievalStatistics(candidates, 'quartz zebra', [{memoryId: 'a', score: 4}, {memoryId: 'b', score: 2}]);
  assert.equal(result.clarityProxyNats, 0);
  assert.equal(result.scoreCv, 1 / 3);
  assert.equal(result.relativeTopGap, 0.5);
  assert.equal(result.projectDiversity.meanQueryGroupFraction, 0.75);
  assert.equal(result.sessionDiversity.meanQueryGroupFraction, 0.75);
  const single = statistics.retrievalStatistics(candidates, 'quartz', [{memoryId: 'a', score: 4}]);
  assert.ok(Math.abs(single.clarityProxyNats - 0.5 * Math.log(1.5) - 0.5 * Math.log(0.75)) < 1e-12);
  assert.equal(single.scoreCv, null);
  assert.equal(single.relativeTopGap, null);
});

test('absent, single-group, incomplete provenance and empty results cannot imply specificity', () => {
  const {candidates} = fixture();
  const empty = statistics.retrievalStatistics([], 'quartz', []);
  assert.equal(empty.clarityProxyNats, null);
  assert.equal(empty.projectDiversity.meanQueryGroupFraction, null);
  const partial = statistics.retrievalStatistics([{...candidates[0]}, {...candidates[1], projectId: undefined}], 'quartz', []);
  assert.equal(partial.projectDiversity.labelledDocuments, 1);
  assert.equal(partial.projectDiversity.meanQueryGroupFraction, null);
  const unknown = statistics.retrievalStatistics(candidates, 'noSuchToken', []);
  assert.equal(unknown.projectDiversity.meanQueryGroupFraction, null);
  assert.equal(unknown.projectDiversity.matchedQueryTerms, 0);
});

test('assessment validation preserves context privately and rejects incomplete paired claims', () => {
  const assessment = {context: 'private context', rationale: 'private rationale', provenance: 'observed',
    pairedOutcome: {withoutMemory: 'fail', withMemory: 'pass', evidence: 'private evidence'}};
  const normalized = normalizeFixture({memories, cases: [{...cases[0], assessment}]});
  assert.deepEqual(normalized.cases[0].assessment, assessment);
  for (const bad of [{...assessment, provenance: 'guess'}, {...assessment, pairedOutcome: {withoutMemory: 'fail', withMemory: 'pass'}}, {...assessment, context: 5}]) {
    assert.throws(() => normalizeFixture({memories, cases: [{...cases[0], assessment: bad}]}));
  }
  assert.throws(() => normalizeFixture({memories: [{...memories[0], projectId: 3}], cases}));
  const result = evaluate(normalized.candidates, normalized.cases, cs => new Map([[cs[0], 4]]), {statistics: true});
  assert.ok(result.cases[0].statistics);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(result.pairedOutcomes.observed, {pairs: 1, helped: 1, harmed: 0, bothPass: 0, bothFail: 0});
  assert.equal(result.pairedOutcomes.unmeasured, 0);
});

test('no measurements invented; synthetic pairs and all four observed outcomes remain separate', () => {
  const {candidates} = fixture();
  const annotated = [null, ...['observed', 'synthetic'].flatMap(provenance => ['pass', 'fail'].flatMap(withoutMemory => ['pass', 'fail'].map(withMemory => ({
    context: '', rationale: 'test', provenance, pairedOutcome: {withoutMemory, withMemory, evidence: 'unit test only'},
  }))))].map((assessment, i) => ({...cases[0], id: `c${i}`, ...(assessment ? {assessment} : {})}));
  const result = evaluate(candidates, annotated, () => [], {statistics: true});
  assert.equal(result.pairedOutcomes.unmeasured, 1);
  for (const kind of ['observed', 'synthetic']) assert.deepEqual(result.pairedOutcomes[kind], {pairs: 4, helped: 1, harmed: 1, bothPass: 1, bothFail: 1});
});

test('CLI statistics is opt-in, private, and does not affect retrieval decisions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-stats-'));
  try {
    const input = path.join(dir, 'input.json'), output = path.join(dir, 'output.json');
    fs.writeFileSync(input, JSON.stringify({memories, cases}));
    const args = ['--fixture', input, '--out', output];
    const plain = await runCli(args);
    const enriched = await runCli([...args, '--statistics']);
    assert.equal(plain.fixture.candidate.cases[0].statistics, undefined);
    assert.ok(enriched.fixture.candidate.cases[0].statistics);
    assert.deepEqual(enriched.fixture.candidate.metrics, plain.fixture.candidate.metrics);
    assert.deepEqual(enriched.fixture.candidate.cases[0].returned, plain.fixture.candidate.cases[0].returned);
    assert.equal(enriched.fixture.candidate.pairedOutcomes.unmeasured, 1);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const report = fs.readFileSync(output, 'utf8');
    assert.ok(!report.includes('quartz') && !report.includes('p1') && !report.includes('s1'));
    await assert.rejects(runCli([...args, '--statistics', '--calibrate']), /statistics.*calibration/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
