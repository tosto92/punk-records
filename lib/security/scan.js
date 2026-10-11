import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadMemories} from '../build.js';
import {storePath} from '../paths.js';
import {escapedJSON} from './render.js';

const ENGINE_VERSION = '0.3.1', PROTOCOL_VERSION = 1;
const RULES_DIR = path.join(import.meta.dirname, 'rules');
const BRIDGE = path.join(import.meta.dirname, 'scan.py');
const HASH = /^[a-f0-9]{64}$/;
const MEMORY_KEYS = ['memoryId', 'slug', 'seedTitle', 'repo', 'title', 'symptoms', 'solution', 'attempts', 'tags', 'files', 'type', 'outcome', 'updated'];
const ARRAY_KEYS = new Set(['attempts', 'tags', 'files']);
const ERROR_CODES = new Set(['invalid_request', 'protocol_version_mismatch', 'engine_version_mismatch', 'engine_unavailable',
  'empty_rules', 'duplicate_rule_file', 'rule_hash_mismatch', 'rules_hash_mismatch', 'rules_parse_error', 'duplicate_rule_name', 'evaluator_error']);
const ITEM_CODES = new Set([...ERROR_CODES, 'invalid_item', 'memory_too_large']);
const RULE_CODES = new Set(['semantic_unavailable', 'llm_unavailable', 'evaluator_error', 'unavailable_condition', 'condition_probe_limit']);
const digest = content => createHash('sha256').update(content).digest('hex');
// UTF-8 lexical order matches Python's code-point order, including astral filenames.
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.length > 0;
const codes = (value, allowed) => Array.isArray(value) && value.every(code => allowed.has(code)) && new Set(value).size === value.length;

function physicalStore(store) {
  storePath(store, 'events.jsonl');
  let current = path.resolve(store);
  const missing = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...missing); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      missing.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

function snapshot(entry) {
  if (!object(entry) || !object(entry.memory) || !['repo', 'global'].includes(entry.scope)) throw new Error('invalid_entry');
  let store;
  try { store = physicalStore(entry.store); }
  catch { throw new Error('store_unavailable'); }
  const content = {store, scope: entry.scope};
  for (const key of MEMORY_KEYS) {
    const value = entry.memory[key];
    if (ARRAY_KEYS.has(key) ? !Array.isArray(value) || value.some(v => typeof v !== 'string') : typeof value !== 'string') {
      throw new Error('invalid_entry');
    }
    content[key] = ARRAY_KEYS.has(key) ? [...value] : value;
  }
  const texts = [];
  for (const [key, value] of Object.entries(content)) {
    if (Array.isArray(value)) value.forEach((text, index) => texts.push({field: `${key}[${index}]`, text}));
    else texts.push({field: key, text: value});
  }
  return {store, scope: entry.scope, memoryId: content.memoryId, contentHash: digest(JSON.stringify(content)), texts};
}

function loadRules(rulesDir) {
  let dir;
  let names;
  const read = name => {
    const file = storePath(dir, name);
    const bytes = fs.readFileSync(file);
    const content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    return {name, sha256: digest(bytes), content};
  };
  try {
    dir = path.resolve(rulesDir ?? RULES_DIR);
    storePath(dir, 'manifest.json');
    if (rulesDir === null) {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (!object(manifest) || manifest.upstreamCommit !== '3cee07e073c949bd00a8445a6eb2fd57a03ce1d2' ||
          !Array.isArray(manifest.default) || !object(manifest.sha256)) throw new Error('bundled_manifest_mismatch');
      const bundled = new Map();
      for (const [name, expected] of Object.entries(manifest.sha256)) {
        if (!text(name) || !HASH.test(expected)) throw new Error('bundled_manifest_mismatch');
        const rule = read(name);
        if (rule.sha256 !== expected) throw new Error('bundled_manifest_mismatch');
        bundled.set(name, rule);
      }
      names = manifest.default;
      if (!names.every(name => typeof name === 'string' && name.endsWith('.nov') && bundled.has(name))) throw new Error('bundled_manifest_mismatch');
      if (new Set(names).size !== names.length) throw new Error('duplicate_rule_file');
      const rules = names.map(name => bundled.get(name)).sort((a, b) => compare(a.name, b.name));
      if (!rules.length) throw new Error('empty_rules');
      return rules;
    }
    names = [];
    function walk(relative = '') {
      const current = relative ? storePath(dir, relative) : dir;
      for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error('rule_symlink');
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile() && name.endsWith('.nov')) names.push(name);
      }
    }
    walk();
    if (!names.length) throw new Error('empty_rules');
    if (new Set(names).size !== names.length) throw new Error('duplicate_rule_file');
    return names.sort(compare).map(read);
  } catch (err) {
    if (/symlink/.test(err.message)) throw new Error('rule_symlink');
    if (['bundled_manifest_mismatch', 'empty_rules', 'duplicate_rule_file'].includes(err.message)) throw err;
    throw new Error(rulesDir === null ? 'bundled_manifest_mismatch' : 'rules_unavailable');
  }
}

function identity(item) { return JSON.stringify([item.store, item.scope, item.memoryId]); }
function validScanner(scanner, expected, failed) {
  return keys(scanner, ['engineVersion', 'protocolVersion', 'rulesHash']) && scanner.engineVersion === expected.engineVersion &&
    scanner.protocolVersion === expected.protocolVersion &&
    (scanner.rulesHash === expected.rulesHash || failed && scanner.rulesHash === null);
}
function validate(response, items, scanner) {
  if (!keys(response, ['scanner', 'results', 'errors']) || !codes(response.errors, ERROR_CODES) ||
      !validScanner(response.scanner, scanner, response.errors.length > 0) || !Array.isArray(response.results) ||
      response.results.length !== items.length) return false;
  const pending = new Map(items.map(item => [identity(item), item]));
  for (const result of response.results) {
    if (!keys(result, ['store', 'scope', 'memoryId', 'contentHash', 'scanner', 'status', 'matches', 'incompleteRules', 'reasonCodes'])) return false;
    const item = pending.get(identity(result));
    if (!item || result.contentHash !== item.contentHash || !validScanner(result.scanner, scanner, response.errors.length > 0) ||
        result.scanner.rulesHash !== response.scanner.rulesHash || !codes(result.reasonCodes, ITEM_CODES) ||
        !Array.isArray(result.matches) || !Array.isArray(result.incompleteRules)) return false;
    pending.delete(identity(result));
    const fields = new Set([...item.texts.map(t => t.field), 'combined']);
    for (const match of result.matches) {
      if (!keys(match, ['ruleId', 'ruleName', 'uuid', 'category', 'severity', 'field', 'patternIds']) ||
          !text(match.ruleId) || match.ruleName !== match.ruleId || !fields.has(match.field) ||
          !['uuid', 'category', 'severity'].every(key => match[key] === null || typeof match[key] === 'string') ||
          !Array.isArray(match.patternIds) || !match.patternIds.every(text) || new Set(match.patternIds).size !== match.patternIds.length) return false;
    }
    for (const rule of result.incompleteRules) {
      if (!keys(rule, ['ruleId', 'reason']) || !text(rule.ruleId) || !RULE_CODES.has(rule.reason)) return false;
    }
    const incomplete = result.incompleteRules.length > 0 || result.reasonCodes.length > 0;
    if (result.status === 'no_signals' ? result.matches.length > 0 || incomplete :
        result.status === 'suspicious' ? result.matches.length === 0 :
        result.status === 'incomplete' ? result.matches.length > 0 || !incomplete : true) return false;
    if (response.errors.length && (result.status !== 'incomplete' || !response.errors.every(code => result.reasonCodes.includes(code)))) return false;
  }
  return pending.size === 0;
}

function incomplete(item, scanner, code) {
  const {store, scope, memoryId, contentHash} = item;
  return {store, scope, memoryId, contentHash, scanner, status: 'incomplete', matches: [], incompleteRules: [], reasonCodes: [code]};
}

export function scanMemories(entries, {rulesDir = null} = {}) {
  const scanner = {engineVersion: ENGINE_VERSION, protocolVersion: PROTOCOL_VERSION, rulesHash: null};
  let items = [];
  const fail = code => ({scanner, results: items.map(item => incomplete(item, scanner, code)), errors: [code]});
  if (!Array.isArray(entries)) return fail('invalid_entry');
  try {
    items = entries.map(entry => ({store: entry?.store, scope: entry?.scope, memoryId: entry?.memory?.memoryId, contentHash: null}));
    items = entries.map(snapshot);
  } catch (err) { return fail(err.message); }
  if (new Set(items.map(identity)).size !== items.length) return fail('duplicate_memory_identity');
  let rules;
  try { rules = loadRules(rulesDir); }
  catch (err) { return fail(err.message); }
  scanner.rulesHash = digest(JSON.stringify(rules.map(rule => [rule.name, rule.sha256])));
  const oversized = new Set(items.filter(item => item.texts.reduce((sum, t) => sum + [...t.text].length, 0) > 50000));
  const eligible = items.filter(item => !oversized.has(item));
  const input = JSON.stringify({...scanner, rules, items: eligible});
  if (Buffer.byteLength(input) > 4 * 1024 * 1024) return fail('batch_too_large');
  const child = spawnSync(process.env.PREVIOUSLY_PYTHON || 'python3', [BRIDGE], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error) return fail(child.error.code === 'ETIMEDOUT' ? 'scan_timeout' :
    child.error.code === 'ENOBUFS' ? 'bridge_output_too_large' : 'python_unavailable');
  if (child.status !== 0) return fail('bridge_exit');
  let response;
  try { response = JSON.parse(child.stdout); }
  catch { return fail('invalid_bridge_response'); }
  if (!validate(response, eligible, scanner)) return fail('invalid_bridge_response');
  const results = new Map(response.results.map(result => [identity(result), result]));
  return {scanner: response.scanner, errors: response.errors, results: items.map(item => oversized.has(item)
    ? incomplete(item, response.scanner, 'memory_too_large') : results.get(identity(item)))};
}

export function scanStore(store, scope, {rulesDir = null} = {}) {
  let actual, compilation;
  try {
    actual = physicalStore(store);
    compilation = loadMemories(actual, {scope});
  } catch {
    const report = scanMemories([], {rulesDir});
    report.errors = [...new Set(['store_unavailable', ...report.errors])];
    return {entries: [], report};
  }
  for (const issue of compilation.issues) console.error(escapedJSON(
    `previously: ${path.join(actual, 'events.jsonl')} line ${issue.line}: ${issue.message}`,
  ).slice(1, -1));
  const entries = compilation.memories.map(memory => ({store: actual, scope, memory}));
  return {entries, report: scanMemories(entries, {rulesDir})};
}
