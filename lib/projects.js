// Registry of project roots holding a local memory store, so the all-projects
// graph can find them. Append-only lines (concurrent hooks cannot clobber each
// other); duplicates, junk and vanished projects are dropped on read.
import fs from "node:fs";
import path from "node:path";
import { globalDir, memoryRoot, repoDir, storePath } from "./paths.js";

const FILE = "projects.txt";

export function listProjects() {
  let text;
  try {
    text = fs.readFileSync(path.join(globalDir(), FILE), "utf8");
  } catch {
    return [];
  }
  const roots = new Set();
  for (const line of text.split("\n")) {
    const root = line.trim();
    if (!path.isAbsolute(root) || !fs.existsSync(root)) continue;
    try {
      const canonical = memoryRoot(root);
      if (fs.existsSync(path.join(repoDir(canonical), "events.jsonl"))) roots.add(canonical);
    } catch { /* stale or unusable Git metadata must not hide other projects */ }
  }
  return [...roots];
}

// A convenience index: never fails the save that triggers it.
export function registerProject(root) {
  try {
    root = memoryRoot(root);
    if (listProjects().includes(root)) return;
    fs.mkdirSync(globalDir(), { recursive: true });
    fs.appendFileSync(storePath(globalDir(), FILE), root + "\n");
  } catch {
    /* unreadable or unwritable registry: the project just stays out of the view */
  }
}
