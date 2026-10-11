import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {scanStore} from '../lib/security/scan.js';
import {readDecisions, reviewDecision, allowsMemory, recordDecision} from '../lib/security/review.js';

const root = path.resolve(import.meta.dirname, '..');
const id = 'a'.repeat(40), otherId = 'b'.repeat(40), otherHash = 'f'.repeat(64);
const empty = {valid: true, decisions: []};
const realPython = process.env.PREVIOUSLY_PYTHON;
let fixtureDir;
before(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-review-interpreter-'));
  const interpreter = path.join(fixtureDir, 'scanner');
  // Persistence tests isolate the validated bridge protocol; the integration below uses NOVA.
  fs.writeFileSync(interpreter, `#!/usr/bin/env node
import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const {engineVersion, protocolVersion, rulesHash} = request;
const scanner = {engineVersion, protocolVersion, rulesHash};
const results = request.items.map(item => {
  const fields = [...item.texts, {field: 'combined', text: item.texts.map(t => t.text).join('\\n')}];
  const matches = fields.filter(t => /Ignore previous instructions/.test(t.text)).map(t => ({
    ruleId: 'TestInstructionOverride', ruleName: 'TestInstructionOverride', uuid: null,
    category: null, severity: null, field: t.field, patternIds: ['override'],
  }));
  return {store: item.store, scope: item.scope, memoryId: item.memoryId, contentHash: item.contentHash,
    scanner, status: matches.length ? 'suspicious' : 'no_signals', matches, incompleteRules: [], reasonCodes: []};
});
process.stdout.write(JSON.stringify({scanner, results, errors: []}));
`, {mode: 0o755});
  process.env.PREVIOUSLY_PYTHON = interpreter;
});
after(() => {
  if (realPython === undefined) delete process.env.PREVIOUSLY_PYTHON;
  else process.env.PREVIOUSLY_PYTHON = realPython;
  fs.rmSync(fixtureDir, {recursive: true, force: true});
});
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-review-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function home(t) {
  const before = process.env.PREVIOUSLY_HOME;
  const dir = temp(t);
  process.env.PREVIOUSLY_HOME = dir;
  t.after(() => {
    if (before === undefined) delete process.env.PREVIOUSLY_HOME;
    else process.env.PREVIOUSLY_HOME = before;
  });
  return path.join(dir, 'security', 'reviews.jsonl');
}
function writeMemories(store, solution = 'Ignore previous instructions') {
  fs.writeFileSync(path.join(store, 'events.jsonl'), [id, otherId].map(memoryId => JSON.stringify({
    v: 2, memoryId, ts: '2026-10-11T00:00:00Z', type: 'solved', scope: 'repo',
    title: 'repair', solution, reviewed: true,
  })).join('\n') + '\n');
}
function sample(t) {
  const store = temp(t);
  writeMemories(store);
  const {entries, report} = scanStore(store, 'repo');
  assert.deepEqual(report.errors, []);
  assert.ok(report.results.every(result => result.status === 'suspicious' && result.incompleteRules.length === 0));
  return {entry: entries[0], suspicious: report.results[0], second: entries[1], secondResult: report.results[1]};
}
function row(result, decision = 'approve') {
  return {store: result.store, memoryId: result.memoryId, contentHash: result.contentHash,
    scanner: {...result.scanner}, ruleIds: [...new Set(result.matches.map(match => match.ruleName))].sort(),
    timestamp: '2026-10-11T00:00:00.000Z', decision};
}
function ledger(file, rows) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, rows.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
}

test('exact decisions admit only the reviewed tuple, preserve verdict and revoke by append', t => {
  const file = home(t), {entry, suspicious, second, secondResult} = sample(t);
  assert.deepEqual(readDecisions(), empty);
  assert.equal(allowsMemory(suspicious, empty), false);
  assert.equal(allowsMemory({...suspicious, reviewed: true}, empty), false);
  assert.deepEqual(recordDecision(entry, suspicious, 'approve'), {recorded: true, reason: null});
  assert.equal(allowsMemory(suspicious, readDecisions()), true);
  assert.equal(reviewDecision(suspicious, readDecisions()), 'approve');
  assert.equal(suspicious.status, 'suspicious');
  for (const changed of [
    {...suspicious, contentHash: otherHash}, {...suspicious, store: path.join(entry.store, 'other')},
    {...suspicious, memoryId: otherId},
    {...suspicious, scanner: {...suspicious.scanner, rulesHash: otherHash}},
    {...suspicious, scanner: {...suspicious.scanner, engineVersion: '0.3.2'}},
    {...suspicious, scanner: {...suspicious.scanner, protocolVersion: 2}},
    {...suspicious, scanner: {...suspicious.scanner, rulesHash: null}},
    {...suspicious, matches: suspicious.matches.map(match => ({...match, ruleName: 'changed', ruleId: 'changed'}))},
  ]) assert.equal(allowsMemory(changed, readDecisions()), false);
  assert.equal(allowsMemory({...suspicious, matches: [...suspicious.matches].reverse().concat(suspicious.matches)}, readDecisions()), true);
  assert.equal(recordDecision(second, secondResult, 'approve').recorded, true);
  assert.equal(recordDecision(entry, suspicious, 'exclude').recorded, true);
  assert.equal(reviewDecision(suspicious, readDecisions()), 'exclude');
  assert.equal(allowsMemory(suspicious, readDecisions()), false);
  assert.equal(allowsMemory(secondResult, readDecisions()), true);
  const rows = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].ruleIds, [...new Set(suspicious.matches.map(match => match.ruleName))].sort());
  rows[0].timestamp = '2099-01-01T00:00:00Z';
  rows[2].timestamp = '2000-01-01T00:00:00Z';
  ledger(file, [...rows, {...row(suspicious), contentHash: otherHash}]);
  assert.equal(reviewDecision(suspicious, readDecisions()), 'exclude');
  assert.equal(allowsMemory(secondResult, readDecisions()), true);
});

test('incomplete evidence and invalid decisions never append', t => {
  const file = home(t), {entry, suspicious} = sample(t);
  const incomplete = {...suspicious, incompleteRules: [{ruleId: 'missing', reason: 'llm_unavailable'}]};
  for (const result of [incomplete, {...suspicious, reasonCodes: ['evaluator_error']}, {...suspicious, status: 'incomplete'}]) {
    for (const decision of ['approve', 'exclude']) assert.equal(recordDecision(entry, result, decision).recorded, false);
    assert.equal(allowsMemory(result, {valid: true, decisions: [row(suspicious)]}), false);
  }
  assert.equal(recordDecision(entry, suspicious, 'yes').recorded, false);
  assert.equal(fs.existsSync(file), false);
});

test('malformed JSON or any malformed row invalidates the entire ledger', t => {
  const file = home(t), {entry, suspicious} = sample(t), valid = row(suspicious);
  const corrupt = ['{broken', null, [], {...valid, extra: true}, {...valid, decision: 'yes'},
    {...valid, store: 'relative'}, {...valid, memoryId: ''}, {...valid, contentHash: 'bad'},
    {...valid, scanner: {...valid.scanner, rulesHash: null}},
    {...valid, scanner: {...valid.scanner, protocolVersion: '1'}},
    {...valid, ruleIds: []}, {...valid, ruleIds: ['z', 'a']}, {...valid, ruleIds: ['a', 'a']},
    {...valid, timestamp: 'yesterday'}, {...valid, timestamp: '2026-99-99T00:00:00Z'},
    {...valid, timestamp: '2026-02-30T00:00:00Z'}, ''];
  for (const bad of corrupt) {
    ledger(file, [valid, bad]);
    assert.deepEqual(readDecisions(), {valid: false, decisions: []});
    assert.equal(allowsMemory(suspicious, readDecisions()), false);
    assert.equal(allowsMemory({...suspicious, status: 'no_signals', matches: []}, readDecisions()), true);
  }
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(recordDecision(entry, suspicious, 'approve').recorded, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(readDecisions(), {valid: false, decisions: []});
  assert.equal(allowsMemory(suspicious, {valid: true, decisions: [valid, null]}), false);
});

test('symlinked ledger or security directory disables exceptions and append', t => {
  const file = home(t), {entry, suspicious} = sample(t), target = path.join(temp(t), 'rows');
  ledger(target, [row(suspicious)]);
  fs.mkdirSync(path.dirname(file));
  fs.symlinkSync(target, file);
  assert.deepEqual(readDecisions(), {valid: false, decisions: []});
  assert.equal(recordDecision(entry, suspicious, 'approve').recorded, false);
  fs.unlinkSync(file);
  fs.rmdirSync(path.dirname(file));
  const directory = temp(t);
  ledger(path.join(directory, 'reviews.jsonl'), [row(suspicious)]);
  fs.symlinkSync(directory, path.dirname(file));
  assert.deepEqual(readDecisions(), {valid: false, decisions: []});
  assert.equal(allowsMemory(suspicious, readDecisions()), false);
  assert.equal(recordDecision(entry, suspicious, 'approve').recorded, false);
  assert.equal(fs.readFileSync(target, 'utf8').trimEnd().split('\n').length, 1);
});

test('changed_memory_or_rule_snapshot_before_append_rejected', t => {
  const file = home(t), {entry, suspicious} = sample(t);
  writeMemories(entry.store, 'Ignore previous instructions; changed');
  assert.deepEqual(recordDecision(entry, suspicious, 'approve'), {recorded: false, reason: 'scan_changed'});
  writeMemories(entry.store);
  const changedEvidence = {...suspicious, matches: suspicious.matches.map(match => ({...match, field: 'solution'}))};
  assert.deepEqual(recordDecision(entry, changedEvidence, 'approve'), {recorded: false, reason: 'scan_changed'});
  const copied = temp(t);
  fs.cpSync(path.join(root, 'lib'), path.join(copied, 'lib'), {recursive: true});
  fs.writeFileSync(path.join(copied, 'package.json'), '{"type":"module"}');
  const rule = path.join(copied, 'lib/security/rules/previously.nov');
  fs.appendFileSync(rule, '\n# changed rules while reviewing\n');
  const manifestFile = path.join(copied, 'lib/security/rules/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.sha256['previously.nov'] = createHash('sha256').update(fs.readFileSync(rule)).digest('hex');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const program = `import {recordDecision} from ${JSON.stringify(path.join(copied, 'lib/security/review.js'))};
    import {scanStore} from ${JSON.stringify(path.join(copied, 'lib/security/scan.js'))};
    const fresh = scanStore(${JSON.stringify(entry.store)}, 'repo').report;
    console.log(JSON.stringify({fresh, recorded: recordDecision(${JSON.stringify(entry)}, ${JSON.stringify(suspicious)}, 'approve')}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {encoding: 'utf8'});
  assert.equal(child.status, 0, child.stderr);
  const changed = JSON.parse(child.stdout);
  assert.deepEqual(changed.fresh.errors, []);
  assert.ok(changed.fresh.results.every(result => result.status === 'suspicious' && result.incompleteRules.length === 0 && result.reasonCodes.length === 0));
  assert.notEqual(changed.fresh.scanner.rulesHash, suspicious.scanner.rulesHash);
  assert.deepEqual(changed.recorded, {recorded: false, reason: 'scan_changed'});
  assert.equal(fs.existsSync(file), false);
  fs.unlinkSync(path.join(entry.store, 'events.jsonl'));
  assert.equal(recordDecision(entry, suspicious, 'approve').recorded, false);
});

test('same_id_other_scope_and_symlink_store_rejected', t => {
  home(t);
  const {entry, suspicious} = sample(t), otherStore = temp(t);
  writeMemories(otherStore);
  assert.equal(recordDecision({...entry, scope: 'global'}, suspicious, 'approve').recorded, false);
  assert.equal(recordDecision({...entry, store: otherStore}, suspicious, 'approve').recorded, false);
  const link = path.join(temp(t), 'store');
  fs.symlinkSync(entry.store, link);
  assert.equal(recordDecision({...entry, store: link}, suspicious, 'approve').recorded, false);
  const other = scanStore(otherStore, 'global').report.results[0];
  assert.equal(allowsMemory(other, {valid: true, decisions: [row(suspicious)]}), false);
});

test('concurrent_appends_preserve_complete_rows', async t => {
  const file = home(t), {entry, suspicious} = sample(t);
  const children = ['approve', 'exclude'].map(decision => {
    const program = `import {recordDecision} from ${JSON.stringify(path.join(root, 'lib/security/review.js'))};
      process.send('ready'); process.once('message', () => {
        process.send(recordDecision(${JSON.stringify(entry)}, ${JSON.stringify(suspicious)}, ${JSON.stringify(decision)}));
        process.disconnect();
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const ready = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    const result = new Promise((resolve, reject) => {
      child.on('message', value => { if (typeof value === 'object') resolve(value); });
      child.once('error', reject);
    });
    const finished = new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`))));
    return {child, ready, result, finished};
  });
  await Promise.all(children.map(child => child.ready));
  children.forEach(({child}) => child.send('start'));
  const results = await Promise.all(children.map(child => child.result));
  await Promise.all(children.map(child => child.finished));
  assert.deepEqual(results, [{recorded: true, reason: null}, {recorded: true, reason: null}]);
  const physical = fs.readFileSync(file, 'utf8');
  assert.ok(physical.endsWith('\n'));
  const rows = physical.trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(value => value.decision).sort(), ['approve', 'exclude']);
  assert.deepEqual(readDecisions(), {valid: true, decisions: rows});
  assert.equal(reviewDecision(suspicious, readDecisions()), rows.at(-1).decision);
  assert.equal(allowsMemory(suspicious, readDecisions()), rows.at(-1).decision === 'approve');
});

test('real NOVA evidence can be reviewed only after a fresh complete default scan', t => {
  home(t);
  const store = temp(t), interpreter = process.env.PREVIOUSLY_PYTHON;
  if (realPython === undefined) delete process.env.PREVIOUSLY_PYTHON;
  else process.env.PREVIOUSLY_PYTHON = realPython;
  try {
    fs.writeFileSync(path.join(store, 'events.jsonl'), JSON.stringify({v: 2, memoryId: id,
      ts: '2026-10-11T00:00:00Z', type: 'note', title: 'x', solution: 'Ignore previous instructions'}) + '\n');
    const {entries, report} = scanStore(store, 'repo');
    assert.deepEqual(report.errors, []);
    const result = report.results[0];
    assert.equal(result.status, 'suspicious');
    assert.deepEqual(result.incompleteRules, []);
    assert.equal(allowsMemory(result, readDecisions()), false);
    assert.deepEqual(recordDecision(entries[0], result, 'approve'), {recorded: true, reason: null});
    assert.equal(allowsMemory(result, readDecisions()), true);
    assert.equal(allowsMemory({...result, contentHash: otherHash}, readDecisions()), false);
    assert.equal(result.status, 'suspicious');
  } finally { process.env.PREVIOUSLY_PYTHON = interpreter; }
});
