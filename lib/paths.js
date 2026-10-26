import path from "node:path";
import fs from 'node:fs';
import os from "node:os";
import { execFileSync } from "node:child_process";
import { setting } from "./env.js";

export function globalDir() {
  const configured = setting("HOME");
  if (configured) return configured;
  const base = path.join(os.homedir(), ".local", "share");
  const legacy = path.join(base, "previously");
  return fs.existsSync(legacy) ? legacy : path.join(base, "punk-records");
}

export function repoDir(repoRoot) {
  return path.join(memoryRoot(repoRoot), "memory");
}

function gitOutput(cwd, args) {
  return execFileSync("git", args, {cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8"}).trim();
}

export function gitRoot(cwd) {
  try { return gitOutput(cwd, ["rev-parse", "--show-toplevel"]) || null; }
  catch { return null; }
}

// Git lists the primary checkout first, regardless of branch or worktree location.
export function memoryRoot(projectRoot) {
  const root = path.resolve(projectRoot);
  const checkout = gitRoot(root);
  if (checkout !== root) {
    if (!checkout) {
      if (fs.existsSync(path.join(root, ".git"))) throw new Error(`punk-records: Git metadata unavailable at ${root}; repair it before using repository memory`);
      let bare = false;
      try { bare = gitOutput(root, ["rev-parse", "--is-bare-repository"]) === "true"; } catch { /* standalone non-Git projects have no metadata */ }
      if (bare) throw new Error(`punk-records: primary Git checkout unavailable for bare repository ${root}`);
    }
    return root;
  }
  try {
    const common = cwd => fs.realpathSync(gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const first = gitOutput(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")[0].split("\0");
    let primary = first[0]?.startsWith("worktree ") ? first[0].slice(9) : null;
    const commonDir = common(root);
    // Submodules and separate Git dirs record their checkout relative to the Git dir.
    try { primary = path.resolve(commonDir, gitOutput(root, [`--git-dir=${commonDir}`, "config", "--path", "--get", "core.worktree"])); }
    catch (err) { if (err.status !== 1) throw err; }
    if (!primary || first.includes("bare") || !fs.lstatSync(primary).isDirectory() ||
        gitRoot(primary) !== primary || common(primary) !== commonDir) throw new Error("unusable primary checkout");
    fs.accessSync(primary, fs.constants.R_OK | fs.constants.X_OK);
    return primary;
  } catch (cause) {
    throw new Error(`punk-records: primary Git checkout unavailable for ${root}; restore an accessible primary worktree before using repository memory`, {cause});
  }
}

// Old markers remain valid so existing non-git projects keep their scope.
export const MARKER = ".punk-records";
const LEGACY_MARKER = ".previously";

function markerRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, MARKER)) || fs.existsSync(path.join(dir, LEGACY_MARKER))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

// Nearest of git root and marker folder: the deeper path is the closer one.
function projectRoot(cwd, requireGit = true) {
  const git = gitRoot(cwd), marker = markerRoot(cwd);
  if (!git && requireGit) {
    for (let dir = path.resolve(cwd); dir !== marker; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) throw new Error(`punk-records: Git metadata unavailable at ${dir}; repair it before using repository memory`);
      if (path.dirname(dir) === dir) break;
    }
  }
  return [git, marker].filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? null;
}

export function resolveScopes({ explicit = null } = {}, cwd = process.cwd()) {
  const root = projectRoot(cwd, explicit !== "global");
  let repoName = root ? path.basename(root) : "";
  if (root) {
    try { repoName = path.basename(memoryRoot(root)); }
    catch (err) { if (explicit !== "global") throw err; }
  }
  let writes;
  if (explicit === "global") writes = ["global"];
  else if (explicit === "local") writes = ["local"];
  else writes = root ? ["local"] : ["global"];
  return { writes, repoRoot: root, repoName };
}

export function storePath(dir, relative) {
  const root = path.resolve(dir);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new TypeError('output escapes memory store');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep)]) {
    if (part) current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new TypeError(`refusing output symlink: ${current}`);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return target;
}

export function memoryPath(dir, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new TypeError('invalid memory slug');
  return storePath(dir, path.join('memory', `${slug}.md`));
}
