import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initRepo } from "../lib/init.js";

// Global init also wires Claude Code and Codex under the home directory:
// this whole file runs against a throwaway HOME.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mem-init-home-"));
process.env.HOME = SANDBOX_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
test.after(() => fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_FILE = path.join(ROOT, ".opencode", "plugins", "previously.ts");
const BIN = path.join(ROOT, "bin", "punk-records");

// A fresh git repo plus fully isolated global scope; nothing leaks to the real home.
function fixture(t, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-init-"));
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  const prev = {};
  const set = { PREVIOUSLY_HOME: path.join(tmp, "home"), PREVIOUSLY_CONFIG: path.join(tmp, "global.json"),
    PREVIOUSLY_PLUGINS: path.join(tmp, "plugins"), PREVIOUSLY_SKILLS: path.join(tmp, "skills"), ...env };
  for (const [k, v] of Object.entries(set)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return tmp;
}

function tree(dir) {
  const out = {};
  const walk = (base, prefix) => {
    if (!fs.existsSync(base)) return;
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(base, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full, rel);
      else out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

function snap(dir) {
  const out = {};
  for (const rel of ["AGENTS.md", "opencode.json", ".gitattributes", "memory/events.jsonl"]) {
    const p = path.join(dir, rel);
    out[rel] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }
  return out;
}

test("init creates markers and second run is byte-identical", () => {
  // Guard: real work-directory files must not be touched by the test.
  const real = (rel) => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), "utf8") : null);
  const realAgents = real("AGENTS.md");
  const realOpencode = real("opencode.json");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-init-"));
  execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-home-"));
  const prevHome = process.env.PREVIOUSLY_HOME;
  process.env.PREVIOUSLY_HOME = home;
  try {
  fs.writeFileSync(
    path.join(tmp, "AGENTS.md"),
    "<!-- graft:start -->\ngraft stuff\n<!-- graft:end -->\n",
  );
  fs.writeFileSync(
    path.join(tmp, "opencode.json"),
    JSON.stringify({ mcp: { graft: { type: "local", command: ["graft", "mcp"], enabled: true } } }, null, 2) + "\n",
  );

  const first = initRepo({ cwd: tmp });
  assert.ok(first.touched.length > 0);
  const after1 = snap(tmp);

  assert.match(after1["AGENTS.md"], /<!-- previously:start -->/);
  assert.match(after1["AGENTS.md"], /<!-- previously:end -->/);
  assert.match(after1["AGENTS.md"], /<!-- graft:start -->\ngraft stuff\n<!-- graft:end -->/);
  assert.equal(after1["memory/events.jsonl"], "");
  // default init creates BOTH scopes: repo-local and overridden global
  assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8"), "");
  assert.match(after1[".gitattributes"], /memory\/events\.jsonl merge=union/);
  const oc = JSON.parse(after1["opencode.json"]);
  assert.ok(oc.mcp["previously"]);
  assert.equal(oc.mcp["previously"].type, "local");
  assert.equal(oc.mcp["previously"].enabled, true);
  assert.deepEqual(oc.mcp["previously"].command.slice(0, 1), ["node"]);
  assert.deepEqual(oc.mcp["previously"].command.slice(2), ["mcp"]);
  assert.ok(path.isAbsolute(oc.mcp["previously"].command[1]));
  assert.ok(oc.mcp.graft, "legacy graft entry preserved");

  const second = initRepo({ cwd: tmp });
  const after2 = snap(tmp);
  assert.deepEqual(after2, after1);
  assert.equal(second.touched.length, 0);
  assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8"), "");

  const memBlocks = after2["AGENTS.md"].split("<!-- previously:start -->").length - 1;
  assert.equal(memBlocks, 1);

  // dry-run changes nothing
  const before3 = snap(tmp);
  const dry = initRepo({ cwd: tmp, dryRun: true });
  assert.deepEqual(snap(tmp), before3);
  assert.ok(Array.isArray(dry.touched));

  // --local creates only the repo store
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-init-local-"));
  execFileSync("git", ["init"], { cwd: tmp2, stdio: "ignore" });
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-home2-"));
  process.env.PREVIOUSLY_HOME = home2;
  initRepo({ cwd: tmp2, explicit: "local" });
  assert.equal(fs.existsSync(path.join(tmp2, "memory", "events.jsonl")), true);
  assert.equal(fs.existsSync(path.join(home2, "events.jsonl")), false);

  assert.equal(real("AGENTS.md"), realAgents);
  assert.equal(real("opencode.json"), realOpencode);
  } finally {
    if (prevHome === undefined) delete process.env.PREVIOUSLY_HOME;
    else process.env.PREVIOUSLY_HOME = prevHome;
  }
});

test("invalid opencode.json aborts init instead of being replaced", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-init-bad-"));
  execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-home-bad-"));
  const prevHome = process.env.PREVIOUSLY_HOME;
  process.env.PREVIOUSLY_HOME = home;
  try {
  const bad = "{ not valid json !!!";
  fs.writeFileSync(path.join(tmp, "opencode.json"), bad);

  const before = snap(tmp);
  assert.throws(() => initRepo({ cwd: tmp }), /valid JSON/);
  assert.deepEqual(snap(tmp), before);
  assert.deepEqual(fs.readdirSync(tmp).sort(), [".git", "opencode.json"]);
  assert.equal(fs.readdirSync(home).length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.PREVIOUSLY_HOME;
    else process.env.PREVIOUSLY_HOME = prevHome;
  }
});

test("global init wires plugin symlink and global MCP config", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-init-global-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-home-global-"));
  const prevHome = process.env.PREVIOUSLY_HOME;
  const prevConfig = process.env.PREVIOUSLY_CONFIG;
  const prevPlugins = process.env.PREVIOUSLY_PLUGINS;
  const prevSkills = process.env.PREVIOUSLY_SKILLS;
  const fakeConfig = path.join(tmp, "global-opencode.json");
  const fakePlugins = path.join(tmp, "plugins");
  const fakeSkills = path.join(tmp, "skills");
  process.env.PREVIOUSLY_HOME = home;
  process.env.PREVIOUSLY_CONFIG = fakeConfig;
  process.env.PREVIOUSLY_PLUGINS = fakePlugins;
  process.env.PREVIOUSLY_SKILLS = fakeSkills;
  try {
  const first = initRepo({ cwd: tmp, explicit: "global" });
  // plugin symlink installed: the real file, never the directory
  const link = path.join(fakePlugins, "previously.ts");
  assert.equal(fs.readlinkSync(link), PLUGIN_FILE);
  // global MCP config merged (flat key)
  const oc = JSON.parse(fs.readFileSync(fakeConfig, "utf8"));
  assert.ok(oc.mcp["previously"]);
  assert.equal(oc.mcp["previously"].type, "local");
  // global skill symlinked
  const skillLink = path.join(fakeSkills, "previously");
  assert.equal(fs.readlinkSync(skillLink), path.join(ROOT, "skills", "previously"));
  // repo-local files untouched by explicit global run outside a repo
  assert.ok(!fs.existsSync(path.join(tmp, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(tmp, "opencode.json")));
  // idempotent second run
  const before = {
    link: fs.readlinkSync(link),
    config: fs.readFileSync(fakeConfig, "utf8"),
    store: fs.readFileSync(path.join(home, "events.jsonl"), "utf8"),
    skill: fs.readlinkSync(skillLink),
  };
  const second = initRepo({ cwd: tmp, explicit: "global" });
  assert.equal(fs.readlinkSync(link), before.link);
  assert.equal(fs.readlinkSync(skillLink), before.skill);
  assert.equal(fs.readFileSync(fakeConfig, "utf8"), before.config);
  assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8"), before.store);
  assert.deepEqual(second.touched, []);
  } finally {
    if (prevHome === undefined) delete process.env.PREVIOUSLY_HOME;
    else process.env.PREVIOUSLY_HOME = prevHome;
    if (prevConfig === undefined) delete process.env.PREVIOUSLY_CONFIG;
    else process.env.PREVIOUSLY_CONFIG = prevConfig;
    if (prevPlugins === undefined) delete process.env.PREVIOUSLY_PLUGINS;
    else process.env.PREVIOUSLY_PLUGINS = prevPlugins;
    if (prevSkills === undefined) delete process.env.PREVIOUSLY_SKILLS;
    else process.env.PREVIOUSLY_SKILLS = prevSkills;
  }
});

test("local init links the plugin file and its hints run without previously on PATH", t => {
  const tmp = fixture(t);
  initRepo({ cwd: tmp });
  assert.equal(fs.readlinkSync(path.join(tmp, ".opencode", "plugins", "previously.ts")), PLUGIN_FILE);
  const agents = fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(`node ${BIN}`), "AGENTS hints must not require mem on PATH");
  // the generated hint is executable as written, even with an empty PATH
  const run = spawnSync(process.execPath, [BIN, "save", "--global", "--type", "note", "--title", "init hint"],
    { cwd: tmp, env: { ...process.env, PATH: "", PREVIOUSLY_HOME: path.join(tmp, "home") }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /memoryId/);
});

test("V2 init writes mcp.servers and preserves unrelated servers", t => {
  const tmp = fixture(t);
  const graft = { type: "local", command: ["graft", "mcp"], environment: { A: "1" } };
  fs.writeFileSync(path.join(tmp, "opencode.json"), JSON.stringify({ mcp: { servers: { graft } } }, null, 2) + "\n");
  initRepo({ cwd: tmp, opencodeApi: "v2" });
  const config = JSON.parse(fs.readFileSync(path.join(tmp, "opencode.json"), "utf8"));
  assert.deepEqual(config.mcp.servers.graft, graft);
  assert.equal(config.mcp.servers["previously"].disabled, false);
  assert.equal(config.mcp.servers["previously"].type, "local");
  assert.deepEqual(config.mcp.servers["previously"].command, ["node", BIN, "mcp"]);
  assert.equal(config.mcp["previously"], undefined);
  assert.deepEqual(initRepo({ cwd: tmp, opencodeApi: "v2" }).touched, []);
});

test("a config in the opposite API format blocks init before any write", t => {
  const tmp = fixture(t);
  const v2Config = JSON.stringify({ mcp: { servers: { graft: { command: ["graft"] } } } }, null, 2) + "\n";
  fs.writeFileSync(path.join(tmp, "opencode.json"), v2Config);
  const before = tree(tmp);
  assert.throws(() => initRepo({ cwd: tmp, opencodeApi: "v1" }), /--opencode-api v2/);
  assert.deepEqual(tree(tmp), before);
  fs.writeFileSync(path.join(tmp, "opencode.json"), JSON.stringify({ mcp: { graft: { command: ["graft"] } } }, null, 2) + "\n");
  const flat = tree(tmp);
  assert.throws(() => initRepo({ cwd: tmp, opencodeApi: "v2" }), /--opencode-api v1/);
  assert.deepEqual(tree(tmp), flat);
});

test("a foreign plugin is left alone", t => {
  const other = fixture(t);
  const foreign = path.join(other, "plugins", "previously.ts");
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, "export default {id: 'someone-else'};\n");
  initRepo({ cwd: other, explicit: "global" });
  assert.equal(fs.readFileSync(foreign, "utf8"), "export default {id: 'someone-else'};\n");
  assert.equal(fs.existsSync(path.join(other, "skills", "previously")), true);
});
