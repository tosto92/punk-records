import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScopes, globalDir, repoDir, MARKER } from "./paths.js";
import { registerProject } from "./projects.js";
import { MATCHERS } from "./hook-tools.js";
import { setting } from "./env.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "punk-records");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SRC = path.join(ROOT, ".opencode", "plugins", "previously.ts");

const MEM_START = "<!-- punk-records:start -->";
const MEM_END = "<!-- punk-records:end -->";
const LEGACY_MEM_START = "<!-- previously:start -->";
const LEGACY_MEM_END = "<!-- previously:end -->";

// Absolute node invocation: the hints must work even when the CLI is not on PATH.
const BLOCK =
  `${MEM_START}\n` +
  `## Punk Records\n\n` +
  `- Recall first: \`node ${BIN} ask "<question>"\` (or the \`memory_find\` MCP tool).\n` +
  `- Record what generalizes: \`node ${BIN} save --type solved --title "<t>" --solution "<s>"\`\n` +
  `  (or the \`memory_save\` MCP tool). Types: solved, attempt_failed, decision, note.\n` +
  `${MEM_END}\n`;

const GITATTR_LINE = "memory/events.jsonl merge=union";

const SKILL_SRC = path.join(ROOT, "skills", "previously");
// Every skill init links, by installed name.
const SKILLS = {
  "punk-records": path.join(ROOT, "skills", "punk-records"),
  "punk-records-episodes": path.join(ROOT, "skills", "punk-records-episodes"),
  previously: SKILL_SRC,
  "previously-episodes": path.join(ROOT, "skills", "previously-episodes"),
};
const COMMANDS = ["punk-records-save.md", "previously-save.md"];
export const AGENT_NAMES = ["opencode", "claude", "codex"];
const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"];
// Codex reads a project .codex/hooks.json (docs/claude-codex-compatibility.md F1).
export const CODEX_PROJECT_HOOKS = true;
const TOML_START = "# punk-records:start";
const TOML_END = "# punk-records:end";
const LEGACY_TOML_START = "# previously:start";
const LEGACY_TOML_END = "# previously:end";
// Any non-comment line defining our current or legacy key/table (header, inline table, dotted key).
// note: loose on purpose; a false positive only skips the file with a warning.
const FOREIGN_TABLE = /^[ \t]*[^#\n]*?(?:^|[.\[ \t])["']?(?:previously|punk-records)["']?[ \t]*[.=\]]/m;
const tomlBlock = () => `${TOML_START}\n[mcp_servers.punk-records]\ncommand = "node"\nargs = [${JSON.stringify(BIN)}, "mcp"]\n${TOML_END}\n`;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const claudeJson = () =>
  process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Stable across old/new global and repo configs so Claude Code dedups the commands.
export const hookCommand = (agent, event) => `previously hook ${agent} ${event}`;

export function initRepo({ cwd = process.cwd(), dryRun = false, explicit = null, opencodeApi = "v1", agents = AGENT_NAMES } = {}) {
  if (opencodeApi !== "v1" && opencodeApi !== "v2") throw new Error(`punk-records: unknown --opencode-api ${opencodeApi}`);
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => !AGENT_NAMES.includes(a))) {
    throw new Error(`punk-records: --agents takes a comma list of ${AGENT_NAMES.join(", ")}`);
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
    const start = text.includes(MEM_START) ? MEM_START : LEGACY_MEM_START;
    const end = start === MEM_START ? MEM_END : LEGACY_MEM_END;
    if (text.includes(start) && text.includes(end)) {
      const s = text.indexOf(start);
      const e = text.indexOf(end);
      const after = e + end.length + (text[e + end.length] === "\n" ? 1 : 0);
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
  const pluginBase = setting("PLUGINS") || path.join(os.homedir(), ".config", "opencode", "plugins");
  const globalOc = setting("CONFIG") || path.join(os.homedir(), ".config", "opencode", "opencode.json");
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
    if (blocker) console.error(`punk-records: warning: ${blocker} is not a directory; skipping ${t.label}`);
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
    const skillBase = setting("SKILLS") || path.join(os.homedir(), ".config", "opencode", "skills");
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
  if (codexHooksAdded && !dryRun) console.error("punk-records: note: Codex runs new hooks only after you approve them: start codex and use /hooks");
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
    throw new Error(`punk-records: ${ocPath} is not valid JSON; fix or remove it, then re-run init`);
  }
  if (typeof oc !== "object" || oc === null || Array.isArray(oc)) throw new Error(`punk-records: ${ocPath} must hold a JSON object`);
  const mcp = typeof oc.mcp === "object" && oc.mcp !== null && !Array.isArray(oc.mcp) ? oc.mcp : null;
  const flat = mcp ? Object.keys(mcp).filter((k) => k !== "servers") : [];
  const nested = mcp && typeof mcp.servers === "object" && mcp.servers !== null && !Array.isArray(mcp.servers) ? Object.keys(mcp.servers) : [];
  if (opencodeApi === "v1" && nested.length) throw new Error(`punk-records: ${ocPath} uses the OpenCode V2 mcp.servers layout; re-run with --opencode-api v2`);
  if (opencodeApi === "v2" && flat.length) throw new Error(`punk-records: ${ocPath} uses the OpenCode V1 flat mcp layout; re-run with --opencode-api v1`);
  return oc;
}

// Links the plugin's real file; replaces only links from the old package.
function installPlugin(base, { cwd, dryRun, touched, absolute = false }) {
  const dest = path.join(base, "previously.ts");
  const label = absolute ? dest : path.relative(cwd, dest);
  const have = linkTarget(dest);
  if (have === PLUGIN_SRC) return;
  if (have !== null && !legacyLink(have, PLUGIN_SRC)) {
    console.error(`punk-records: warning: ${dest} exists and is not the Punk Records plugin; left alone`);
    return;
  }
  if (!fs.existsSync(PLUGIN_SRC)) {
    console.error("punk-records: warning: plugin source missing; skipping plugin install");
    return;
  }
  touched.push(label);
  if (!dryRun) {
    fs.mkdirSync(base, { recursive: true });
    if (have !== null) fs.unlinkSync(dest);
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

function legacyLink(have, src) {
  const rel = src === BIN ? path.join("bin", "previously") : path.relative(ROOT, src);
  return typeof have === "string" && path.isAbsolute(have) &&
    have.endsWith(`${path.sep}previously-on-localhost${path.sep}${rel}`);
}

function managedMcp(entry) {
  const command = Array.isArray(entry?.command) ? entry.command : [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])];
  return command.length === 3 && command[0] === "node" && command[2] === "mcp" &&
    typeof command[1] === "string" && path.isAbsolute(command[1]) &&
    ["previously", "punk-records"].includes(path.basename(command[1])) &&
    path.basename(path.dirname(command[1])) === "bin" &&
    (path.dirname(command[1]) === path.dirname(BIN) || path.basename(path.dirname(path.dirname(command[1]))) === "previously-on-localhost");
}

function mergeMcp(ocPath, { cwd, dryRun, touched, absolute = false, opencodeApi = "v1", config = null }) {
  const label = absolute ? ocPath : path.relative(cwd, ocPath);
  const oc = config ?? readConfig(ocPath, opencodeApi);
  if (typeof oc.mcp !== "object" || oc.mcp === null || Array.isArray(oc.mcp)) oc.mcp = {};
  const entry = { type: "local", command: ["node", BIN, "mcp"] };
  if (opencodeApi === "v2") {
    if (typeof oc.mcp.servers !== "object" || oc.mcp.servers === null || Array.isArray(oc.mcp.servers)) oc.mcp.servers = {};
    if (Object.hasOwn(oc.mcp.servers, "punk-records") && !managedMcp(oc.mcp.servers["punk-records"])) {
      console.error(`punk-records: warning: ${ocPath} has a foreign punk-records MCP entry; left alone`);
      return;
    }
    if (managedMcp(oc.mcp.servers.previously)) delete oc.mcp.servers.previously;
    oc.mcp.servers["punk-records"] = { ...entry, disabled: false };
  } else {
    if (Object.hasOwn(oc.mcp, "punk-records") && !managedMcp(oc.mcp["punk-records"])) {
      console.error(`punk-records: warning: ${ocPath} has a foreign punk-records MCP entry; left alone`);
      return;
    }
    if (managedMcp(oc.mcp.previously)) delete oc.mcp.previously;
    oc.mcp["punk-records"] = { ...entry, enabled: true };
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
    for (const name of COMMANDS) t.links.push({ dest: path.join(cwd, ".claude", "commands", name), src: path.join(ROOT, "commands", name), label: path.join(".claude", "commands", name) });
  }
  if (global && want("claude")) {
    t.json.push({ path: path.join(claudeDir(), "settings.json"), hooks: "claude" });
    t.json.push({ path: claudeJson(), servers: true, backup: true });
    for (const [name, src] of Object.entries(SKILLS)) t.links.push({ dest: path.join(claudeDir(), "skills", name), src });
    for (const name of COMMANDS) t.links.push({ dest: path.join(claudeDir(), "commands", name), src: path.join(ROOT, "commands", name) });
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
    t.links.push({ dest: path.join(os.homedir(), ".local", "bin", "punk-records"), src: BIN });
    t.links.push({ dest: path.join(os.homedir(), ".local", "bin", "previously"), src: BIN });
  }
  for (const x of [...t.json, ...t.toml]) x.label ??= x.path;
  for (const x of t.links) x.label ??= x.dest;
  return t;
}

// Codex runs every copy of a hook (no dedup): a repo copy on top of the
// user's global one would run twice and need approving twice.
function codexHooksGlobal() {
  try {
    const config = fs.readFileSync(path.join(codexDir(), "hooks.json"), "utf8");
    return config.includes(hookCommand("codex", "Stop")) || config.includes("punk-records hook codex Stop");
  }
  catch { return false; }
}

function readAgentJson(t) {
  let value = {};
  if (fs.existsSync(t.path)) {
    const raw = fs.readFileSync(t.path, "utf8");
    if (raw.trim()) {
      try { value = JSON.parse(raw); }
      catch { throw new Error(`punk-records: ${t.path} is not valid JSON; fix or remove it, then re-run init`); }
    }
  }
  if (!isObject(value)) throw new Error(`punk-records: ${t.path} must hold a JSON object`);
  if (t.servers && value.mcpServers !== undefined && !isObject(value.mcpServers)) {
    throw new Error(`punk-records: ${t.path}: "mcpServers" must be an object; fix it, then re-run init`);
  }
  if (t.hooks) {
    if (value.hooks !== undefined && !isObject(value.hooks)) throw new Error(`punk-records: ${t.path}: "hooks" must be an object; fix it, then re-run init`);
    for (const e of HOOK_EVENTS) {
      if (value.hooks?.[e] !== undefined && !Array.isArray(value.hooks[e])) {
        throw new Error(`punk-records: ${t.path}: "hooks.${e}" must be an array; fix it, then re-run init`);
      }
    }
  }
  return value;
}

// Appends our group last: foreign hooks keep their indices (Codex keys hook
// trust by file:event:group:hook index).
function addHooks(config, agent) {
  let changed = 0;
  config.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const command = hookCommand(agent, event);
    const alias = `punk-records hook ${agent} ${event}`;
    const groups = (config.hooks[event] ??= []);
    const owned = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (let i = 0; i < group.hooks.length; i++) {
        const hook = group.hooks[i];
        if (hook?.command !== command && hook?.command !== alias) continue;
        const pinned = group.hooks.slice(i + 1).some((h) => h?.command !== command && h?.command !== alias);
        owned.push({ hook, pinned });
      }
    }
    const keep = owned.find((h) => h.pinned) ?? owned.find((h) => h.hook.command === command) ?? owned[0];
    for (let i = groups.length - 1; i >= 0; i--) {
      const hooks = groups[i]?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (let j = hooks.length - 1; j >= 0; j--) {
        const item = owned.find((h) => h.hook === hooks[j]);
        if (!item) continue;
        if (item === keep) {
          if (hooks[j].command !== command) { hooks[j].command = command; changed++; }
        } else if (item.pinned) {
          console.error("punk-records: warning: duplicate hook shares a group with later foreign hooks; left alone to preserve hook approvals");
        } else {
          hooks.splice(j, 1);
          changed++;
        }
      }
    }
    if (!keep) {
      groups.push({ ...(event === "PostToolUse" ? { matcher: MATCHERS[agent] } : {}), hooks: [{ type: "command", command, timeout: 10 }] });
      changed++;
    }
  }
  return changed;
}

// Untouched files keep their bytes and formatting: write only on a real change.
function applyJson(t, value, { dryRun, touched }) {
  let changed = false;
  if (t.servers) {
    const entry = { type: "stdio", command: "node", args: [BIN, "mcp"] };
    if (value.mcpServers && Object.hasOwn(value.mcpServers, "punk-records") && !managedMcp(value.mcpServers["punk-records"])) {
      console.error(`punk-records: warning: ${t.path} has a foreign punk-records MCP entry; left alone`);
    } else {
      if (managedMcp(value.mcpServers?.previously)) {
        delete value.mcpServers.previously;
        changed = true;
      }
      if (JSON.stringify(value.mcpServers?.["punk-records"]) !== JSON.stringify(entry)) {
        value.mcpServers = { ...(value.mcpServers ?? {}), "punk-records": entry };
        changed = true;
      }
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
    fs.copyFileSync(real, `${file}.punk-records-bak`);
    fs.chmodSync(`${file}.punk-records-bak`, mode);
  }
  const tmp = `${real}.punk-records-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
}

// Points dest at our src; unrelated paths already at dest are left alone.
function linkInto(t, { dryRun, touched }) {
  const have = linkTarget(t.dest);
  if (have === t.src) return;
  if (have !== null && !legacyLink(have, t.src)) {
    console.error(`punk-records: warning: ${t.dest} exists and is not managed by Punk Records; left alone`);
    return;
  }
  if (!fs.existsSync(t.src)) {
    console.error(`punk-records: warning: ${t.src} missing; skipping ${t.dest}`);
    return;
  }
  touched.push(t.label);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(t.dest), { recursive: true });
    if (have !== null) fs.unlinkSync(t.dest);
    fs.symlinkSync(t.src, t.dest);
  }
}

// Hooks run the primary command; say so when the shell cannot find it.
function warnPath({ repo, global, want }) {
  if (!want("claude") && !want("codex")) return;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const bin = path.join(os.homedir(), ".local", "bin");
  if (global && !dirs.includes(path.resolve(bin))) {
    console.error(`punk-records: warning: ${bin} is not on PATH; Claude Code/Codex hooks run 'punk-records'`);
  } else if (repo && !dirs.some((d) => fs.existsSync(path.join(d, "punk-records")))) {
    console.error("punk-records: warning: 'punk-records' is not on PATH; run 'punk-records init --global' so Claude Code/Codex hooks can run it");
  }
}

// No TOML parser (zero deps): init owns only its marker block.
function planToml(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const count = (marker) => text.split(marker).length - 1;
  const blocks = [[TOML_START, TOML_END], [LEGACY_TOML_START, LEGACY_TOML_END]].map(([start, end]) => ({
    start, end, s: text.indexOf(start), e: text.indexOf(end),
  }));
  for (const block of blocks) {
    if (count(block.start) > 1 || count(block.end) > 1 || (block.s === -1) !== (block.e === -1) || (block.s !== -1 && block.e < block.s)) {
      throw new Error(`punk-records: ${file} has a broken '${block.start}' / '${block.end}' block; fix it, then re-run init`);
    }
  }
  const present = blocks.filter((block) => block.s !== -1);
  if (present.length > 1) throw new Error(`punk-records: ${file} has both legacy and current MCP blocks; remove one, then re-run init`);
  const block = present[0];
  const after = block ? block.e + block.end.length + (text[block.e + block.end.length] === "\n" ? 1 : 0) : 0;
  const outside = block ? text.slice(0, block.s) + text.slice(after) : text;
  if (FOREIGN_TABLE.test(outside)) return { foreign: true };
  const next = !block
    ? text + (text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n") + tomlBlock()
    : text.slice(0, block.s) + tomlBlock() + text.slice(after);
  return { foreign: false, changed: next !== text, next };
}

function applyToml(t, plan, { dryRun, touched }) {
  if (plan.foreign) {
    console.error(`punk-records: warning: ${t.path} already defines this MCP server outside the managed block; left alone`);
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
