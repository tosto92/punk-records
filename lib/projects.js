// Registry of project roots holding a local memory store, so the all-projects
// graph can find them. Append-only lines (concurrent hooks cannot clobber each
// other); duplicates, junk and vanished projects are dropped on read.
import fs from "node:fs";
import path from "node:path";
import { globalDir, repoDir, storePath } from "./paths.js";

const FILE = "projects.txt";

export function listProjects() {
  let text;
  try {
    text = fs.readFileSync(path.join(globalDir(), FILE), "utf8");
  } catch {
    return [];
  }
  return [...new Set(text.split("\n").map((l) => l.trim()).filter((l) => path.isAbsolute(l)))]
    .filter((root) => fs.existsSync(path.join(repoDir(root), "events.jsonl")));
}

// A convenience index: never fails the save that triggers it.
export function registerProject(root) {
  try {
    if (listProjects().includes(root)) return;
    fs.mkdirSync(globalDir(), { recursive: true });
    fs.appendFileSync(storePath(globalDir(), FILE), root + "\n");
  } catch {
    /* unreadable or unwritable registry: the project just stays out of the view */
  }
}
