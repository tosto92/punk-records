import test from "node:test";
import assert from "node:assert/strict";
import { summarizeActivity } from "../lib/activity.js";

test("empty edits produce no draft", () => {
  assert.equal(summarizeActivity([], { sessionId: "abc123", startedAt: "2026-10-02T10:00:00Z" }), null);
  assert.equal(summarizeActivity([], { sessionId: "abc123" }), null);
});

test("draft dedups, caps files, and carries prompt + auto tag", () => {
  const edits = ["a.ts", "b.ts", "a.ts", "c.ts"];
  const d = summarizeActivity(edits, {
    sessionId: "abcdef123456",
    startedAt: "2026-10-02T10:00:00Z",
    prompt: "fix the auth bug",
  });
  assert.equal(d.type, "note");
  assert.equal(d.outcome, "open");
  assert.deepEqual(d.tags, ["auto"]);
  assert.deepEqual(d.files, ["a.ts", "b.ts", "c.ts"]);
  assert.equal(d.title, 'OpenCode session abcdef123456');
  assert.match(d.symptoms, /fix the auth bug/);
});

test("files capped at 20, order preserved", () => {
  const edits = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
  const d = summarizeActivity(edits, { sessionId: "s1" });
  assert.equal(d.files.length, 20);
  assert.equal(d.files[0], "f0.ts");
  assert.equal(d.title, 'OpenCode session s1');
});

test("blank and non-string entries ignored", () => {
  const d = summarizeActivity(["a.ts", "", null, "  ", "b.ts"], { sessionId: "s1" });
  assert.deepEqual(d.files, ["a.ts", "b.ts"]);
});

test("agent names the draft title; OpenCode stays the default", () => {
  assert.equal(summarizeActivity(["a.js"], { sessionId: "s1", agent: "Claude Code" }).title, "Claude Code session s1");
  assert.equal(summarizeActivity(["a.js"], { sessionId: "s1", agent: "Codex" }).title, "Codex session s1");
  assert.equal(summarizeActivity(["a.js"], { sessionId: "s1" }).title, "OpenCode session s1");
});
