import fs from 'node:fs';
import path from 'node:path';
import {globalDir, storePath} from '../paths.js';
import {MEMORY_ID} from '../events.js';
import {scanStore} from './scan.js';

const LEDGER = 'security/reviews.jsonl';
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.length > 0;
const hash = value => typeof value === 'string' && HASH.test(value);
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const ruleIds = result => [...new Set(result.matches.map(match => match.ruleName))].sort(compare);
function validScanner(scanner) {
  return keys(scanner, ['engineVersion', 'protocolVersion', 'rulesHash']) && text(scanner.engineVersion) &&
    Number.isSafeInteger(scanner.protocolVersion) && scanner.protocolVersion > 0 && hash(scanner.rulesHash);
}
function validTuple(value) {
  return object(value) && text(value.store) && path.isAbsolute(value.store) &&
    typeof value.memoryId === 'string' && MEMORY_ID.test(value.memoryId) && hash(value.contentHash) && validScanner(value.scanner);
}
function validDecision(value) {
  return keys(value, ['store', 'memoryId', 'contentHash', 'scanner', 'ruleIds', 'timestamp', 'decision']) && validTuple(value) &&
    ['approve', 'exclude'].includes(value.decision) && typeof value.timestamp === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.timestamp) && Number.isFinite(Date.parse(value.timestamp)) &&
    new Date(value.timestamp).toISOString().slice(0, 19) === value.timestamp.slice(0, 19) &&
    Array.isArray(value.ruleIds) && value.ruleIds.length > 0 && value.ruleIds.every(text) &&
    value.ruleIds.every((name, index) => index === 0 || compare(value.ruleIds[index - 1], name) < 0);
}
function complete(result) {
  return object(result) && Array.isArray(result.incompleteRules) && result.incompleteRules.length === 0 &&
    Array.isArray(result.reasonCodes) && result.reasonCodes.length === 0;
}
function suspicious(result) {
  return validTuple(result) && ['repo', 'global'].includes(result.scope) && result.status === 'suspicious' && complete(result) &&
    Array.isArray(result.matches) && result.matches.length > 0 && result.matches.every(match =>
      keys(match, ['ruleId', 'ruleName', 'uuid', 'category', 'severity', 'field', 'patternIds']) && text(match.ruleName) &&
      match.ruleId === match.ruleName && text(match.field) && ['uuid', 'category', 'severity'].every(key => match[key] === null || typeof match[key] === 'string') &&
      Array.isArray(match.patternIds) && match.patternIds.every(text) && new Set(match.patternIds).size === match.patternIds.length);
}
function tuple(value, names) {
  return JSON.stringify([value.store, value.memoryId, value.contentHash, value.scanner.engineVersion,
    value.scanner.protocolVersion, value.scanner.rulesHash, names]);
}
function evidence(result) {
  return JSON.stringify(result.matches.map(match => JSON.stringify([match.ruleName, match.uuid, match.category,
    match.severity, match.field, [...match.patternIds].sort(compare)])).sort(compare));
}

export function readDecisions() {
  let fd;
  try {
    const file = storePath(globalDir(), LEDGER);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return {valid: false, decisions: []};
    const raw = new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(fd));
    if (!raw) return {valid: true, decisions: []};
    if (!raw.endsWith('\n')) return {valid: false, decisions: []};
    const decisions = raw.slice(0, -1).split('\n').map(line => JSON.parse(line));
    if (!decisions.every(validDecision)) return {valid: false, decisions: []};
    return {valid: true, decisions};
  } catch (err) {
    return {valid: err.code === 'ENOENT', decisions: []};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function reviewDecision(result, ledger) {
  if (!suspicious(result) || !object(ledger) || ledger.valid !== true || !Array.isArray(ledger.decisions) ||
      !ledger.decisions.every(validDecision)) return null;
  const expected = tuple(result, ruleIds(result));
  for (let i = ledger.decisions.length - 1; i >= 0; i--) {
    const decision = ledger.decisions[i];
    if (tuple(decision, decision.ruleIds) === expected) return decision.decision;
  }
  return null;
}

export function allowsMemory(result, ledger) {
  if (result?.status === 'no_signals' && complete(result) && Array.isArray(result.matches) && result.matches.length === 0) return true;
  return reviewDecision(result, ledger) === 'approve';
}

export function recordDecision(entry, displayed, decision) {
  const reject = reason => ({recorded: false, reason});
  if (!['approve', 'exclude'].includes(decision)) return reject('invalid_decision');
  if (!suspicious(displayed)) return reject('incomplete_or_invalid_result');
  if (!object(entry) || entry.scope !== displayed.scope || entry.memory?.memoryId !== displayed.memoryId ||
      typeof entry.store !== 'string' || path.resolve(entry.store) !== displayed.store) return reject('memory_changed');
  if (!readDecisions().valid) return reject('invalid_ledger');
  const {report} = scanStore(entry.store, entry.scope);
  if (report.errors.length) return reject('scan_incomplete');
  const current = report.results.find(result => result.store === displayed.store && result.scope === displayed.scope && result.memoryId === displayed.memoryId);
  if (!suspicious(current)) return reject('memory_missing_or_incomplete');
  if (tuple(current, ruleIds(current)) !== tuple(displayed, ruleIds(displayed)) || evidence(current) !== evidence(displayed)) return reject('scan_changed');
  let fd;
  try {
    const file = storePath(globalDir(), LEDGER);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    storePath(globalDir(), LEDGER);
    if (!readDecisions().valid) return reject('invalid_ledger');
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    if (!fs.fstatSync(fd).isFile()) return reject('invalid_ledger');
    const row = {store: current.store, memoryId: current.memoryId, contentHash: current.contentHash,
      scanner: current.scanner, ruleIds: ruleIds(current), timestamp: new Date().toISOString(), decision};
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    if (fs.writeSync(fd, bytes) !== bytes.length) return reject('ledger_write_failed');
    return {recorded: true, reason: null};
  } catch { return reject('ledger_write_failed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
