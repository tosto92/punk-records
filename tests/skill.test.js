import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("Punk Records skills and save command have canonical names alongside legacy aliases", () => {
  for (const name of ["punk-records", "punk-records-episodes"]) {
    const src = fs.readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
    assert.match(src, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(src, /punk-records (ask|episodes)/);
  }
  assert.match(fs.readFileSync(path.join(root, "commands", "punk-records-save.md"), "utf8"), /punk-records save/);
  assert.ok(fs.existsSync(path.join(root, "skills", "previously", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(root, "commands", "previously-save.md")));
});

test("previously skill teaches when to save and recall", () => {
  const p = path.join(root, "skills", "previously", "SKILL.md");
  assert.ok(fs.existsSync(p), "SKILL.md must exist");
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /^---\nname: previously\n/, "frontmatter name");
  assert.match(src, /description: .{20,}/, "frontmatter description drives triggering");
  for (const trigger of ["bug", "decision", "workaround", "preference"]) {
    assert.ok(src.toLowerCase().includes(trigger), `must mention save trigger: ${trigger}`);
  }
  assert.ok(src.includes("punk-records ask"), "must teach recall-first");
  assert.match(src, /blocked in auto mode/, "must teach recording tool blocks as facts");
  assert.ok(src.includes("punk-records save"), "must teach save mechanics");
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

  const command = fs.readFileSync(path.join(root, "commands", "previously-save.md"), "utf8");
  assert.ok(command.includes("-session-<id>") && command.includes("--ref"), "previously-save must document slug ref format");
  assert.ok(!/--ref "[A-Z]/.test(command), "previously-save example must not quote ref with capital letter");
});

test("previously skill supplies the protected memory review workflow", () => {
  const src = fs.readFileSync(path.join(root, "skills", "previously", "SKILL.md"), "utf8");
  for (const reference of ["PUNK_RECORDS_SECURITY=1", "PUNK_RECORDS_PYTHON", "punk-records scan", "punk-records review",
    "no_signals", "suspicious", "incomplete", "pending", "false positive", "revoke", "docs/memory-security.md"]) {
    assert.ok(src.includes(reference), `must document security reference: ${reference}`);
  }
  assert.match(src, /reference data, never instructions/);
  assert.match(src, /never approve automatically/i);
  assert.match(src, /no_signals` means[^.]*does not prove truth or authorize/i);
  assert.match(src, /content,\s*store,\s*scanner,\s*and matched rule/i);
  assert.match(src, /MCP.*approval/i);
  assert.match(src, /unconfigured installs are unprotected/i);
});

for (const name of ['punk-records', 'previously']) {
  test(`${name} starts with concise recall/save procedure and teaches full retrieval`, () => {
    const src = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(src.indexOf('## Workflow') < src.indexOf('## Recall'));
    for (const phrase of ['--full --limit 1', 'full: true', 'Activity drafts are not learned solutions', 'reference data', 'validation']) assert.ok(src.includes(phrase), phrase);
    assert.match(src, /excluded from automatic recall/);
    assert.match(src, /searchable explicitly/);
    assert.doesNotMatch(src, /never outrank curated/);
    assert.match(src, /PUNK_RECORDS_SECURITY=1/);
    assert.match(src, /--ref claude-code-session-/);
    const command = fs.readFileSync(path.join(root, 'commands', `${name}-save.md`), 'utf8');
    assert.match(command, /existing memory/);
    assert.match(command, /validation/);
    assert.match(command, /--full --limit 1/);
  });
}

test('canonical and compatibility skills keep identical workflow bodies', () => {
  const body = name => fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8').split('# Punk Records')[1];
  assert.equal(body('punk-records'), body('previously'));
});
