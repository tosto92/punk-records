import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {appendEvent, normalizeEvent} from '../lib/events.js';
import {loadMemories} from '../lib/build.js';
import {initRepo} from '../lib/init.js';

// Explicit opt-in: runtime binaries are external prerequisites, never downloaded
// by the ordinary unit suite. No real provider credentials or services are used.
const matrix = [
  ['V1 minimum', 'OPENCODE_V1_MIN_BIN', 'v1', 'local'],
  ['V1 latest', 'OPENCODE_V1_BIN', 'v1', 'global'],
  ['V2 minimum', 'OPENCODE_V2_MIN_BIN', 'v2', 'local'],
  ['V2 installed', 'OPENCODE_V2_BIN', 'v2', 'global'],
];

async function run(binary, args, {cwd, env}, timeout = 180000) {
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

for (const [label, variable, api, installation] of matrix) {
  test(`${label}: ${installation} plugin recalls and captures a real write`, {skip: !process.env[variable], timeout: 600000}, async t => {
    const binary = path.resolve(process.env[variable]);
    const version = execFileSync(binary, ['--version'], {encoding: 'utf8'}).trim();
    assert.match(version, api === 'v1' ? /1\.\d+\.\d+/ : /2\.\d+\.\d+/);
    t.diagnostic(`${version}; isolated ${installation} installation`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-runtime-smoke-'));
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|PREVIOUSLY_|XDG_|OPENAI_|ANTHROPIC_)/.test(key)));
    Object.assign(env, {HOME: path.join(root, 'home'), PWD: cwd,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), XDG_RUNTIME_DIR: path.join(root, 'run'),
      PREVIOUSLY_HOME: path.join(root, 'memory-global'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: path.join(root, 'models.json')});
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) fs.mkdirSync(env[key], {recursive: true});
    fs.writeFileSync(env.OPENCODE_MODELS_PATH, '{}');
    execFileSync('git', ['init', '-q'], {cwd, env});
    const configDir = path.join(env.XDG_CONFIG_HOME, 'opencode');
    const overrides = {PREVIOUSLY_HOME: env.PREVIOUSLY_HOME, PREVIOUSLY_PLUGINS: path.join(configDir, 'plugins'),
      PREVIOUSLY_CONFIG: path.join(configDir, 'opencode.json'), PREVIOUSLY_SKILLS: path.join(configDir, 'skills')};
    // In-process initRepo also resolves ~/.claude and ~/.codex: sandbox HOME too.
    const previous = Object.fromEntries([...Object.keys(overrides), 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides, {HOME: env.HOME});
    delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
    try {initRepo({cwd, explicit: installation, opencodeApi: api, agents: ['opencode']});}
    finally {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}}
    Object.assign(env, overrides);
    appendEvent({dir: path.join(cwd, 'memory'), event: normalizeEvent({type: 'solved', title: 'runtime fixture', solution: 'RECALL_SENTINEL'}, {writes: ['local'], repoName: 'project'})});

    const requests = [];
    const provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const write = body.tools?.find(tool => tool.function?.name === 'write');
      const call = write && !body.messages?.some(message => message.role === 'tool');
      const delta = call ? {role: 'assistant', tool_calls: [{index: 0, id: 'call_write', type: 'function', function: {name: 'write',
        arguments: JSON.stringify({[api === 'v1' ? 'filePath' : 'path']: path.join(cwd, 'written.txt'), content: 'runtime ok\n'})}}]} : {role: 'assistant', content: 'RUNTIME_OK'};
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const send = (choices, usage) => res.write('data: ' + JSON.stringify({id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices, ...(usage ? {usage} : {})}) + '\n\n');
      send([{index: 0, delta, finish_reason: null}]);
      send([{index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop'}], {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15});
      res.end('data: [DONE]\n\n');
    });
    t.after(() => {provider.closeAllConnections(); provider.close();});
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${provider.address().port}/v1`;
    const model = {test: {name: 'test', limit: {context: 100000, output: 1000}}};
    const configFile = installation === 'local' ? path.join(cwd, 'opencode.json') : overrides.PREVIOUSLY_CONFIG;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    Object.assign(config, api === 'v1' ? {model: 'local/test', permission: 'allow', provider: {local: {npm: '@ai-sdk/openai-compatible', options: {baseURL, apiKey: 'fixture'}, models: model}}}
      : {providers: {local: {package: '@opencode/ai/providers/openai-compatible', settings: {baseURL, apiKey: 'fixture'}, models: model}}});
    fs.writeFileSync(configFile, JSON.stringify(config));
    if (api === 'v1') {
      // Cold V1 performs dependency installation before loading any plugin.
      // Prepare it with Node/npm: isolate caches and avoid first-start ambiguity.
      const sdkVersion = version.match(/1\.\d+\.\d+/)[0];
      for (const dir of [path.join(cwd, '.opencode'), configDir]) {
        fs.mkdirSync(dir, {recursive: true});
        await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@opencode-ai/plugin@${sdkVersion}`], {cwd: dir, env});
      }
    }
    const output = await run(binary, ['run', ...(api === 'v2' ? ['--standalone', '--auto'] : []), '--format', 'json', '--model', 'local/test', 'runtime fixture write written.txt'], {cwd, env});
    assert.match(output, /RUNTIME_OK/);
    assert.equal(fs.readFileSync(path.join(cwd, 'written.txt'), 'utf8'), 'runtime ok\n');
    assert.ok(requests.some(body => body.messages?.some(message => message.role === 'system' && JSON.stringify(message.content).includes('RECALL_SENTINEL'))), 'memory must reach the actual model request');
    const drafts = loadMemories(path.join(cwd, 'memory')).memories.filter(memory => memory.tags.includes('auto'));
    assert.equal(drafts.length, 1, 'exactly one automatic session draft');
    assert.deepEqual(drafts[0].files, ['written.txt']);
    assert.equal(drafts[0].outcome, 'open');
    assert.match(drafts[0].title, /^OpenCode session ses_/);
    assert.match(drafts[0].symptoms, /runtime fixture write written.txt/);
    t.diagnostic('real turn, recall, write and attributed draft verified');
  });
}
