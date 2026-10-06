import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScopes, globalDir, repoDir, MARKER } from "./paths.js";
import { registerProject } from "./projects.js";
import { MATCHERS } from "./hook-tools.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "previously");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SRC = path.join(ROOT, ".opencode", "plugins", "previously.ts");

const MEM_START = "<!-- previously:start -->";
const MEM_END = "<!-- previously:end -->";

// Absolute node invocation: the hints must work even when `previously` is not on PATH.
const BLOCK =
  `${MEM_START}\n` +
  `## Previously on localhost\n\n` +
  `- Recall first: \`node ${BIN} ask "<question>"\` (or the \`memory_find\` MCP tool).\n` +
  `- Record what generalizes: \`node ${BIN} save --type solved --title "<t>" --solution "<s>"\`\n` +
  `  (or the \`memory_save\` MCP tool). Types: solved, attempt_failed, decision, note.\n` +
  `${MEM_END}\n`;

const GITATTR_LINE = "memory/events.jsonl merge=union";

const SKILL_SRC = path.join(ROOT, "skills", "previously");
// Every skill init links, by installed name.
const SKILLS = { previously: SKILL_SRC, "previously-episodes": path.join(ROOT, "skills", "previously-episodes") };
const COMMAND_SRC = path.join(ROOT, "commands", "previously-save.md");
export const AGENT_NAMES = ["opencode", "claude", "codex"];
const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];
// Codex reads a project .codex/hooks.json (docs/claude-codex-compatibility.md F1).
export const CODEX_PROJECT_HOOKS = true;
const TOML_START = "# previously:start";
const TOML_END = "# previously:end";
// Any non-comment line defining a previously key or table (header, inline table, dotted key).
// note: loose on purpose; a false positive only skips the file with a warning.
const FOREIGN_TABLE = /^[ \t]*[^#\n]*?(?:^|[.\[ \t])["']?previously["']?[ \t]*[.=\]]/m;
const tomlBlock = () => `${TOML_START}\n[mcp_servers.previously]\ncommand = "node"\nargs = [${JSON.stringify(BIN)}, "mcp"]\n${TOML_END}\n`;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const claudeJson = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Identical everywhere (global and repo) so Claude Code dedups the commands.
export const hookCommand = (agent, event) => `previously hook ${agent} ${event}`;

export function initRepo({ cwd = process.cwd(), dryRun = false, explicit = null, opencodeApi = "v1", agents = AGENT_NAMES } = {}) {
  if (opencodeApi !== "v1" && opencodeApi !== "v2") throw new Error(`previously: unknown --opencode-api ${opencodeApi}`);
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => !AGENT_NAMES.includes(a))) {
    throw new Error(`previously: --agents takes a comma list of ${AGENT_NAMES.join(", ")}`);
  }
  const want = (a) => agents.includes(a);
  const touched = [];
  const write = (rel, content) => {
    touched.push(rel);
    if (!dryRun) fs.writeFileSync(path.join(cwd, rel), content);
  };
  // Marker block in an instructions file the agent reads (AGENTS.md, CLAUDE.md).
  const upsertBlock = (rel) => {
    const p = path.join(cwd, rel);
    const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    if (text === null) return write(rel, BLOCK);
    if (text.includes(MEM_START) && text.includes(MEM_END)) {
      const s = text.indexOf(MEM_START);
      const e = text.indexOf(MEM_END);
      const after = e + MEM_END.length + (text[e + MEM_END.length] === "\n" ? 1 : 0);
      const next = text.slice(0, s) + BLOCK + text.slice(after);
      if (next !== text) write(rel, next);
    } else {
      const sep = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      write(rel, text + sep + BLOCK);
    }
  };

  // events stores: one per interested scope (global home always; repo dir when
  // inside a git repo), unless narrowed with explicit global/local.
  let resolved = resolveScopes({ explicit }, cwd);
  // --local outside any project makes cwd one; the marker is written after preflight.
  const markProject = explicit === "local" && !resolved.repoRoot;
  if (markProject) resolved = { ...resolved, repoRoot: path.resolve(cwd), repoName: path.basename(path.resolve(cwd)) };
  let writes;
  if (explicit === "global") writes = ["global"];
  else if (explicit === "local") writes = ["local"];
  else {
    writes = ["global"];
    if (resolved.repoRoot) writes.push("local");
  }
  const pluginBase = process.env.PREVIOUSLY_PLUGINS || path.join(os.homedir(), ".config", "opencode", "plugins");
  const globalOc = process.env.PREVIOUSLY_CONFIG || path.join(os.homedir(), ".config", "opencode", "opencode.json");
  // Preflight every config before touching anything: a broken or opposite-format
  // config aborts with no partial install.
  const repoScope = writes.includes("local");
  const configs = [];
  if (want("opencode") && repoScope) configs.push(path.join(cwd, "opencode.json"));
  if (want("opencode") && explicit === "global") configs.push(globalOc);
  const parsed = new Map(configs.map((p) => [p, readConfig(p, opencodeApi)]));
  const targets = agentTargets({ cwd, want, repo: repoScope, global: explicit === "global" });
  // A file where a config folder should be (seen in the wild: an empty read-only
  // `.codex` placeholder) blocks only that target, like a foreign symlink (spec §6).
  const usable = (t) => {
    const blocker = blockedBy(t.path ?? t.dest);
    if (blocker) console.error(`previously: warning: ${blocker} is not a directory; skipping ${t.label}`);
    return !blocker;
  };
  for (const kind of ["json", "toml", "links"]) targets[kind] = targets[kind].filter(usable);
  const jsonValues = new Map(targets.json.map((t) => [t.path, readAgentJson(t)]));
  const tomlPlans = new Map(targets.toml.map((t) => [t.path, planToml(t.path)]));

  if (markProject) write(MARKER, "");
  for (const w of writes) {
    const dir = w === "global" ? globalDir() : repoDir(resolved.repoRoot);
    const ev = path.join(dir, "events.jsonl");
    if (!fs.existsSync(ev)) {
      touched.push(w === "global" ? ev : path.relative(cwd, ev));
      if (!dryRun) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(ev, "");
      }
    }
  }
  if (repoScope && !dryRun) registerProject(resolved.repoRoot);


  if (repoScope) {
    const managesAgents = want("opencode") || want("codex");
    if (managesAgents) upsertBlock("AGENTS.md");
    if (want("claude")) {
      const claudeMd = path.join(cwd, "CLAUDE.md");
      const imports = fs.existsSync(claudeMd) && /^@AGENTS\.md\s*$/m.test(fs.readFileSync(claudeMd, "utf8"));
      // A CLAUDE.md that imports AGENTS.md already carries the block.
      if (!(managesAgents && imports)) upsertBlock("CLAUDE.md");
    }
    if (want("opencode")) {
      mergeMcp(path.join(cwd, "opencode.json"), { cwd, dryRun, touched, opencodeApi, config: parsed.get(path.join(cwd, "opencode.json")) });
      // plugin entry point: a direct link to the real file, never the directory
      installPlugin(path.join(cwd, ".opencode", "plugins"), { cwd, dryRun, touched });
    }

    // .gitattributes union line
    const gaPath = path.join(cwd, ".gitattributes");
    let ga = fs.existsSync(gaPath) ? fs.readFileSync(gaPath, "utf8") : "";
    const hasLine = ga.split("\n").some((l) => l.trim() === GITATTR_LINE);
    if (!hasLine) {
      const sep = ga.length === 0 || ga.endsWith("\n") ? "" : "\n";
      write(".gitattributes", ga + sep + GITATTR_LINE + "\n");
    }
  }

  if (explicit === "global" && want("opencode")) {
    // global wiring: plugin symlink + MCP entry in the user-level config.
    // Repo-local files above are untouched in this mode.
    installPlugin(pluginBase, { cwd, dryRun, touched, absolute: true });
    mergeMcp(globalOc, { cwd, dryRun, touched, absolute: true, opencodeApi, config: parsed.get(globalOc) });
    // global skill (teaches agents when to save/recall)
    const skillBase = process.env.PREVIOUSLY_SKILLS || path.join(os.homedir(), ".config", "opencode", "skills");
    for (const [name, src] of Object.entries(SKILLS)) {
      const skillDest = path.join(skillBase, name);
      linkInto({ dest: skillDest, src, label: skillDest }, { dryRun, touched });
    }
  }

  let codexHooksAdded = false;
  for (const t of targets.json) {
    const before = touched.length;
    applyJson(t, jsonValues.get(t.path), { dryRun, touched });
    if (t.hooks === "codex" && touched.length > before) codexHooksAdded = true;
  }
  // Codex skips hooks the user has not approved yet; init never writes that trust itself.
  if (codexHooksAdded && !dryRun) console.error("previously: note: Codex runs new hooks only after you approve them: start codex and use /hooks");
  for (const t of targets.toml) applyToml(t, tomlPlans.get(t.path), { dryRun, touched });
  for (const t of targets.links) linkInto(t, { dryRun, touched });
  warnPath({ repo: repoScope, global: explicit === "global", want });

  return { touched };
}

// Parses and shape-checks a config without mutating it. Throws on JSON that
// cannot be parsed or that uses the opposite OpenCode API layout, so no silent
// conversion of foreign servers (Graft and friends) can happen.
function readConfig(ocPath, opencodeApi) {
  if (!fs.existsSync(ocPath)) return {};
  let oc;
  try {
    oc = JSON.parse(fs.readFileSync(ocPath, "utf8"));
  } catch {
    throw new Error(`previously: ${ocPath} is not valid JSON; fix or remove it, then re-run init`);
  }
  if (typeof oc !== "object" || oc === null || Array.isArray(oc)) throw new Error(`previously: ${ocPath} must hold a JSON object`);
  const mcp = typeof oc.mcp === "object" && oc.mcp !== null && !Array.isArray(oc.mcp) ? oc.mcp : null;
  const flat = mcp ? Object.keys(mcp).filter((k) => k !== "servers") : [];
  const nested = mcp && typeof mcp.servers === "object" && mcp.servers !== null && !Array.isArray(mcp.servers) ? Object.keys(mcp.servers) : [];
  if (opencodeApi === "v1" && nested.length) throw new Error(`previously: ${ocPath} uses the OpenCode V2 mcp.servers layout; re-run with --opencode-api v2`);
  if (opencodeApi === "v2" && flat.length) throw new Error(`previously: ${ocPath} uses the OpenCode V1 flat mcp layout; re-run with --opencode-api v1`);
  return oc;
}

// Links the plugin's real file; replaces only our own legacy directory link.
function installPlugin(base, { cwd, dryRun, touched, absolute = false }) {
  const dest = path.join(base, "previously.ts");
  const label = absolute ? dest : path.relative(cwd, dest);
  const have = linkTarget(dest);
  if (have === PLUGIN_SRC) return;
  if (have !== null) {
    console.error(`previously: warning: ${dest} exists and is not the previously plugin; left alone`);
    return;
  }
  if (!fs.existsSync(PLUGIN_SRC)) {
    console.error("previously: warning: plugin source missing; skipping plugin install");
    return;
  }
  touched.push(label);
  if (!dryRun) {
    fs.mkdirSync(base, { recursive: true });
    fs.symlinkSync(PLUGIN_SRC, dest);
  }
}

function linkTarget(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return fs.existsSync(p) ? "<occupied>" : null;
  }
}

function mergeMcp(ocPath, { cwd, dryRun, touched, absolute = false, opencodeApi = "v1", config = null }) {
  const label = absolute ? ocPath : path.relative(cwd, ocPath);
  const oc = config ?? readConfig(ocPath, opencodeApi);
  if (typeof oc.mcp !== "object" || oc.mcp === null || Array.isArray(oc.mcp)) oc.mcp = {};
  const entry = { type: "local", command: ["node", BIN, "mcp"] };
  if (opencodeApi === "v2") {
    if (typeof oc.mcp.servers !== "object" || oc.mcp.servers === null || Array.isArray(oc.mcp.servers)) oc.mcp.servers = {};
    oc.mcp.servers["previously"] = { ...entry, disabled: false };
  } else {
    oc.mcp["previously"] = { ...entry, enabled: true };
  }
  const next = JSON.stringify(oc, null, 2) + "\n";
  if (!fs.existsSync(ocPath) || next !== fs.readFileSync(ocPath, "utf8")) {
    touched.push(label);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(ocPath), { recursive: true });
      fs.writeFileSync(ocPath, next);
    }
  }
}

// Every Claude Code / Codex file init owns, for the requested scopes.
// Repo labels are repo-relative, global labels absolute (as in `touched`).
function agentTargets({ cwd, want, repo, global }) {
  const t = { json: [], toml: [], links: [] };
  const inRepo = (...parts) => ({ path: path.join(cwd, ...parts), label: path.join(...parts) });
  if (repo && want("claude")) {
    t.json.push({ ...inRepo(".mcp.json"), servers: true });
    t.json.push({ ...inRepo(".claude", "settings.json"), hooks: "claude" });
    for (const [name, src] of Object.entries(SKILLS)) t.links.push({ dest: path.join(cwd, ".claude", "skills", name), src, label: path.join(".claude", "skills", name) });
    t.links.push({ dest: path.join(cwd, ".claude", "commands", "previously-save.md"), src: COMMAND_SRC, label: path.join(".claude", "commands", "previously-save.md") });
  }
  if (global && want("claude")) {
    t.json.push({ path: path.join(claudeDir(), "settings.json"), hooks: "claude" });
    t.json.push({ path: claudeJson(), servers: true, backup: true });
    for (const [name, src] of Object.entries(SKILLS)) t.links.push({ dest: path.join(claudeDir(), "skills", name), src });
    t.links.push({ dest: path.join(claudeDir(), "commands", "previously-save.md"), src: COMMAND_SRC });
  }
  if (repo && want("codex")) {
    t.toml.push(inRepo(".codex", "config.toml"));
    for (const [name, src] of Object.entries(SKILLS)) t.links.push({ dest: path.join(cwd, ".agents", "skills", name), src, label: path.join(".agents", "skills", name) });
    if (CODEX_PROJECT_HOOKS && !codexHooksGlobal()) t.json.push({ ...inRepo(".codex", "hooks.json"), hooks: "codex" });
  }
  if (global && want("codex")) {
    t.json.push({ path: path.join(codexDir(), "hooks.json"), hooks: "codex" });
    t.toml.push({ path: path.join(codexDir(), "config.toml") });
    for (const [name, src] of Object.entries(SKILLS)) t.links.push({ dest: path.join(codexDir(), "skills", name), src });
  }
  if (global && (want("claude") || want("codex"))) {
    t.links.push({ dest: path.join(os.homedir(), ".local", "bin", "previously"), src: BIN });
  }
  for (const x of [...t.json, ...t.toml]) x.label ??= x.path;
  for (const x of t.links) x.label ??= x.dest;
  return t;
}

// Codex runs every copy of a hook (no dedup): a repo copy on top of the
// user's global one would run twice and need approving twice.
function codexHooksGlobal() {
  try { return fs.readFileSync(path.join(codexDir(), "hooks.json"), "utf8").includes(hookCommand("codex", "Stop")); }
  catch { return false; }
}

function readAgentJson(t) {
  let value = {};
  if (fs.existsSync(t.path)) {
    const raw = fs.readFileSync(t.path, "utf8");
    if (raw.trim()) {
      try { value = JSON.parse(raw); }
      catch { throw new Error(`previously: ${t.path} is not valid JSON; fix or remove it, then re-run init`); }
    }
  }
  if (!isObject(value)) throw new Error(`previously: ${t.path} must hold a JSON object`);
  if (t.servers && value.mcpServers !== undefined && !isObject(value.mcpServers)) {
    throw new Error(`previously: ${t.path}: "mcpServers" must be an object; fix it, then re-run init`);
  }
  if (t.hooks) {
    if (value.hooks !== undefined && !isObject(value.hooks)) throw new Error(`previously: ${t.path}: "hooks" must be an object; fix it, then re-run init`);
    for (const e of HOOK_EVENTS) {
      if (value.hooks?.[e] !== undefined && !Array.isArray(value.hooks[e])) {
        throw new Error(`previously: ${t.path}: "hooks.${e}" must be an array; fix it, then re-run init`);
      }
    }
  }
  return value;
}

// Appends our group last: foreign groups keep their indices (Codex keys hook
// trust by file:event:group:hook index).
function addHooks(config, agent) {
  let added = 0;
  config.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const command = hookCommand(agent, event);
    const groups = (config.hooks[event] ??= []);
    if (groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command))) continue;
    groups.push({ ...(event === "PostToolUse" ? { matcher: MATCHERS[agent] } : {}), hooks: [{ type: "command", command, timeout: 10 }] });
    added++;
  }
  return added;
}

// Untouched files keep their bytes and formatting: write only on a real change.
function applyJson(t, value, { dryRun, touched }) {
  let changed = false;
  if (t.servers) {
    const entry = { type: "stdio", command: "node", args: [BIN, "mcp"] };
    if (JSON.stringify(value.mcpServers?.["previously"]) !== JSON.stringify(entry)) {
      value.mcpServers = { ...(value.mcpServers ?? {}), "previously": entry };
      changed = true;
    }
  }
  if (t.hooks && addHooks(value, t.hooks) > 0) changed = true;
  if (!changed) return;
  touched.push(t.label);
  if (!dryRun) writeAtomic(t.path, JSON.stringify(value, null, 2) + "\n", { backup: t.backup });
}

// Temp file + rename in the real file's directory: no half-written config,
// a dotfiles symlink stays a symlink, and the mode (0600 for ~/.claude.json) is kept.
function writeAtomic(file, text, { backup = false } = {}) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  // A fresh ~/.claude.json (backup target) will hold oauth data: private from the start.
  const mode = fs.existsSync(real) ? fs.statSync(real).mode & 0o777 : backup ? 0o600 : 0o644;
  if (backup && fs.existsSync(real)) {
    fs.copyFileSync(real, `${file}.previously-bak`);
    fs.chmodSync(`${file}.previously-bak`, mode);
  }
  const tmp = `${real}.previously-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
}

// Points dest at our src; anything else already at dest is left alone.
function linkInto(t, { dryRun, touched }) {
  const have = linkTarget(t.dest);
  if (have === t.src) return;
  if (have !== null) {
    console.error(`previously: warning: ${t.dest} exists and is not previously's; left alone`);
    return;
  }
  if (!fs.existsSync(t.src)) {
    console.error(`previously: warning: ${t.src} missing; skipping ${t.dest}`);
    return;
  }
  touched.push(t.label);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(t.dest), { recursive: true });
    fs.symlinkSync(t.src, t.dest);
  }
}

// Hooks run the bare `previously` command; say so when the shell cannot find it.
function warnPath({ repo, global, want }) {
  if (!want("claude") && !want("codex")) return;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const bin = path.join(os.homedir(), ".local", "bin");
  if (global && !dirs.includes(path.resolve(bin))) {
    console.error(`previously: warning: ${bin} is not on PATH; Claude Code/Codex hooks run 'previously'`);
  } else if (repo && !dirs.some((d) => fs.existsSync(path.join(d, "previously")))) {
    console.error("previously: warning: 'previously' is not on PATH; run 'previously init --global' so Claude Code/Codex hooks can run it");
  }
}

// No TOML parser (zero deps): init owns only the marker block. A half or
// doubled block aborts; a previously table outside the block is the user's.
function planToml(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const count = (marker) => text.split(marker).length - 1;
  const s = text.indexOf(TOML_START);
  const e = text.indexOf(TOML_END);
  if (count(TOML_START) > 1 || count(TOML_END) > 1 || (s === -1) !== (e === -1) || e < s) {
    throw new Error(`previously: ${file} has a broken '${TOML_START}' / '${TOML_END}' block; fix it, then re-run init`);
  }
  const end = e + TOML_END.length + (text[e + TOML_END.length] === "\n" ? 1 : 0);
  const outside = s === -1 ? text : text.slice(0, s) + text.slice(end);
  if (FOREIGN_TABLE.test(outside)) return { foreign: true };
  const next = s === -1
    ? text + (text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n") + tomlBlock()
    : text.slice(0, s) + tomlBlock() + text.slice(end);
  return { foreign: false, changed: next !== text, next };
}

function applyToml(t, plan, { dryRun, touched }) {
  if (plan.foreign) {
    console.error(`previously: warning: ${t.path} already defines mcp_servers.previously outside the previously block; left alone`);
    return;
  }
  if (!plan.changed) return;
  touched.push(t.label);
  if (!dryRun) writeAtomic(t.path, plan.next);
}

// The nearest existing ancestor of file's folder, when it is not a directory.
function blockedBy(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      return fs.statSync(dir).isDirectory() ? null : dir;
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    }
    if (path.dirname(dir) === dir) return null;
  }
}
