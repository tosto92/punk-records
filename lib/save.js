import {resolveScopes, globalDir, repoDir, storePath} from './paths.js';
import {appendEvent, normalizeEvent, reportIssues} from './events.js';
import {loadMemories, resolveReference} from './build.js';
import {fingerprint} from './fingerprint.js';
import {slugify} from './slug.js';
import {registerProject} from './projects.js';
import {isDraft} from './activity.js';

export function saveMemory(input, {cwd = process.cwd(), scope = null, automatic = false} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('memory input must be an object');
  if (scope !== null && !['repo', 'global'].includes(scope)) throw new TypeError('invalid write scope');
  const resolved = resolveScopes({explicit: scope === 'repo' ? 'local' : scope}, cwd);
  const local = resolved.writes[0] === 'local';
  if (local && !resolved.repoRoot) throw new TypeError('local scope requested outside a project (git repo or .previously; run previously init --local)');
  const dir = local ? repoDir(resolved.repoRoot) : globalDir();
  storePath(dir, 'events.jsonl');
  const compiled = loadMemories(dir);
  reportIssues(dir, compiled.issues);
  const target = input.ref ? resolveReference(compiled, input.ref) : null;
  const provided = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const merged = {...(target || {}), ...provided, scope: local ? 'repo' : 'global', repo: target?.repo ?? resolved.repoName};
  if (!merged.type || typeof merged.title !== 'string' || !merged.title.trim()) throw new TypeError('new memory requires type and non-empty title');
  const memoryId = target?.memoryId ?? fingerprint(merged);
  const outcome = input.outcome !== undefined ? input.outcome : merged.type === 'solved'
    ? (merged.title.trim() && typeof merged.solution === 'string' && merged.solution.trim() ? 'ok' : 'open')
    : (target?.outcome ?? 'open');
  const event = normalizeEvent({...merged, memoryId, outcome, ref: input.ref ?? null}, resolved);
  const existing = target || compiled.memories.find(m => m.memoryId === memoryId);
  const slug = existing?.slug ?? `${slugify(event.title)}--${memoryId}`;
  if (automatic && existing && !isDraft(existing)) {
    return {ok: true, written: 0, memoryId, slug, outcome: existing.outcome};
  }
  appendEvent({dir, event});
  if (local) registerProject(resolved.repoRoot);
  return {ok: true, written: 1, memoryId, slug, outcome};
}
