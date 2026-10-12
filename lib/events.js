import fs from "node:fs";
import path from "node:path";
import {storePath} from './paths.js';
import {fingerprint} from './fingerprint.js';

const EVENTS_FILE = "events.jsonl";

const TYPES = ['solved', 'attempt_failed', 'decision', 'note'];
const OUTCOMES = ['open', 'partial', 'ok'];
export const MEMORY_ID = /^[0-9a-f]{40}$/;
export const SAFE_REF = /^[a-z0-9][a-z0-9-]*$/;

function validateFields(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event must be an object');
  for (const field of ['type', 'title', 'ts', 'scope', 'repo', 'symptoms', 'solution', 'outcome']) {
    if (event[field] !== undefined && typeof event[field] !== 'string') throw new TypeError(`${field} must be a string`);
  }
  for (const field of ['attempts', 'files', 'tags']) {
    if (event[field] !== undefined && (!Array.isArray(event[field]) || event[field].some(v => typeof v !== 'string'))) {
      throw new TypeError(`${field} must be an array of strings`);
    }
  }
  if (event.type !== undefined && !TYPES.includes(event.type)) throw new TypeError('invalid type');
  if (event.outcome !== undefined && !OUTCOMES.includes(event.outcome)) throw new TypeError('invalid outcome');
  if (event.scope !== undefined && !['repo', 'global'].includes(event.scope)) throw new TypeError('invalid scope');
  if (event.ref != null && (typeof event.ref !== 'string' || !SAFE_REF.test(event.ref))) throw new TypeError('invalid ref');
  if (event.ts !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(event.ts) || !Number.isFinite(Date.parse(event.ts)))) {
    throw new TypeError('invalid UTC timestamp');
  }
}

export function validateEvent(event) {
  validateFields(event);
  if (![1, 2].includes(event.v)) throw new TypeError('invalid event version');
  const update = event.v === 2 && !!event.ref;
  if (!event.ts || (!update && !TYPES.includes(event.type))) throw new TypeError('event requires ts and type');
  if (!update && (typeof event.title !== 'string' || (!event.ref && !event.title.trim()))) throw new TypeError('event requires title');
  if (event.v === 2 && (typeof event.memoryId !== 'string' || !MEMORY_ID.test(event.memoryId))) throw new TypeError('invalid memoryId');
  return event;
}

export function appendEvent({ dir, event }) {
  validateEvent(event);
  const file = storePath(dir, EVENTS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) throw new TypeError('event register has an incomplete trailing line; repair it before saving');
    }
    fs.appendFileSync(fd, JSON.stringify(event) + "\n");
  } finally { fs.closeSync(fd); }
}

export function readEventRecords(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, EVENTS_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {records: [], issues: []};
    throw err;
  }
  const records = [], issues = [];
  for (const [index, text] of raw.split("\n").entries()) {
    const line = index + 1;
    if (!text.trim()) continue;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      issues.push({line, code: 'json', message: 'malformed JSONL', blocking: false});
      continue;
    }
    try { validateEvent(event); records.push({line, event}); }
    catch (err) { issues.push({line, code: 'schema', message: err.message, blocking: true}); }
  }
  return {records, issues};
}

export function reportIssues(dir, issues) {
  for (const issue of issues) console.error(`punk-records: ${path.join(dir, EVENTS_FILE)} line ${issue.line}: ${issue.message}`);
}

export function readEvents(dir) {
  const {records, issues} = readEventRecords(dir);
  reportIssues(dir, issues);
  return records.map(r => r.event);
}

export function normalizeEvent(partial, resolved) {
  validateFields(partial);
  const writes = (resolved && resolved.writes) || [];
  const scope = writes[0] === "local" ? "repo" : "global";
  if (partial.ref && !partial.memoryId) throw new TypeError('resolve ref before normalizing an update');
  return validateEvent({
    v: 2,
    memoryId: partial.memoryId ?? fingerprint({...partial, repo: partial.repo ?? resolved?.repoName ?? ''}),
    ts: partial.ts || new Date().toISOString(),
    type: partial.type,
    title: partial.title,
    scope: partial.scope || scope,
    repo: partial.repo != null ? partial.repo : ((resolved && resolved.repoName) || ""),
    symptoms: partial.symptoms || "",
    attempts: Array.isArray(partial.attempts) ? partial.attempts : [],
    solution: partial.solution || "",
    files: Array.isArray(partial.files) ? partial.files : [],
    tags: Array.isArray(partial.tags) ? partial.tags : [],
    outcome: partial.outcome || "open",
    ref: partial.ref != null ? partial.ref : null,
  });
}
