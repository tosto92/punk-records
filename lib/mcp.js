import readline from "node:readline";

import { search } from "./ask.js";
import {saveMemory} from './save.js';
import { checkScope } from "./check.js";
import { resolveScopes, globalDir, repoDir } from "./paths.js";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "memory_find",
    description: "Ranked search over stored memories (global and/or repo scope).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        scope: { type: "string", enum: ["global", "local", "all"] },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description: "Save a memory (type+title for creation; ref for updates). Immediately searchable without build.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["solved", "attempt_failed", "decision", "note"] },
        title: { type: "string" },
        symptoms: { type: "string" },
        solution: { type: "string" },
        attempt: { type: "string" },
        attempts: { type: "array", items: { type: "string" } },
        files: { type: ["array", "string"], items: { type: "string" } },
        tags: { type: ["array", "string"], items: { type: "string" } },
        ref: { type: "string" },
        outcome: {type: 'string', enum: ['open', 'partial', 'ok']},
        scope: { type: "string", enum: ["global", "local"] },
      },
    },
  },
  {
    name: "memory_freshness",
    description: "Rebuild-and-diff freshness check; {stale, drift[]}.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "local", "all"] },
      },
    },
  },
];

function toList(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value.map(s => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  throw new TypeError('files/tags must be strings or arrays of strings');
}

function defaultScope(flagExplicit) {
  return flagExplicit === "global" ? "global" : flagExplicit === "local" ? "local" : "all";
}

function cmdScope(scope) {
  return scope === "global" ? "global" : scope === "local" ? "local" : null;
}

function handleFind(args, flagExplicit, cwd) {
  const scope = args.scope == null ? defaultScope(flagExplicit) : args.scope;
  if (!["global", "local", "all"].includes(scope)) {
    throw Object.assign(new Error(`invalid scope: ${scope}`), { code: -32602 });
  }
  const explicit = cmdScope(scope) ?? flagExplicit;
  const resolved = resolveScopes({ explicit }, cwd);
  const limit = args.limit == null ? 5 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw Object.assign(new Error("limit must be a positive integer"), { code: -32602 });
  }
  return search({ query: String(args.query || ""), limit, scope, resolved });
}

function handleSave(args, flagExplicit, cwd) {
  if (!args || (!args.ref && (!args.type || !args.title))) {
    throw Object.assign(new Error("memory_save requires type and title"), { code: -32602 });
  }
  if (args.scope != null && !["global", "local"].includes(args.scope)) {
    throw Object.assign(new Error(`invalid scope: ${args.scope}`), { code: -32602 });
  }
  const scope = args.scope === "global" || args.scope === "local" ? args.scope : flagExplicit;
  if (args.attempts !== undefined && (!Array.isArray(args.attempts) || args.attempts.some(v => typeof v !== 'string'))) throw new TypeError('attempts must be strings');
  if (args.attempt !== undefined && typeof args.attempt !== 'string') throw new TypeError('attempt must be a string');
  const attempts = args.attempts !== undefined || args.attempt !== undefined ? [...(args.attempts || []), ...(args.attempt ? [args.attempt] : [])] : undefined;
  const partial = {
    type: args.type,
    title: args.title,
    symptoms: args.symptoms,
    solution: args.solution,
    attempts,
    files: toList(args.files),
    tags: toList(args.tags),
    ref: args.ref,
    outcome: args.outcome,
  };
  return saveMemory(partial, {cwd, scope: scope === 'local' ? 'repo' : scope ?? null});
}

function handleFreshness(args, flagExplicit, cwd) {
  const scope = args && args.scope != null ? args.scope : defaultScope(flagExplicit);
  if (!["global", "local", "all"].includes(scope)) {
    throw Object.assign(new Error(`invalid scope: ${scope}`), { code: -32602 });
  }
  const explicit = cmdScope(scope) ?? flagExplicit;
  const resolved = resolveScopes({ explicit }, cwd);
  let writes;
  if (explicit === "global") writes = ["global"];
  else if (explicit === "local") {
    if (!resolved.repoRoot) throw Object.assign(new Error("local scope requested outside a project (git repo or .previously; run previously init --local)"), { code: -32602 });
    writes = ["local"];
  } else {
    writes = ["global"];
    if (resolved.repoRoot) writes.push("local");
  }
  let stale = false;
  const drift = [];
  for (const w of writes) {
    const dir = w === "global" ? globalDir() : repoDir(resolved.repoRoot);
    const res = checkScope(dir);
    if (res.stale) {
      stale = true;
      for (const rel of res.drift) drift.push(writes.length > 1 ? `${w}: ${rel}` : rel);
    }
  }
  return { stale, drift };
}

function handleToolCall(params, flagExplicit, cwd) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  switch (name) {
    case "memory_find":
      return handleFind(args, flagExplicit, cwd);
    case "memory_save":
      return handleSave(args, flagExplicit, cwd);
    case "memory_freshness":
      return handleFreshness(args, flagExplicit, cwd);
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  }
}

export function handleMessage(msg, ctx) {
  const { flagExplicit, cwd } = ctx;
  if (msg.id === undefined || msg.id === null) return null; // notification: no response
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "previously", version: "1.0.0" },
          },
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const result = handleToolCall(params, flagExplicit, cwd);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: err.code === -32602 || err instanceof TypeError ? -32602 : -32603, message: err.message },
    };
  }
}

export function serve({ flagExplicit = null, cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const res = handleMessage(msg, { flagExplicit, cwd });
    if (res) output.write(JSON.stringify(res) + "\n");
  });
  return rl;
}
