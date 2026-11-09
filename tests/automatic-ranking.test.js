import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {automaticTokens, rankCurrent, analyzeQuery, rankCandidate, DEFAULT_PARAMETERS, PARAMETER_GRID} from '../lib/automatic-ranking.js';
import {search} from '../lib/ask.js';
import * as ranking from '../lib/automatic-ranking.js';

const memory = (title, extra = {}) => ({memoryId: title, title, ...extra});
const admitted = (candidates, query) => rankCandidate(candidates, query).filter(hit => hit.admitted);

test('candidate predeclares the fixed grid and preserves query boundaries and Unicode', () => {
  assert.deepEqual(PARAMETER_GRID, {commonAttenuation: [0.05, 0.15], idfCap: [3, 4],
    unknownPenalty: [0.15, 0.30], minEvidence: [2, 3], minCoverage: [0.45, 0.60]});
  for (const [key, values] of Object.entries(PARAMETER_GRID)) assert.equal(DEFAULT_PARAMETERS[key], values[0]);
  const query = analyzeQuery('Café UserPromptSubmit lib/main.zeek');
  assert.equal(query.original, 'Café UserPromptSubmit lib/main.zeek');
  assert.deepEqual(query.terms.map(term => term.normalized), ['cafe', 'userpromptsubmit', 'lib/main.zeek']);
  assert.equal(query.terms[0].raw, 'Café');
  assert.equal(query.terms[0].common, true);
  assert.equal(query.terms[1].lexicalUnknown, true);
  assert.deepEqual(analyzeQuery('Cafe\u0301').terms.map(term => term.normalized), ['cafe']);
  for (const [accented, plain] of [['già', 'gia'], ['però', 'pero'], ['così', 'cosi']]) {
    const [term] = analyzeQuery(accented).terms;
    const [equivalent] = analyzeQuery(plain).terms;
    assert.equal(term.common, true);
    assert.equal(term.lexicalUnknown, false);
    assert.equal(term.zipf, equivalent.zipf);
  }
});

test('candidate rejects generic words even when locally rare or capitalized', () => {
  const candidates = [memory('done fatto'), memory('Darktrace VA Nessus'), memory('Other unrelated')];
  for (const query of ['done', 'fatto', 'va bene', 'VA bene']) assert.deepEqual(admitted(candidates, query), []);
  assert.equal(admitted(candidates, 'VA Nessus')[0].memoryId, 'Darktrace VA Nessus');
  assert.equal(admitted([memory('Modbus Redis')], 'Modbus Redis').length, 1);
});

test('candidate distinguishes path fragments from exact basename, path and technical identifiers', () => {
  const candidates = [memory('Generic', {files: ['scripts/main.zeek'], _symptoms: 'UserPromptSubmit'})];
  assert.equal(admitted(candidates, 'main').length, 0);
  for (const query of ['main.zeek', 'scripts/main.zeek', 'UserPromptSubmit']) assert.equal(admitted(candidates, query).length, 1);
});

test('candidate requires two distinct specific body terms or a strong match', () => {
  const candidates = [memory('Generic', {_solution: 'Modbus Redis'})];
  assert.equal(admitted(candidates, 'Modbus Redis').length, 1);
  assert.equal(admitted(candidates, 'Modbus').length, 0);
  assert.equal(admitted([memory('Generic', {_symptoms: 'Redis Redis', _solution: 'Redis'})], 'Redis').length, 0);
});

test('candidate caps unknown penalty but abstains for unknown queries and conflicting error codes', () => {
  const candidates = [memory('Redis ERR_1001')];
  const known = rankCandidate(candidates, 'Redis')[0];
  const unknown = rankCandidate(candidates, 'Redis frobnicated blorptastic')[0];
  assert.equal(unknown.admitted, true);
  assert.equal(unknown.unknownFraction, 2 / 3);
  assert.ok(unknown.coverage >= 1 - DEFAULT_PARAMETERS.unknownPenalty);
  assert.ok(known.coverage >= unknown.coverage);
  assert.equal(admitted(candidates, 'frobnicated blorptastic').length, 0);
  assert.equal(admitted(candidates, 'Redis ERR_2002').length, 0);
  assert.equal(admitted(candidates, 'Redis ERR_1001').length, 1);
});

test('candidate has finite deterministic scores, stable order and no repetition inflation', () => {
  assert.deepEqual(rankCandidate([], 'Redis'), []);
  const original = memory('Redis', {_solution: 'Modbus', tags: ['Redis'], files: ['main.zeek']});
  const repeated = {...original, title: 'Redis Redis', _solution: 'Modbus Modbus', tags: ['Redis Redis'], files: ['main.zeek', 'main.zeek']};
  assert.deepEqual(rankCandidate([original], 'Redis Modbus'), rankCandidate([repeated], 'Redis Redis Modbus'));
  const candidates = [memory('Redis one'), memory('Redis two'), memory('')];
  const hits = rankCandidate(candidates, 'Redis');
  assert.deepEqual(hits.map(hit => hit.memoryId), candidates.map(candidate => candidate.memoryId));
  assert.equal(hits.filter(hit => hit.admitted).length, 2);
  for (const query of ['', undefined, 'Redis', 'unknownword']) {
    for (const hit of rankCandidate(candidates, query)) {
      for (const key of ['score', 'evidence', 'coverage', 'unknownFraction']) assert.ok(Number.isFinite(hit[key]), key);
    }
  }
});

test('candidate caps local rarity, keeps lexical unknown explicit and validates parameters', () => {
  const candidates = [memory('Redis'), ...Array.from({length: 100}, (_, index) => memory(`irrelevant${index}`))];
  const [hit] = rankCandidate(candidates, 'Redis', {idfCap: 3});
  assert.equal(hit.score, 9);
  assert.ok(hit.reasons.includes('lexicalUnknown:redis'));
  assert.equal(admitted([memory('Generic', {files: ['unicornmodule/main.zeek']})], 'unicornmodule').length, 0);
  assert.throws(() => rankCandidate([], 'Redis', {idfCap: Infinity}), TypeError);
  assert.throws(() => rankCandidate([], 'Redis', {unknownPenalty: 2}), RangeError);
});

test('candidate abstains for structurally explicit mismatched error codes independent of case', () => {
  const candidates = [memory('Redis ERR_1001 ECONNRESET 0x80070006 E1001')];
  for (const code of ['ERR_2002', 'err_2002', 'ECONNREFUSED', '0x80070005', '0X80070005', 'E2002', 'e2002']) {
    const [hit] = rankCandidate(candidates, `Redis ${code}`);
    assert.equal(hit.admitted, false, code);
    assert.ok(hit.reasons.includes('unmatched-error-identifier'), code);
  }
  for (const code of ['ERR_1001', 'err_1001', 'ECONNRESET', '0x80070006', '0X80070006', 'E1001', 'e1001']) {
    assert.equal(admitted(candidates, `Redis ${code}`).length, 1, code);
  }
  assert.equal(admitted(candidates, 'Redis extrapolating').length, 1);
});

test('candidate retains dotfiles and relative prefixes without matching a different path', () => {
  for (const name of ['.env', '.env.production', '../src/main.zeek', './src/main.zeek', '/src/main.zeek']) {
    assert.equal(analyzeQuery(name).terms[0].raw, name);
    assert.equal(analyzeQuery(name).terms[0].normalized, name);
    assert.equal(admitted([memory('Generic', {files: [name]})], name).length, 1, name);
  }
  for (const [stored, requested] of [['env', '.env'], ['env.production', '.env.production'],
    ['/src/main.zeek', '../src/main.zeek'], ['../src/main.zeek', '/src/main.zeek'],
    ['other/main.zeek', './src/main.zeek']]) {
    assert.equal(admitted([memory('Generic', {files: [stored]})], requested).length, 0, `${stored} vs ${requested}`);
  }
  assert.equal(admitted([memory('Generic', {files: ['../src/main.zeek']})], 'main.zeek').length, 1);
});

test('candidate preserves hidden components within full paths and distinguishes parent directories', () => {
  for (const requested of ['src/.env', 'src/.config/settings.json']) {
    assert.deepEqual(analyzeQuery(requested).terms.map(term => term.raw), [requested]);
    assert.equal(admitted([memory('Generic', {files: [requested]})], requested).length, 1);
    const wrongParent = requested.replace('src/', 'other/');
    assert.equal(admitted([memory('Generic', {files: [wrongParent]})], requested).length, 0);
  }
});

test('candidate does not turn measured-common uppercase E words into error identifiers', () => {
  const candidates = [memory('Redis')];
  for (const term of ['ERROR', 'EXAMPLE']) {
    assert.equal(analyzeQuery(term).terms[0].common, true);
    assert.equal(analyzeQuery(term).terms[0].errorCode, false);
    assert.deepEqual(rankCandidate(candidates, `Redis ${term}`), rankCandidate(candidates, `Redis ${term.toLowerCase()}`));
    assert.equal(admitted(candidates, `Redis ${term}`).length, 1);
  }
  assert.equal(analyzeQuery('ECONNREFUSED').terms[0].errorCode, true);
  assert.equal(admitted(candidates, 'Redis ECONNREFUSED').length, 0);
});

test('current ranking keeps field multipliers and weights from document frequency', () => {
  const common = {title: 'redis', _symptoms: 'redis', _solution: 'redis', tags: ['redis'], files: ['redis']};
  const rare = {title: 'redis hooks', _solution: 'hooks'};
  const scores = rankCurrent([common, rare], 'redis hooks');
  assert.deepEqual([...scores.keys()], [common, rare]);
  assert.equal(scores.get(common), 10);
  assert.equal(scores.get(rare), 8.621860432432657);
});

test('current coverage admits at 70 percent and anchor coverage at 35 percent', () => {
  const terms = Array.from({length: 20}, (_, index) => `term${index}`);
  function admitted(count, size, field) {
    const query = terms.slice(0, size);
    const matched = query.slice(0, count).join(' ');
    const candidate = {[field]: field === 'tags' ? [matched] : matched};
    const complement = {_solution: query.slice(count).join(' ')};
    return rankCurrent([candidate, complement], query.join(' ')).has(candidate);
  }
  assert.equal(admitted(7, 10, '_solution'), true);
  assert.equal(admitted(6, 10, '_solution'), false);
  assert.equal(admitted(7, 20, 'title'), true);
  assert.equal(admitted(6, 20, 'title'), false);
  assert.equal(admitted(7, 20, 'tags'), true);
});

test('automatic tokens preserve Unicode normalization, accents and stopwords', () => {
  assert.deepEqual([...automaticTokens('Perché CAFÉ cafe\u0301 Redis lib/recall.js 42 grazie')],
    ['cafe', 'redis', 'lib', 'recall', 'js', '42']);
  assert.deepEqual(automaticTokens('Café'.normalize('NFC')), automaticTokens('Café'.normalize('NFD')));
  assert.deepEqual([...automaticTokens(null)], []);
});

test('duplicate field terms and query terms do not increase the current score', () => {
  const original = {title: 'redis', _symptoms: 'redis', _solution: 'redis', tags: ['redis'], files: ['redis.js']};
  const repeated = {title: 'redis redis', _symptoms: 'redis redis', _solution: 'redis redis',
    tags: ['redis', 'redis redis'], files: ['redis.js', 'redis.js']};
  assert.equal(rankCurrent([original], 'redis').get(original), 10);
  assert.equal(rankCurrent([repeated], 'redis redis').get(repeated), 10);
});

test('current ranking returns no hits for empty candidates, fields or effective queries', () => {
  assert.deepEqual([...rankCurrent([], 'redis')], []);
  assert.deepEqual([...rankCurrent([{}], 'redis')], []);
  for (const query of ['', undefined, 'grazie please']) assert.deepEqual([...rankCurrent([{title: 'redis'}], query)], []);
});

test('automatic production parameters match the evaluated conservative selection', () => {
  assert.deepEqual(ranking.AUTOMATIC_PARAMETERS, JSON.parse(fs.readFileSync(new URL('./fixtures/recall-evidence-parameters.json', import.meta.url))));
});

test('ask automatic integration uses candidate evidence and keeps success/date/slug tie ordering', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-ranking-'));
  const names = ['PUNK_RECORDS_HOME', 'PUNK_RECORDS_SECURITY', 'PUNK_RECORDS_SYNTHESIS'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {PUNK_RECORDS_HOME: home, PUNK_RECORDS_SECURITY: '0', PUNK_RECORDS_SYNTHESIS: '0'});
  t.after(() => {
    for (const name of names) if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    fs.rmSync(home, {recursive: true, force: true});
  });
  const candidates = [
    {title: 'Redis newest', outcome: 'open', ts: '2026-11-03T00:00:00Z'},
    {title: 'Redis beta', outcome: 'ok', ts: '2026-11-02T00:00:00Z'},
    {title: 'Redis alpha', outcome: 'ok', ts: '2026-11-02T00:00:00Z'},
    {title: 'Redis old', outcome: 'ok', ts: '2026-11-01T00:00:00Z'},
    {title: 'Other note', solution: 'redis', _solution: 'redis', outcome: 'ok'},
  ];
  fs.writeFileSync(path.join(home, 'events.jsonl'), candidates.map(candidate => JSON.stringify({
    v: 1, type: 'note', ts: '2026-11-01T00:00:00Z', scope: 'global', repo: '',
    tags: [], files: [], symptoms: '', solution: '', ...candidate,
  })).join('\n') + '\n');
  const hits = search({query: 'redis', automatic: true, resolved: {repoRoot: null}, limit: 10});
  assert.deepEqual(hits.map(hit => hit.title), ['Redis alpha', 'Redis beta', 'Redis old', 'Redis newest']);
  const scores = rankCandidate(candidates, 'redis', JSON.parse(fs.readFileSync(new URL('./fixtures/recall-evidence-parameters.json', import.meta.url))));
  for (const hit of hits) assert.equal(hit.score, scores[candidates.findIndex(candidate => candidate.title === hit.title)].score);
  assert.ok(search({query: 'redis', resolved: {repoRoot: null}, limit: 10}).some(hit => hit.title === 'Other note'), 'explicit search still admits weak body matches');
});
