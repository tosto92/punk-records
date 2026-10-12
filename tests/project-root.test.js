import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveScopes, globalDir, MARKER } from "../lib/paths.js";
import { initRepo } from "../lib/init.js";
import { saveMemory } from "../lib/save.js";
import { loadMemories } from "../lib/build.js";

// Throwaway dir outside any git repo, plus an isolated HOME and global store.
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mem-project-")));
  const keys = ["HOME", "PREVIOUSLY_HOME", "PUNK_RECORDS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = path.join(root, "home");
  process.env.PREVIOUSLY_HOME = path.join(root, "global");
  delete process.env.PUNK_RECORDS_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("new global stores use Punk Records while old stores and env names remain readable", (t) => {
  const root = scratch(t);
  const old = process.env.PREVIOUSLY_HOME;
  const current = path.join(root, "current");
  process.env.PUNK_RECORDS_HOME = current;
  assert.equal(globalDir(), current);
  process.env.PUNK_RECORDS_HOME = "";
  assert.equal(globalDir(), old);
  delete process.env.PUNK_RECORDS_HOME;
  assert.equal(globalDir(), old);
  delete process.env.PREVIOUSLY_HOME;
  assert.equal(globalDir(), path.join(root, "home", ".local", "share", "punk-records"));
  fs.mkdirSync(path.join(root, "home", ".local", "share", "previously"), { recursive: true });
  assert.equal(globalDir(), path.join(root, "home", ".local", "share", "previously"));
});

test("a .previously marker makes a non-git folder a project, also from subfolders", (t) => {
  const root = scratch(t);
  const proj = path.join(root, "notes");
  fs.mkdirSync(path.join(proj, "deep", "er"), { recursive: true });
  assert.deepEqual(resolveScopes({}, proj).writes, ["global"]);
  fs.writeFileSync(path.join(proj, MARKER), "");
  for (const cwd of [proj, path.join(proj, "deep", "er")]) {
    const r = resolveScopes({}, cwd);
    assert.equal(r.repoRoot, proj);
    assert.equal(r.repoName, "notes");
    assert.deepEqual(r.writes, ["local"]);
  }
});

test("the old .previously marker still resolves after the canonical marker changes", (t) => {
  const root = scratch(t);
  const proj = path.join(root, "old-project");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, ".previously"), "");
  assert.equal(resolveScopes({}, proj).repoRoot, proj);
  assert.equal(MARKER, ".punk-records");
});

test("the nearest root wins between a git repo and a marker", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "sub", "x"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(root, MARKER), "");
  assert.equal(resolveScopes({}, path.join(repo, "sub")).repoRoot, repo, "git root is nearer than the outer marker");
  fs.writeFileSync(path.join(repo, "sub", MARKER), "");
  assert.equal(resolveScopes({}, path.join(repo, "sub", "x")).repoRoot, path.join(repo, "sub"), "inner marker is nearer than git root");
});

test("init --local outside git marks the folder; save then writes there", (t) => {
  const root = scratch(t);
  const proj = path.join(root, "notes");
  fs.mkdirSync(proj);
  const dry = initRepo({ cwd: proj, explicit: "local", agents: ["opencode"], dryRun: true });
  assert.ok(dry.touched.includes(MARKER));
  assert.equal(fs.existsSync(path.join(proj, MARKER)), false, "dry run writes nothing");

  const { touched } = initRepo({ cwd: proj, explicit: "local", agents: ["opencode"] });
  assert.ok(touched.includes(MARKER));
  assert.ok(fs.existsSync(path.join(proj, MARKER)));
  assert.equal(fs.readFileSync(path.join(proj, "memory", "events.jsonl"), "utf8"), "");
  assert.deepEqual(initRepo({ cwd: proj, explicit: "local", agents: ["opencode"] }).touched, []);

  saveMemory({ type: "note", title: "non-git project note" }, { cwd: proj });
  assert.equal(loadMemories(path.join(proj, "memory")).memories[0].title, "non-git project note");
  assert.equal(fs.existsSync(path.join(root, "global", "events.jsonl")), false, "nothing went global");
});

test("default init outside any project still only creates the global store", (t) => {
  const root = scratch(t);
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  initRepo({ cwd: plain, agents: ["opencode"] });
  assert.equal(fs.existsSync(path.join(plain, MARKER)), false);
  assert.equal(fs.existsSync(path.join(plain, "memory")), false);
});
