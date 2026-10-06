import { createHash } from "node:crypto";

export function slugify(title, taken = new Set()) {
  let base = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  if (!base) {
    base = "mem-" + createHash("sha1").update(String(title ?? "")).digest("hex").slice(0, 6);
  }
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `-${n}`;
    const trimmed = base.slice(0, 60 - suffix.length).replace(/-+$/g, "");
    candidate = `${trimmed}${suffix}`;
  }
  return candidate;
}
