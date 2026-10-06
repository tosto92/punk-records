import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { edgesOf, graphHtml, writeGraph, contextGraph, collectMemories } from "../lib/graph.js";
import { repoDir, resolveScopes } from "../lib/paths.js";

const mem = (slug, tags, files, outcome = 'open') => ({slug, type: 'note', tags, files, outcome, scope: 'repo', title: slug});

test('shared tags draw solid edges, shared files dashed', () => {
  const memories = [mem('a', ['x'], ['a.js']), mem('b', ['x'], ['b.js']), mem('c', ['y'], ['a.js']), mem('d', ['z'], ['z.js'])];
  const edges = edgesOf(memories);
  assert.deepEqual(edges.map(e => `${e.a}-${e.b}:${e.tags.length ? 'tag' : 'file'}`), ['0-1:tag', '0-2:file']);
});

test('html is self-contained and links each memory', () => {
  const html = graphHtml([mem('a', ['x'], ['a.js'])]);
  assert.match(html, /<!doctype html>/);
  assert.equal(html.includes('<script'), false);
  assert.match(html, /<title>a\n/);
});

test('previously graph writes graph.html in the repo store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-graph-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'memory'), {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: repo});
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, {recursive: true});
  const run = (...args) => execFileSync(process.execPath, [path.resolve('bin/previously'), ...args], {
    cwd: repo, encoding: 'utf8', env: {...process.env, PREVIOUSLY_HOME: path.join(home, 'missing')},
  });
  run('save', '--type', 'note', '--title', 'alpha', '--tags', 'x', '--local');
  run('save', '--type', 'note', '--title', 'beta', '--tags', 'x', '--files', 'lib/a.js', '--local');
  const out = run('graph', '--local').trim();
  assert.match(out, new RegExp(`${path.join(repo, 'memory', 'graph.html')} \\(2 memories\\)`));
  assert.match(fs.readFileSync(repoDir(repo) + '/graph.html', 'utf8'), /alpha/);
});

const tempRepo = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'memory'), {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: repo});
  return repo;
};

test('serveGraph answers on 127.0.0.1 with a fresh page per request', async () => {
  const repo = tempRepo('mem-serve-');
  const env = {...process.env, PREVIOUSLY_HOME: path.join(repo, '..', 'global')};
  const run = (...args) => execFileSync(process.execPath, [path.resolve('bin/previously'), ...args], {cwd: repo, encoding: 'utf8', env});
  run('save', '--type', 'note', '--title', 'alpha', '--tags', 'x', '--local');

  const {serveGraph} = await import('../lib/graph.js');
  const {resolveScopes} = await import('../lib/paths.js');
  const server = await serveGraph(resolveScopes({explicit: 'local'}, repo), {scope: 'local', port: 45_000 + (process.pid % 500), viewer: 'svg'});
  try {
    assert.equal(server.viewer, 'svg');
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await (await fetch(server.url)).text();
    assert.match(page, /alpha/);
    run('save', '--type', 'note', '--title', 'beta', '--tags', 'x', '--local');
    assert.match(await (await fetch(server.url + '/index.html')).text(), /beta/);
    assert.equal((await fetch(server.url + '/nope')).status, 404);
  } finally {
    await server.close();
  }
});

test('contextGraph matches the viewer contract', () => {
  const memories = [
    {...mem('a', ['x'], ['a.js']), title: 'A', type: 'solved', symptoms: 'boom', solution: 'fix', outcome: 'ok'},
    {...mem('b', ['x'], ['a.js']), title: 'B', type: 'note', symptoms: 'meh', solution: '', outcome: 'open'},
  ];
  const graph = contextGraph(memories, {repoName: 'demo'});
  assert.equal(graph.meta.nodeCount, 2);
  assert.equal(graph.meta.edgeCount, 1);
  assert.deepEqual(graph.meta.tabs, ['context', 'outline']);
  assert.deepEqual(graph.nodes[0].sources, ['a.js']);
  assert.match(graph.nodes[0].summary, /^\[repo\] · ok/);
  assert.equal(graph.edges[0].relation, 'shares_tag_and_file');
});

test('contextGraph speaks memory: types, drafts, scope and detail sections', () => {
  const memories = [
    {...mem('fix', ['auth'], ['a.js']), title: 'Login fix', type: 'solved', outcome: 'ok', scope: 'global', updated: '2026-10-05T09:00:00Z',
      symptoms: 'token expired', solution: 'refresh first', attempts: ['retry loop', 'longer ttl']},
    {...mem('draft', ['auto'], ['b.js']), title: 'Codex session s1', type: 'note', symptoms: 'fix notes', attempts: []},
    {...mem('other', ['auth'], ['z.js']), title: 'Other', type: 'decision', attempts: []},
  ];
  const [fix, draft, other] = contextGraph(memories).nodes;
  assert.equal(fix.type, 'solved');
  assert.equal(fix.name, 'Login fix [global]');
  assert.equal(draft.type, 'draft');
  assert.equal(draft.name, 'Codex session s1');
  assert.equal(other.type, 'decision');
  assert.match(fix.summary, /^\[global\] · ok · 2026-10-05/);
  assert.match(fix.summary, /Symptoms\ntoken expired/);
  assert.match(fix.summary, /Solution\nrefresh first/);
  assert.match(fix.summary, /Failed attempts\n- retry loop\n- longer ttl/);
  assert.match(fix.summary, /#auth/);
  assert.equal(contextGraph(memories).edges[0].relation, 'shares_tag');
});

test('the vendored viewer colours every memory type in all themes', () => {
  const app = fs.readFileSync(path.resolve('lib/viewer/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('lib/viewer/style.css'), 'utf8');
  for (const type of ['solved', 'attempt_failed', 'decision', 'note', 'draft']) assert.match(app, new RegExp(`[{,]${type}:"--`), type);
  for (const v of ['--ok', '--bad']) assert.equal(css.match(new RegExp(`${v}:#`, 'g'))?.length, 4, v);
});

test('collectMemories can leave auto drafts out', () => {
  const repo = tempRepo('mem-drafts-');
  const env = {...process.env, PREVIOUSLY_HOME: path.join(repo, '..', 'global')};
  for (const [title, tags] of [['kept', 'x'], ['Claude Code session s1', 'auto']]) {
    execFileSync(process.execPath, [path.resolve('bin/previously'), 'save', '--type', 'note', '--title', title, '--tags', tags, '--local'], {cwd: repo, env});
  }
  const resolved = resolveScopes({explicit: 'local'}, repo);
  assert.deepEqual(collectMemories(resolved, 'local').map((m) => m.title).sort(), ['Claude Code session s1', 'kept']);
  assert.deepEqual(collectMemories(resolved, 'local', {drafts: false}).map((m) => m.title), ['kept']);
  const out = path.join(repo, 'g.html');
  const cli = execFileSync(process.execPath, [path.resolve('bin/previously'), 'graph', '--local', '--no-drafts', '--out', out], {cwd: repo, env, encoding: 'utf8'});
  assert.match(cli, /\(1 memories\)/);
});

test('interactive viewer is self-contained: serves its bundle and the memories api', async () => {
  const repo = tempRepo('mem-viewer-');
  const env = {...process.env, PREVIOUSLY_HOME: path.join(repo, '..', 'global')};
  execFileSync(process.execPath, [path.resolve('bin/previously'), 'save', '--type', 'solved', '--title', 'alpha', '--symptoms', 'boom', '--solution', 'fix', '--tags', 'x', '--files', 'a.js', '--local'], {cwd: repo, env});
  const {serveGraph} = await import('../lib/graph.js');
  const {resolveScopes} = await import('../lib/paths.js');
  const server = await serveGraph(resolveScopes({explicit: 'local'}, repo), {scope: 'local', port: 46_000 + (process.pid % 500), viewer: 'auto'});
  try {
    assert.equal(server.viewer, 'interactive');
    assert.match(await (await fetch(server.url + '/')).text(), /<b>previously on localhost<\/b>/);
    assert.match(fs.readFileSync(path.resolve('lib/viewer/LICENSE'), 'utf8'), /MIT License/);
    const page = await (await fetch(server.url + '/app.js')).text();
    assert.match(page, /context-graph/);
    const graph = await (await fetch(server.url + '/api/context-graph')).json();
    assert.match(graph.nodes[0].id, /^alpha/);
    assert.equal(graph.nodes[0].sources[0], 'a.js');
    assert.equal((await fetch(server.url + '/api/code-graph')).status, 404);
  } finally {
    await server.close();
  }
});
test('the web viewer carries no graft branding; only its LICENSE names the origin', () => {
  for (const f of ['index.html', 'app.js', 'style.css']) {
    assert.doesNotMatch(fs.readFileSync(path.resolve('lib/viewer', f), 'utf8'), /graft/i, f);
  }
  assert.match(fs.readFileSync(path.resolve('lib/viewer/LICENSE'), 'utf8'), /MIT License[\s\S]*Copyright/);
});
