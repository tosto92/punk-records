import { createHash } from "node:crypto";

export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");
}

export function fingerprint({ repo, title, symptoms } = {}) {
  const joined = `${normalizeText(repo)}\n${normalizeText(title)}\n${normalizeText(symptoms)}`;
  return createHash("sha1").update(joined).digest("hex");
}
