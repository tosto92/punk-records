import { globalDir, repoDir } from "./paths.js";
import {loadMemories} from './build.js';
import {reportIssues} from './events.js';
import path from 'node:path';
import {scanMemories} from './security/scan.js';
import {readDecisions, allowsMemory} from './security/review.js';

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
  return memories.map(m => ({...m, _store: path.resolve(dir), _scope: scopeLabel, _symptoms: m.symptoms, _solution: m.solution}));
}

export function search({ query, limit = 5, scope = "all", resolved } = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];
  const { repoRoot } = resolved || {};
  const searchGlobal = scope === "all" || scope === "global";
  const searchLocal = (scope === "all" || scope === "local") && repoRoot;

  let candidates = [];
  if (searchGlobal) candidates.push(...readScope(globalDir(), "global"));
  if (searchLocal) candidates.push(...readScope(repoDir(repoRoot), "repo"));

  if (process.env.PREVIOUSLY_SECURITY === '1') {
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
      try { console.error(`previously: security ${excluded} excluded (${suspicious} suspicious, ${incomplete} incomplete), ${reviewed} reviewed exceptions admitted; previously review`); }
      catch { /* diagnostics must not interrupt a session */ }
    }
  }

  const scored = [];
  for (const c of candidates) {
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
    const score = matchScore + (c.outcome === 'ok' ? 1 : 0);
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
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
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
      return lines.join("\n");
    })
    .join("\n\n");
}
