import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScopes, globalDir, repoDir, storePath, MARKER } from "./paths.js";
import { registerProject } from "./projects.js";
import { MATCHERS } from "./hook-tools.js";
import { setting } from "./env.js";
import {checkLegacyEnvironment, legacyProjectRoot, planStoreMigration, migrateHookCommands, migrateManagedEnv, migrateTomlEnv} from "./legacy-migration.js";
import { WORKFLOW_GUIDANCE } from "./workflow.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "punk-records");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SRC = path.join(ROOT, ".opencode", "plugins", "punk-records.ts");

const MEM_START = "<!-- punk-records:start -->";
const MEM_END = "<!-- punk-records:end -->";
const LEGACY_MEM_START = "<!-- previously:start -->";
const LEGACY_MEM_END = "<!-- previously:end -->";

// Absolute node invocation: the hints must work even when the CLI is not on PATH.
const BLOCK =
  `${MEM_START}\n` +
  `## Punk Records\n\n` +
  `${WORKFLOW_GUIDANCE}\n\n` +
  `- Recall first: \`node ${BIN} ask "<question>"\` (or the \`memory_find\` MCP tool).\n` +
  `- Record what generalizes: \`node ${BIN} save --type solved --title "<t>" --solution "<s>"\`\n` +
  `  (or the \`memory_save\` MCP tool). Types: solved, attempt_failed, decision, note.\n` +
  `${MEM_END}\n`;

const GITATTR_LINE = "memory/events.jsonl merge=union";

// Every skill init links, by installed name.
const SKILLS = {
  "punk-records-synthesize": path.join(ROOT, "skills", "punk-records-synthesize"),
  brainbrain: path.join(ROOT, "skills", "brainbrain"),
  "brainbrain-synthesize": path.join(ROOT, "skills", "brainbrain-synthesize"),
  "punk-records": path.join(ROOT, "skills", "punk-records"),
  "punk-records-sessions": path.join(ROOT, "skills", "punk-records-sessions"),
  "punk-records-learn": path.join(ROOT, "skills", "punk-records-learn"),
};
const COMMANDS = ["punk-records-save.md", "learn.md"];
export const AGENT_NAMES = ["opencode", "claude", "codex"];
const HOOK_EVENTS = {claude: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"], codex: ["UserPromptSubmit", "PostToolUse", "Stop"]};
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

// Canonical command for all newly generated hooks.
export const hookCommand = (agent, event) => `punk-records hook ${agent} ${event}`;

export function initRepo({ cwd = process.cwd(), dryRun = false, explicit = null, opencodeApi = "v1", agents = AGENT_NAMES } = {}) {
  if (opencodeApi !== "v1" && opencodeApi !== "v2") throw new Error(`punk-records: unknown --opencode-api ${opencodeApi}`);
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => !AGENT_NAMES.includes(a))) {
    throw new Error(`punk-records: --agents takes a comma list of ${AGENT_NAMES.join(", ")}`);
  }
  checkLegacyEnvironment();
  const want = (a) => agents.includes(a);
  const touched = [];
  const write = (rel, content) => {
    touched.push(rel);
    if (!dryRun) writeAtomic(path.join(cwd, rel), content, {backup: true});
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
  let legacyRoot = explicit !== "global" ? legacyProjectRoot(cwd) : null;
  let resolved = resolveScopes({ explicit }, cwd);
  if (legacyRoot && (!resolved.repoRoot || path.relative(resolved.repoRoot, legacyRoot).split(path.sep)[0] !== "..")) {
    cwd = legacyRoot;
    resolved = {...resolved, repoRoot: legacyRoot, repoName: path.basename(legacyRoot)};
  } else legacyRoot = null;
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
  const storeMoves = planStoreMigration({global: writes.includes("global"), repoRoot: writes.includes("local") ? resolved.repoRoot : null});
  const storeMove = storeMoves.find(([from]) => from === path.join(os.homedir(), ".local", "share", "previously"));
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
  const tomlPlans = new Map(targets.toml.map((t) => [t.path, planToml(t.path, storeMove)]));
  let claudeGlobal;
  if (repoScope && want("claude")) {
    const file = path.resolve(claudeDir(), "settings.json");
    try { claudeGlobal = { file, config: readAgentJson({ path: file, hooks: "claude" }) }; }
    catch {
      console.error(`punk-records: warning: ${file}: ${HOOK_EVENTS.claude.join(", ")}: cannot inspect read-only global Claude settings; assuming no hook coverage`);
    }
  }

  for (const [from, to] of storeMoves) {
    touched.push(to);
    if (!dryRun) {fs.mkdirSync(path.dirname(to), {recursive: true}); fs.renameSync(from, to);}
  }
  if (legacyRoot && repoScope) {
    if (!fs.existsSync(path.join(cwd, MARKER))) write(MARKER, "");
    touched.push(".previously");
    if (!dryRun) fs.unlinkSync(path.join(cwd, ".previously"));
  }
  if (markProject) write(MARKER, "");
  for (const w of writes) {
    const dir = w === "global" ? globalDir() : repoDir(resolved.repoRoot);
    const ev = storePath(dir, "events.jsonl");
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
      mergeMcp(path.join(cwd, "opencode.json"), { cwd, dryRun, touched, opencodeApi, storeMove, config: parsed.get(path.join(cwd, "opencode.json")) });
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
    mergeMcp(globalOc, { cwd, dryRun, touched, absolute: true, opencodeApi, storeMove, config: parsed.get(globalOc) });
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
    applyJson(t, jsonValues.get(t.path), { dryRun, touched, claudeGlobal, storeMove });
    if (t.hooks === "codex" && touched.length > before) codexHooksAdded = true;
  }
  // Codex skips hooks the user has not approved yet; init never writes that trust itself.
  if (codexHooksAdded && !dryRun) console.error("punk-records: note: Codex runs new hooks only after you approve them: start codex and use /hooks");
  for (const t of targets.toml) applyToml(t, tomlPlans.get(t.path), { dryRun, touched });
  for (const t of targets.links) linkInto(t, { dryRun, touched });
  removeLegacyLinks({cwd, want, repo: repoScope, global: explicit === "global", pluginBase}, {dryRun, touched});
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
  for (const entries of [oc.mcp, oc.mcp?.servers]) managedEntries(entries);
  return oc;
}

// Links the plugin's real file; replaces only links from the old package.
function installPlugin(base, { cwd, dryRun, touched, absolute = false }) {
  const dest = path.join(base, "punk-records.ts");
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
  const relatives = [path.relative(ROOT, src), ...(src === BIN ? [path.join("bin", "previously")] : [])];
  return typeof have === "string" && path.isAbsolute(have) &&
    relatives.some(rel => have.endsWith(`${path.sep}previously-on-localhost${path.sep}${rel}`));
}

// Remove only symlinks to this checkout or the known historical package layout.
function removeLegacyLinks({cwd, want, repo, global, pluginBase}, {dryRun, touched}) {
  const candidates = [];
  const addBase = (base, kind, names) => {
    for (const name of names) candidates.push({dest: path.join(base, name), rel: path.join(kind, name)});
  };
  const skills = ['previously', 'previously-episodes', 'punk-records-episodes'];
  if (repo && want('claude')) {
    addBase(path.join(cwd, '.claude/skills'), 'skills', skills);
    addBase(path.join(cwd, '.claude/commands'), 'commands', ['previously-save.md']);
  }
  if (repo && want('codex')) addBase(path.join(cwd, '.agents/skills'), 'skills', skills);
  if (global && want('claude')) {
    addBase(path.join(claudeDir(), 'skills'), 'skills', skills);
    addBase(path.join(claudeDir(), 'commands'), 'commands', ['previously-save.md']);
  }
  if (global && want('codex')) addBase(path.join(codexDir(), 'skills'), 'skills', skills);
  if (global && want('opencode')) addBase(setting('SKILLS') || path.join(os.homedir(), '.config/opencode/skills'), 'skills', skills);
  if (repo && want('opencode')) addBase(path.join(cwd, '.opencode/plugins'), '.opencode/plugins', ['previously.ts']);
  if (global && want('opencode')) addBase(pluginBase, '.opencode/plugins', ['previously.ts']);
  for (const {dest, rel} of candidates) {
    const have = linkTarget(dest);
    const owned = typeof have === 'string' && path.isAbsolute(have) && (have === path.join(ROOT, rel) || have.endsWith(`${path.sep}previously-on-localhost${path.sep}${rel}`));
    if (have === null) continue;
    if (!owned) { console.error(`punk-records: warning: legacy path ${dest} is not a verified managed link; left alone`); continue; }
    touched.push(global ? dest : path.relative(cwd, dest));
    if (!dryRun) fs.unlinkSync(dest);
  }
  if (global && fs.lstatSync(path.join(os.homedir(), '.local/bin/previously'), {throwIfNoEntry: false})) {
    console.error('punk-records: warning: existing ~/.local/bin/previously left alone: other repositories may still use it; run punk-records init --local in each project and remove the legacy executable link manually');
  }
}

function managedMcp(entry) {
  const command = Array.isArray(entry?.command) ? entry.command : [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])];
  return command.length === 3 && command[0] === "node" && command[2] === "mcp" &&
    typeof command[1] === "string" && path.isAbsolute(command[1]) &&
    ["previously", "punk-records"].includes(path.basename(command[1])) &&
    path.basename(path.dirname(command[1])) === "bin" &&
    (path.dirname(command[1]) === path.dirname(BIN) || path.basename(path.dirname(path.dirname(command[1]))) === "previously-on-localhost");
}

function managedEntries(entries, storeMove) {
  const old = managedMcp(entries?.previously) ? migrateManagedEnv(entries.previously, storeMove) : null;
  const current = managedMcp(entries?.['punk-records']) ? migrateManagedEnv(entries['punk-records'], storeMove) : null;
  if (!old || !current) return current ?? old ?? {};
  for (const key of Object.keys(old)) {
    if (['type', 'command', 'args', 'enabled', 'disabled', 'env'].includes(key)) continue;
    if (Object.hasOwn(current, key) && JSON.stringify(old[key]) !== JSON.stringify(current[key])) throw new Error(`punk-records: conflicting managed MCP option ${key}; reconcile aliases before init`);
  }
  for (const key of Object.keys(old.env ?? {})) if (Object.hasOwn(current.env ?? {}, key) && old.env[key] !== current.env[key]) {
    throw new Error(`punk-records: conflicting managed environment values for ${key}; reconcile MCP aliases before init`);
  }
  return {...old, ...current, ...(old.env || current.env ? {env: {...old.env, ...current.env}} : {})};
}

function mergeMcp(ocPath, { cwd, dryRun, touched, absolute = false, opencodeApi = "v1", config = null, storeMove }) {
  const label = absolute ? ocPath : path.relative(cwd, ocPath);
  const oc = config ?? readConfig(ocPath, opencodeApi);
  if (typeof oc.mcp !== "object" || oc.mcp === null || Array.isArray(oc.mcp)) oc.mcp = {};
  const entries = opencodeApi === "v2" ? oc.mcp.servers : oc.mcp;
  const prior = managedEntries(entries, storeMove);
  const entry = { ...migrateManagedEnv(prior), type: "local", command: ["node", BIN, "mcp"] };
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
      writeAtomic(ocPath, next, {backup: true});
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
    for (const name of ['punk-records-synthesize', 'brainbrain', 'brainbrain-synthesize']) t.links.push({ dest: path.join(os.homedir(), '.local', 'bin', name), src: path.join(ROOT, 'bin', name) });
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
    return config.includes(hookCommand("codex", "Stop")) || config.includes("previously hook codex Stop");
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
    for (const e of HOOK_EVENTS[t.hooks]) {
      if (value.hooks?.[e] !== undefined && !Array.isArray(value.hooks[e])) {
        throw new Error(`punk-records: ${t.path}: "hooks.${e}" must be an array; fix it, then re-run init`);
      }
    }
  }
  managedEntries(value.mcpServers);
  return value;
}

// Recognizes literal supported commands only; user shell wrappers are never evaluated.
function hookCoverage(config, event, agent = "claude") {
  const recognized = [];
  let covers = false, ambiguous = config.disableAllHooks === true;
  const command = hookCommand(agent, event), alias = `previously hook ${agent} ${event}`;
  const commands = [command, alias, `env PUNK_RECORDS_SYNTHESIS=1 ${command}`, `env PUNK_RECORDS_SYNTHESIS=1 ${alias}`];
  for (const [groupIndex, group] of (config.hooks?.[event] ?? []).entries()) {
    if (!Array.isArray(group?.hooks)) { ambiguous = true; continue; }
    for (const [hookIndex, hook] of group.hooks.entries()) {
      if (typeof hook?.command !== "string") continue;
      const owned = hook.type === "command" && commands.includes(hook.command);
      if (!owned) {
        if (new RegExp(`\\b(?:previously|punk-records)\\b.*\\bhook\\s+${agent}\\b`, "s").test(hook.command)) ambiguous = true;
        continue;
      }
      const matcher = group.matcher;
      const eligible = (matcher === undefined || matcher === "" || matcher === "*" || (event === "PostToolUse" && matcher === MATCHERS[agent])) &&
        hook.async !== true && !Object.hasOwn(hook, "if") && !Object.hasOwn(group, "if") &&
        (hook.timeout === undefined || (Number.isFinite(hook.timeout) && hook.timeout > 0));
      const safe = eligible && Object.keys(group).every(key => key === "matcher" || key === "hooks") &&
        Object.keys(hook).every(key => ["type", "command", "timeout"].includes(key));
      recognized.push({groupIndex, hookIndex, command: hook.command, safe, hook, synthesis: hook.command.startsWith("env ")});
      if (!safe) ambiguous = true;
      if (eligible && config.disableAllHooks !== true) covers = true;
    }
  }
  return {recognized, covers, ambiguous};
}

// Appends our group last: foreign hooks keep their indices (Codex keys hook
// trust by file:event:group:hook index).
function addHooks(config, agent, {file, global} = {}) {
  let changed = 0;
  if (agent === "claude") {
    let pluginOverlap = false;
    for (const input of [{file, config}, ...(global ? [global] : [])]) {
      if (isObject(input.config.enabledPlugins) && Object.entries(input.config.enabledPlugins).some(([name, enabled]) =>
        enabled === true && /^(punk-records|previously)(@|$)/.test(name))) {
        pluginOverlap = true;
        console.error(`punk-records: warning: ${input.file}: visible plugin configuration may overlap standalone Claude hooks; plugin discovery is not exhaustive`);
      }
    }
    for (const event of HOOK_EVENTS.claude) {
      let local = hookCoverage(config, event);
      const upstream = global ? hookCoverage(global.config, event) : null;
      if (!local.ambiguous && local.recognized.length && upstream?.covers && !upstream.ambiguous && !pluginOverlap && config.disableAllHooks !== true &&
        fs.realpathSync(file) !== fs.realpathSync(global.file)) {
        for (const hook of [...local.recognized].reverse()) {
          const hooks = config.hooks[event][hook.groupIndex].hooks;
          // Keep retained handler and group indices stable, including empty groups.
          if (!hook.safe || ![undefined, 10].includes(hook.hook.timeout) || hook.hookIndex !== hooks.length - 1 ||
            !upstream.recognized.some(other => other.safe && (!hook.synthesis || other.synthesis))) continue;
          hooks.splice(hook.hookIndex, 1);
          changed++;
        }
        local = hookCoverage(config, event);
      }
      for (const [input, coverage] of [[{file, config}, local], ...(global ? [[global, upstream]] : [])]) {
        if (coverage.ambiguous) console.error(`punk-records: warning: ${input.file}: ${event}: ambiguous Claude hook coverage; ambiguous entries left alone${input.config.disableAllHooks === true ? "; disableAllHooks is true: adding local handlers does not override host disablement or prove execution" : ""}`);
        if (coverage.recognized.length > 1) console.error(`punk-records: warning: ${input.file}: ${event}: duplicate Claude handlers preserved`);
      }
      if (local.ambiguous || upstream?.ambiguous) continue;
      if (local.recognized.length && upstream?.recognized.length) {
        console.error(`punk-records: warning: ${file} and ${global.file}: ${event}: duplicate Claude handlers across settings files preserved`);
      }
      if (local.covers || upstream?.covers) continue;
      config.hooks ??= {};
      (config.hooks[event] ??= []).push({ ...(event === "PostToolUse" ? {matcher: MATCHERS.claude} : {}), hooks: [{type: "command", command: hookCommand(agent, event), timeout: 10}] });
      changed++;
    }
    return changed;
  }
  config.hooks ??= {};
  for (const event of HOOK_EVENTS[agent]) {
    const command = hookCommand(agent, event);
    const groups = (config.hooks[event] ??= []);
    const coverage = hookCoverage(config, event, agent);
    if (coverage.ambiguous) {
      console.error(`punk-records: warning: ${file}: ${event}: ambiguous Codex hook coverage; ambiguous entries left alone`);
      continue;
    }
    const owned = coverage.recognized.map(item => ({...item,
      pinned: !item.safe || ![undefined, 10].includes(item.hook.timeout) ||
        groups[item.groupIndex].hooks.slice(item.hookIndex + 1).some(hook => {
          const other = coverage.recognized.find(other => other.hook === hook);
          return !other || ![undefined, 10].includes(hook.timeout) || other.synthesis !== item.synthesis;
        })}));
    const keep = owned.find((h) => h.pinned) ?? owned.find((h) => h.hook.command === command) ?? owned[0];
    for (let i = groups.length - 1; i >= 0; i--) {
      const hooks = groups[i]?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (let j = hooks.length - 1; j >= 0; j--) {
        const item = owned.find((h) => h.hook === hooks[j]);
        if (!item) continue;
        if (item === keep) {
          if (!item.synthesis && [undefined, 10].includes(item.hook.timeout) && hooks[j].command !== command) {
            hooks[j].command = command; changed++;
          }
          continue;
        }
        if (item.pinned || item.synthesis !== keep.synthesis) {
          console.error(`punk-records: warning: ${file}: ${event}: duplicate Codex hook preserved to retain custom settings, synthesis and hook approvals`);
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
function applyJson(t, value, { dryRun, touched, claudeGlobal, storeMove }) {
  let changed = t.hooks ? migrateHookCommands(value, t.hooks) : false;
  if (t.servers) {
    const prior = managedEntries(value.mcpServers, storeMove);
    const entry = { ...migrateManagedEnv(prior), type: "stdio", command: "node", args: [BIN, "mcp"] };
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
  if (t.hooks && addHooks(value, t.hooks, {file: path.resolve(t.path), global: t.hooks === "claude" ? claudeGlobal : undefined}) > 0) changed = true;
  if (!changed) return;
  touched.push(t.label);
  if (!dryRun) writeAtomic(t.path, JSON.stringify(value, null, 2) + "\n", { backup: true });
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
function planToml(file, storeMove) {
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
  let replacement = tomlBlock();
  if (block) {
    const body = text.slice(block.s + block.start.length, block.e);
    let owner, section, valid = !/"""|'''/.test(body);
    const tables = new Set(), invocation = new Set();
    const lines = body.split('\n').map(line => {
      if (/^\s*(?:#.*)?$/.test(line)) return line;
      if (line.trim().startsWith('[')) {
        const header = line.match(/^(\s*\[mcp_servers\.)(punk-records|previously)((?:\.env|\.tools(?:\.[A-Za-z0-9_-]+)*)?)(\]\s*(?:#.*)?)$/);
        if (!header || (!owner && header[3]) || (owner && owner !== header[2]) || tables.has(header[3])) {valid = false; return line;}
        owner ??= header[2]; section = header[3]; tables.add(section);
        return header[1] + 'punk-records' + section + header[4];
      }
      if (!owner) {valid = false; return line;}
      if (section !== '') return line;
      const envRoot = line.match(/^\s*(env|"(?:\\.|[^"\\])*"|'[^']*')\s*[.=]/);
      if (envRoot) {
        let key;
        try {key = envRoot[1] === 'env' ? 'env' : envRoot[1].startsWith('"') ? JSON.parse(envRoot[1]) : envRoot[1].slice(1, -1);}
        catch {valid = false; return line;}
        if (key === 'env' && !/^\s*env\s*=\s*\{.*\}\s*(?:#.*)?$/.test(line)) {valid = false; return line;}
      }
      const field = line.match(/^(\s*)(command|args)(\s*=\s*)(.*)$/);
      if (!field) return line;
      if (invocation.has(field[2])) {valid = false; return line;}
      invocation.add(field[2]);
      if (field[2] === 'command') {
        if (!/^(?:"node"|'node')\s*(?:#.*)?$/.test(field[4])) valid = false;
        return line;
      }
      const value = field[4].match(/^(\[[^\n]*\])(\s*(?:#.*)?)$/);
      let args;
      try {args = value && JSON.parse(value[1]);} catch {}
      if (!Array.isArray(args) || args.length !== 2 || args[1] !== 'mcp' || typeof args[0] !== 'string' || !/[/\\]bin[/\\](punk-records|previously)$/.test(args[0])) {valid = false; return line;}
      return field[1] + field[2] + field[3] + `[${JSON.stringify(BIN)}, "mcp"]` + value[2];
    });
    // Only owned tables and literal invocations are rewritten; custom syntax stays manual.
    if (!valid || invocation.size !== 2) {
      if (storeMove) throw new Error(`punk-records: ${file} has a custom managed MCP block; migrate its environment manually before moving the default store, then re-run init`);
      console.error(`punk-records: warning: ${file} has a custom managed MCP block; left alone`);
      return {foreign: false, changed: false, next: text};
    }
    replacement = TOML_START + migrateTomlEnv(lines.join('\n'), file, storeMove) + TOML_END + '\n';
  }
  const next = !block
    ? text + (text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n") + replacement
    : text.slice(0, block.s) + replacement + text.slice(after);
  return { foreign: false, changed: next !== text, next };
}

function applyToml(t, plan, { dryRun, touched }) {
  if (plan.foreign) {
    console.error(`punk-records: warning: ${t.path} already defines this MCP server outside the managed block; left alone`);
    return;
  }
  if (!plan.changed) return;
  touched.push(t.label);
  if (!dryRun) writeAtomic(t.path, plan.next, {backup: true});
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
