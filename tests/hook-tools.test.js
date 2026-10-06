import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {writtenFiles, MATCHERS, CODEX_PATCH_TOOL} from '../lib/hook-tools.js';

test('Claude write tools name their file; other tools name none', () => {
  assert.deepEqual(writtenFiles('claude', 'Write', {file_path: '/r/a.js', content: 'x'}), ['/r/a.js']);
  assert.deepEqual(writtenFiles('claude', 'Edit', {file_path: 'b.js', old_string: 'a', new_string: 'b'}), ['b.js']);
  assert.deepEqual(writtenFiles('claude', 'MultiEdit', {file_path: 'c.js', edits: []}), ['c.js']);
  assert.deepEqual(writtenFiles('claude', 'NotebookEdit', {notebook_path: 'n.ipynb'}), ['n.ipynb']);
  assert.deepEqual(writtenFiles('claude', 'Bash', {command: 'echo hi > x'}), []);
  assert.deepEqual(writtenFiles('claude', 'Write', {}), []);
});

test('Codex patches list every added, updated, moved and deleted file', () => {
  const patch = ['*** Begin Patch', '*** Add File: src/new file.js', '+x', '*** Update File: README.md',
    '*** Move to: docs/README.md', '@@', '-a', '+b', '*** Delete File: old.js', '*** End Patch', ''].join('\n');
  const expected = ['src/new file.js', 'README.md', 'docs/README.md', 'old.js'];
  for (const input of [{input: patch}, {patch}, {command: patch}, {command: ['apply_patch', patch]}, {input: patch.replaceAll('\n', '\r\n')}]) {
    assert.deepEqual(writtenFiles('codex', CODEX_PATCH_TOOL, input), expected);
  }
  assert.deepEqual(writtenFiles('codex', CODEX_PATCH_TOOL, {input: 'no patch here'}), []);
});

test('unknown agents, inherited keys and odd inputs yield nothing', () => {
  for (const [agent, tool, input] of [['nope', 'Write', {file_path: 'a'}], ['claude', 'constructor', {}],
    ['claude', '__proto__', {}], ['claude', 'toString', {}], ['__proto__', 'Write', {file_path: 'a'}],
    ['claude', 'Write', null], ['codex', CODEX_PATCH_TOOL, 42], ['codex', CODEX_PATCH_TOOL, {command: [1, null]}]]) {
    assert.deepEqual(writtenFiles(agent, tool, input), [], `${agent}/${tool}`);
  }
});

test('matchers list exactly the extracting tools', () => {
  assert.deepEqual(MATCHERS.claude.split('|').sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  assert.deepEqual(MATCHERS.codex.split('|'), [CODEX_PATCH_TOOL]);
});

test('real captured payloads extract hello.txt', () => {
  for (const agent of ['claude', 'codex']) {
    const file = path.join(import.meta.dirname, 'fixtures', 'hooks', `${agent}-PostToolUse.json`);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = writtenFiles(agent, payload.tool_name, payload.tool_input);
    assert.ok(files.some(f => f.endsWith('hello.txt')), `${agent}: ${JSON.stringify(files)}`);
  }
});
