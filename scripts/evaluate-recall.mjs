import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { retrievalStatistics, summarizePairedOutcomes } from './recall-statistics.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const identifier = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(x);
const sha256 = x => createHash('sha256').update(x).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };

export function normalizeFixture(input, existingCandidates) {
  assert(object(input), 'fixture must be an object');
  const raw = input.candidates ?? input.memories;
  assert(existingCandidates || Array.isArray(raw), 'fixture requires candidates or memories');
  const candidates = existingCandidates || raw.map(m => {
    assert(object(m), 'memory must be an object');
    const synthetic = input.memories !== undefined;
    const memoryId = synthetic ? m.label : m.memoryId;
    assert(identifier(memoryId), 'invalid memory identifier');
    assert(typeof m.title === 'string' && m.title.trim(), `invalid title for ${memoryId}`);
    for (const key of synthetic ? ['solution', 'symptoms'] : ['_solution', '_symptoms'])
      assert(m[key] === undefined || typeof m[key] === 'string', `invalid ${key} for ${memoryId}`);
    for (const key of ['tags', 'files']) assert(m[key] === undefined || Array.isArray(m[key]) && m[key].every(v => typeof v === 'string'), `invalid ${key} for ${memoryId}`);
    for (const key of ['slug', 'updated', 'outcome', '_scope']) assert(m[key] === undefined || typeof m[key] === 'string', `invalid ${key} for ${memoryId}`);
    for (const key of ['projectId', 'sessionId']) assert(m[key] === undefined || identifier(m[key]), `invalid ${key} for ${memoryId}`);
    return {...m, memoryId, slug: synthetic ? memoryId : m.slug ?? memoryId,
      _solution: synthetic ? m.solution ?? '' : m._solution ?? '',
      _symptoms: synthetic ? m.symptoms ?? '' : m._symptoms ?? '',
      tags: m.tags ?? [], files: m.files ?? [], _scope: m._scope ?? 'repo',
      outcome: synthetic ? 'ok' : m.outcome ?? 'ok', updated: synthetic ? '2026-01-01T00:00:00.000Z' : m.updated ?? ''};
  });
  const ids = new Set(candidates.map(c => c.memoryId));
  assert(ids.size === candidates.length, 'duplicate memory identifiers');
  assert(Array.isArray(input.cases), 'fixture requires cases');
  const caseIds = new Set();
  const cases = input.cases.map(c => {
    assert(object(c) && identifier(c.id) && !caseIds.has(c.id), 'invalid or duplicate case identifier');
    caseIds.add(c.id);
    assert(typeof c.prompt === 'string' && c.prompt.trim(), `invalid prompt for ${c.id}`);
    assert(['none', 'useful', 'ambiguous'].includes(c.expected), `invalid expected for ${c.id}`);
    assert(Array.isArray(c.memoryLabels) && c.memoryLabels.every(id => identifier(id) && ids.has(id)), `unknown memory label for ${c.id}`);
    assert(new Set(c.memoryLabels).size === c.memoryLabels.length, `duplicate memory labels for ${c.id}`);
    assert(c.expected !== 'useful' || c.memoryLabels.length > 0, `useful case ${c.id} requires labels`);
    assert(c.expected === 'useful' || c.memoryLabels.length === 0, `non-useful case ${c.id} cannot have labels`);
    if (c.assessment !== undefined) {
      const a = c.assessment;
      assert(object(a) && typeof a.context === 'string' && typeof a.rationale === 'string' && a.rationale.trim() &&
        ['observed', 'synthetic'].includes(a.provenance), `invalid assessment for ${c.id}`);
      if (a.pairedOutcome !== undefined) {
        const pair = a.pairedOutcome;
        assert(object(pair) && ['pass', 'fail'].includes(pair.withoutMemory) && ['pass', 'fail'].includes(pair.withMemory) &&
          typeof pair.evidence === 'string' && pair.evidence.trim(), `invalid paired outcome for ${c.id}`);
      }
    }
    return {id: c.id, prompt: c.prompt, expected: c.expected, memoryLabels: [...c.memoryLabels],
      ...(c.assessment !== undefined ? {assessment: c.assessment} : {})};
  });
  return {candidates, cases};
}

export function evaluate(candidates, cases, ranker, {statistics = false} = {}) {
  const byId = new Map(candidates.map(c => [c.memoryId, c]));
  const metrics = Object.fromEntries(['negativeInjections', 'usefulMisses', 'usefulWithDistractors', 'top3ExpectedCoverage', 'ambiguousInjections'].map(k => [k, {count: 0, denominator: 0}]));
  let extraDistractors = 0;
  const rows = cases.map(c => {
    const ranked = ranker(candidates, c.prompt);
    const diagnostics = ranked instanceof Map
      ? [...ranked].map(([memory, score]) => { assert(candidates.includes(memory), 'baseline returned unknown candidate'); return {memoryId: memory.memoryId, score, admitted: true, reasons: ['baseline']}; })
      : ranked;
    assert(Array.isArray(diagnostics), 'ranker must return a Map or diagnostic rows');
    const seen = new Set();
    for (const row of diagnostics) {
      assert(object(row) && byId.has(row.memoryId) && !seen.has(row.memoryId) && Number.isFinite(row.score) && typeof row.admitted === 'boolean', 'invalid ranker result');
      seen.add(row.memoryId);
    }
    const returned = diagnostics.filter(r => r.admitted).sort((a, b) => {
      const x = byId.get(a.memoryId), y = byId.get(b.memoryId);
      return b.score - a.score || Number(y.outcome === 'ok') - Number(x.outcome === 'ok') || (x.updated < y.updated ? 1 : x.updated > y.updated ? -1 : 0) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0);
    }).slice(0, 3).map(r => ({memoryId: r.memoryId, score: r.score,
      reasons: Array.isArray(r.reasons) ? [...new Set(r.reasons.filter(v => typeof v === 'string').map(v => v.split(':')[0]).filter(v => /^[a-zA-Z0-9_-]{1,64}$/.test(v)))].slice(0, 8) : []}));
    const expected = new Set(c.memoryLabels), hits = returned.filter(r => expected.has(r.memoryId)).length;
    if (c.expected === 'none') { metrics.negativeInjections.denominator++; metrics.negativeInjections.count += Number(returned.length > 0); }
    if (c.expected === 'ambiguous') { metrics.ambiguousInjections.denominator++; metrics.ambiguousInjections.count += Number(returned.length > 0); }
    if (c.expected === 'useful') {
      metrics.usefulMisses.denominator++; metrics.usefulMisses.count += Number(hits === 0);
      metrics.usefulWithDistractors.denominator++; metrics.usefulWithDistractors.count += Number(returned.length > hits);
      metrics.top3ExpectedCoverage.denominator += expected.size; metrics.top3ExpectedCoverage.count += hits;
      extraDistractors += returned.length - hits;
    }
    return {id: c.id, expected: c.expected, expectedIds: c.memoryLabels, returned,
      ...(statistics ? {statistics: retrievalStatistics(candidates, c.prompt, returned)} : {})};
  });
  return {metrics, extraDistractors, cases: rows, ...(statistics ? {
    contextUsedForRanking: false,
    pairedOutcomes: summarizePairedOutcomes(cases),
    pairedOutcomesScope: 'input task observations, not attributed to either ranker',
  } : {})};
}

function validateParameters(parameters, defaults) {
  assert(object(parameters) && Object.keys(parameters).length > 0, 'parameters must be a nonempty numeric object');
  assert(Object.keys(parameters).length === Object.keys(defaults).length && Object.keys(defaults).every(k => Object.hasOwn(parameters, k)), 'parameters must match declared parameter names');
  assert(Object.values(parameters).every(Number.isFinite), 'parameters must be finite numbers');
  return parameters;
}

export function calibrate(candidates, cases, rankers) {
  const {rankCurrent, rankCandidate, DEFAULT_PARAMETERS, PARAMETER_GRID} = rankers;
  const baseline = evaluate(candidates, cases, rankCurrent);
  const baselineHits = new Set(baseline.cases.filter(c => c.expected === 'useful' && c.returned.some(r => c.expectedIds.includes(r.memoryId))).map(c => c.id));
  const grid = Array.isArray(PARAMETER_GRID) ? PARAMETER_GRID : Object.entries(PARAMETER_GRID).reduce((rows, [key, values]) => {
    assert(Array.isArray(values) && values.length > 0, 'invalid parameter grid');
    return rows.flatMap(row => values.map(value => ({...row, [key]: value})));
  }, [{}]);
  assert(grid.length > 0, 'empty parameter grid');
  const gridResults = grid.map(parameters => {
    validateParameters(parameters, DEFAULT_PARAMETERS);
    const result = evaluate(candidates, cases, (cs, q) => rankCandidate(cs, q, parameters));
    const lostUseful = result.cases.filter(c => baselineHits.has(c.id) && !c.returned.some(r => c.expectedIds.includes(r.memoryId))).length;
    return {parameters, lostUseful, ...result};
  });
  const objective = row => [row.lostUseful, row.metrics.negativeInjections.count, row.extraDistractors];
  const conservative = row => ['minEvidence', 'minCoverage', 'unknownPenalty', 'commonAttenuation', 'idfCap'].map((key, i) => (i < 3 ? -1 : 1) * (row.parameters[key] ?? 0));
  const selected = gridResults.reduce((best, row) => {
    const a = [...objective(row), ...conservative(row)], b = [...objective(best), ...conservative(best)];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? row : best;
    return best;
  });
  return {baseline, gridResults, selectedParameters: selected.parameters, acceptance: {zeroLostUseful: selected.lostUseful === 0, zeroUsefulMisses: selected.metrics.usefulMisses.count === 0, zeroNegativeInjections: selected.metrics.negativeInjections.count === 0}, tiePolicy: 'larger minEvidence, minCoverage, unknownPenalty; smaller commonAttenuation, idfCap; then declared grid order'};
}

export function benchmark(rankers, parameters) {
  return [100, 1000, 10000].map(size => {
    const candidates = Array.from({length: size}, (_, i) => ({memoryId: `bench-${i}`, slug: `bench-${i}`, title: `component${i} TLS certificate verify`, _symptoms: `failure${i} gateway${i % 19}`, _solution: `install authority${i} certificate`, tags: [`tag${i}`], files: [`src/component${i}.js`], outcome: 'ok', updated: '2026-01-01', _scope: 'repo'}));
    const runners = [() => rankers.rankCurrent(candidates, 'TLS certificate verify component42'), () => rankers.rankCandidate(candidates, 'TLS certificate verify component42', parameters)];
    const p95 = runners.map(run => {
      for (let i = 0; i < 3; i++) run();
      const times = Array.from({length: 30}, () => { const start = performance.now(); run(); return performance.now() - start; }).sort((a, b) => a - b);
      return times[Math.ceil(times.length * 0.95) - 1];
    });
    return {candidates: size, repetitions: 30, warmup: 3, currentP95Ms: p95[0], candidateP95Ms: p95[1], deltaP95Ms: p95[1] - p95[0], scope: 'local ranking only; excludes full hook latency'};
  });
}

export async function runCli(argv, suppliedRankers) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: node scripts/evaluate-recall.mjs --fixture PATH [--parameters PATH] [--validation PATH] [--out PATH] [--benchmark] [--statistics]\n       node scripts/evaluate-recall.mjs --fixture PATH --calibrate [--out PATH]\nCalibration uses only fixture cases and cannot accept validation, statistics or selected parameters.\nReports omit raw prompts/memory/context text; --out writes atomically with mode 0600.\nStatistics are descriptive proxies, not WIG/NQC or an activation gate.\nBenchmark measures local ranking only, excluding full hook latency.\n');
    return;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    assert(['--fixture', '--parameters', '--validation', '--out', '--calibrate', '--benchmark', '--statistics'].includes(arg) && !Object.hasOwn(options, arg), `unknown or duplicate argument: ${arg}`);
    if (['--calibrate', '--benchmark', '--statistics'].includes(arg)) options[arg] = true;
    else { assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `missing path for ${arg}`); options[arg] = argv[++i]; }
  }
  assert(options['--fixture'], '--fixture PATH is required');
  assert(!options['--calibrate'] || !options['--validation'], '--validation cannot be used during calibration');
  assert(!options['--calibrate'] || !options['--parameters'], '--parameters cannot be used during calibration');
  assert(!options['--calibrate'] || !options['--statistics'], '--statistics cannot be used during calibration');
  const read = file => { try { const text = fs.readFileSync(file, 'utf8'); return {value: JSON.parse(text), hash: sha256(text)}; } catch { throw new Error(`cannot read valid JSON: ${file}`); } };
  const fixture = read(options['--fixture']);
  const normalized = normalizeFixture(fixture.value);
  const rankers = suppliedRankers ?? await import('../lib/automatic-ranking.js');
  const parameters = validateParameters(options['--parameters'] ? read(options['--parameters']).value : rankers.DEFAULT_PARAMETERS, rankers.DEFAULT_PARAMETERS);
  const report = {runtimeAlgorithm: 'production baseline; evidence candidate inactive', fixtureSha256: fixture.hash, parameters, parametersSha256: sha256(JSON.stringify(parameters)), corpusCounts: {candidates: normalized.candidates.length, cases: normalized.cases.length}};
  report.sourceSha256 = sha256(fs.readFileSync(new URL('../lib/automatic-ranking.js', import.meta.url)));
  report.frequencyAssetSha256 = sha256(fs.readFileSync(new URL('../lib/data/recall-frequency.json', import.meta.url)));
  if (options['--statistics']) report.statisticsSourceSha256 = sha256(fs.readFileSync(new URL('./recall-statistics.mjs', import.meta.url)));
  const evaluationOptions = {statistics: Boolean(options['--statistics'])};
  const compare = cases => ({baseline: evaluate(normalized.candidates, cases, rankers.rankCurrent, evaluationOptions), candidate: evaluate(normalized.candidates, cases, (cs, q) => rankers.rankCandidate(cs, q, parameters), evaluationOptions)});
  if (options['--calibrate']) {
    report.calibration = calibrate(normalized.candidates, normalized.cases, rankers);
    report.parameters = report.calibration.selectedParameters;
    report.parametersSha256 = sha256(JSON.stringify(report.parameters));
  } else {
    report.fixture = compare(normalized.cases);
    if (options['--validation']) {
      const validation = read(options['--validation']);
      const {cases} = normalizeFixture(validation.value, normalized.candidates);
      const known = new Set(normalized.cases.map(c => c.id));
      assert(cases.every(c => !known.has(c.id)), 'validation case identifiers overlap fixture');
      report.validationSha256 = validation.hash;
      report.corpusCounts.validationCases = cases.length;
      report.validation = compare(cases);
    }
  }
  if (options['--benchmark']) report.benchmark = benchmark(rankers, report.parameters);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options['--out']) {
    const destination = path.resolve(options['--out']);
    const physicalDestination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
    assert(!['--fixture', '--parameters', '--validation'].some(k => options[k] &&
      (path.resolve(options[k]) === destination || fs.realpathSync(options[k]) === physicalDestination)), 'output must not overwrite an input');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, serialized, {mode: 0o600, flag: 'wx'}); fs.renameSync(temporary, destination); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  } else process.stdout.write(serialized);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => { console.error(`evaluate-recall: ${error.message}`); process.exitCode = 1; });
}
