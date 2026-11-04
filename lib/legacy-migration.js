import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {globalDir, gitRoot, repoDir, storePath} from './paths.js';

export function checkLegacyEnvironment() {
  const old = Object.keys(process.env).filter(key => key.startsWith('PREVIOUSLY_') && process.env[key]);
  if (old.length) throw new Error(`punk-records: update shell environment before init: ${old.map(key => `${key} -> ${key.replace('PREVIOUSLY_', 'PUNK_RECORDS_')}`).join(', ')}; remove the old variables (shell profiles are not edited)`);
}

// Legacy non-Git projects are discovered only from the selected directory's ancestry.
export function legacyProjectRoot(cwd) {
  const git = gitRoot(cwd);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.previously');
    const stat = fs.lstatSync(marker, {throwIfNoEntry: false});
    if (stat?.isFile() && stat.size === 0) return dir;
    if (dir === git || path.dirname(dir) === dir) return null;
  }
}

// Preflight all renames together: neither a directory nor a SQLite family is merged.
export function planStoreMigration({global, repoRoot}) {
  const moves = [];
  const old = path.join(os.homedir(), '.local', 'share', 'previously');
  const current = globalDir();
  const exists = file => fs.lstatSync(file, {throwIfNoEntry: false}) !== undefined;
  let source = current;
  if (global && !process.env.PUNK_RECORDS_HOME && exists(old)) {
    storePath(old, 'events.jsonl'); storePath(current, 'events.jsonl');
    if (exists(current)) throw new Error(`punk-records: store conflict: ${old} and ${current} both exist; reconcile them before init`);
    moves.push([old, current]); source = old;
  }
  const stores = [...(global ? [[source, current]] : []), ...(repoRoot ? [[repoDir(repoRoot), repoDir(repoRoot)]] : [])];
  for (const [from, to] of stores) {
    const legacy = ['', '-wal', '-shm', '-journal'].map(s => storePath(from, `episodes.db${s}`));
    const canonical = ['', '-wal', '-shm', '-journal'].map(s => storePath(from, `sessions.db${s}`));
    if (from !== to && canonical.slice(1).some(exists)) throw new Error(`punk-records: SQLite sidecars in ${from}; close all agent sessions and checkpoint sessions.db before init`);
    if (!legacy.some(exists)) continue;
    if (!exists(legacy[0])) throw new Error(`punk-records: orphan legacy SQLite sidecar in ${from}; restore/checkpoint episodes.db before init`);
    if (legacy.slice(1).some(exists)) throw new Error(`punk-records: legacy SQLite sidecars in ${from}; close all agent sessions and checkpoint episodes.db before init`);
    if (canonical.some(exists)) throw new Error(`punk-records: database conflict in ${from}: episodes.db and sessions.db files both exist; reconcile them before init`);
    for (const file of legacy.filter(exists)) moves.push([path.join(to, path.basename(file)), path.join(to, path.basename(file).replace('episodes.db', 'sessions.db'))]);
  }
  return moves;
}

export function migrateHookCommands(config, agent) {
  let changed = false;
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (hook?.type !== 'command' || typeof hook.command !== 'string') continue;
      const match = hook.command.match(/^(env (?:PREVIOUSLY|PUNK_RECORDS)_SYNTHESIS=1 )?(previously|punk-records) hook (claude|codex) (SessionStart|UserPromptSubmit|PostToolUse|Stop)$/);
      if (!match || match[3] !== agent || match[4] !== event) continue;
      const next = `${match[1] ? 'env PUNK_RECORDS_SYNTHESIS=1 ' : ''}punk-records hook ${agent} ${event}`;
      if (next !== hook.command) {hook.command = next; changed = true;}
    }
  }
  return changed;
}

const pointsToMovedStore = (value, move) => move && typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === move[0];

export function migrateManagedEnv(entry, storeMove) {
  if (!entry?.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) return entry;
  const env = {...entry.env};
  for (const key of Object.keys(env)) if (key.startsWith('PREVIOUSLY_')) {
    const next = key.replace('PREVIOUSLY_', 'PUNK_RECORDS_');
    if (Object.hasOwn(env, next) && env[next] !== env[key]) throw new Error(`punk-records: conflicting managed environment values for ${key} and ${next}`);
    env[next] = env[key]; delete env[key];
  }
  if (pointsToMovedStore(env.PUNK_RECORDS_HOME, storeMove)) env.PUNK_RECORDS_HOME = storeMove[1];
  return {...entry, env};
}

// Tokenize strings/comments first so literal values never become environment keys.
export function migrateTomlEnv(text, file, storeMove) {
  let table = false;
  const seen = new Set();
  const rewrite = line => line.replace(/"(?:\\.|[^"\\])*"|'[^']*'|#[^\n]*|\b(?:PREVIOUSLY|PUNK_RECORDS)_[A-Z_]+(?=\s*=)(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'[^']*'))?/g, (token, offset) => {
    if (/^["']/.test(token) && /^\s*=/.test(line.slice(offset + token.length))) {
      let key;
      try {key = token.startsWith('"') ? JSON.parse(token) : token.slice(1, -1);}
      catch {throw new Error(`punk-records: unsupported quoted environment key in ${file}; use unquoted assignments before init`);}
      if (/^(PREVIOUSLY|PUNK_RECORDS)_[A-Z_]+$/.test(key)) throw new Error(`punk-records: quoted managed environment key in ${file}; use one unquoted canonical assignment before init`);
    }
    if (!/^(PREVIOUSLY|PUNK_RECORDS)_/.test(token)) return token;
    const name = token.match(/^[A-Z_]+/)[0];
    const key = name.replace(/^PREVIOUSLY_/, 'PUNK_RECORDS_');
    if (seen.has(key)) throw new Error(`punk-records: duplicate/conflicting managed environment key ${key} in ${file}; keep one canonical assignment before init`);
    seen.add(key);
    const assignment = token.slice(name.length);
    if (storeMove && key === 'PUNK_RECORDS_HOME') {
      const value = assignment.match(/^(\s*=\s*)(["'].*["'])$/);
      let decoded;
      try {decoded = value?.[2].startsWith('"') ? JSON.parse(value[2]) : value?.[2].slice(1, -1);}
      catch {throw new Error(`punk-records: cannot decode managed HOME in ${file}; use a plain quoted path before moving the default store, then re-run init`);}
      if (pointsToMovedStore(decoded, storeMove)) return key + value[1] + JSON.stringify(storeMove[1]);
    }
    return key + assignment;
  });
  return text.split('\n').map(line => {
    if (/^\s*\[mcp_servers\.(?:previously|punk-records)\.env\]\s*(?:#.*)?$/.test(line)) {table = true; return line;}
    if (table) return rewrite(line);
    if (/^\s*env\s*=\s*\{.*\}\s*(?:#.*)?$/.test(line)) return rewrite(line);
    if (/^\s*env\s*=/.test(line) && /PREVIOUSLY_[A-Z_]+\s*=/.test(text)) throw new Error(`punk-records: custom managed environment in ${file}; migrate its PREVIOUSLY_ keys manually before init`);
    return line;
  }).join('\n');
}
