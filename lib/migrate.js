import fs from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {readEventRecords, validateEvent, MEMORY_ID} from './events.js';
import {compileMemories, resolveReference} from './build.js';
import {fingerprint} from './fingerprint.js';
import {storePath} from './paths.js';

export function migrateScope(dir, {apply = false, expectedSource = null, refs = {}} = {}) {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new TypeError('refs must be a line-to-memoryId object');
  const file = storePath(dir, 'events.jsonl');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const sourceHash = createHash('sha256').update(raw).digest('hex');
  if (apply && expectedSource !== sourceHash) throw new TypeError('source changed; preview again and provide expected-source');
  const {records, issues} = readEventRecords(dir);
  const compiled = compileMemories(records);
  const unresolved = [...issues, ...compiled.issues.filter(i => records.find(r => r.line === i.line)?.event.v === 2)], mappings = [], replacements = new Map();
  for (const key of Object.keys(refs)) {
    if (!records.some(r => String(r.line) === key && r.event.v === 1 && r.event.ref)) throw new TypeError(`invalid ref mapping line: ${key}`);
  }
  for (const {line, event} of records) {
    if (event.v === 2) continue;
    try {
      let memoryId;
      if (refs[line] !== undefined) {
        if (typeof refs[line] !== 'string' || !MEMORY_ID.test(refs[line])) throw new TypeError('mapping requires full memoryId');
        memoryId = resolveReference(compiled, refs[line]).memoryId;
      } else memoryId = event.ref ? resolveReference(compiled, event.ref).memoryId : fingerprint(event);
      const target = resolveReference(compiled, memoryId);
      const converted = {...event, v: 2, memoryId};
      // Legacy reference fields described the attempt, not a presentation update.
      if (event.ref) { delete converted.title; delete converted.symptoms; delete converted.type; }
      validateEvent(converted);
      replacements.set(line, JSON.stringify(converted));
      mappings.push({line, ref: event.ref ?? null, memoryId, slug: target.slug});
    } catch (err) { unresolved.push({line, code: 'ref', message: err.message, blocking: true}); }
  }
  const result = {sourceHash, mappings, unresolved, backupPath: null, changed: false};
  if (!apply) return result;
  if (unresolved.length) throw new TypeError('unresolved records: ' + unresolved.map(i => `line ${i.line}: ${i.message}`).join('; '));
  if (!replacements.size) return result;
  const next = raw.split('\n').map((text, i) => replacements.get(i + 1) ?? text).join('\n');
  const checked = compileMemories(next.split('\n').filter(Boolean).map((text, i) => ({line: i + 1, event: JSON.parse(text)})));
  if (checked.issues.some(i => i.blocking)) throw new TypeError('migration would produce unresolved records');
  const backupPath = `${file}.bak-${randomUUID()}`, tmp = `${file}.tmp-${randomUUID()}`;
  // ponytail: offline migration requires stopped writers; checksum is not a lock.
  // Add cooperative writer locking only if online migration becomes a requirement.
  if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== raw) throw new TypeError('source changed during migration');
  fs.writeFileSync(backupPath, raw, {flag: 'wx'});
  try {
    fs.writeFileSync(tmp, next, {flag: 'wx'});
    if (fs.readFileSync(file, 'utf8') !== raw) throw new TypeError('source changed during migration');
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return {...result, backupPath, changed: true};
}
