import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setting} from './env.js';

const HELPER = fileURLToPath(new URL('./sessions/opencode_learning.py', import.meta.url));
const MAX_BYTES = 32 << 20;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export class OpenCodeCaptureError extends Error {}

// Only fixed reader diagnostics may cross the public boundary; subprocess stderr is untrusted.
const DIAGNOSTICS = new Set([
  'OpenCode database not found or unreadable; select --database',
  'OpenCode database must be a regular non-symlink file',
  'OpenCode session not found; select an exact native session ID',
  'unsupported OpenCode schema; use a supported native database',
  'unsupported OpenCode schema; native session tables missing',
  'unsupported OpenCode session schema',
  'malformed native JSON; selected session cannot be captured',
  'selected native JSON limit exceeded (32 MiB)',
  'canonical projection limit exceeded (32 MiB)',
  'native row limit exceeded for selected session',
  'ambiguous native message order', 'ambiguous native part order', 'ambiguous native content order',
  'dangling native part relationship', 'cross-session native part relationship', 'cross-session native JSON relationship',
  'native database capture failed; check schema and read access',
  ...['prompt text','timestamp','visible text','content shape','tool state','tool status','tool content',
    'tool content shape','tool content type','tool exit code','content type','assistant content',
    'shell status','shell exit code','idle outcome','message type','message role'].map(shape=>`unsupported native ${shape}`),
]);

export function captureOpenCodeSession({sessionId, database} = {}) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('-') || sessionId.includes('\0')) throw new OpenCodeCaptureError('OpenCode needs an exact native session ID');
  if (database !== undefined && (typeof database !== 'string' || !database || database.includes('\0'))) throw new OpenCodeCaptureError('OpenCode needs a database path');
  const args = [HELPER, 'capture', sessionId];
  if (database !== undefined) args.push('--database', database);
  const child = spawnSync(setting('PYTHON') || 'python3', args, {encoding: 'utf8', timeout: 30000, maxBuffer: 40 << 20});
  if (child.error) throw new OpenCodeCaptureError(child.error.code === 'ETIMEDOUT' ? 'OpenCode capture timed out' : child.error.code === 'ENOBUFS' ? 'OpenCode capture transport limit exceeded' : 'OpenCode capture needs Python 3.9+; check PUNK_RECORDS_PYTHON');
  if (child.status !== 0) {
    const diagnostic = child.stderr.trim().replace(/^OpenCode capture: /, '');
    throw new OpenCodeCaptureError(DIAGNOSTICS.has(diagnostic) ? `OpenCode capture: ${diagnostic}` : 'OpenCode capture failed; check schema and read access');
  }
  let capture;
  try { capture = JSON.parse(child.stdout); }
  catch { throw new OpenCodeCaptureError('OpenCode capture returned invalid JSON'); }
  if (!Array.isArray(capture.records) || !capture.descriptor || typeof capture.sourceRevision !== 'string' || typeof capture.coverage?.sourceComplete !== 'boolean') throw new OpenCodeCaptureError('OpenCode capture returned invalid data');
  const bytes = Buffer.from(capture.records.map(record => canonical(record) + '\n').join(''));
  if (bytes.length > MAX_BYTES) throw new OpenCodeCaptureError('OpenCode canonical projection limit exceeded (32 MiB)');
  return {bytes, descriptor: capture.descriptor, sourceRevision: capture.sourceRevision, coverage: capture.coverage};
}
