import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { resolveScopes } from "../lib/paths.js";
import { appendEvent, readEvents, normalizeEvent } from "../lib/events.js";
import * as eventsApi from "../lib/events.js";

test('only V2 reference updates may omit presentation fields', () => {
  const update = {v: 2, ts: '2026-10-02T00:00:00Z', memoryId: 'a'.repeat(40), ref: 'a'.repeat(40), solution: 'fix'};
  assert.equal(eventsApi.validateEvent(update), update);
  for (const invalid of [{...update, ref: null}, {...update, v: 1}, {...update, type: 'unknown'},
    {...update, title: 3}, {...update, memoryId: 'invalid'}, {...update, ts: undefined}]) {
    assert.throws(() => eventsApi.validateEvent(invalid), TypeError);
  }
});

test('rejects unsafe refs and malformed event shapes without append', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-validation-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const valid = normalizeEvent({type: 'note', title: 'valid'}, {writes: ['global']});
  appendEvent({dir, event: valid});
  const original = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const invalid = [null, [], {...valid, v: 99}, {...valid, type: 'bugfix'},
    {...valid, ts: 'yesterday'}, {...valid, title: 1}, {...valid, files: 'x'},
    {...valid, tags: [3]}, {...valid, attempts: {}}, {...valid, ref: 3},
    ...['../../outside-memory', '../x', 'a/b', 'a\\b', '.', '..', 'x\0y', 'UPPER', ''].map(ref => ({...valid, ref}))];
  for (const event of invalid) assert.throws(() => appendEvent({dir, event}), TypeError);
  assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), original);
  assert.equal(eventsApi.validateEvent(valid), valid);
  assert.equal(eventsApi.validateEvent({...valid, ref: 'safe--' + 'a'.repeat(40)}).ref,
    'safe--' + 'a'.repeat(40));
});

test('record diagnostics identify invalid schema and incomplete line numbers', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-records-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const valid = normalizeEvent({type: 'note', title: 'valid'}, {writes: ['global']});
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `null\n${JSON.stringify(valid)}\n{unfinished`);
  const {records, issues} = eventsApi.readEventRecords(dir);
  assert.deepEqual(records.map(r => r.line), [2]);
  assert.deepEqual(issues.map(i => [i.line, i.blocking]), [[1, true], [3, false]]);
});

test('CLI rejects unsafe ref before creating a register', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-invalid-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/previously'), 'save',
    '--global', '--type', 'note', '--title', 'unsafe', '--ref', '../../outside'],
    {env: {...process.env, PREVIOUSLY_HOME: home}, encoding: 'utf8'});
  assert.equal(run.status, 2);
  assert.equal(fs.existsSync(path.join(home, 'events.jsonl')), false);
});

test("save appends one atomic line and readEvents round-trips, skipping bad lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previously-"));
  process.env.PREVIOUSLY_HOME = dir;
  const resolved = { writes: ["global"], repoRoot: null, repoName: "" };
  const e1 = normalizeEvent({ type: "note", title: "first" }, resolved);
  const e2 = normalizeEvent({ type: "solved", title: "second", outcome: "ok" }, resolved);
  appendEvent({ dir, event: e1 });
  appendEvent({ dir, event: e2 });
  fs.appendFileSync(path.join(dir, "events.jsonl"), "{not valid json\n\n");
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, "first");
  assert.equal(events[0].outcome, "open");
  assert.equal(events[0].v, 2);
  assert.equal(events[1].outcome, "ok");
  assert.ok(events[0].ts);
});

test("default scope is repo inside git, global outside", () => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "previously-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: inside });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "previously-out-"));
  assert.deepEqual(resolveScopes({}, inside).writes, ["local"]);
  assert.equal(resolveScopes({}, inside).repoRoot, inside);
  assert.deepEqual(resolveScopes({}, outside).writes, ["global"]);
  assert.equal(resolveScopes({}, outside).repoRoot, null);
  assert.deepEqual(resolveScopes({ explicit: "global" }, inside).writes, ["global"]);
  assert.deepEqual(resolveScopes({ explicit: "local" }, outside).writes, ["local"]);
});

test("previously save CLI appends event and enforces required flags", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "previously-home-"));
  const env = { ...process.env, PREVIOUSLY_HOME: home };
  try {
    execFileSync("node", ["bin/previously", "save", "--type", "note"], { env, cwd: path.resolve(import.meta.dirname, "..") });
    assert.fail("missing --title should exit non-zero");
  } catch (err) {
    assert.equal(err.status, 2);
  }
  execFileSync(
    "node",
    ["bin/previously", "save", "--type", "note", "--title", "cli works", "--tags", "a,b", "--global"],
    { env, cwd: path.resolve(import.meta.dirname, "..") },
  );
  const events = readEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "cli works");
  assert.deepEqual(events[0].tags, ["a", "b"]);
});

test("unknown subcommand exits 2", () => {
  try {
    execFileSync("node", ["bin/previously", "frobnicate"], { cwd: path.resolve(import.meta.dirname, "..") });
    assert.fail("should exit non-zero");
  } catch (err) {
    assert.equal(err.status, 2);
  }
});

test("flag parser rejects flag-like values and conflicting scope flags", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "previously-guard-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "previously-guard-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PREVIOUSLY_HOME: home };
  const mem = path.resolve(import.meta.dirname, "..", "bin", "previously");
  try {
    execFileSync("node", [mem, "save", "--type", "--title", "x"], { env, cwd: repo, stdio: "pipe" });
    assert.fail("--type consuming --title should exit 2");
  } catch (err) {
    assert.equal(err.status, 2);
  }
  try {
    execFileSync("node", [mem, "save", "--type", "note", "--title", "t", "--global", "--local"], { env, cwd: repo, stdio: "pipe" });
    assert.fail("--global + --local should exit 2");
  } catch (err) {
    assert.equal(err.status, 2);
  }
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false, "no event appended to global store");
  assert.equal(fs.existsSync(path.join(repo, "memory", "events.jsonl")), false, "no event appended to repo store");
});
