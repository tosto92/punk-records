import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { listProjects, registerProject } from "../lib/projects.js";
import { saveMemory } from "../lib/save.js";
import { initRepo } from "../lib/init.js";
import { collectMemories, contextGraph } from "../lib/graph.js";
import { resolveScopes } from "../lib/paths.js";
import { loadMemories } from "../lib/build.js";

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
  const saved = saveMemory({ type: "note", title: "two" }, { cwd: a });
  assert.equal(saved.written, 1);
  assert.ok(loadMemories(path.join(a, "memory")).memories.some(m => m.memoryId === saved.memoryId));
});

test("registerProject does not probe unrelated roots", (t) => {
  const { root, repo } = sandbox(t);
  const current = repo("current");
  const unrelated = Array.from({length: 12}, (_, i) => repo(`unrelated-${i}`));
  const alias = path.join(root, "stale-alias");
  fs.symlinkSync(path.join(root, "vanished"), alias);
  const inaccessible = repo("inaccessible");
  const registry = path.join(root, "global", "projects.txt");
  fs.mkdirSync(path.dirname(registry));
  fs.writeFileSync(registry, [...unrelated, alias, inaccessible].join("\n") + "\n");
  // Observe Git launches in a child so the spy cannot affect other tests.
  const targets = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const original = cp.execFileSync, targets = [];
    cp.execFileSync = (command, args, options) => {
      if (command === 'git') {
        targets.push(options.cwd);
        if (options.cwd === ${JSON.stringify(inaccessible)}) throw new Error('inaccessible repository');
      }
      return original(command, args, options);
    };
    syncBuiltinESMExports();
    const {registerProject} = await import('./lib/projects.js');
    registerProject(${JSON.stringify(current)});
    console.log(JSON.stringify(targets));
  `], {cwd: path.resolve(import.meta.dirname, ".."), env: process.env, encoding: "utf8"}));
  assert.ok(targets.length > 0, "current root must still be validated");
  assert.deepEqual([...new Set(targets)], [current]);
  assert.ok(fs.readFileSync(registry, "utf8").endsWith(`${current}\n`));
});

test("registration compares trimmed canonical lines and appends a legacy alias only once", (t) => {
  const { root, repo } = sandbox(t);
  const current = repo("current"), alias = path.join(root, "alias");
  fs.symlinkSync(current, alias);
  const registry = path.join(root, "global", "projects.txt");
  fs.mkdirSync(path.dirname(registry));
  fs.writeFileSync(registry, `  ${current}  \n`);
  registerProject(alias);
  assert.equal(fs.readFileSync(registry, "utf8"), `  ${current}  \n`);
  fs.mkdirSync(path.join(current, "memory"));
  fs.writeFileSync(path.join(current, "memory", "events.jsonl"), "");
  fs.writeFileSync(registry, `${alias}\n`);
  registerProject(alias);
  registerProject(current);
  assert.equal(fs.readFileSync(registry, "utf8"), `${alias}\n${current}\n`);
  assert.deepEqual(listProjects(), [current]);
});

test("registration refuses a registry symlink without changing its target", (t) => {
  const { root, repo } = sandbox(t);
  const current = repo("current"), target = path.join(root, "target");
  fs.writeFileSync(target, "unchanged\n");
  fs.mkdirSync(path.join(root, "global"));
  fs.symlinkSync(target, path.join(root, "global", "projects.txt"));
  assert.doesNotThrow(() => registerProject(current));
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged\n");
});

test("invalid current Git metadata does not change the registry", (t) => {
  const { root } = sandbox(t);
  const invalid = path.join(root, "invalid");
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, ".git"), "gitdir: missing\n");
  const registry = path.join(root, "global", "projects.txt");
  fs.mkdirSync(path.dirname(registry));
  fs.writeFileSync(registry, "unchanged\n");
  assert.doesNotThrow(() => registerProject(invalid));
  assert.equal(fs.readFileSync(registry, "utf8"), "unchanged\n");
});

test("concurrent registration preserves complete append lines and deduplicated listing", async (t) => {
  const { root, repo } = sandbox(t);
  const current = repo("current");
  fs.mkdirSync(path.join(current, "memory"));
  fs.writeFileSync(path.join(current, "memory", "events.jsonl"), "");
  await Promise.all(Array.from({length: 6}, () => new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", `
      import {registerProject} from './lib/projects.js';
      registerProject(${JSON.stringify(current)});
    `], {cwd: path.resolve(import.meta.dirname, ".."), env: process.env}, error => error ? reject(error) : resolve());
  })));
  const lines = fs.readFileSync(path.join(root, "global", "projects.txt"), "utf8").trim().split("\n");
  assert.ok(lines.length >= 1 && lines.length <= 6);
  assert.ok(lines.every(line => line === current));
  assert.deepEqual(listProjects(), [current]);
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
