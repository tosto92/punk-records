import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MATCHERS} from '../lib/hook-tools.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const json = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];

test('plugin manifests agree with package.json and point at files that exist', () => {
  const pkg = json('package.json');
  const claude = json('.claude-plugin/plugin.json');
  const codex = json('.codex-plugin/plugin.json');
  for (const m of [claude, codex]) {
    assert.equal(m.name, 'punk-records');
    assert.equal(m.version, pkg.version);
    assert.equal(m.license, pkg.license);
  }
  for (const rel of [claude.hooks, codex.hooks, codex.skills, 'skills/punk-records/SKILL.md',
    'skills/punk-records-synthesize/SKILL.md', 'skills/brainbrain/SKILL.md', 'skills/brainbrain-synthesize/SKILL.md',
    'skills/punk-records-sessions/SKILL.md', 'commands/punk-records-save.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
  assert.deepEqual(claude.mcpServers['punk-records'].args, ['${CLAUDE_PLUGIN_ROOT}/bin/punk-records', 'mcp']);
  assert.equal(json('.claude-plugin/marketplace.json').plugins[0].name, claude.name);
  assert.equal(json('.agents/plugins/marketplace.json').plugins[0].name, codex.name);
  for (const dir of ['skills/', 'commands/', 'hooks/', '.claude-plugin/', '.codex-plugin/']) assert.ok(pkg.files.includes(dir), dir);
});

for (const agent of ['claude', 'codex']) {
  test(`${agent} plugin hooks cover every event with the right agent and matcher, and run`, t => {
    const {hooks} = json(`hooks/${agent}.json`);
    const events = agent === 'claude' ? ['SessionStart', ...EVENTS] : EVENTS;
    assert.deepEqual(Object.keys(hooks), events);
    if (agent === 'claude') {
      assert.equal(hooks.SessionStart[0].matcher, undefined);
      assert.equal(hooks.SessionStart[0].hooks[0].timeout, 10);
    }
    assert.equal(hooks.PostToolUse[0].matcher, MATCHERS[agent]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'punk-records-plugin-'));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    for (const event of events) {
      const [{command}] = hooks[event][0].hooks;
      assert.equal(command, `node "\${CLAUDE_PLUGIN_ROOT}/bin/punk-records" hook ${agent} ${event}`);
      const input = JSON.stringify({session_id: 's1', cwd: home, hook_event_name: event, source: 'startup', prompt: 'hello'});
      const res = spawnSync('sh', ['-c', command], {input, encoding: 'utf8',
        env: {...process.env, CLAUDE_PLUGIN_ROOT: ROOT, PUNK_RECORDS_HOME: path.join(home, 'store'), PUNK_RECORDS_AUTOSAVE: '0'}});
      assert.equal(res.status, 0, res.stderr);
      if (event === 'SessionStart') assert.equal(JSON.parse(res.stdout).hookSpecificOutput.hookEventName, event);
    }
  });
}
