#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const help = `Usage: node scripts/reconcile-installation.mjs [--apply] [--details] [--source PATH]
       [--repo PATH ...] [--registered] [--agents claude,codex] [--opencode-api v1|v2]

Defaults to a read-only preview, including all init --dry-run preflights.
--details displays raw init output locally; it may contain private configuration values.
Always reconciles global installation; local projects require --repo or --registered.
Registered memory-only projects and stale entries are reported and skipped.
--source selects the stable source checkout used for init and executable links.
Close agent and viewer processes before --apply; reopen your shell afterward.
Only simple shell profile assignments are renamed; complex syntax requires manual edits.
Backups and a completion manifest are stored in a private directory under ~/.local/state.
Init owns store migration; this script does not copy/delete memories, approve security
findings, change Codex trust, stop processes, or checkpoint SQLite.
Apply is sequential: later failure can leave completed scopes applied. See the manifest.
`;

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; return null; }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(help); return; }
  let apply = false, details = false, registered = false, agents = 'claude,codex', api = 'v1';
  let source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repos = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--apply') { apply = true; continue; }
    if (flag === '--details') { details = true; continue; }
    if (flag === '--registered') { registered = true; continue; }
    if (!['--repo', '--source', '--agents', '--opencode-api'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--repo') repos.add(path.resolve(value));
    if (flag === '--source') source = path.resolve(value);
    if (flag === '--agents') agents = value;
    if (flag === '--opencode-api') api = value;
  }
  if (!agents.split(',').every(name => ['claude', 'codex', 'opencode'].includes(name))) throw new Error('Invalid --agents');
  if (!['v1', 'v2'].includes(api)) throw new Error('Invalid --opencode-api');
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'punk-records') throw new Error('--source must be a punk-records checkout');
  const cli = path.join(source, 'bin', 'punk-records');
  if (!fs.statSync(cli).isFile()) throw new Error('Source CLI is missing');
  const env = {...process.env};
  for (const key of Object.keys(env).filter(key => key.startsWith('PREVIOUSLY_'))) {
    const canonical = key.replace('PREVIOUSLY_', 'PUNK_RECORDS_');
    if (Object.hasOwn(env, canonical) && env[canonical] !== env[key]) throw new Error(`Conflicting environment identifiers: ${key}, ${canonical}`);
    env[canonical] = env[key];
    delete env[key];
    console.log(`Child environment: ${key} -> ${canonical}`);
  }
  const home = os.homedir();
  console.log(`${apply ? 'Apply' : 'Preview'} source: ${source}`);
  for (const repo of repos) if (!fs.statSync(repo).isDirectory()) throw new Error(`Not a project directory: ${repo}`);

  function configured(repo) {
    if (['.previously', '.punk-records'].some(name => {
      const info = stat(path.join(repo, name));
      return info?.isFile() && info.size === 0;
    })) return true;
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.json', '.codex/config.toml', '.codex/hooks.json', 'opencode.json']) {
      const file = path.join(repo, name);
      if (!stat(file)?.isFile()) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (name.endsWith('.md')) {
        if (/<!--\s*(?:previously|punk-records):/.test(text)) return true;
      } else if (name.endsWith('.toml')) {
        if (/^\s*\[mcp_servers\.(?:"(?:previously|punk-records)"|(?:previously|punk-records))\]/m.test(text)) return true;
      } else {
        let config;
        try { config = JSON.parse(text); } catch { continue; }
        if ([config?.mcpServers, config?.mcp, config?.mcp?.servers].some(servers => ['previously', 'punk-records'].some(id => Object.hasOwn(servers ?? {}, id)))) return true;
        const commands = JSON.stringify(config?.hooks ?? {});
        if (/\b(?:previously|punk-records)\s+hook\s+(?:claude|codex)\b/.test(commands)) return true;
      }
    }
    return false;
  }
  if (registered) {
    const stores = new Set([path.join(home, '.local/share/previously'), path.join(home, '.local/share/punk-records'), env.PUNK_RECORDS_HOME].filter(Boolean));
    for (const store of stores) {
      const file = path.join(store, 'projects.txt');
      if (!stat(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const repo = line.trim();
        if (!repo) continue;
        if (!path.isAbsolute(repo) || !stat(repo)?.isDirectory()) { console.log(`Skip stale registration: ${repo}`); continue; }
        if (!configured(repo)) { console.log(`Skip registration without local configuration: ${repo}`); continue; }
        repos.add(repo);
      }
    }
  }

  const profiles = [], declarations = new Set();
  for (const name of ['.bashrc', '.profile', '.bash_profile', '.zshrc', '.zprofile']) {
    const file = path.join(home, name), info = stat(file);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`Manual profile reconciliation required (symlink): ${file}`);
    if (!info.isFile()) throw new Error(`Not a regular profile: ${file}`);
    const before = fs.readFileSync(file, 'utf8');
    const lines = before.split('\n');
    for (const line of lines) {
      if (/^\s*#/.test(line)) continue;
      const canonical = line.match(/^\s*(?:export\s+)?(PUNK_RECORDS_\w+)\s*=/);
      if (canonical) declarations.add(canonical[1]);
    }
    profiles.push({file, before, lines, mode: info.mode & 0o777});
  }
  const renamed = new Set();
  for (const profile of profiles) {
    profile.after = profile.lines.map(line => {
      if (/^\s*#/.test(line) || !/\bPREVIOUSLY_\w+/.test(line)) return line;
      const match = line.match(/^(\s*(?:export\s+)?)(PREVIOUSLY_\w+)(=)(.*)$/);
      // shortcut: only single-line shell words are supported; edit compound shell syntax manually.
      if (!match || !/^(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s;|&<>`\\'"()]*)(?:\s+#.*)?\s*$/.test(match[4]) || /\bPREVIOUSLY_\w+/.test(match[4])) {
        throw new Error(`Unsupported legacy environment syntax; edit manually: ${profile.file}`);
      }
      const canonical = match[2].replace('PREVIOUSLY_', 'PUNK_RECORDS_');
      if (declarations.has(canonical) || renamed.has(canonical)) throw new Error(`Conflicting profile declaration: ${canonical}`);
      renamed.add(canonical);
      return match[1] + canonical + match[3] + match[4];
    }).join('\n');
    if (profile.after !== profile.before) console.log(`Rename profile identifiers: ${profile.file}`);
  }

  const aliases = [];
  for (const name of ['punk-records', 'punk-records-synthesize', 'brainbrain', 'brainbrain-synthesize']) {
    if (pkg.bin?.[name] !== `bin/${name}`) throw new Error(`Unexpected source bin entry: ${name}`);
    const target = path.join(source, pkg.bin[name]), dest = path.join(home, '.local/bin', name), info = stat(dest);
    if (!fs.statSync(target).isFile()) throw new Error(`Missing source executable: ${name}`);
    let previous = null;
    if (info) {
      if (!info.isSymbolicLink()) throw new Error(`Refuse executable collision: ${dest}`);
      previous = fs.readlinkSync(dest);
      const resolved = fs.realpathSync(dest), ownerRoot = path.dirname(path.dirname(resolved));
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'package.json'), 'utf8')); } catch { /* foreign link */ }
      const relative = path.relative(ownerRoot, resolved);
      if (!['punk-records', 'previously-on-localhost'].includes(owner?.name) || !['bin/punk-records', 'bin/previously', 'bin/punk-records-synthesize', 'bin/previously-synthesize', 'bin/brainbrain', 'bin/brainbrain-synthesize'].includes(relative)) {
        throw new Error(`Refuse foreign executable link: ${dest}`);
      }
      if (resolved === fs.realpathSync(target)) continue;
    }
    aliases.push({dest, target, previous});
    console.log(`Point executable to source: ${dest}`);
  }

  const scopes = [{cwd: source, flag: '--global'}, ...[...repos].map(cwd => ({cwd, flag: '--local'}))];
  const diagnostics = [];
  let diagnosticsDir;
  const saveDiagnostic = (entry, index) => fs.writeFileSync(path.join(diagnosticsDir, `init-${index}.json`), JSON.stringify(entry, null, 2) + '\n', {mode: 0o600});
  function init(scope, dryRun) {
    console.log(`${dryRun ? 'Preflight' : 'Init'} ${scope.flag}: ${scope.cwd}`);
    const result = spawnSync(process.execPath, [cli, 'init', scope.flag, '--agents', agents, '--opencode-api', api, ...(dryRun ? ['--dry-run'] : [])], {cwd: scope.cwd, env, encoding: 'utf8'});
    const entry = {cwd: scope.cwd, scope: scope.flag, dryRun, status: result.status, stdout: result.stdout, stderr: result.stderr};
    diagnostics.push(entry);
    if (diagnosticsDir) saveDiagnostic(entry, diagnostics.length - 1);
    if (details) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
    // Never echo child output: config errors may include environment values or private payloads.
    if (dryRun) {
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      console.log(`Init output: ${(result.stdout ?? '').split('\n').filter(Boolean).length} lines; stderr: ${(result.stderr ?? '').split('\n').filter(Boolean).length} lines${result.stderr ? ' (requires review)' : ''}. Use this script with --details to inspect locally, or run directly after mapping/unsetting inherited PREVIOUSLY_* identifiers:`);
      console.log(`  cwd ${quote(scope.cwd)}: node ${quote(cli)} init ${scope.flag} --agents ${quote(agents)} --opencode-api ${api} --dry-run`);
    }
    if (result.error || result.status !== 0) throw new Error(`init ${scope.flag} failed for ${scope.cwd}; run its dry-run directly to inspect the error`);
  }
  for (const scope of scopes) init(scope, true);
  if (!apply) { console.log('Preview complete; no changes written. Use --apply after closing agents/viewers.'); return; }

  const state = path.join(home, '.local/state/punk-records');
  fs.mkdirSync(state, {recursive: true, mode: 0o700});
  const backup = fs.mkdtempSync(path.join(state, 'reconcile-'));
  fs.chmodSync(backup, 0o700);
  diagnosticsDir = backup;
  diagnostics.forEach(saveDiagnostic);
  const manifest = {source, profiles: [], aliases, completed: [], diagnostics: backup, status: 'running'};
  const manifestFile = path.join(backup, 'manifest.json');
  const record = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
  console.log(`Backups and completion manifest: ${manifestFile}`);
  try {
    for (const profile of profiles.filter(profile => profile.after !== profile.before)) {
      const copy = path.join(backup, path.basename(profile.file));
      fs.writeFileSync(copy, profile.before, {mode: 0o600, flag: 'wx'});
      manifest.profiles.push({file: profile.file, backup: copy, mode: profile.mode});
    }
    record();
    for (const profile of profiles.filter(profile => profile.after !== profile.before)) {
      if (stat(profile.file)?.isSymbolicLink() || fs.readFileSync(profile.file, 'utf8') !== profile.before) throw new Error(`Profile changed after preflight: ${profile.file}`);
      const temporary = `${profile.file}.punk-records-${process.pid}`;
      let created = false;
      try {
        fs.writeFileSync(temporary, profile.after, {mode: profile.mode, flag: 'wx'});
        created = true;
        fs.chmodSync(temporary, profile.mode);
        fs.renameSync(temporary, profile.file);
      } finally { if (created && stat(temporary)) fs.unlinkSync(temporary); }
      manifest.completed.push(`profile: ${profile.file}`); record();
    }
    for (const alias of aliases) {
      fs.mkdirSync(path.dirname(alias.dest), {recursive: true});
      if (alias.previous !== null) {
        if (!stat(alias.dest)?.isSymbolicLink() || fs.readlinkSync(alias.dest) !== alias.previous) throw new Error(`Executable changed after preflight: ${alias.dest}`);
      } else if (stat(alias.dest)) throw new Error(`Executable appeared after preflight: ${alias.dest}`);
      const temporary = `${alias.dest}.punk-records-${process.pid}`;
      let created = false;
      try {
        fs.symlinkSync(alias.target, temporary);
        created = true;
        fs.renameSync(temporary, alias.dest);
      } finally { if (created && stat(temporary)) fs.unlinkSync(temporary); }
      manifest.completed.push(`alias: ${alias.dest}`); record();
    }
    for (const scope of scopes) {
      manifest.activeStep = `init ${scope.flag}: ${scope.cwd}`; record();
      init(scope, false); manifest.completed.push(manifest.activeStep); record();
    }
    delete manifest.activeStep;
    manifest.status = diagnostics.some(entry => entry.stderr) ? 'complete_with_diagnostics' : 'complete'; record();
    console.log('Reconciliation steps complete. Review private init diagnostics for warnings or manual work; reopen your shell and review Codex hooks using /hooks.');
  } catch (error) {
    manifest.status = 'failed'; manifest.error = error.message; record();
    throw new Error(`${error.message}; partial changes are recorded in ${manifestFile}`);
  }
}

try { main(); } catch (error) { console.error(`reconcile: ${error.message}`); process.exitCode = 1; }
