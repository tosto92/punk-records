import fs from "node:fs";
import path from "node:path";

import { readEventRecords, reportIssues, validateEvent, MEMORY_ID } from "./events.js";
import { fingerprint } from "./fingerprint.js";
import { slugify } from "./slug.js";
import { globalDir, repoDir, memoryPath, storePath } from "./paths.js";

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, {flag: 'wx'});
  fs.renameSync(tmp, file);
}

function uniquePush(list, value) {
  if (value == null || value === "") return;
  if (!list.includes(value)) list.push(value);
}

function scopeFromDir(dir) {
  try {
    if (path.resolve(dir) === path.resolve(globalDir())) return "global";
  } catch {
    /* ignore */
  }
  return "repo";
}

const EVENT_KEYS = ['v', 'ts', 'memoryId', 'type', 'title', 'scope', 'repo', 'symptoms', 'attempts', 'solution', 'files', 'tags', 'outcome', 'ref'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function eventKey(event) {
  return JSON.stringify(EVENT_KEYS.map(key => key === 'ts' ? new Date(event.ts).toISOString() : event[key] ?? null));
}
function eventOrder(a, b) {
  return Date.parse(a.event.ts) - Date.parse(b.event.ts) || compare(eventKey(a.event), eventKey(b.event));
}

export function resolveReference(compilation, ref) {
  const direct = MEMORY_ID.test(ref) && compilation.memories.find(m => m.memoryId === ref);
  if (direct) return direct;
  const ids = compilation.aliases.get(ref);
  if (!ids?.size) throw new TypeError(`unknown memory ref: ${ref}`);
  if (ids.size !== 1) throw new TypeError(`ambiguous memory ref: ${ref}`);
  return compilation.memories.find(m => m.memoryId === [...ids][0]);
}

export function compileMemories(records, {scope = 'repo'} = {}) {
  const groups = new Map(), aliases = new Map(), issues = [], valid = [];
  const addAlias = (name, id) => {
    if (!aliases.has(name)) aliases.set(name, new Set());
    aliases.get(name).add(id);
  };
  for (const record of records) {
    try { validateEvent(record.event); valid.push(record); }
    catch (err) { issues.push({line: record.line, code: 'schema', message: err.message, blocking: true}); }
  }
  valid.sort(eventOrder);
  for (const {event} of valid) {
    if (event.ref) continue;
    const memoryId = event.v === 2 ? event.memoryId : fingerprint(event);
    if (!groups.has(memoryId)) {
      groups.set(memoryId, {memoryId, seed: event, slug: `${slugify(event.title)}--${memoryId}`, events: [], titles: new Set()});
    }
    groups.get(memoryId).titles.add(event.title);
  }
  for (const g of groups.values()) {
    addAlias(g.memoryId, g.memoryId);
    addAlias(g.slug, g.memoryId);
    for (const title of g.titles) addAlias(slugify(title), g.memoryId);
  }
  // note: conservative possible historical aliases, O(n³) worst case;
  // replace with exact branch provenance only if register size demands it.
  for (let pass = 0; pass < groups.size; pass++) {
    for (const g of groups.values()) for (const title of g.titles) {
      const taken = new Set();
      let candidate = slugify(title);
      for (let n = 1; n < groups.size; n++) {
        if (![...(aliases.get(candidate) || [])].some(id => id !== g.memoryId)) break;
        taken.add(candidate);
        candidate = slugify(title, taken);
        addAlias(candidate, g.memoryId);
      }
    }
  }
  const provisional = {memories: [...groups.values()], aliases};
  for (const {line, event} of valid) {
    try {
      const id = event.v === 2 ? event.memoryId : event.ref
        ? resolveReference(provisional, event.ref).memoryId : fingerprint(event);
      const group = groups.get(id);
      if (!group) throw new TypeError(`unknown memoryId: ${id}`);
      group.events.push(event);
    } catch (err) { issues.push({line, code: 'ref', message: err.message, blocking: true}); }
  }
  const memories = [...groups.values()].map(g => mergeGroup(g, scope)).sort((a, b) => compare(a.slug, b.slug));
  return {memories, aliases, issues: issues.sort((a, b) => a.line - b.line)};
}

export function loadMemories(dir, {scope = scopeFromDir(dir)} = {}) {
  const read = readEventRecords(dir);
  const compiled = compileMemories(read.records, {scope});
  return {...compiled, issues: [...read.issues, ...compiled.issues].sort((a, b) => a.line - b.line)};
}

function mergeGroup(group, defaultScope) {
  const identity = group.seed;
  let title = identity.title || '', symptoms = identity.symptoms || '', type = identity.type;
  let solution = "";
  let outcome = "open";
  let updated = "";
  const attempts = [];
  const files = [];
  const tags = [];

  for (const ev of group.events) {
    // Legacy references never renamed the original problem; preserve that.
    if (ev.v === 2 && ev.ref) {
      if (ev.title !== undefined) title = ev.title;
      if (ev.symptoms !== undefined) symptoms = ev.symptoms;
      if (ev.type !== undefined) type = ev.type;
    }
    if (ev.solution) solution = ev.solution;
    if (ev.outcome) outcome = ev.outcome;
    updated = ev.ts;
    for (const a of ev.attempts || []) uniquePush(attempts, a);
    for (const f of ev.files || []) uniquePush(files, f);
    for (const t of ev.tags || []) uniquePush(tags, t);
  }

  const repo = identity.repo || "";
  const scope = identity.scope || defaultScope;

  return {
    slug: group.slug,
    memoryId: group.memoryId,
    seedTitle: identity.title,
    type,
    title,
    scope,
    repo,
    tags,
    files,
    attempts,
    symptoms,
    solution,
    outcome,
    updated,
    fingerprint: fingerprint({ repo, title, symptoms }),
    covers: files[0] ?? "-",
  };
}

function tagList(tags) {
  return `[${tags.join(", ")}]`;
}

function renderMarkdown(m) {
  const lines = [
    "---",
    `title: ${m.title}`,
    `scope: ${m.scope}`,
    `repo: ${m.repo}`,
    `tags: ${tagList(m.tags)}`,
    `outcome: ${m.outcome}`,
    `updated: ${m.updated}`,
    `fingerprint: ${m.fingerprint}`,
    `memoryId: ${m.memoryId}`,
    `covers: ${m.covers}`,
    "related: []",
    "---",
    "",
    "## Sintomi",
    "",
    m.symptoms,
    "",
    "## Tentativi falliti",
    "",
    ...m.attempts.map((a) => `- ${a}`),
    "",
    "## Soluzione",
    "",
    m.solution,
    "",
    "## Esito",
    "",
    m.outcome,
    "",
  ];
  return lines.join("\n");
}

function renderIndexMd(memories) {
  if (memories.length === 0) return "";
  return (
    memories
      .map((m) => `- [${m.slug}](memory/${m.slug}.md) — ${m.title} (${m.outcome})`)
      .join("\n") + "\n"
  );
}

function renderIndexJson(memories) {
  const entries = memories.map((m) => ({
    slug: m.slug,
    memoryId: m.memoryId,
    title: m.title,
    tags: m.tags,
    files: m.files,
    outcome: m.outcome,
    updated: m.updated,
    fingerprint: m.fingerprint,
  }));
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return JSON.stringify({ version: 2, entries }, null, 2) + "\n";
}

export function buildScope(dir) {
  const {memories, issues} = loadMemories(dir);
  reportIssues(dir, issues);
  if (issues.some(i => i.blocking)) throw new TypeError(issues.filter(i => i.blocking).map(i => `line ${i.line}: ${i.message}`).join('; '));

  for (const m of memories) memoryPath(dir, m.slug);
  storePath(dir, 'INDEX.md');
  storePath(dir, 'index.json');

  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).entries || []; }
  catch (err) { if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err; }
  const keep = new Set(memories.map(m => m.slug));
  const obsolete = [];
  for (const old of Array.isArray(previous) ? previous : []) {
    if (!old || keep.has(old.slug) || !MEMORY_ID.test(old.fingerprint || '')) continue;
    const file = memoryPath(dir, old.slug);
    try {
      const md = fs.readFileSync(file, 'utf8');
      if (md.startsWith('---\n') && md.includes(`\nfingerprint: ${old.fingerprint}\n`) && md.includes('\nrelated: []\n')) obsolete.push(file);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  const wrote = [];
  for (const m of memories) {
    const rel = path.join("memory", `${m.slug}.md`);
    writeAtomic(memoryPath(dir, m.slug), renderMarkdown(m));
    wrote.push(rel);
  }

  writeAtomic(storePath(dir, 'INDEX.md'), renderIndexMd(memories));
  wrote.push("INDEX.md");
  writeAtomic(storePath(dir, 'index.json'), renderIndexJson(memories));
  wrote.push("index.json");

  for (const file of obsolete) fs.unlinkSync(file);

  return { wrote, index: JSON.parse(renderIndexJson(memories)) };
}

export function buildAll(resolved, explicit = null) {
  const { repoRoot } = resolved || {};
  let writes;
  if (explicit === "global") {
    writes = ["global"];
  } else if (explicit === "local") {
    if (!repoRoot) throw new Error("punk-records: --local requested outside a project (git repo or .punk-records; run punk-records init --local)");
    writes = ["local"];
  } else {
    writes = ["global"];
    if (repoRoot) writes.push("local");
  }
  for (const w of writes) {
    const dir = w === "global" ? globalDir() : repoDir(repoRoot);
    buildScope(dir);
  }
}
