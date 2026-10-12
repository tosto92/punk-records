import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {initRepo, CODEX_PROJECT_HOOKS} from '../lib/init.js';
import {RECALL_OUTPUT} from '../lib/hook.js';
import {saveMemory} from '../lib/save.js';
import {loadMemories} from '../lib/build.js';

// Opt-in: real CLIs with real credentials copied into throwaway config dirs.
//   CLAUDE_BIN=$(which claude) CODEX_BIN=$(which codex) node --test tests/agent-smoke.test.js
// Codex skips untrusted new hooks, so exec runs with --dangerously-bypass-hook-trust
// (confined to the throwaway CODEX_HOME; docs/claude-codex-compatibility.md F5).
const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'punk-records');
const PROMPT = 'If your context contains Punk Records, state the deploy codeword they mention. '
  + 'Then create a file named hello.txt containing the word hi using your file editing tool. Do nothing else.';

async function run(binary, args, {cwd, env}, timeout = 300000) {
  const child = spawn(binary, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {output += data;});
  const deadline = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {}}, timeout);
  try {
    const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
    assert.equal(code, 0, output.slice(-6000));
    return output;
  } finally {clearTimeout(deadline);}
}

// Temp git repo, `previously` on PATH via a temp bin dir, isolated global store and HOME.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-agent-smoke-'));
  const cwd = path.join(root, 'repo'), bin = path.join(root, 'bin');
  fs.mkdirSync(cwd); fs.mkdirSync(bin);
  fs.symlinkSync(BIN, path.join(bin, 'previously'));
  execFileSync('git', ['init', '-q'], {cwd});
  saveMemory({type: 'solved', title: 'Zebra quartz deploy codeword', symptoms: 'deploy codeword zebra quartz',
    solution: 'The deploy codeword is PLATYPUS-42'}, {cwd});
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PREVIOUSLY_HOME: path.join(root, 'store')};
  delete env.PREVIOUSLY_AUTOSAVE;
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, cwd, env};
}

// initRepo reads HOME / CODEX_HOME / PREVIOUSLY_HOME from process.env.
function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

function draftsOf(cwd) {
  return loadMemories(path.join(cwd, 'memory')).memories.filter(m => m.tags.includes('auto'));
}

// The model may not echo injected context, so recall is proven from the session transcripts.
function transcriptsContain(dir, needle) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, {recursive: true}).some(f => f.endsWith('.jsonl')
    && fs.readFileSync(path.join(dir, f), 'utf8').includes(needle));
}

test('Claude Code: repo hooks recall the seeded memory and save a draft for hello.txt',
  {skip: !process.env.CLAUDE_BIN && 'CLAUDE_BIN not set', timeout: 600000}, async t => {
    const {root, cwd, env} = project(t);
    env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
    fs.copyFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'));
    withEnv({HOME: path.join(root, 'home'), PATH: env.PATH, PREVIOUSLY_HOME: env.PREVIOUSLY_HOME}, () => initRepo({cwd, explicit: 'local', agents: ['claude']}));
    const out = await run(process.env.CLAUDE_BIN, ['-p', PROMPT, '--permission-mode', 'acceptEdits', '--strict-mcp-config'], {cwd, env});
    t.diagnostic(out.slice(-400));
    assert.ok(transcriptsContain(path.join(env.CLAUDE_CONFIG_DIR, 'projects'), 'PLATYPUS-42'), 'recalled memory must reach the transcript');
    const drafts = draftsOf(cwd);
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].title, /^Claude Code session /);
    assert.ok(drafts[0].files.includes('hello.txt'), JSON.stringify(drafts[0].files));
  });

test('Codex: hooks recall the seeded memory and save a draft for hello.txt',
  {skip: !process.env.CODEX_BIN && 'CODEX_BIN not set', timeout: 600000}, async t => {
    const {root, cwd, env} = project(t);
    env.CODEX_HOME = path.join(root, 'codex-home');
    fs.mkdirSync(env.CODEX_HOME);
    fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(env.CODEX_HOME, 'auth.json'));
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
    withEnv({HOME: path.join(root, 'home'), PATH: env.PATH, CODEX_HOME: env.CODEX_HOME, PREVIOUSLY_HOME: env.PREVIOUSLY_HOME},
      () => initRepo({cwd, explicit: CODEX_PROJECT_HOOKS ? 'local' : 'global', agents: ['codex']}));
    const out = await run(process.env.CODEX_BIN, ['exec', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', PROMPT], {cwd, env});
    t.diagnostic(out.slice(-400));
    if (RECALL_OUTPUT.codex) assert.ok(transcriptsContain(path.join(env.CODEX_HOME, 'sessions'), 'PLATYPUS-42'), 'recalled memory must reach the transcript');
    const drafts = draftsOf(cwd);
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].title, /^Codex session /);
    assert.ok(drafts[0].files.includes('hello.txt'), JSON.stringify(drafts[0].files));
  });
