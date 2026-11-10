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
import {fixture, mutate} from './fixtures/learning/opencode.js';
import {captureOpenCodeSession} from '../lib/opencode-learning.js';

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
    const env = Object.fromEntries(['PATH', 'LANG', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, {HOME: path.join(root, 'home'), PWD: cwd,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), XDG_RUNTIME_DIR: path.join(root, 'run'),
      PUNK_RECORDS_HOME: path.join(root, 'memory-global'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: path.join(root, 'models.json')});
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) fs.mkdirSync(env[key], {recursive: true});
    fs.writeFileSync(env.OPENCODE_MODELS_PATH, '{}');
    execFileSync('git', ['init', '-q'], {cwd, env});
    const configDir = path.join(env.XDG_CONFIG_HOME, 'opencode');
    const overrides = {PUNK_RECORDS_HOME: env.PUNK_RECORDS_HOME, PUNK_RECORDS_PLUGINS: path.join(configDir, 'plugins'),
      PUNK_RECORDS_CONFIG: path.join(configDir, 'opencode.json'), PUNK_RECORDS_SKILLS: path.join(configDir, 'skills')};
    // In-process initRepo also resolves ~/.claude and ~/.codex: sandbox HOME too.
    const previous = Object.fromEntries([...Object.keys(overrides), 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides, {HOME: env.HOME});
    delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
    try {initRepo({cwd, explicit: installation, opencodeApi: api, agents: ['opencode']});}
    finally {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}}
    Object.assign(env, overrides);
    appendEvent({dir: path.join(cwd, 'memory'), event: normalizeEvent({type: 'solved', title: 'runtime fixture', solution: 'RECALL_SENTINEL'}, {writes: ['local'], repoName: 'project'})});

    const requests = [];
    let steps = null;
    const protocolErrors = [];
    const provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const write = body.tools?.find(tool => tool.function?.name === 'write');
      const call = write && !body.messages?.some(message => message.role === 'tool');
      let delta = call ? {role: 'assistant', tool_calls: [{index: 0, id: 'call_write', type: 'function', function: {name: 'write',
        arguments: JSON.stringify({[api === 'v1' ? 'filePath' : 'path']: path.join(cwd, 'written.txt'), content: 'runtime ok\n'})}}]} : {role: 'assistant', content: 'RUNTIME_OK'};
      if (steps && body.tools?.length) {
        try { assert.ok(steps.length, 'unexpected provider request'); delta = steps.shift()(body); }
        catch (error) {protocolErrors.push(error); delta = {role: 'assistant', content: 'HARNESS_ERROR'};}
      }
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const send = (choices, usage) => res.write('data: ' + JSON.stringify({id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices, ...(usage ? {usage} : {})}) + '\n\n');
      send([{index: 0, delta, finish_reason: null}]);
      send([{index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}], {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15});
      res.end('data: [DONE]\n\n');
    });
    t.after(() => {provider.closeAllConnections(); provider.close();});
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${provider.address().port}/v1`;
    const model = {test: {name: 'test', limit: {context: 100000, output: 1000}}};
    const configFile = installation === 'local' ? path.join(cwd, 'opencode.json') : overrides.PUNK_RECORDS_CONFIG;
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
    const runtimeSession = output.match(/"sessionID":"([^"]+)"/)?.[1];
    assert.ok(runtimeSession, 'runtime output must identify the native session');
    const runtimeCapture = captureOpenCodeSession({sessionId: runtimeSession, database: path.join(env.XDG_DATA_HOME, 'opencode', 'opencode.db')});
    assert.equal(runtimeCapture.descriptor.storageFormat, `opencode-${api}`);
    assert.equal(runtimeCapture.coverage.sourceComplete, true);
    assert.match(runtimeCapture.bytes.toString(), /RUNTIME_OK/);
    t.diagnostic(`fresh client-written ${runtimeCapture.descriptor.storageFormat} captured; coverage=${JSON.stringify(runtimeCapture.coverage)}`);

    // Scripted provider acceptance: exercise real installed tools and save receipts,
    // not semantic extraction/model quality. All native rows and stores are synthetic.
    const database = fixture(t, api === 'v1' ? 1 : 2, api === 'v1' ? [
      {data: {role: 'user'}, parts: [{type: 'text', text: 'Check the repair'}]},
      {data: {role: 'assistant', finish: 'stop', time: {completed: 1002}}, parts: [{type: 'text', text: 'verified repair'}]},
    ] : undefined);
    mutate(database, `UPDATE ${api === 'v1' ? 'session' : 'session_v2'} SET directory=?`, [cwd]);
    const installed = path.join(configDir, 'skills', 'punk-records-learn');
    const captureScript = path.join(root, 'capture.mjs'), snapshot = path.join(root, 'capture.json');
    fs.writeFileSync(captureScript, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import {captureOpenCodeSession} from ${JSON.stringify(new URL('../lib/opencode-learning.js', import.meta.url).href)};
import {readLearningWindow} from ${JSON.stringify(new URL('../lib/learning.js', import.meta.url).href)};
const capture=captureOpenCodeSession({sessionId:'selected',database:${JSON.stringify(database)}});
const window=readLearningWindow(capture.bytes,'opencode');
assert.equal(capture.descriptor.sessionId,'selected');
assert.equal(capture.descriptor.directory,${JSON.stringify(cwd)});
assert.equal(capture.coverage.sourceComplete,true);
assert.ok(window.records.some(record=>record.role==='assistant' && record.locator));
const file=${JSON.stringify(snapshot)};
if(process.argv.includes('--recheck')) assert.equal(capture.sourceRevision,JSON.parse(fs.readFileSync(file)).sourceRevision);
else fs.writeFileSync(file,JSON.stringify({...capture,bytes:undefined,window}),{mode:0o600});
console.log(JSON.stringify({...capture,bytes:undefined,window}));
`);
    const tool = (suffix, args) => body => {
      const name = body.tools?.find(tool => tool.function?.name === suffix || tool.function?.name.endsWith('_' + suffix))?.function.name;
      assert.ok(name, `${suffix} unavailable: ${body.tools?.map(tool => tool.function?.name)}`);
      return {role: 'assistant', tool_calls: [{index: 0, id: `call_${requests.length}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]};
    };
    const text = content => () => ({role: 'assistant', content});
    const shell = command => body => {
      const definition = body.tools?.find(tool => ['bash', 'shell'].includes(tool.function?.name))?.function;
      assert.ok(definition, `shell unavailable: ${body.tools?.map(tool => tool.function?.name)}`);
      return tool(definition.name, {command, description: 'Read synthetic native source', timeout: 30000})(body);
    };
    const cli = args => ['node', path.resolve(import.meta.dirname, '../bin/punk-records'), ...args]
      .map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
    const memoryTool = (name, args) => body => {
      if (body.tools?.some(tool => tool.function?.name.endsWith(name))) return tool(name, args)(body);
      t.diagnostic(`direct ${name} absent from provider tool list; CLI fallback exercised`);
      return shell(cli(name === 'memory_find' ? ['ask', args.query, '--full']
        : ['save', '--local', '--type', args.type, '--title', args.title, '--solution', args.solution]))(body);
    };
    const launch = async (prompt, session) => {
      const output = await run(binary, ['run', ...(api === 'v2' ? ['--standalone', '--auto'] : []), '--format', 'json', '--model', 'local/test', ...(session ? ['--session', session] : []), prompt], {cwd, env});
      assert.deepEqual(protocolErrors, [], protocolErrors.map(error => error.message).join('\n'));
      assert.equal(steps.length, 0, output.slice(-4000));
      return output;
    };
    for (const yolo of [false, true]) {
      const title = `Native learning ${yolo ? 'yolo' : 'confirmed'}`;
      steps = [tool('skill', {[api === 'v1' ? 'name' : 'id']: 'punk-records-learn'}),
        body => {
          const loaded = JSON.stringify(body.messages.filter(message => message.role === 'tool').at(-1));
          assert.ok(loaded.includes('references/workflow.md'), `installed skill must actually load its workflow link: ${loaded}`);
          return tool('read', {[api === 'v1' ? 'filePath' : 'path']: path.join(installed, 'references', 'workflow.md')})(body);
        },
        body => {
          assert.ok(JSON.stringify(body.messages).includes('captureOpenCodeSession'), 'actual workflow must expose native capture contract');
          return shell(`node '${captureScript}'`)(body);
        }, memoryTool('memory_find', {query: title, full: true})];
      const saveSteps = [shell(`node '${captureScript}' --recheck`), body => {
        const capture = JSON.parse(fs.readFileSync(snapshot));
        assert.ok(JSON.stringify(body.messages.filter(message => message.role === 'tool').at(-1)).includes(capture.sourceRevision), 'native revision recheck must succeed before save');
        const record = capture.window.records.find(record => record.role === 'assistant');
        return memoryTool('memory_save', {type: 'note', title, scope: 'local',
          solution: `${record.text}\nNative evidence: ${JSON.stringify(record.locator)}; database=${capture.descriptor.database}; session=selected; revision=${capture.sourceRevision}; sourceComplete=${capture.coverage.sourceComplete}. Synthetic historical result; deployment unverified.`})(body);
      }, text('LEARNING_SAVED')];
      const before = loadMemories(path.join(cwd, 'memory')).memories.length;
      if (yolo) steps.push(...saveSteps);
      else steps.push(text('Selected 1; processed 1; held 0; duplicates 0; saved 0. Create 1 native finding. Save this plan?'));
      const learned = await launch(`Use punk-records-learn to learn selected native source in ${database}${yolo ? ', yolo' : ''}`);
      if (!yolo) {
        assert.equal(learned.match(/Save this plan\?/g)?.length, 1, 'one consolidated confirmation');
        assert.equal(loadMemories(path.join(cwd, 'memory')).memories.length, before, 'no save before approval');
        const session = learned.match(/"sessionID":"([^"]+)"/)?.[1];
        assert.ok(session, learned.slice(-3000));
        steps = saveSteps;
        assert.match(await launch('Confirm: save the shown plan.', session), /LEARNING_SAVED/);
      } else {
        assert.doesNotMatch(learned, /Save this plan\?/);
        assert.match(learned, /LEARNING_SAVED/);
      }
      const saved = loadMemories(path.join(cwd, 'memory')).memories;
      assert.equal(saved.length, before + 1, 'one actual local save receipt');
      const finding = saved.find(memory => memory.title === title);
      assert.ok(finding?.memoryId);
      assert.match(finding.solution, /Native evidence:.*revision=.*deployment unverified/);
    }
    t.diagnostic('installed skill/workflow, native capture/revision recheck, admitted search, default approval/resume and yolo local save receipts verified with scripted provider');
  });
}
