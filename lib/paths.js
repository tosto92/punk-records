import path from "node:path";
import fs from 'node:fs';
import os from "node:os";
import { execFileSync } from "node:child_process";

export function globalDir() {
  return process.env.PREVIOUSLY_HOME || path.join(os.homedir(), ".local", "share", "previously");
}

export function repoDir(repoRoot) {
  return path.join(repoRoot, "memory");
}

export function gitRoot(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// A folder holding this file is a project even without git (`previously init --local`).
export const MARKER = ".previously";

function markerRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, MARKER))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

// Nearest of git root and marker folder: the deeper path is the closer one.
function projectRoot(cwd) {
  const roots = [gitRoot(cwd), markerRoot(cwd)].filter(Boolean);
  return roots.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function resolveScopes({ explicit = null } = {}, cwd = process.cwd()) {
  const root = projectRoot(cwd);
  let writes;
  if (explicit === "global") writes = ["global"];
  else if (explicit === "local") writes = ["local"];
  else writes = root ? ["local"] : ["global"];
  return { writes, repoRoot: root, repoName: root ? path.basename(root) : "" };
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
