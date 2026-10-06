import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listProjects, registerProject } from "../lib/projects.js";
import { saveMemory } from "../lib/save.js";
import { initRepo } from "../lib/init.js";
import { collectMemories, contextGraph } from "../lib/graph.js";
import { resolveScopes } from "../lib/paths.js";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "previously");

// Isolated global store + HOME; returns a factory for throwaway git repos.
function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mem-projects-")));
  const keys = ["HOME", "PREVIOUSLY_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = path.join(root, "home");
  process.env.PREVIOUSLY_HOME = path.join(root, "global");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  };
  return { root, repo };
}

test("a local save registers its project once; vanished projects drop out", (t) => {
  const { root, repo } = sandbox(t);
  const a = repo("alpha"), b = repo("beta");
  saveMemory({ type: "note", title: "one" }, { cwd: a });
  saveMemory({ type: "note", title: "two" }, { cwd: a });
  saveMemory({ type: "note", title: "three" }, { cwd: b });
  saveMemory({ type: "note", title: "global one" }, { cwd: a, scope: "global" });
  assert.deepEqual(listProjects(), [a, b]);
  assert.equal(fs.readFileSync(path.join(root, "global", "projects.txt"), "utf8"), `${a}\n${b}\n`);
  fs.rmSync(b, { recursive: true });
  assert.deepEqual(listProjects(), [a]);
});

test("registry junk lines are ignored and an unwritable registry never breaks a save", (t) => {
  const { root, repo } = sandbox(t);
  const a = repo("alpha");
  fs.mkdirSync(path.join(root, "global"), { recursive: true });
  fs.writeFileSync(path.join(root, "global", "projects.txt"), "relative/path\n\n");
  saveMemory({ type: "note", title: "one" }, { cwd: a });
  assert.deepEqual(listProjects(), [a]);
  fs.rmSync(path.join(root, "global", "projects.txt"));
  fs.mkdirSync(path.join(root, "global", "projects.txt"));
  assert.doesNotThrow(() => registerProject(a));
  assert.doesNotThrow(() => saveMemory({ type: "note", title: "two" }, { cwd: a }));
});

test("init --local registers the project", (t) => {
  const { repo } = sandbox(t);
  const a = repo("alpha");
  initRepo({ cwd: a, explicit: "local", agents: ["opencode"] });
  assert.deepEqual(listProjects(), [a]);
});

test("the all-projects view merges every registered project with the global store", (t) => {
  const { root, repo } = sandbox(t);
  const a = repo("alpha"), b = repo("beta");
  saveMemory({ type: "solved", title: "alpha fix", tags: ["dns"] }, { cwd: a });
  saveMemory({ type: "decision", title: "beta choice", tags: ["dns"] }, { cwd: b });
  saveMemory({ type: "note", title: "habit", tags: ["dns"] }, { cwd: a, scope: "global" });
  const memories = collectMemories(resolveScopes({}, root), "projects");
  assert.deepEqual(memories.map((m) => m.title).sort(), ["alpha fix", "beta choice", "habit"]);
  const graph = contextGraph(memories, { scope: "projects" });
  assert.deepEqual(graph.nodes.map((n) => n.name).sort(), ["alpha fix [alpha]", "beta choice [beta]", "habit [global]"]);
  assert.equal(graph.meta.subtitle, "all projects");
  assert.equal(graph.edges.length, 3, "shared tag links memories across projects");

  const out = path.join(root, "g.html");
  const cli = execFileSync(process.execPath, [BIN, "graph", "--all-projects", "--out", out], { cwd: root, encoding: "utf8", env: process.env });
  assert.match(cli, /\(3 memories\)/);
});
