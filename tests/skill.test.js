import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("previously skill teaches when to save and recall", () => {
  const p = path.join(root, ".opencode", "skills", "previously", "SKILL.md");
  assert.ok(fs.existsSync(p), "SKILL.md must exist");
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /^---\nname: previously\n/, "frontmatter name");
  assert.match(src, /description: .{20,}/, "frontmatter description drives triggering");
  for (const trigger of ["bug", "decision", "workaround", "preference"]) {
    assert.ok(src.toLowerCase().includes(trigger), `must mention save trigger: ${trigger}`);
  }
  assert.ok(src.includes("previously ask"), "must teach recall-first");
  assert.match(src, /blocked in auto mode/, "must teach recording tool blocks as facts");
  assert.ok(src.includes("previously save"), "must teach save mechanics");
  assert.ok(src.includes("--ref"), "must teach draft promotion");
  assert.ok(src.includes("--global"), "must teach scope choice");
  for (const unimplemented of ["mem pin", "mem useful", "mem useless", "memory_pin"]) {
    assert.ok(!src.includes(unimplemented), `must not document unimplemented: ${unimplemented}`);
  }
  // Check Drafts section mentions all three agents and uses slug format
  const draftSection = src.split("## Drafts")[1].split("\n## ")[0];
  assert.ok(draftSection.includes("OpenCode"), "Drafts section must mention OpenCode");
  assert.ok(draftSection.includes("Claude Code"), "Drafts section must mention Claude Code");
  assert.ok(draftSection.includes("Codex"), "Drafts section must mention Codex");
  assert.ok(draftSection.includes("--ref claude-code-session-"), "Drafts example must use slug ref format");
  assert.ok(!/--ref "[A-Z]/.test(src), "SKILL.md example must not quote the ref with capitals");

  const command = fs.readFileSync(path.join(root, ".opencode", "commands", "previously-save.md"), "utf8");
  assert.ok(command.includes("-session-<id>") && command.includes("--ref"), "previously-save must document slug ref format");
  assert.ok(!/--ref "[A-Z]/.test(command), "previously-save example must not quote ref with capital letter");
});
