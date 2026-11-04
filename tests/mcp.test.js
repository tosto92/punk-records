import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleMessage } from '../lib/mcp.js';
import {securityFixture, writeSecurityStore, attack, benign, benignId} from './helpers/security.js';

test('MCP rejects wrong field shapes and traversal without append', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mcp-invalid-'));
  execFileSync('git', ['init', '-q'], {cwd});
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  for (const bad of [{ref: '../../outside'}, {files: [2]}, {tags: {}}, {attempts: 'x'}, {attempt: 2}, {type: 'bugfix'}, {title: 3}]) {
    const res = handleMessage({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'memory_save', arguments: {type: 'note', title: 'bad', ...bad}}}, {cwd, flagExplicit: 'local'});
    assert.equal(res.error?.code, -32602);
    assert.equal(fs.existsSync(path.join(cwd, 'memory/events.jsonl')), false);
  }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test('MCP validates envelopes before treating them as notifications', () => {
  const ctx = {cwd: ROOT, flagExplicit: null};
  for (const msg of [null, true, 42, 'text', [], {}, {id: 1}, {jsonrpc: '1.0', method: 'tools/list'},
    {jsonrpc: '2.0', method: 2}, {jsonrpc: '2.0', method: 'tools/list', id: {}},
    {jsonrpc: '2.0', method: 'tools/list', params: null}]) {
    const res = handleMessage(msg, ctx);
    assert.equal(res.error.code, -32600);
  }
  assert.equal(handleMessage({jsonrpc: '2.0', method: 'notifications/initialized'}, ctx), null);
  assert.ok(handleMessage({jsonrpc: '2.0', id: null, method: 'tools/list'}, ctx).result.tools);
});

test('MCP continues on the same process after malformed JSON and invalid envelopes', () => {
  const messages = [null, 1, [], {}, {jsonrpc: '2.0', method: 'notifications/initialized'},
    {jsonrpc: '2.0', id: 'after-invalid', method: 'tools/list'}];
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'punk-records'), 'mcp'], {
    cwd: ROOT, input: '{broken\n' + messages.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(res.status, 0, res.stderr);
  const replies = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.slice(0, -1).map(r => r.error.code), [-32700, -32600, -32600, -32600, -32600]);
  assert.equal(replies.at(-1).id, 'after-invalid');
  assert.equal(replies.at(-1).result.tools.length, 3);
});

function renderMd(m) {
  return [
    "---",
    `title: ${m.title}`,
    `scope: ${m.scope}`,
    `repo: ${m.repo || ""}`,
    `tags: [${m.tags.join(", ")}]`,
    `outcome: ${m.outcome}`,
    `updated: ${m.updated}`,
    `fingerprint: ${m.fingerprint || "0".repeat(40)}`,
    `covers: ${m.files[0] ?? "-"}`,
    "related: []",
    "---",
    "",
    "## Sintomi",
    "",
    m.symptoms || "",
    "",
    "## Tentativi falliti",
    "",
    "",
    "## Soluzione",
    "",
    m.solution || "",
    "",
    "## Esito",
    "",
    m.outcome,
    "",
  ].join("\n");
}

function writeScope(dir, memories) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'events.jsonl'), memories.map(m => JSON.stringify({
    ...m, v: 1, type: 'note', ts: m.updated, ref: null,
  })).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  const entries = memories.map((m) => ({
    slug: m.slug,
    title: m.title,
    tags: m.tags,
    files: m.files,
    outcome: m.outcome,
    updated: m.updated,
    fingerprint: m.fingerprint || "0".repeat(40),
  }));
  entries.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ version: 1, entries }, null, 2) + "\n");
  for (const m of memories) {
    fs.writeFileSync(path.join(dir, "memory", `${m.slug}.md`), renderMd(m));
  }
}

function startMcp({ home, cwd, args = [] }) {
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "punk-records"), "mcp", ...args], {
    cwd,
    env: { ...process.env, PUNK_RECORDS_HOME: home,
      PUNK_RECORDS_SECURITY: '0', PUNK_RECORDS_SYNTHESIS: '0' },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9) + 1;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000).unref();
    });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { child, call, notify };
}

test("mcp lists 3 tools and memory_find returns ranked hits", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-cwd-"));
  writeScope(home, [
    {
      slug: "auth-bug",
      title: "Auth bug fix",
      scope: "global",
      repo: "",
      tags: [],
      files: ["src/auth.js"],
      outcome: "ok",
      updated: "2026-10-02T00:00:00Z",
      symptoms: "login fails",
      solution: "rotate token",
    },
  ]);
  const { child, call, notify } = startMcp({ home, cwd });
  try {
    const init = await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.ok(init.result.serverInfo.name);
    notify("notifications/initialized");

    const list = await call("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["memory_find", "memory_freshness", "memory_save"]);

    const found = await call("tools/call", {
      name: "memory_find",
      arguments: { query: "auth" },
    });
    const text = found.result.content[0].text;
    const hits = JSON.parse(text);
    assert.ok(Array.isArray(hits));
    assert.match(hits[0].slug, /^auth-bug-fix--[a-f0-9]{40}$/);
  } finally {
    child.kill();
  }
});

test("memory_save accepts attempt singular and comma-string files/tags; memory_freshness reports drift", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-home2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-cwd2-"));
  const { child, call, notify } = startMcp({ home, cwd });
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    notify("notifications/initialized");

    const saved = await call("tools/call", {
      name: "memory_save",
      arguments: {
        type: "solved",
        title: "Login redirect loop",
        symptoms: "redirect to /login repeatedly",
        solution: "clear cookie",
        attempt: "tried clearing cache, no help",
        files: "src/auth.js, src/session.js",
        tags: ["auth", "cookies"],
      },
    });
    const savedResult = JSON.parse(saved.result.content[0].text);
    assert.equal(savedResult.ok, true);

    const eventsRaw = fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(eventsRaw.length, 1);
    const ev = JSON.parse(eventsRaw[0]);
    assert.deepEqual(ev.attempts, ["tried clearing cache, no help"]);
    assert.deepEqual(ev.files, ["src/auth.js", "src/session.js"]);
    assert.deepEqual(ev.tags, ["auth", "cookies"]);

    const fresh = await call("tools/call", { name: "memory_freshness", arguments: {} });
    const freshness = JSON.parse(fresh.result.content[0].text);
    assert.equal(freshness.stale, true, "events appended without build must be stale");
  } finally {
    child.kill();
  }
});

test("memory_save rejects out-of-enum scope with -32602", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-home4-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-cwd4-"));
  const { child, call, notify } = startMcp({ home, cwd });
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    notify("notifications/initialized");
    for (const bad of ["all", "global,local", "Glob"]) {
      const res = await call("tools/call", {
        name: "memory_save",
        arguments: { type: "note", title: "x", scope: bad },
      });
      assert.equal(res.error.code, -32602, `scope ${bad} must be rejected`);
    }
    assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false, "no event appended");
  } finally {
    child.kill();
  }
});

test("unknown method returns JSON-RPC -32601", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-home3-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-mcp-cwd3-"));
  const { child, call } = startMcp({ home, cwd });
  try {
    const res = await call("bogus/method", {});
    assert.equal(res.error.code, -32601);
  } finally {
    child.kill();
  }
});

test('MCP save/find/update roundtrip without build', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mcp-live-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const {child, call} = startMcp({home, cwd: home});
  t.after(() => child.kill());
  const create = await call('tools/call', {name: 'memory_save', arguments: {type: 'note', title: 'mcp zebra'}});
  const saved = JSON.parse(create.result.content[0].text);
  assert.match(saved.memoryId, /^[0-9a-f]{40}$/);
  const update = await call('tools/call', {name: 'memory_save', arguments: {ref: saved.memoryId, type: 'solved', solution: 'restart', outcome: 'ok'}});
  assert.equal(JSON.parse(update.result.content[0].text).outcome, 'ok');
  fs.writeFileSync(path.join(home, 'index.json'), '{broken');
  const find = await call('tools/call', {name: 'memory_find', arguments: {query: 'mcp zebra'}});
  const hits = JSON.parse(find.result.content[0].text);
  assert.equal(hits[0].memoryId, saved.memoryId);
  assert.equal(hits[0].outcome, 'ok');
  assert.equal(fs.readFileSync(path.join(home, 'index.json'), 'utf8'), '{broken');
});

test('MCP memory_find shares the gate and approval claims expose no approval tool', t => {
  const f = securityFixture(t); writeSecurityStore(f.home, [attack, benign]);
  const logs = []; t.mock.method(console, 'error', line => logs.push(line));
  const ctx = {cwd: f.home, flagExplicit: 'global'};
  const call = (method, params = {}) => handleMessage({jsonrpc: '2.0', id: 1, method, params}, ctx);
  assert.deepEqual(call('tools/list').result.tools.map(t => t.name).sort(), ['memory_find', 'memory_freshness', 'memory_save']);
  const found = call('tools/call', {name: 'memory_find', arguments: {query: 'deploy', limit: 1, approved: true}});
  const output = found.result.content[0].text;
  assert.equal(JSON.parse(output)[0].memoryId, benignId);
  assert.doesNotMatch(output + logs.join('\n'), /quarantined|QUARANTINED|Ignore/);
  const noApproval = call('tools/call', {name: 'memory_approve', arguments: {memoryId: attack.memoryId}});
  assert.ok(noApproval.error);
  process.env.PUNK_RECORDS_PYTHON = path.join(f.root, 'missing');
  const saved = call('tools/call', {name: 'memory_save', arguments: {type: 'note', title: 'committed deploy', approved: true}});
  const result = JSON.parse(saved.result.content[0].text);
  assert.equal(result.ok, true); assert.equal(result.written, 1); assert.equal(result.security.status, 'incomplete');
});


test('MCP memory_find validates full strictly and returns admitted full bodies', t => {
  const f = securityFixture(t);
  const solution = 'first\nsecond\nthird\nTAIL-CONDITION';
  writeSecurityStore(f.home, [{...benign, solution}, attack]);
  const ctx = {cwd: f.home, flagExplicit: 'global'};
  const call = arguments_ => handleMessage({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'memory_find', arguments: {query: 'deploy', ...arguments_}}}, ctx);
  for (const full of ['true', null, 0, [], {}]) assert.equal(call({full}).error?.code, -32602);
  const tools = handleMessage({jsonrpc: '2.0', id: 2, method: 'tools/list'}, ctx).result.tools;
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.find(t => t.name === 'memory_find').inputSchema.properties.full, {type: 'boolean'});
  const short = JSON.parse(call({}).result.content[0].text);
  assert.deepEqual(JSON.parse(call({full: false}).result.content[0].text), short);
  const hits = JSON.parse(call({full: true}).result.content[0].text);
  assert.deepEqual(hits.map(({memory, ...hit}) => hit), short);
  assert.equal(hits[0].memory.memoryId, benignId);
  assert.equal(hits[0].memory.solution, solution);
  assert.doesNotMatch(JSON.stringify(hits), /QUARANTINED|_store|_fresh|scanner/);
});
