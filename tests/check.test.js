import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { appendEvent, normalizeEvent } from "../lib/events.js";
import { buildScope } from "../lib/build.js";
import { checkScope } from "../lib/check.js";

test('check rejects unsafe records and derived symlinks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-check-unsafe-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({v: 1, ts: '2026-10-02T00:00:00Z',
    type: 'note', title: 'bad', ref: '../outside'}) + '\n');
  assert.throws(() => checkScope(dir), /ref/);
  fs.unlinkSync(path.join(dir, 'events.jsonl'));
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'memory'));
  assert.throws(() => checkScope(dir), /symlink/);
});

test("check passes after build, fails after appending event without rebuild", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previously-check-"));
  const resolved = { writes: ["global"], repoRoot: null, repoName: "" };
  appendEvent({ dir, event: normalizeEvent({ type: "note", title: "first" }, resolved) });
  buildScope(dir);
  const clean = checkScope(dir);
  assert.equal(clean.stale, false);
  assert.deepEqual(clean.drift, []);
  appendEvent({ dir, event: normalizeEvent({ type: "note", title: "second" }, resolved) });
  const stale = checkScope(dir);
  assert.equal(stale.stale, true);
  assert.ok(stale.drift.includes("index.json"), `drift: ${stale.drift}`);
  assert.ok(stale.drift.includes("INDEX.md"), `drift: ${stale.drift}`);
  assert.ok(stale.drift.some((d) => d.startsWith("memory/")), `drift: ${stale.drift}`);
});

test("check flags extra and missing derived files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previously-check2-"));
  const resolved = { writes: ["global"], repoRoot: null, repoName: "" };
  appendEvent({ dir, event: normalizeEvent({ type: "note", title: "only one" }, resolved) });
  buildScope(dir);
  fs.writeFileSync(path.join(dir, "memory", "ghost.md"), "stale file\n");
  const extra = checkScope(dir);
  assert.equal(extra.stale, true);
  assert.ok(extra.drift.includes(path.join("memory", "ghost.md")), `drift: ${extra.drift}`);
  fs.rmSync(path.join(dir, "memory", "ghost.md"));
  const gone = buildScope(dir).wrote;
  const node = gone.find(rel => rel.startsWith('memory/only-one--'));
  assert.ok(node);
  fs.rmSync(path.join(dir, node));
  const missing = checkScope(dir);
  assert.equal(missing.stale, true);
  assert.ok(missing.drift.includes(node), `drift: ${missing.drift}`);
});

test("checkScope returns clean for an empty scope and CLI exits 0/1", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "previously-check-home-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "previously-check-cwd-"));
  const env = { ...process.env, PREVIOUSLY_HOME: home };
  assert.deepEqual(checkScope(home), { stale: false, drift: [] });
  execFileSync("node", ["bin/previously", "save", "--type", "note", "--title", "cli check", "--global"], {
    env,
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  execFileSync("node", ["bin/previously", "build", "--global"], {
    env,
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  const mem = path.resolve(import.meta.dirname, "..", "bin", "previously");
  execFileSync("node", [mem, "check", "--global"], { env, cwd: elsewhere });
  appendEvent({ dir: home, event: normalizeEvent({ type: "note", title: "later" }, { writes: ["global"], repoRoot: null, repoName: "" }) });
  try {
    execFileSync("node", [mem, "check", "--global"], { env, cwd: elsewhere, encoding: "utf8" });
    assert.fail("stale check should exit 1");
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(err.stdout, /stale: index\.json/);
  }
});
