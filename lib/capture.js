import {summarizeActivity} from './activity.js';
import {saveMemory} from './save.js';
import {loadMemories} from './build.js';
import {resolveScopes, globalDir, repoDir} from './paths.js';

const DEBOUNCE = 60000, MAX_BATCH = 50;
export function diagnostic(message) {
  try { console.error(`previously: ${message}`); } catch { /* logging must not retry a committed append */ }
}

// One draft per session: the auto memory already holding this title, if any.
export function autoMemoryId(cwd, title, load = loadMemories) {
  const resolved = resolveScopes({}, cwd);
  const dir = resolved.repoRoot ? repoDir(resolved.repoRoot) : globalDir();
  const existing = load(dir).memories.filter(m => m.title === title && m.tags.includes('auto'));
  if (existing.length > 1) throw new TypeError('ambiguous automatic session memory');
  return existing[0]?.memoryId ?? null;
}

export function createCapture({cwd, save = saveMemory, load = loadMemories}) {
  const sessions = new Map();
  let disposed = false, sequence = 0;
  const enabled = () => !disposed && process.env.PREVIOUSLY_AUTOSAVE !== '0';
  const state = sid => {
    if (!enabled() || typeof sid !== 'string' || !sid) return null;
    if (!sessions.has(sid)) sessions.set(sid, {prompt: '', queue: [], memoryId: null, savedAt: null, idle: false, timer: null, saving: null});
    return sessions.get(sid);
  };
  const cancel = s => { if (s.timer !== null) clearTimeout(s.timer); s.timer = null; };
  const schedule = (sid, s) => {
    if (!enabled() || !s.idle || !s.queue.length || s.timer !== null) return;
    s.timer = setTimeout(() => {s.timer = null; void flush(sid).catch(err => diagnostic(err.message));}, Math.max(0, DEBOUNCE - (Date.now() - s.savedAt)));
    s.timer.unref?.();
  };
  async function flush(sid, force = false) {
    const s = sessions.get(sid);
    if (!enabled() || !s?.queue.length) return;
    if (s.saving) return s.saving;
    if (!force && s.savedAt !== null && Date.now() - s.savedAt < DEBOUNCE) {schedule(sid, s); return;}
    cancel(s);
    const draft = summarizeActivity(s.queue.slice(0, MAX_BATCH).map(e => e.file), {sessionId: sid, prompt: s.prompt});
    if (!draft) return;
    const selected = new Set(draft.files);
    const captured = new Set(s.queue.slice(0, MAX_BATCH).filter(e => selected.has(e.file)).map(e => e.sequence));
    let committed = false;
    s.saving = (async () => {
      if (!s.memoryId) s.memoryId = autoMemoryId(cwd, draft.title, load);
      const result = await save({...draft, ...(s.memoryId ? {ref: s.memoryId} : {})}, {cwd});
      committed = true;
      if (sessions.get(sid) !== s || disposed) return;
      s.memoryId = result.memoryId;
      s.queue = s.queue.filter(e => !captured.has(e.sequence));
      s.savedAt = Date.now();
      diagnostic(`draft saved for ${sid} (${draft.files.length} files)`);
    })();
    try { await s.saving; }
    finally { s.saving = null; if (committed) schedule(sid, s); }
  }
  return {
    prompt(sid, text) {
      const s = state(sid); if (!s) return;
      s.idle = false; cancel(s);
      if (typeof text === 'string') s.prompt = text.trim().slice(0, 500);
    },
    edit(sid, files) {
      const s = state(sid); if (!s) return;
      s.idle = false; cancel(s);
      // ponytail: failed writes retain a RAM backlog instead of dropping edits.
      // Add a durable bounded spool only if prolonged outages exhaust memory.
      for (const file of Array.isArray(files) ? files : []) {
        if (typeof file === 'string' && file.trim()) s.queue.push({file: file.trim(), sequence: sequence++});
      }
      if (s.queue.length >= MAX_BATCH) void flush(sid, true).catch(err => diagnostic(err.message));
    },
    async idle(sid) {const s = sessions.get(sid); if (s) {s.idle = true; await flush(sid);}},
    forget(sid) {const s = sessions.get(sid); if (s) cancel(s); sessions.delete(sid);},
    dispose() {disposed = true; for (const s of sessions.values()) cancel(s); sessions.clear();},
  };
}
