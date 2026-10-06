// `previously hook <agent> <event>`: stateless Claude Code / Codex hook handler.
// Every event is its own process, so a per-session spool in the global store
// carries the prompt and the written files from PostToolUse to Stop.
import fs from 'node:fs';
import path from 'node:path';
import {globalDir, storePath} from './paths.js';
import {recallBlock, relative} from './recall.js';
import {writtenFiles} from './hook-tools.js';
import {summarizeActivity} from './activity.js';
import {saveMemory} from './save.js';
import {loadMemories} from './build.js';
import {autoMemoryId} from './capture.js';

export const AGENTS = {claude: 'Claude Code', codex: 'Codex'};
// Whether the agent injects UserPromptSubmit additionalContext (docs/claude-codex-compatibility.md F3).
export const RECALL_OUTPUT = {claude: true, codex: true};
const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop']);
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const autosave = () => process.env.PREVIOUSLY_AUTOSAVE !== '0';

export function spoolPath(agent, sid) {
  return storePath(globalDir(), path.join('spool', `${agent}-${sid}.jsonl`));
}

// One write per call: short appends land whole even with concurrent hooks.
function append(file, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.appendFileSync(file, records.map(r => JSON.stringify(r) + '\n').join(''));
}

function readSpool(file) {
  let prompt = '';
  const files = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.t === 'prompt' && typeof r.text === 'string') prompt = r.text;
    else if (r?.t === 'edit' && typeof r.file === 'string') files.push(r.file);
  }
  return {prompt, files};
}

// Sessions that never reached Stop (crash, killed terminal) leave spools behind.
function sweep(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try { if (now - fs.lstatSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file); } catch { /* raced with another Stop */ }
  }
}

export async function handleHook(agent, event, input, {save = saveMemory, load = loadMemories} = {}) {
  if (!Object.hasOwn(AGENTS, agent) || !EVENTS.has(event)) return null;
  const sid = input?.session_id;
  if (typeof sid !== 'string' || !SID.test(sid)) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

  if (event === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 500) : '';
    // Recall must not depend on the spool: an unwritable or symlinked store only costs autosave.
    if (autosave() && prompt) {
      try { append(spoolPath(agent, sid), [{t: 'prompt', text: prompt}]); }
      catch (err) { console.error('previously: ' + err.message); }
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
    append(spool, files.map(file => ({t: 'edit', file})));
    return null;
  }

  // Stop: claim the batch atomically; a concurrent or duplicate Stop finds nothing.
  sweep(path.dirname(spool));
  const flushing = `${spool}.flushing.${process.pid}`;
  try { fs.renameSync(spool, flushing); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  let keep = false;
  try {
    const {prompt, files} = readSpool(flushing);
    const draft = summarizeActivity(files, {sessionId: sid, prompt, agent: AGENTS[agent]});
    if (draft) {
      const memoryId = autoMemoryId(cwd, draft.title, load);
      await save({...draft, ...(memoryId ? {ref: memoryId} : {})}, {cwd});
    }
  } catch (err) {
    // Back into the spool for the next Stop; append keeps lines written meanwhile.
    try {
      fs.mkdirSync(path.dirname(spool), {recursive: true});
      fs.appendFileSync(spool, fs.readFileSync(flushing));
    } catch { keep = true; /* left as .flushing; swept after 7 days */ }
    throw err;
  } finally {
    if (!keep) { try { fs.unlinkSync(flushing); } catch { /* already gone */ } }
  }
  return null;
}
