import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { buildScope, buildAll } from "../lib/build.js";
import { slugify } from "../lib/slug.js";
import { resolveScopes } from "../lib/paths.js";
import * as buildApi from '../lib/build.js';
import { fingerprint } from '../lib/fingerprint.js';

const baseEvent = {v: 1, ts: '2026-10-02T00:00:00Z', type: 'note', scope: 'repo', repo: 'demo',
  title: 'same title', symptoms: 'A', solution: '', attempts: [], files: [], tags: [], outcome: 'open', ref: null};
const recordsOf = events => events.map((event, i) => ({line: i + 1, event}));

test('branch union and equal timestamp updates are deterministic', () => {
  const a = {...baseEvent, v: 2, memoryId: fingerprint(baseEvent)};
  const b = {...a, symptoms: 'B', memoryId: fingerprint({...baseEvent, symptoms: 'B'})};
  const updates = [
    {...a, ref: 'same-title', ts: '2026-10-02T01:00:00Z', solution: 'fix A', files: ['a.js']},
    {...b, ref: 'same-title', ts: '2026-10-02T01:00:00Z', solution: 'fix B', files: ['b.js']},
    {...a, ref: a.memoryId, ts: '2026-10-02T01:00:00Z', solution: 'z fix A'},
  ];
  const one = buildApi.compileMemories(recordsOf([a, ...updates, b])).memories;
  const two = buildApi.compileMemories(recordsOf([b, ...updates.toReversed(), a])).memories;
  assert.deepEqual(one, two);
  assert.equal(one.find(m => m.memoryId === a.memoryId).solution, 'z fix A');
  assert.equal(one.find(m => m.memoryId === b.memoryId).solution, 'fix B');
  assert.deepEqual(one.find(m => m.memoryId === a.memoryId).files, ['a.js']);
});

test('v2 title updates retain identity and seed filename', () => {
  const memoryId = fingerprint(baseEvent);
  const canonical = {...baseEvent, v: 2, memoryId};
  const c = buildApi.compileMemories(recordsOf([canonical, {...canonical, ref: memoryId,
    ts: '2026-10-02T01:00:00Z', title: 'new title', symptoms: 'new symptoms'}]));
  assert.equal(c.memories[0].memoryId, memoryId);
  assert.equal(c.memories[0].slug, 'same-title--' + memoryId);
  assert.equal(c.memories[0].title, 'new title');
  assert.notEqual(c.memories[0].fingerprint, memoryId);
  assert.equal(buildApi.resolveReference(c, memoryId).memoryId, memoryId);
  assert.equal(buildApi.resolveReference(c, c.memories[0].slug).memoryId, memoryId);
  assert.throws(() => buildApi.resolveReference(c, 'not-found'), /unknown/);
});

test('legacy title collisions and numeric aliases are rejected, not guessed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ambiguous-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const ref of ['same-title', 'same-title-2', 'missing']) {
    const events = [baseEvent, {...baseEvent, symptoms: 'B'}, {...baseEvent, ref, solution: 'unknown owner'}];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    assert.throws(() => buildScope(dir), /ambiguous|unknown/);
    const c = buildApi.loadMemories(dir);
    assert.equal(c.issues.length, 1);
    assert.equal(c.issues[0].line, 3);
    assert.equal(c.memories.every(m => !m.solution), true);
    assert.throws(() => buildApi.resolveReference(c, ref), /ambiguous|unknown/);
    assert.equal(fs.existsSync(path.join(dir, 'index.json')), false);
  }
});

test('build cleans only verified previously indexed nodes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cleanup-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, 'memory'));
  fs.writeFileSync(path.join(dir, 'memory/user.md'), 'user notes');
  fs.writeFileSync(path.join(dir, 'memory/same-title.md'), `---\nfingerprint: ${fingerprint(baseEvent)}\nrelated: []\n---\n`);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({version: 1, entries: [{slug: 'same-title', fingerprint: fingerprint(baseEvent)}]}));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(baseEvent) + '\n');
  const {index} = buildScope(dir);
  assert.equal(index.version, 2);
  assert.equal(fs.existsSync(path.join(dir, 'memory/same-title.md')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'memory/user.md'), 'utf8'), 'user notes');
  assert.equal(index.entries[0].memoryId, fingerprint(baseEvent));
});

test('build blocks unsafe stored refs before publishing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-build-unsafe-'));
  const dir = path.join(root, 'store');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({v: 1, ts: '2026-10-02T00:00:00Z',
    type: 'note', title: 'unsafe', ref: '../../outside-memory'}) + '\n');
  assert.throws(() => buildScope(dir), /line 1|ref/);
  assert.deepEqual(fs.readdirSync(dir), ['events.jsonl']);
});

for (const mode of ['directory', 'node', 'index']) {
  test(`build refuses ${mode} symlink without external writes`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-outside-'));
    t.after(() => {fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(outside, {recursive: true, force: true});});
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({v: 1, ts: '2026-10-02T00:00:00Z',
      type: 'note', title: 'safe', repo: '', ref: null}) + '\n');
    const {index} = buildScope(dir);
    const target = mode === 'directory' ? path.join(dir, 'memory') : mode === 'node'
      ? path.join(dir, 'memory', index.entries[0].slug + '.md') : path.join(dir, 'index.json');
    fs.rmSync(target, {recursive: true});
    fs.symlinkSync(mode === 'directory' ? outside : path.join(outside, 'node.md'), target);
    assert.throws(() => buildScope(dir), /symlink/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  });
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(dir);
  return out;
}

test("build dedups same problem and accumulates failed attempts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-build-"));
  const line = (o) => JSON.stringify(o) + "\n";
  const first = {
    v: 1,
    ts: "2026-10-02T10:00:00Z",
    type: "solved",
    scope: "repo",
    repo: "demo",
    title: "Auth Bug",
    symptoms: "login fails",
    attempts: [],
    solution: "rotate token",
    files: ["src/auth.js:12"],
    tags: ["auth"],
    outcome: "ok",
    ref: null,
  };
  const legacySlug = slugify(first.title, new Set());
  const firstSlug = legacySlug + '--' + fingerprint(first);

  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    [
      line(first),
      line({
        ...first,
        ts: "2026-10-02T11:00:00Z",
        title: "auth bug",
        symptoms: "  LOGIN   fails ",
        solution: "",
        attempts: ["restart server"],
        outcome: "partial",
      }),
      line({
        v: 1,
        ts: "2026-10-02T12:00:00Z",
        type: "attempt_failed",
        scope: "repo",
        repo: "demo",
        title: "auth retry",
        symptoms: "login fails",
        attempts: ["reinstall deps"],
        solution: "",
        files: [],
        tags: ["auth"],
        outcome: "open",
        ref: legacySlug,
      }),
    ].join(""),
  );

  buildScope(dir);

  const mds = fs.readdirSync(path.join(dir, "memory")).filter((f) => f.endsWith(".md"));
  assert.equal(mds.length, 1, "same problem must dedup to a single markdown file");
  const md = fs.readFileSync(path.join(dir, "memory", mds[0]), "utf8");

  assert.match(md, /## Tentativi falliti/);
  assert.match(md, /restart server/);
  assert.match(md, /reinstall deps/);
  assert.match(md, /## Sintomi/);
  assert.match(md, /## Soluzione/);
  assert.match(md, /## Esito/);
  assert.match(md, /^title: Auth Bug$/m);
  assert.match(md, /^scope: repo$/m);
  assert.match(md, /^repo: demo$/m);
  assert.match(md, /^outcome: open$/m);
  assert.match(md, /^updated: 2026-10-02T12:00:00Z$/m);
  assert.match(md, /^fingerprint: [0-9a-f]{40}$/m);
  assert.match(md, /^covers: src\/auth\.js:12$/m);
  assert.match(md, /^related: \[\]$/m);
  assert.match(md, /^tags: \[auth\]$/m);

  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.equal(index.version, 2);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].slug, firstSlug);
  assert.deepEqual(index.entries[0].tags, ["auth"]);
  assert.deepEqual(index.entries[0].files, ["src/auth.js:12"]);
  assert.equal(index.entries[0].outcome, "open");
  assert.equal(index.entries[0].updated, "2026-10-02T12:00:00Z");
  assert.match(index.entries[0].fingerprint, /^[0-9a-f]{40}$/);

  const indexMd = fs.readFileSync(path.join(dir, "INDEX.md"), "utf8");
  assert.equal(indexMd, `- [${firstSlug}](memory/${firstSlug}.md) — Auth Bug (open)\n`);

  const before = snapshot(dir);
  buildScope(dir);
  assert.deepEqual(snapshot(dir), before, "build must be byte-identical on repeat");
});

test("ref event before its target still merges into one node", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-build-reffirst-"));
  const line = (o) => JSON.stringify(o) + "\n";
  const target = {
    v: 1,
    ts: "2026-10-02T12:00:00Z",
    type: "solved",
    scope: "repo",
    repo: "demo",
    title: "Ref First",
    symptoms: "boom",
    attempts: [],
    solution: "fix it",
    files: [],
    tags: [],
    outcome: "ok",
    ref: null,
  };
  const legacyTargetSlug = slugify(target.title, new Set());
  const targetSlug = legacyTargetSlug + '--' + fingerprint(target);

  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    [
      line({
        v: 1,
        ts: "2026-10-02T10:00:00Z",
        type: "attempt_failed",
        scope: "repo",
        repo: "demo",
        title: "early attempt",
        symptoms: "boom",
        attempts: ["early failed try"],
        solution: "",
        files: [],
        tags: [],
        outcome: "open",
        ref: legacyTargetSlug,
      }),
      line(target),
    ].join(""),
  );

  const { index } = buildScope(dir);
  assert.equal(index.entries.length, 1, "ref-first must not create a second node");
  assert.equal(index.entries[0].slug, targetSlug);

  const mds = fs.readdirSync(path.join(dir, "memory")).filter((f) => f.endsWith(".md"));
  assert.equal(mds.length, 1);
  assert.deepEqual(mds, [`${targetSlug}.md`]);
  const md = fs.readFileSync(path.join(dir, "memory", mds[0]), "utf8");
  assert.match(md, /## Tentativi falliti/);
  assert.match(md, /early failed try/);
  assert.match(md, /## Soluzione/);
  assert.match(md, /fix it/);
});

test("buildAll default builds both global and repo scopes inside a repo", () => {
  // realpath: on macOS os.tmpdir() is a /var symlink to /private/var, and git reports the real path.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-build-both-repo-")));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-build-both-home-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const prevHome = process.env.PUNK_RECORDS_HOME;
  process.env.PUNK_RECORDS_HOME = home;
  try {
    const resolved = resolveScopes({}, repo);
    assert.equal(resolved.repoRoot, repo);

    buildAll(resolved);

    assert.ok(fs.existsSync(path.join(home, "index.json")), "global scope must be built");
    assert.ok(fs.existsSync(path.join(repo, "memory", "index.json")), "repo scope must be built");

    // The CLI default must produce the identical scope set.
    execFileSync("node", [path.resolve(import.meta.dirname, "..", "bin", "punk-records"), "build"], {
      cwd: repo,
      env: { ...process.env, PUNK_RECORDS_HOME: home },
    });
    assert.ok(fs.existsSync(path.join(home, "index.json")));
    assert.ok(fs.existsSync(path.join(repo, "memory", "index.json")));
  } finally {
    if (prevHome === undefined) delete process.env.PUNK_RECORDS_HOME;
    else process.env.PUNK_RECORDS_HOME = prevHome;
  }
});
