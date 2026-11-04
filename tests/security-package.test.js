import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {writeSecurityStore, benign, attack} from './helpers/security.js';

const checkout = path.resolve(import.meta.dirname, '..');

test('actual npm artifact scans benign and suspicious memories outside the checkout', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-package-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const unpacked = path.join(temp, 'unpacked package with spaces');
  const cwd = path.join(temp, 'outside checkout');
  const store = path.join(temp, 'temporary memory store');
  fs.mkdirSync(unpacked); fs.mkdirSync(cwd);
  assert.ok(!temp.startsWith(checkout + path.sep), 'artifact must run outside checkout');
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', temp], {
    cwd: checkout, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(packed.status, 0, String(packed.error || packed.stderr));
  const [artifact] = JSON.parse(packed.stdout);
  const files = new Set(artifact.files.map(file => file.path));
  for (const file of ['bin/previously', 'lib/security/scan.py', 'lib/security/scan.js',
    'lib/security/requirements.txt', 'lib/security/rules/manifest.json', 'lib/security/rules/previously.nov',
    'lib/security/rules/upstream/claude_magic_string.nov', 'lib/security/rules/upstream/delimiter_termination_probe.nov',
    'lib/security/rules/upstream/hidden_unicode.nov', 'lib/security/rules/upstream/LICENSE']) {
    assert.ok(files.has(file), `missing published asset: ${file}`);
  }
  const extracted = spawnSync('tar', ['-xzf', path.join(temp, artifact.filename), '-C', unpacked], {encoding: 'utf8'});
  assert.equal(extracted.status, 0, String(extracted.error || extracted.stderr));
  const cli = path.join(unpacked, 'package', 'bin', 'previously');
  assert.ok(fs.lstatSync(cli).isFile(), 'CLI is an extracted file, not a checkout link');
  const env = {...process.env, PREVIOUSLY_HOME: store, PUNK_RECORDS_PYTHON: process.env.PUNK_RECORDS_PYTHON || 'python3'};
  env.PUNK_RECORDS_SECURITY = '0';
  for (const [memory, expectedCode, expectedStatus] of [[benign, 0, 'no_signals'], [attack, 1, 'suspicious']]) {
    writeSecurityStore(store, [memory]);
    const result = spawnSync(process.execPath, [cli, 'scan', '--global'], {cwd, env, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, expectedCode, String(result.error || result.stderr) + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.errors, []);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].store, fs.realpathSync(store));
    assert.equal(report.results[0].status, expectedStatus);
    assert.deepEqual(report.results[0].incompleteRules, []);
    assert.deepEqual(report.results[0].reasonCodes, []);
    assert.equal(report.scanner.engineVersion, '0.3.1');
    assert.match(report.scanner.rulesHash, /^[a-f0-9]{64}$/);
    if (expectedStatus === 'suspicious') assert.ok(report.results[0].matches.some(match => match.ruleName === 'PreviouslyInstructionOverride'));
  }
});


test('npm artifact excludes Python caches even after local execution', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-package-cache-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  fs.copyFileSync(path.join(checkout, 'package.json'), path.join(source, 'package.json'));
  fs.cpSync(path.join(checkout, 'lib'), path.join(source, 'lib'), {recursive: true});
  for (const relative of ['security/__pycache__/scan.cpython-312.pyc', 'episodes/__pycache__/sessions.cpython-310.pyc', 'security/scan.pyc', 'episodes/sessions.pyo']) {
    const file = path.join(source, 'lib', relative);
    fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'synthetic bytecode');
  }
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', temp], {cwd: source, encoding: 'utf8', timeout: 60000});
  assert.equal(packed.status, 0, String(packed.error || packed.stderr));
  const files = JSON.parse(packed.stdout)[0].files.map(f => f.path);
  assert.deepEqual(files.filter(f => f.includes('__pycache__/') || /\.py[co]$/.test(f)), []);
  for (const file of ['lib/security/scan.py', 'lib/episodes/sessions.py', 'lib/security/rules/manifest.json']) assert.ok(files.includes(file), file);
});
