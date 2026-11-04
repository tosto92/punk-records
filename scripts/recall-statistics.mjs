import {automaticTokens} from '../lib/automatic-ranking.js';

// Descriptive proxies only: no relevance-model estimation or corpus retrieval score.
export function retrievalStatistics(candidates, query, returned) {
  const documents = candidates.map(c => ({...c, terms: automaticTokens([
    c.title, c._symptoms, c._solution, ...(c.tags || []), ...(c.files || []),
  ].join(' '))}));
  const queryTerms = [...automaticTokens(query)];
  const distribution = docs => {
    const counts = new Map();
    let total = 0;
    for (const doc of docs) for (const term of doc.terms) {
      counts.set(term, (counts.get(term) || 0) + 1);
      total++;
    }
    return new Map([...counts].map(([term, count]) => [term, count / total]));
  };
  const selected = new Set(returned.map(r => r.memoryId));
  const corpus = distribution(documents);
  const top = distribution(documents.filter(d => selected.has(d.memoryId)));
  const clarityProxyNats = top.size ? Math.max(0, [...top].reduce((sum, [term, p]) => sum + p * Math.log(p / corpus.get(term)), 0)) : null;
  const scores = returned.map(r => r.score);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const scoreCv = scores.length > 1 && mean > 0
    ? Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length) / mean : null;
  const diversity = field => {
    const labelled = documents.filter(d => typeof d[field] === 'string' && d[field].length);
    const groups = new Set(labelled.map(d => d[field]));
    const matched = queryTerms.filter(term => labelled.some(d => d.terms.has(term)));
    // Missing provenance or an unknown query term is not evidence of rarity.
    const fractions = matched.map(term => new Set(labelled.filter(d => d.terms.has(term)).map(d => d[field])).size / groups.size);
    return {labelledDocuments: labelled.length, totalDocuments: documents.length, groups: groups.size,
      matchedQueryTerms: matched.length, totalQueryTerms: queryTerms.length,
      meanQueryGroupFraction: labelled.length === documents.length && groups.size >= 2 && fractions.length
        ? fractions.reduce((a, b) => a + b, 0) / fractions.length : null};
  };
  return {returnedCount: returned.length, clarityProxyNats, scoreCv,
    relativeTopGap: scores.length > 1 && scores[0] > 0 ? (scores[0] - scores[1]) / scores[0] : null,
    projectDiversity: diversity('projectId'), sessionDiversity: diversity('sessionId')};
}

export function summarizePairedOutcomes(cases) {
  const counts = () => ({pairs: 0, helped: 0, harmed: 0, bothPass: 0, bothFail: 0});
  const result = {observed: counts(), synthetic: counts(), unmeasured: 0};
  for (const c of cases) {
    const pair = c.assessment?.pairedOutcome;
    if (!pair) { result.unmeasured++; continue; }
    const bucket = result[c.assessment.provenance];
    bucket.pairs++;
    const before = pair.withoutMemory === 'pass', after = pair.withMemory === 'pass';
    bucket[before ? (after ? 'bothPass' : 'harmed') : (after ? 'helped' : 'bothFail')]++;
  }
  return result;
}
