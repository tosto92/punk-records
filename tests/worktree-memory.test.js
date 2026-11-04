import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as paths from '../lib/paths.js';
import {saveMemory} from '../lib/save.js';
import {loadMemories, buildAll} from '../lib/build.js';
import {search} from '../lib/ask.js';
import {collectMemories} from '../lib/graph.js';
import {listProjects, registerProject} from '../lib/projects.js';
import {createCapture} from '../lib/capture.js';
import {handleHook} from '../lib/hook.js';
import {initRepo} from '../lib/init.js';
import {handleMessage} from '../lib/mcp.js';
import {runScan} from '../lib/security/cli.js';

const exec = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/punk-records');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'punk-worktrees-')));
  const values = {HOME: path.join(root, 'home'), PUNK_RECORDS_HOME: path.join(root, 'global'),
    PUNK_RECORDS_HOME: path.join(root, 'global'), PUNK_RECORDS_SECURITY: '0',
    PUNK_RECORDS_AUTOSAVE: '1', PUNK_RECORDS_SYNTHESIS: '0',
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, {recursive: true, force: true});
  });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const repo = path.join(root, 'primary');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial');
  const internal = path.join(repo, 'trees', 'internal'), external = path.join(root, 'external');
  git(repo, 'worktree', 'add', '-qb', 'internal', internal);
  git(repo, 'worktree', 'add', '-q', '--detach', external);
  return {root, repo, internal, external, git, store: path.join(repo, 'memory')};
}

test('linked, detached and moved checkouts share primary memory and identity, keeping checkout roots', t => {
  const {root, repo, internal, external, git, store} = fixture(t);
  const moved = path.join(root, 'moved');
  git(repo, 'worktree', 'move', external, moved);
  for (const cwd of [internal, moved, repo]) {
    assert.equal(paths.resolveScopes({}, cwd).repoRoot, cwd);
    assert.equal(paths.repoDir(cwd), store);
    assert.equal(paths.resolveScopes({}, cwd).repoName, 'primary');
    assert.equal(paths.memoryRoot(cwd), repo);
  }
});

test('saves and updates by ref are visible from primary and sibling without local stores', t => {
  const {repo, internal, external, store} = fixture(t);
  const saved = saveMemory({type: 'solved', title: 'shared worktree fix', solution: 'restart', ts: '2026-01-01T00:00:00.000Z'}, {cwd: internal});
  for (const [cwd, ts] of [[repo, '2026-01-01T00:00:01.000Z'], [external, '2026-01-01T00:00:02.000Z']]) {
    assert.equal(search({query: 'shared worktree fix', scope: 'local', resolved: {repoRoot: cwd}})[0]?.memoryId, saved.memoryId);
    const updated = saveMemory({ref: saved.memoryId, solution: 'restart safely', ts}, {cwd});
    assert.equal(updated.memoryId, saved.memoryId);
  }
  assert.equal(loadMemories(store).memories[0].solution, 'restart safely');
  assert.equal(loadMemories(store).memories[0].repo, 'primary');
  for (const cwd of [internal, external]) assert.equal(fs.existsSync(path.join(cwd, 'memory')), false);
});

test('concurrent writers from linked checkouts retain every complete searchable event', async t => {
  const {repo, internal, external, store} = fixture(t);
  await Promise.all(Array.from({length: 8}, (_, i) => exec(process.execPath,
    [BIN, 'save', '--local', '--type', 'note', '--title', `parallel writer ${i}`], {cwd: i % 2 ? internal : external, env: process.env})));
  const events = fs.readFileSync(path.join(store, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 8);
  assert.equal(new Set(events.map(e => e.memoryId)).size, 8);
  assert.equal(search({query: 'parallel writer', limit: 20, scope: 'local', resolved: {repoRoot: repo}}).length, 8);
});

test('registry canonicalizes existing linked roots and future registrations', t => {
  const {root, repo, internal, external, store} = fixture(t);
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'events.jsonl'), '');
  fs.mkdirSync(path.join(root, 'global'));
  const registry = path.join(root, 'global', 'projects.txt');
  fs.writeFileSync(registry, `${internal}\n${repo}\n${external}\n`);
  assert.deepEqual(listProjects(), [repo]);
  const before = fs.readFileSync(registry, 'utf8');
  registerProject(external);
  assert.equal(fs.readFileSync(registry, 'utf8'), before);
  fs.writeFileSync(registry, '');
  registerProject(internal); registerProject(external);
  assert.equal(fs.readFileSync(registry, 'utf8'), `${repo}\n`);
});

test('local init leaves instructions and agent config in the current worktree', t => {
  const {repo, external, store} = fixture(t);
  initRepo({cwd: external, explicit: 'local', agents: ['opencode']});
  assert.ok(fs.existsSync(path.join(external, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(external, 'opencode.json')));
  assert.ok(fs.existsSync(path.join(store, 'events.jsonl')));
  for (const name of ['AGENTS.md', 'opencode.json']) assert.equal(fs.existsSync(path.join(repo, name)), false);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
  assert.deepEqual(listProjects(), [repo]);
});

test('capture resumes the same session memory across trees while distinct sessions remain distinct', async t => {
  const {repo, internal, external, store} = fixture(t);
  for (const [cwd, sid, file] of [[internal, 'same-session', 'first.js'], [external, 'same-session', 'second.js'], [repo, 'other-session', 'third.js']]) {
    const capture = createCapture({cwd});
    try { capture.prompt(sid, 'fix worktree capture'); capture.edit(sid, [file]); await capture.idle(sid); }
    finally { capture.dispose(); }
  }
  const memories = loadMemories(store).memories;
  assert.equal(memories.length, 2);
  assert.equal(fs.readFileSync(path.join(store, 'events.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(fs.existsSync(path.join(internal, 'memory')), false);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
});

test('hook capture keeps edited paths relative to the current checkout and writes primary memory', async t => {
  const {external, store} = fixture(t);
  const input = {cwd: external, session_id: 'hook-worktree'};
  await handleHook('claude', 'UserPromptSubmit', {...input, prompt: 'change worktree feature'});
  await handleHook('claude', 'PostToolUse', {...input, tool_name: 'Write', tool_input: {file_path: path.join(external, 'src', 'feature.js')}});
  await handleHook('claude', 'Stop', input);
  assert.deepEqual(loadMemories(store).memories[0]?.files, ['src/feature.js']);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
});

test('build, graph, MCP freshness and synthesis CLI consume the shared store with plain repoRoot', t => {
  const {repo, external, store} = fixture(t);
  saveMemory({type: 'solved', title: 'shared consumer evidence', solution: 'use primary'}, {cwd: repo});
  buildAll({repoRoot: external}, 'local');
  assert.ok(fs.existsSync(path.join(store, 'INDEX.md')));
  assert.equal(collectMemories({repoRoot: external}, 'local')[0]?.title, 'shared consumer evidence');
  const fresh = () => handleMessage({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'memory_freshness', arguments: {scope: 'local'}}}, {cwd: external, flagExplicit: 'local'});
  assert.equal(JSON.parse(fresh().result.content[0].text).stale, false);
  saveMemory({type: 'note', title: 'later consumer evidence'}, {cwd: repo});
  assert.equal(JSON.parse(fresh().result.content[0].text).stale, true);
  const prepared = JSON.parse(execFileSync(process.execPath, [BIN, 'synth', 'prepare', '--local', '--group', 'shared', '--memory', loadMemories(store).memories[0].memoryId], {cwd: external, encoding: 'utf8'}));
  assert.ok(prepared.requestId);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
});

test('protected search and scan retain primary store identity across worktrees', t => {
  const {repo, external, store} = fixture(t);
  process.env.PUNK_RECORDS_SECURITY = '1';
  process.env.PUNK_RECORDS_SECURITY = '1';
  const saved = saveMemory({type: 'solved', title: 'worktree benign restart', solution: 'restart safely'}, {cwd: external});
  assert.equal(saved.security.store, store);
  assert.equal(saved.security.status, 'no_signals');
  assert.equal(search({query: 'benign restart', scope: 'local', resolved: {repoRoot: repo}})[0]?.memoryId, saved.memoryId);
  let output = '';
  assert.equal(runScan(['--local'], {cwd: external, stdout: {write: s => {output += s;}}, stderr: {write: s => assert.fail(s)}}), 0);
  assert.equal(JSON.parse(output).results[0].store, store);
});

test('inner markers, nested repositories, real submodules and plain roots remain independent', t => {
  const {root, repo, external, git} = fixture(t);
  const marked = path.join(external, 'marked'), nested = path.join(external, 'nested'), plain = path.join(root, 'plain');
  for (const dir of [marked, nested, plain]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(marked, paths.MARKER), '');
  git(nested, 'init', '-q');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repo, 'submodule');
  const submodule = path.join(repo, 'submodule');
  for (const cwd of [marked, nested, submodule, plain]) assert.equal(paths.repoDir(cwd), path.join(cwd, 'memory'));
  for (const cwd of [marked, nested, submodule]) assert.equal(paths.resolveScopes({}, cwd).repoRoot, cwd);
  saveMemory({type: 'note', title: 'separate marker'}, {cwd: marked});
  assert.equal(fs.existsSync(path.join(repo, 'memory')), false);
});

test('missing or unrelated primary checkout is an error instead of local or global fallback', t => {
  const {root, repo, external, git} = fixture(t);
  git(repo, 'config', 'core.worktree', path.join(root, 'missing-primary'));
  assert.throws(() => saveMemory({type: 'note', title: 'must fail'}, {cwd: external}), /primary.*(unavailable|unusable|checkout)/i);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
  assert.equal(fs.existsSync(path.join(root, 'global', 'events.jsonl')), false);
  const unrelated = path.join(root, 'unrelated'); fs.mkdirSync(unrelated); git(unrelated, 'init', '-q');
  git(repo, 'config', 'core.worktree', unrelated);
  assert.throws(() => saveMemory({type: 'note', title: 'must also fail'}, {cwd: external}), /primary.*(unavailable|unusable|checkout)/i);
  assert.equal(fs.existsSync(path.join(unrelated, 'memory')), false);
});

test('explicit global save and MCP search do not require a usable primary checkout', t => {
  const {root, repo, external, git} = fixture(t);
  git(repo, 'config', 'core.worktree', path.join(root, 'missing-primary'));
  const saved = saveMemory({type: 'note', title: 'global independent memory'}, {cwd: external, scope: 'global'});
  const result = handleMessage({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'memory_find', arguments: {query: 'global independent', scope: 'global'}}}, {cwd: external, flagExplicit: null});
  assert.equal(JSON.parse(result.result.content[0].text)[0]?.memoryId, saved.memoryId);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
});

test('bare primary repositories are rejected rather than used as a store', t => {
  const {root, repo, git} = fixture(t);
  const bare = path.join(root, 'bare.git'), linked = path.join(root, 'bare-linked');
  git(root, 'clone', '--bare', '-q', repo, bare);
  git(bare, 'worktree', 'add', '-q', '--detach', linked);
  assert.throws(() => paths.repoDir(linked), /primary.*(bare|checkout|unusable)/i);
  assert.throws(() => paths.memoryRoot(bare), /primary.*(bare|checkout|unusable)/i);
  assert.equal(fs.existsSync(path.join(bare, 'memory')), false);
});

test('corrupt Git metadata does not silently select global, while a nearer marker still works', t => {
  const {root, repo} = fixture(t);
  fs.rmSync(path.join(repo, '.git'), {recursive: true});
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /missing/punk-records-test-metadata');
  assert.throws(() => saveMemory({type: 'note', title: 'must fail'}, {cwd: repo}), /git.*(metadata|unavailable)/i);
  assert.throws(() => paths.memoryRoot(repo), /git.*(metadata|unavailable)/i);
  const marked = path.join(repo, 'marked'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, paths.MARKER), '');
  saveMemory({type: 'note', title: 'independent marker'}, {cwd: marked});
  assert.equal(fs.existsSync(path.join(root, 'global', 'events.jsonl')), false);
});

test('shared destination symlinks are still refused without writing the target', t => {
  const {root, repo, external} = fixture(t);
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(repo, 'memory'), 'dir');
  assert.throws(() => saveMemory({type: 'note', title: 'must fail'}, {cwd: external}), /symlink/i);
  assert.equal(fs.existsSync(path.join(target, 'events.jsonl')), false);
});


test('dangling Git metadata fails local scopes before saving globally, but explicit global remains usable', t => {
  const {root, repo} = fixture(t);
  fs.rmSync(path.join(repo, '.git'), {recursive: true});
  fs.symlinkSync(path.join(root, 'missing-metadata'), path.join(repo, '.git'), 'dir');
  assert.throws(() => paths.resolveScopes({}, repo), /Git metadata unavailable/i);
  assert.throws(() => paths.memoryRoot(repo), /Git metadata unavailable/i);
  assert.throws(() => saveMemory({type: 'note', title: 'must fail'}, {cwd: repo}), /Git metadata unavailable/i);
  assert.equal(fs.existsSync(path.join(root, 'global', 'events.jsonl')), false);
  assert.doesNotThrow(() => saveMemory({type: 'note', title: 'explicit global survives'}, {cwd: repo, scope: 'global'}));
  const marked = path.join(repo, 'marked'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, paths.MARKER), '');
  assert.equal(paths.resolveScopes({}, marked).repoRoot, marked);
  saveMemory({type: 'note', title: 'independent marked project'}, {cwd: marked});
  assert.ok(fs.existsSync(path.join(marked, 'memory', 'events.jsonl')));
});

test('default and local saves inside a bare Git repository fail without silently writing globally', t => {
  const {root, repo, git} = fixture(t);
  const bare = path.join(root, 'bare.git');
  git(root, 'clone', '--bare', '-q', repo, bare);
  assert.throws(() => paths.resolveScopes({}, bare), /bare.*repository|primary.*checkout/i);
  for (const scope of [null, 'repo']) assert.throws(() => saveMemory({type: 'note', title: 'must fail'}, {cwd: bare, scope}), /bare.*repository|primary.*checkout/i);
  assert.equal(fs.existsSync(path.join(root, 'global', 'events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(bare, 'memory')), false);
  assert.doesNotThrow(() => saveMemory({type: 'note', title: 'explicit bare global'}, {cwd: bare, scope: 'global'}));
});

test('symlink aliases of linked checkout roots share public plain-repoRoot consumers', t => {
  const {root, repo, external, store} = fixture(t);
  const alias = path.join(root, 'linked-alias'); fs.symlinkSync(external, alias, 'dir');
  const saved = saveMemory({type: 'solved', title: 'symlink shared evidence', solution: 'use primary'}, {cwd: repo});
  assert.equal(paths.repoDir(alias), store);
  assert.equal(search({query: 'symlink shared evidence', scope: 'local', resolved: {repoRoot: alias}})[0]?.memoryId, saved.memoryId);
  buildAll({repoRoot: alias}, 'local');
  assert.ok(fs.existsSync(path.join(store, 'INDEX.md')));
  assert.equal(collectMemories({repoRoot: alias}, 'local')[0]?.memoryId, saved.memoryId);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
  const marked = path.join(alias, 'marked'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, paths.MARKER), '');
  assert.equal(paths.repoDir(marked), path.join(marked, 'memory'));
});


test('local init rejects the primary memory symlink before creating target events', t => {
  const {root, repo, external} = fixture(t);
  const target = path.join(root, 'unrelated-target'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'untouched.txt'), 'keep');
  fs.symlinkSync(target, path.join(repo, 'memory'), 'dir');
  assert.throws(() => initRepo({cwd: external, explicit: 'local', agents: ['opencode']}), /symlink/i);
  assert.deepEqual(fs.readdirSync(target), ['untouched.txt']);
  assert.equal(fs.readFileSync(path.join(target, 'untouched.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(external, 'opencode.json')), false);
});

test('short checkout aliases preserve nearer explicit markers during scope resolution and save', t => {
  const {root, repo, external, git} = fixture(t);
  const longCheckout = path.join(root, 'a-long-physical-linked-checkout-directory');
  git(repo, 'worktree', 'move', external, longCheckout);
  const alias = path.join(root, 'a'); fs.symlinkSync(longCheckout, alias, 'dir');
  const marked = path.join(alias, 'm'); fs.mkdirSync(marked);
  fs.writeFileSync(path.join(marked, paths.MARKER), '');
  const resolved = paths.resolveScopes({}, marked);
  assert.equal(resolved.repoRoot, marked);
  assert.equal(resolved.repoName, 'm');
  saveMemory({type: 'note', title: 'independent aliased marker'}, {cwd: marked});
  assert.equal(loadMemories(path.join(marked, 'memory')).memories[0]?.title, 'independent aliased marker');
  assert.equal(fs.existsSync(path.join(repo, 'memory')), false);
});


test('empty synthesis adds no Git identity probes and preserves recall store attribution', t => {
  const {root, repo, external, store} = fixture(t);
  const local = saveMemory({type: 'solved', title: 'shared recall evidence', solution: 'local source'}, {cwd: repo});
  const global = saveMemory({type: 'solved', title: 'shared recall evidence', solution: 'global source'}, {cwd: repo, scope: 'global'});
  const trace = path.join(root, 'git-trace.jsonl');
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  t.after(() => { if (previous === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previous; });
  const query = synthesis => {
    process.env.PUNK_RECORDS_SYNTHESIS = synthesis;
    process.env.PUNK_RECORDS_SYNTHESIS = synthesis;
    fs.writeFileSync(trace, '');
    const hits = search({query: 'shared recall evidence', resolved: {repoRoot: external}, full: true});
    const probes = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      .filter(event => event.event === 'start').map(event => event.argv);
    return {hits, probes};
  };
  const disabled = query('0'), enabled = query('1');
  assert.ok(disabled.probes.length > 0, 'the linked checkout must exercise real Git identity probes');
  assert.deepEqual(enabled.hits, disabled.hits);
  assert.deepEqual(enabled.hits.map(h => [h.scope, h.memoryId, h.memory.solution]).sort(),
    [['global', global.memoryId, 'global source'], ['repo', local.memoryId, 'local source']]);
  assert.ok(fs.existsSync(path.join(store, 'events.jsonl')));
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
  assert.equal(enabled.probes.length, disabled.probes.length, 'empty synthesis must not repeat Git identity resolution');
});

test('recall revalidates worktree identity on the next query', t => {
  const {root, repo, external, git} = fixture(t);
  process.env.PUNK_RECORDS_SYNTHESIS = '1';
  const saved = saveMemory({type: 'solved', title: 'identity recall evidence', solution: 'primary store'}, {cwd: repo});
  const options = {query: 'identity recall evidence', scope: 'local', resolved: {repoRoot: external}};
  assert.equal(search(options)[0]?.memoryId, saved.memoryId);
  git(repo, 'config', 'core.worktree', path.join(root, 'missing-primary'));
  assert.throws(() => search(options), /primary.*(unavailable|unusable|checkout)/i);
  assert.equal(fs.existsSync(path.join(external, 'memory')), false);
});
