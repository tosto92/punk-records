// `punk-records hook <agent> <event>`: stable Claude Code / Codex hook identity.
// Every event is its own process, so a per-session spool in the global store
// carries the prompt and the written files from PostToolUse to Stop.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {globalDir, storePath, resolveScopes, repoDir} from './paths.js';
import {recallBlock, relative} from './recall.js';
import {writtenFiles} from './hook-tools.js';
import {summarizeActivity, isDraft} from './activity.js';
import {saveMemory} from './save.js';
import {loadMemories} from './build.js';
import {setting} from './env.js';
import {autoMemoryId} from './capture.js';
import {WORKFLOW_GUIDANCE} from './workflow.js';

export const AGENTS = {claude: 'Claude Code', codex: 'Codex'};
// Whether the agent injects UserPromptSubmit additionalContext (docs/claude-codex-compatibility.md F3).
export const RECALL_OUTPUT = {claude: true, codex: true};
const EVENTS = {claude: new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']), codex: new Set(['UserPromptSubmit', 'PostToolUse', 'Stop'])};
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const autosave = () => setting('AUTOSAVE') !== '0';

export function spoolPath(agent, sid) {
  return storePath(globalDir(), path.join('spool', `${agent}-${sid}.jsonl`));
}

// One write per call: short appends land whole even with concurrent hooks.
function append(file, records, cwd) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.appendFileSync(file, records.map(r => JSON.stringify({...r, cwd: path.resolve(cwd)}) + '\n').join(''));
}

function readSpool(file) {
  let prompt = '';
  const files = [], contexts = new Set();
  let context = null, complete = true;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let r;
    if (!line) continue;
    try { r = JSON.parse(line); } catch { complete = false; continue; }
    if (typeof r?.cwd === 'string' && path.isAbsolute(r.cwd)) { context = r.cwd; contexts.add(context); }
    else complete = false;
    if (r?.t === 'prompt' && typeof r.text === 'string') prompt = r.text;
    else if (r?.t === 'edit' && typeof r.file === 'string') files.push(r.file);
    else complete = false;
  }
  return {prompt, files, context: complete && contexts.size === 1 ? context : null};
}

// Sessions that never reached Stop (crash, killed terminal) leave spools behind.
function sweep(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^(claude|codex)-[A-Za-z0-9_-]+\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    try { if (now - fs.lstatSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file); } catch { /* raced with another Stop */ }
  }
}

export async function handleHook(agent, event, input, {save = saveMemory, load = loadMemories} = {}) {
  if (!Object.hasOwn(AGENTS, agent) || !EVENTS[agent].has(event)) return null;
  const sid = input?.session_id;
  if (typeof sid !== 'string' || !SID.test(sid)) return null;
  if (event === 'SessionStart') {
    if (!['startup', 'resume', 'clear', 'compact'].includes(input.source)) return null;
    return {hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: WORKFLOW_GUIDANCE}};
  }
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

  if (event === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 500) : '';
    // Recall must not depend on the spool: an unwritable or symlinked store only costs autosave.
    if (autosave() && prompt) {
      try { append(spoolPath(agent, sid), [{t: 'prompt', text: prompt}], cwd); }
      catch (err) { console.error('punk-records: ' + err.message); }
    }
    const block = RECALL_OUTPUT[agent] ? recallBlock(prompt, cwd) : '';
    return block ? {hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: block}} : null;
  }
  if (!autosave()) return null;
  const spool = spoolPath(agent, sid);

  if (event === 'PostToolUse') {
    // A tool that failed wrote nothing.
    if (input.tool_response?.success === false || input.tool_response?.error) return null;
    const files = writtenFiles(agent, input.tool_name, input.tool_input).map(f => relative(cwd, f)).filter(Boolean);
    append(spool, files.map(file => ({t: 'edit', file})), cwd);
    return null;
  }

  // Stop: claim the batch atomically; a concurrent or duplicate Stop finds nothing.
  sweep(path.dirname(spool));
  const flushing = `${spool}.flushing.${process.pid}`;
  let claimed = false;
  try { fs.renameSync(spool, flushing); claimed = true; }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  let keep = false;
  if (claimed) try {
    const {prompt, files} = readSpool(flushing);
    const draft = summarizeActivity(files, {sessionId: sid, prompt, agent: AGENTS[agent]});
    if (draft) {
      const memoryId = autoMemoryId(cwd, draft.title, load);
      await save({...draft, ...(memoryId ? {ref: memoryId} : {})}, {cwd, automatic: true});
    }
  } catch (err) {
    // Back into the spool for the next Stop; append keeps lines written meanwhile.
    try {
      fs.mkdirSync(path.dirname(spool), {recursive: true});
      fs.appendFileSync(spool, fs.readFileSync(flushing));
    } catch { keep = true; /* retained for recovery */ }
    throw err;
  } finally {
    if (!keep) { try { fs.unlinkSync(flushing); } catch { /* already gone */ } }
  }
  await recoverSpool(spool, agent, sid, cwd, save, load);
  return null;
}


async function recoverSpool(spool, agent, sid, cwd, save, load) {
  const dir = path.dirname(spool), prefix = path.basename(spool) + '.flushing.';
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const owner = /^(\d+)(?:\.[a-f0-9-]{36})?$/.exec(name.slice(prefix.length));
    if (!owner || Number(owner[1]) < 1 || Number(owner[1]) > 2147483647) continue;
    try { process.kill(Number(owner[1]), 0); continue; }
    catch (err) { if (err.code !== 'ESRCH') continue; }
    try {
      const file = storePath(globalDir(), path.join('spool', name));
      if (!fs.lstatSync(file).isFile()) continue;
      const {prompt, files, context} = readSpool(file);
      // Legacy batches have no project binding; never guess their destination.
      if (context !== path.resolve(cwd)) { console.error('punk-records: orphan batch retained; project context needs reconciliation'); continue; }
      const draft = summarizeActivity(files, {sessionId: sid, prompt, agent: AGENTS[agent]});
      if (!draft) continue;
      const memoryId = autoMemoryId(cwd, draft.title, load);
      let existing;
      if (memoryId) {
        const {repoRoot} = resolveScopes({}, cwd);
        existing = load(repoRoot ? repoDir(repoRoot) : globalDir()).memories.find(m => m.memoryId === memoryId);
        if (!existing || !isDraft(existing) || existing.symptoms !== draft.symptoms) {
          console.error('punk-records: orphan batch retained; session memory changed'); continue;
        }
      }
      const claimed = storePath(globalDir(), path.join('spool', `${path.basename(spool)}.flushing.${process.pid}.${randomUUID()}`));
      fs.renameSync(file, claimed);
      // An interrupted post-commit cleanup must not append the same draft again.
      if (!existing || !draft.files.every(file => existing.files.includes(file))) {
        await save({...draft, ...(memoryId ? {ref: memoryId} : {})}, {cwd, automatic: true});
      }
      fs.unlinkSync(claimed);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('punk-records: orphan batch retained; recovery could not complete');
    }
  }
}
