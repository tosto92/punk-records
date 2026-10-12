import path from 'node:path';
import {createInterface} from 'node:readline';
import {resolveScopes, globalDir, repoDir} from '../paths.js';
import {scanStore} from './scan.js';
import {readDecisions, reviewDecision, recordDecision} from './review.js';
import {escapedJSON} from './render.js';

function options(argv, cwd, scan) {
  let explicit = null, rulesDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--local' || arg === '--global') {
      if (explicit !== null) throw new TypeError('scope flags must occur once and are mutually exclusive');
      explicit = arg.slice(2);
    } else if (scan && arg === '--rules') {
      if (rulesDir !== null) throw new TypeError('--rules must occur once');
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new TypeError('--rules requires a directory value');
      rulesDir = path.resolve(cwd, value);
    } else throw new TypeError(`unknown argument: ${arg}`);
  }
  const resolved = resolveScopes({explicit}, cwd);
  const local = resolved.writes[0] === 'local';
  if (local && !resolved.repoRoot) throw new TypeError('--local requested outside a project (git repo or .punk-records; run punk-records init --local)');
  return {store: local ? repoDir(resolved.repoRoot) : globalDir(), scope: local ? 'repo' : 'global', rulesDir};
}

const incomplete = result => result.status === 'incomplete' || result.incompleteRules.length > 0 || result.reasonCodes.length > 0;
function exitCode(report) {
  return report.errors.length || report.results.some(incomplete) ? 2 : report.results.some(result => result.status === 'suspicious') ? 1 : 0;
}
const error = (stderr, reason) => stderr.write(`punk-records: ${escapedJSON(reason)}\n`);

export function runScan(argv, {cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr} = {}) {
  try {
    const {store, scope, rulesDir} = options(argv, cwd, true);
    const {report} = scanStore(store, scope, {rulesDir});
    stdout.write(escapedJSON(report) + '\n');
    return exitCode(report);
  } catch (err) { error(stderr, err.message); return 2; }
}

export async function runReview(argv, {cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr} = {}) {
  let reader;
  try {
    const {store, scope} = options(argv, cwd, false);
    if (stdin.isTTY !== true || stdout.isTTY !== true) throw new TypeError('review requires input and output TTY');
    const {entries, report} = scanStore(store, scope);
    let code = exitCode(report);
    stdout.write(`Scanner: ${escapedJSON(report.scanner)}\nErrors: ${escapedJSON(report.errors)}\n`);
    const ledger = readDecisions();
    if (!ledger.valid) { error(stderr, 'invalid_ledger'); code = 2; }
    // terminal:false reads lines without readline emitting terminal escape sequences.
    reader = createInterface({input: stdin, terminal: false, crlfDelay: Infinity});
    const lines = reader[Symbol.asyncIterator]();
    for (const result of report.results) {
      if (result.status === 'no_signals' && !incomplete(result)) continue;
      const entry = entries.find(entry => entry.store === result.store && entry.scope === result.scope && entry.memory.memoryId === result.memoryId);
      const decision = reviewDecision(result, ledger);
      const status = decision === 'approve' ? 'approved' : decision === 'exclude' ? 'excluded' : 'pending';
      const disabled = incomplete(result) || result.scanner.rulesHash === null;
      stdout.write(`\nVersion: ${escapedJSON(result)}\nMemory: ${escapedJSON(entry?.memory ?? null)}\nReview: ${status}\n`);
      if (disabled) stdout.write('Approval disabled: incomplete scan; this memory stays excluded.\n');
      while (true) {
        stdout.write('a = approve false positive; x = keep excluded (blank default); d = defer\nChoice [x]: ');
        const next = await lines.next();
        if (next.done) return code;
        const choice = next.value.trim();
        if (choice === 'd') break;
        if (choice === 'a' && disabled) { stdout.write('Cannot approve an incomplete scan.\n'); continue; }
        if (!['a', 'x', ''].includes(choice)) { stdout.write('Choose a, x, or d.\n'); continue; }
        if (disabled) { stdout.write('Kept excluded; incomplete versions cannot have ledger decisions.\n'); break; }
        const recorded = recordDecision(entry, result, choice === 'a' ? 'approve' : 'exclude');
        if (!recorded.recorded) { error(stderr, recorded.reason); code = 2; }
        else stdout.write(choice === 'a' ? 'Recorded approve.\n' : 'Recorded exclude.\n');
        break;
      }
    }
    return code;
  } catch (err) { error(stderr, err.message); return 2; }
  finally { reader?.close(); }
}
