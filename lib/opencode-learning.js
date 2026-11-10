import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setting} from './env.js';

const HELPER = fileURLToPath(new URL('./sessions/opencode_learning.py', import.meta.url));
const MAX_BYTES = 32 << 20;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function captureOpenCodeSession({sessionId, database} = {}) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('-') || sessionId.includes('\0')) throw new Error('OpenCode needs an exact native session ID');
  if (database !== undefined && (typeof database !== 'string' || !database || database.includes('\0'))) throw new Error('OpenCode needs a database path');
  const args = [HELPER, 'capture', sessionId];
  if (database !== undefined) args.push('--database', database);
  const child = spawnSync(setting('PYTHON') || 'python3', args, {encoding: 'utf8', timeout: 30000, maxBuffer: 40 << 20});
  if (child.error) throw new Error(child.error.code === 'ETIMEDOUT' ? 'OpenCode capture timed out' : child.error.code === 'ENOBUFS' ? 'OpenCode capture transport limit exceeded' : 'OpenCode capture needs Python 3.9+; check PUNK_RECORDS_PYTHON');
  if (child.status !== 0) throw new Error(child.stderr.trim().slice(0, 1000) || 'OpenCode capture failed');
  let capture;
  try { capture = JSON.parse(child.stdout); }
  catch { throw new Error('OpenCode capture returned invalid JSON'); }
  if (!Array.isArray(capture.records) || !capture.descriptor || typeof capture.sourceRevision !== 'string' || typeof capture.coverage?.sourceComplete !== 'boolean') throw new Error('OpenCode capture returned invalid data');
  const bytes = Buffer.from(capture.records.map(record => canonical(record) + '\n').join(''));
  if (bytes.length > MAX_BYTES) throw new Error('OpenCode canonical projection limit exceeded (32 MiB)');
  return {bytes, descriptor: capture.descriptor, sourceRevision: capture.sourceRevision, coverage: capture.coverage};
}
