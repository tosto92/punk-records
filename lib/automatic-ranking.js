import fs from 'node:fs';

const AUTOMATIC_STOPWORDS = new Set(`a an and are as at be been but by can could do does for from had has have how i if in into is it its me my of on or our please so than that the their them then there these they this those to us was we were what when where which who why will with would you your
  al alla alle allo ai agli anche che chi ci come com con cosa da dal dalla dalle degli dei del della delle dello di e ed era gli ha hai hanno ho i il in io la le li lo ma mi nel nella nelle nello noi non o per perche piu quale quando quanto questa queste questi questo se si sia sono su sul sulla sulle tra tu un una uno vi voi
  grazie thanks thank okay ok yes continua continue procedi vai ottimo bene verifichiamo vediamo situazione funziona`.split(/\s+/));

export function automaticTokens(value) {
  return new Set((String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(term => !AUTOMATIC_STOPWORDS.has(term)));
}

export function rankCurrent(candidates, query) {
  const queryTokens = automaticTokens(query);
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

let frequencies;
export const PARAMETER_GRID = Object.freeze({commonAttenuation: [0.05, 0.15], idfCap: [3, 4],
  unknownPenalty: [0.15, 0.30], minEvidence: [2, 3], minCoverage: [0.45, 0.60]});
export const DEFAULT_PARAMETERS = Object.freeze(Object.fromEntries(Object.entries(PARAMETER_GRID).map(([key, values]) => [key, values[0]])));

const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function atoms(value) {
  return String(value || '').normalize('NFC').match(/(?:(?:\.\.?[/\\])+|[/\\])?\.?[\p{L}\p{N}_]+(?:[./:\\-]\.?[\p{L}\p{N}_]+)*/gu) || [];
}

export function analyzeQuery(text) {
  if (!frequencies) {
    const {languages} = JSON.parse(fs.readFileSync(new URL('./data/recall-frequency.json', import.meta.url), 'utf8'));
    frequencies = new Map();
    for (const language of Object.values(languages)) {
      for (const [raw, zipf] of Object.entries(language)) {
        const term = normalize(raw);
        frequencies.set(term, Math.max(frequencies.get(term) ?? -Infinity, zipf));
      }
    }
  }
  const original = String(text || '');
  const terms = new Map();
  for (const raw of atoms(original)) {
    const normalized = normalize(raw);
    if (AUTOMATIC_STOPWORDS.has(normalized) || terms.has(normalized)) continue;
    const zipf = frequencies.get(normalized) ?? -Infinity;
    terms.set(normalized, {raw, normalized, common: zipf >= 4, lexicalUnknown: !Number.isFinite(zipf),
      zipf: Number.isFinite(zipf) ? zipf : null,
      identifier: /[./:\\_-]/u.test(raw) || /\p{Ll}\p{Lu}/u.test(raw) || /\p{L}.*\p{N}|\p{N}.*\p{L}/u.test(raw),
      errorCode: /^[A-Z][A-Z_\d-]*\d[A-Z_\d-]*$/u.test(raw) ||
        (zipf < 4 && /^E[A-Z]{2,}$/u.test(raw)) ||
        /^(?:ERR(?:OR)?[_:-].+|E\d[\d_-]*|0x[\da-f]+)$/iu.test(raw)});
  }
  return {original, normalized: normalize(original), terms: [...terms.values()]};
}

function candidateField(value) {
  const exact = new Set(), fragments = new Set();
  for (const raw of atoms(value)) {
    const term = normalize(raw);
    exact.add(term);
    // Basenames are complete requested identifiers; individual path pieces are weak.
    exact.add(term.split(/[/\\]/u).at(-1));
    for (const part of term.match(/[\p{L}\p{N}]+/gu) || []) fragments.add(part);
  }
  return {exact, fragments};
}

export function rankCandidate(candidates, query, parameters = {}) {
  const settings = {...DEFAULT_PARAMETERS, ...parameters};
  for (const key of Object.keys(DEFAULT_PARAMETERS)) {
    if (!Number.isFinite(settings[key])) throw new TypeError(`invalid ranking parameter: ${key}`);
  }
  if (settings.commonAttenuation <= 0 || settings.commonAttenuation > 1 || settings.idfCap < 1 ||
      settings.unknownPenalty < 0 || settings.unknownPenalty > 1 || settings.minEvidence < 0 ||
      settings.minCoverage < 0 || settings.minCoverage > 1) throw new RangeError('invalid ranking parameters');
  const {terms} = analyzeQuery(query);
  const documents = candidates.map(candidate => ({candidate, fields: [candidate.title, candidate._symptoms,
    candidate._solution, (candidate.tags || []).join(' '), (candidate.files || []).join(' ')].map(candidateField)}));
  const weighted = terms.map(term => {
    const df = documents.filter(doc => doc.fields.some(field => field.exact.has(term.normalized) || field.fragments.has(term.normalized))).length;
    const weight = Math.min(settings.idfCap, 1 + Math.log((documents.length + 1) / (df + 1))) *
      (term.common ? settings.commonAttenuation : 1);
    return {...term, df, weight};
  });
  const knownWeight = weighted.filter(term => term.df > 0).reduce((sum, term) => sum + term.weight, 0);
  const unknownFraction = terms.length ? weighted.filter(term => term.df === 0).length / terms.length : 0;
  return documents.map(({candidate, fields}) => {
    let score = 0, evidence = 0, covered = 0, strong = false;
    const bodyTerms = new Set(), reasons = [];
    let errorConflict = false;
    for (const term of weighted) {
      let bestEvidence = 0, matched = false, exactMatch = false;
      for (const [index, multiplier] of [3, 2, 1, 2, 2].entries()) {
        const exact = fields[index].exact.has(term.normalized);
        if (!exact && !fields[index].fragments.has(term.normalized)) continue;
        matched = true;
        exactMatch ||= exact;
        score += term.weight * multiplier;
        if (exact && !term.common) {
          bestEvidence = Math.max(bestEvidence, term.weight * multiplier);
          if (index === 0 || index === 3 || term.identifier) strong = true;
          if (index === 1 || index === 2) bodyTerms.add(term.normalized);
        }
      }
      if (term.errorCode && !exactMatch) errorConflict = true;
      if (matched) covered += term.weight;
      evidence += bestEvidence;
      if (bestEvidence && term.lexicalUnknown) reasons.push(`lexicalUnknown:${term.normalized}`);
    }
    const coverage = knownWeight ? covered / knownWeight * (1 - settings.unknownPenalty * unknownFraction) : 0;
    score *= 1 - settings.unknownPenalty * unknownFraction;
    if (!knownWeight) reasons.push('unknown-query');
    if (unknownFraction) reasons.push('bounded-unknown-penalty');
    if (errorConflict) reasons.push('unmatched-error-identifier');
    if (!strong && bodyTerms.size < 2) reasons.push('insufficient-specific-matches');
    if (evidence < settings.minEvidence) reasons.push('below-min-evidence');
    if (coverage < settings.minCoverage) reasons.push('below-min-coverage');
    const admitted = knownWeight > 0 && !errorConflict && (strong || bodyTerms.size >= 2) &&
      evidence >= settings.minEvidence && coverage >= settings.minCoverage;
    if (admitted) reasons.push(strong ? 'strong-specific-match' : 'two-specific-body-terms');
    return {memoryId: candidate.memoryId, score, admitted, reasons, evidence, coverage, unknownFraction};
  });
}
