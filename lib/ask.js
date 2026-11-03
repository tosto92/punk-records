import { globalDir, repoDir } from "./paths.js";
import {loadMemories} from './build.js';
import {reportIssues} from './events.js';
import path from 'node:path';
import {scanMemories} from './security/scan.js';
import {readDecisions, allowsMemory} from './security/review.js';
import {setting} from './env.js';
import {isDraft} from './activity.js';
import {synthesisCandidates, synthesisMemoryVersion} from './synthesis.js';

const AUTOMATIC_STOPWORDS = new Set(`a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our please so than that the their them then there these they this those to us was we were what when where which who why will with would you your
  al alla alle allo ai agli anche che chi ci come com con cosa da dal dalla dalle degli dei del della delle dello di e ed era gli ha hai hanno ho i il in io la le li lo ma mi nel nella nelle nello noi non o per perche piu quale quando quanto questa queste questi questo se si sia sono su sul sulla sulle tra tu un una uno vi voi
  grazie thanks thank okay ok yes continua continue procedi vai ottimo bene verifichiamo vediamo situazione funziona`.split(/\s+/));

function automaticTokens(value) {
  return new Set((String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(term => !AUTOMATIC_STOPWORDS.has(term)));
}

function automaticScores(candidates, queryTokens) {
  const documents = candidates.map(candidate => {
    const fields = [candidate.title, candidate._symptoms, candidate._solution,
      (candidate.tags || []).join(' '), (candidate.files || []).join(' ')].map(automaticTokens);
    return {candidate, fields, terms: new Set(fields.flatMap(field => [...field]))};
  });
  const weights = new Map([...queryTokens].map(term => [term,
    1 + Math.log((documents.length + 1) / (1 + documents.filter(doc => doc.terms.has(term)).length))]));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const scores = new Map();
  for (const {candidate, fields, terms} of documents) {
    let covered = 0, anchored = 0, score = 0;
    for (const [term, weight] of weights) {
      if (terms.has(term)) covered += weight;
      if (fields[0].has(term) || fields[3].has(term)) anchored += weight;
      for (const [index, multiplier] of [3, 2, 1, 2, 2].entries()) {
        if (fields[index].has(term)) score += multiplier * weight;
      }
    }
    if (covered / total >= 0.70 || anchored / total >= 0.35) scores.set(candidate, score);
  }
  return scores;
}

function tokenize(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function overlap(tokensOfField, queryTokens) {
  // presence per query token, not term frequency
  let hits = 0;
  const fieldSet = new Set(tokensOfField);
  for (const t of queryTokens) if (fieldSet.has(t)) hits++;
  return hits;
}

function sharedCount(items, queryTokens) {
  // 2 points per item (tag or file) sharing at least one token with the query
  let n = 0;
  for (const item of items || []) {
    for (const t of tokens(item)) {
      if (queryTokens.has(t)) {
        n++;
        break;
      }
    }
  }
  return n;
}

function firstLines(text, n) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n);
}

function readScope(dir, scopeLabel) {
  const {memories, issues} = loadMemories(dir, {scope: scopeLabel});
  reportIssues(dir, issues);
  return memories.map(m => ({...m, _version: synthesisMemoryVersion(m), _store: path.resolve(dir), _scope: scopeLabel, _symptoms: m.symptoms, _solution: m.solution}));
}

export function search({ query, limit = 5, scope = "all", resolved, automatic = false, full = false } = {}) {
  const queryTokens = automatic ? automaticTokens(query) : tokenize(query);
  if (queryTokens.size === 0) return [];
  const { repoRoot } = resolved || {};
  const searchGlobal = scope === "all" || scope === "global";
  const searchLocal = (scope === "all" || scope === "local") && repoRoot;

  const stores = [
    ...(searchGlobal ? [{store: globalDir(), scope: 'global'}] : []),
    ...(searchLocal ? [{store: repoDir(repoRoot), scope: 'repo'}] : []),
  ];
  let candidates = stores.flatMap(({store, scope}) => readScope(store, scope));
  if (setting('SYNTHESIS') === '1') {
    for (const {store, scope} of stores) {
      try { candidates.push(...synthesisCandidates(store, scope)); }
      catch { console.error('punk-records: synthesis state unavailable; using original memories'); }
    }
  }

  if (automatic) {
    // Hidden sources still need admission when a returned summary depends on them.
    const needed = new Set(candidates.flatMap(c => (c._dependencies || []).map(d =>
      JSON.stringify([c._store, c._scope, d.memoryId]))));
    candidates = candidates.filter(c => !isDraft(c) && c.native !== true || needed.has(JSON.stringify([c._store, c._scope, c.memoryId])));
  }

  if (setting('SECURITY') === '1') {
    let excluded = 0, suspicious = 0, incomplete = 0, reviewed = 0;
    try {
      const report = scanMemories(candidates.map(memory => ({store: memory._store, scope: memory._scope, memory})));
      const decisions = readDecisions();
      candidates = candidates.filter((memory, index) => {
        const result = report.results[index];
        if (!allowsMemory(result, decisions)) {
          excluded++;
          if (result.status === 'suspicious') suspicious++;
          else incomplete++;
          return false;
        }
        if (result.status === 'suspicious') reviewed++;
        return true;
      });
    } catch { excluded = incomplete = candidates.length; candidates = []; suspicious = reviewed = 0; }
    if (excluded || reviewed) {
      try { console.error(`punk-records: security ${excluded} excluded (${suspicious} suspicious, ${incomplete} incomplete), ${reviewed} reviewed exceptions admitted; punk-records review`); }
      catch { /* diagnostics must not interrupt a session */ }
    }
  }

  const admitted = new Map(candidates.map(c => [JSON.stringify([c._store, c._scope, c.memoryId]), c._version]));
  candidates = candidates.filter(c => (!c._fresh || c._fresh()) && (!c._dependencies || c._dependencies.every(d =>
    admitted.get(JSON.stringify([c._store, c._scope, d.memoryId])) === d.version)));

  if (automatic) candidates = candidates.filter(c => !isDraft(c) && c.native !== true);
  const automaticRank = automatic ? automaticScores(candidates, queryTokens) : null;

  const scored = [];
  for (const c of candidates) {
    let score;
    if (automatic) {
      if (!automaticRank.has(c)) continue;
      score = automaticRank.get(c);
    } else {
      const titleHits = overlap(tokens(c.title), queryTokens);
      const symptomHits = overlap(tokens(c._symptoms), queryTokens);
      const solutionHits = overlap(tokens(c._solution), queryTokens);
      const sharedTags = sharedCount(c.tags, queryTokens);
      const sharedFiles = sharedCount(c.files, queryTokens);
      const matchScore =
        3 * titleHits +
        2 * symptomHits +
        1 * solutionHits +
        2 * sharedTags +
        2 * sharedFiles;
      if (matchScore <= 0) continue;
      score = matchScore + (c.outcome === 'ok' ? 1 : 0);
    }
    const symptoms = firstLines(c._symptoms, 3), solution = firstLines(c._solution, 3);
    const cruxLines = (solution.length
      ? [solution[0], symptoms[0], solution[1], ...solution.slice(2), ...symptoms.slice(1)]
      : symptoms).filter(Boolean).slice(0, 3);
    scored.push({
      scope: c._scope,
      slug: c.slug,
      memoryId: c.memoryId,
      title: c.title,
      outcome: c.outcome,
      updated: c.updated,
      crux: cruxLines.join("\n"),
      covers: (c.files && c.files[0]) || "-",
      score,
      ...(full ? {memory: {
        memoryId: c.memoryId, type: c.type, title: c.title, symptoms: c.symptoms, solution: c.solution,
        attempts: c.attempts, files: c.files, tags: c.tags, outcome: c.outcome, updated: c.updated,
      }} : {}),
      ...(c.sourceIds ? {sourceIds: c.sourceIds, sourcePaths: c.sourcePaths, ...(c.derived ? {derived: true} : {native: true})} : {}),
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (automatic && (a.outcome === 'ok') !== (b.outcome === 'ok')) return a.outcome === 'ok' ? -1 : 1;
    if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return scored.slice(0, limit);
}

export function formatHits(hits) {
  return hits
    .map((h) => {
      const lines = [`[${h.scope}] ${h.slug} — ${h.title} (${h.outcome}, ${h.updated})`];
      for (const l of String(h.crux || "").split("\n").filter(Boolean).slice(0, 3)) lines.push(l);
      lines.push(`covers: ${h.covers || "-"}`);
      if (h.sourceIds) lines.push(`sources: ${h.sourceIds.join(', ')}${h.sourcePaths?.length ? ` (${h.sourcePaths.join(', ')})` : ''}${h.derived ? '; derived summary, expand originals for full details' : ''}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
