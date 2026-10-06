import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildScope } from "./build.js";
import {storePath} from './paths.js';

function compareFiles(root) {
  for (const rel of ['memory', 'index.json', 'INDEX.md']) storePath(root, rel);
  const files = ["index.json", "INDEX.md"];
  const memoryDir = path.join(root, "memory");
  if (fs.existsSync(memoryDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        storePath(root, path.relative(root, full));
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(path.relative(root, full));
      }
    };
    walk(memoryDir);
  }
  return files.sort();
}

function isDerived(rel) {
  return rel === "index.json" || rel === "INDEX.md" || rel.startsWith(`memory${path.sep}`);
}

function warnMissingCovers(mdFile, dir) {
  let content;
  try {
    content = fs.readFileSync(mdFile, "utf8");
  } catch {
    return;
  }
  const m = content.match(/^covers:\s*(.+)$/m);
  if (!m) return;
  const target = m[1].trim();
  if (!target || target === "-") return;
  const filePart = target.replace(/:\d+$/, "");
  const candidates = [path.resolve(process.cwd(), filePart)];
  if (path.basename(dir) === "memory") {
    candidates.push(path.resolve(path.dirname(dir), filePart));
  }
  if (!candidates.some((c) => fs.existsSync(c))) {
    console.error(`warn covers: ${target}`);
  }
}

export function checkScope(dir) {
  const events = path.join(dir, "events.jsonl");
  if (!fs.existsSync(events) && !compareFiles(dir).some((rel) => fs.existsSync(path.join(dir, rel)))) {
    return { stale: false, drift: [] };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "previously-check-"));
  try {
    if (fs.existsSync(events)) fs.copyFileSync(events, path.join(tmp, "events.jsonl"));
    buildScope(tmp);

    const actual = compareFiles(dir);
    const fresh = compareFiles(tmp).filter(isDerived);
    const drift = [];
    for (const rel of [...new Set([...actual, ...fresh])].sort()) {
      const a = path.join(dir, rel);
      const b = path.join(tmp, rel);
      const aExists = fs.existsSync(a);
      const bExists = fs.existsSync(b);
      if (aExists !== bExists) drift.push(rel);
      else if (aExists && !fs.readFileSync(a).equals(fs.readFileSync(b))) drift.push(rel);
    }

    for (const rel of fresh) {
      if (rel.startsWith(`memory${path.sep}`)) warnMissingCovers(path.join(tmp, rel), dir);
    }

    return { stale: drift.length > 0, drift };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
