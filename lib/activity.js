// Session activity digest: turns raw file-edited lists into a draft memory.
// Pure, zero-deps, deterministic given inputs. The plugin calls this on
// session idle and persists the result through the shared save (never writes itself).

const MAX_FILES = 20;

export function summarizeActivity(edits, { sessionId = "unknown", startedAt = null, prompt = "", agent = "OpenCode" } = {}) {
  const files = [];
  const seen = new Set();
  for (const e of Array.isArray(edits) ? edits : []) {
    if (typeof e !== "string") continue;
    const f = e.trim();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (files.length < MAX_FILES) files.push(f);
  }
  const total = seen.size;
  if (total === 0) return null;
  return {
    type: "note",
    title: `${agent} session ${sessionId}`,
    symptoms: prompt ? String(prompt).trim().slice(0, 500) : "",
    files,
    tags: ["auto"],
    outcome: "open",
  };
}
