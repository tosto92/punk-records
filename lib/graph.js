import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {synthesisReview, publishSynthesisRun} from './synthesis.js';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadMemories } from './build.js';
import { globalDir, repoDir, storePath } from './paths.js';
import { listProjects } from './projects.js';
import { isDraft } from './activity.js';
import { setting } from './env.js';

const COLORS = {ok: '#2f9e44', partial: '#e8890c', open: '#868e96'};
const W = 1200;
const H = 820;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// note: O(n^2) pairwise affinity — fine to a few hundred memories,
// bucket by tag/file if the store ever outgrows one screen.
export function edgesOf(memories) {
  const edges = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      const tags = a.tags.filter((t) => b.tags.includes(t));
      const files = a.files.filter((f) => b.files.includes(f));
      if (tags.length || files.length) edges.push({a: i, b: j, tags, files});
    }
  }
  return edges;
}

// Cluster = first tag (fallback "untagged"); clusters around a circle, nodes in rings inside.
export function layoutOf(memories) {
  const groups = new Map();
  for (const m of memories) {
    const key = m.tags[0] || 'untagged';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const keys = [...groups.keys()].sort();
  const cx = W / 2;
  const cy = H / 2;
  const orbit = Math.min(W, H) / 2 - 120;
  const positions = new Map();
  keys.forEach((key, k) => {
    const angle = (2 * Math.PI * k) / keys.length - Math.PI / 2;
    const gx = cx + orbit * Math.cos(angle);
    const gy = cy + orbit * Math.sin(angle);
    const members = groups.get(key);
    members.forEach((m, i) => {
      const ring = Math.floor(i / 6);
      const per = Math.min(6, members.length - ring * 6);
      const step = (2 * Math.PI) / per;
      const a = angle + Math.PI + (i % 6) * step;
      const r = 26 + ring * 24;
      positions.set(m.slug, {x: gx + r * Math.cos(a), y: gy + r * Math.sin(a), cluster: key});
    });
  });
  return {positions, clusters: keys.map(k => [k, groups.get(k).length])};
}

export function graphHtml(memories, {title = 'Punk Records'} = {}) {
  const {positions, clusters} = layoutOf(memories);
  const edges = edgesOf(memories);
  const lines = edges.map(({a, b, tags, files}) => {
    const p = positions.get(memories[a].slug);
    const q = positions.get(memories[b].slug);
    const why = [...tags.map(t => `#${t}`), ...files.map(f => `file ${f}`)].join(', ');
    return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="#adb5bd" stroke-width="1"${tags.length ? '' : ' stroke-dasharray="3 4"'}/><title>${esc(why)}</title>`;
  });
  const nodes = memories.map((m) => {
    const p = positions.get(m.slug);
    const r = 5 + Math.min(7, m.files.length);
    const tip = [m.title, `${m.type || 'note'} · ${m.outcome}`, m.scope, m.tags.map(t => `#${t}`).join(' '), m.files.join(', ')]
      .filter(Boolean).join('\n');
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${COLORS[m.outcome] || COLORS.open}" stroke="#fff" stroke-width="1.5"><title>${esc(tip)}</title></circle>`;
  });
  const legend = clusters
    .map(([name, count], i) => `<text x="16" y="${48 + i * 18}" class="legend">#${esc(name)} (${count})</text>`)
    .join('');
  const outcomes = Object.entries(COLORS).map(([k, v], i) => `<rect x="16" y="${H - 60 + i * 18}" width="10" height="10" fill="${v}"/><text x="32" y="${H - 50 + i * 18}" class="legend">${k}</text>`).join('');
  const body = memories.length
    ? `${lines.join('\n')}\n${nodes.join('\n')}\n${legend}\n${outcomes}`
    : `<text x="${W / 2}" y="${H / 2}" class="legend" text-anchor="middle">no memories yet</text>`;
  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
svg{font:12px system-ui,sans-serif}
.legend{fill:#495057}
text{pointer-events:none}
</style>
<svg viewBox="0 0 ${W} ${H}" width="100%">
<rect width="${W}" height="${H}" fill="#f8f9fa"/>
<text x="16" y="24" style="font-size:15px;font-weight:600" fill="#212529">${esc(title)} — ${memories.length} memories</text>
${body}
</svg>
`;
}

export function collectMemories(resolved, scope = 'all', {drafts = true} = {}) {
  const sources = [];
  if (scope !== 'local') sources.push(globalDir());
  if (scope !== 'global' && resolved.repoRoot) sources.push(repoDir(resolved.repoRoot));
  // 'projects': every registered project store too (dedup by memoryId below).
  if (scope === 'projects') sources.push(...listProjects().map(repoDir));
  const byId = new Map();
  for (const dir of sources) {
    for (const m of loadMemories(dir).memories) if (!byId.has(m.memoryId)) byId.set(m.memoryId, m);
  }
  return [...byId.values()].filter((m) => drafts || !isDraft(m)).sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

export function writeGraph(resolved, {scope = 'all', out = null, drafts = true} = {}) {
  const memories = collectMemories(resolved, scope, {drafts});
  const dir = scope === 'global' ? globalDir() : resolved.repoRoot ? repoDir(resolved.repoRoot) : globalDir();
  const target = out ? path.resolve(out) : storePath(dir, 'graph.html');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, graphHtml(memories, {title: scope === 'all' ? 'Punk Records' : `Punk Records (${scope})`}));
  return {wrote: target, memories: memories.length};
}

const opener = {darwin: 'open', win32: 'start'}[process.platform] || 'xdg-open';
export function openBrowser(url) {
  try {
    execFileSync(opener, [url], {stdio: 'ignore'});
  } catch {
    /* headless box: the printed url is enough */
  }
}

// Interactive viewer (lib/viewer, third-party MIT, see its LICENSE): force layout,
// zoom, search, detail panel, outline. Served as static files plus the
// /api/context-graph JSON below; nothing else to install.
const VIEWER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewer');
const VIEWER_ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/synthesis': ['synthesis.html', 'text/html; charset=utf-8'],
  '/synthesis.js': ['synthesis.js', 'text/javascript; charset=utf-8'],
  '/synthesis.css': ['synthesis.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const EPISODES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'episodes', 'sessions.py');

// Episodes live in Python (sessions.py); each API call is one short-lived
// `sessions.py api <path> <query>` run, which also syncs the index first.
function episodesApi(url, query, res) {
  const python = setting('PYTHON') || 'python3';
  execFile(python, [EPISODES, 'api', url, query], {maxBuffer: 64 << 20}, (err, out) => {
    if (err) {
      res.writeHead(502, {'content-type': 'text/plain; charset=utf-8'});
      res.end(`episodes need Python 3.9+ (${python}): ${err.message}`);
      return;
    }
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(out);
  });
}

// Detail panel text (rendered with white-space: pre-line): one header line,
// then the sections a future session actually reuses.
function detail(m) {
  const head = [`[${m.scope}]`, m.outcome, m.updated?.slice(0, 10)].filter(Boolean).join(' · ');
  const sections = [
    m.symptoms && `Symptoms\n${m.symptoms}`,
    m.solution && `Solution\n${m.solution}`,
    m.attempts?.length && `Failed attempts\n${m.attempts.map((a) => `- ${a}`).join('\n')}`,
    m.tags.length && m.tags.map((t) => `#${t}`).join(' '),
  ];
  return [head, ...sections].filter(Boolean).join('\n\n').slice(0, 1500);
}

// The /api/context-graph contract the vendored viewer consumes. Node `type`
// drives colour and the legend's hide toggles (lib/viewer/app.js type map).
export function contextGraph(memories, {repoName = 'memories', scope = 'all'} = {}) {
  const nodes = memories.map((m) => ({
    id: m.slug,
    name: m.scope === 'global' ? `${m.title} [global]` : scope === 'projects' ? `${m.title} [${m.repo || 'project'}]` : m.title,
    type: isDraft(m) ? 'draft' : m.type || 'note',
    summary: detail(m),
    sources: m.files,
  }));
  const edges = edgesOf(memories).map(({a, b, tags, files}) => ({
    source: memories[a].slug,
    target: memories[b].slug,
    relation: tags.length && files.length ? 'shares_tag_and_file' : tags.length ? 'shares_tag' : 'touches_file',
    description: [...tags.map((t) => `#${t}`), ...files].join(', '),
  }));
  return {
    meta: {nodeCount: nodes.length, edgeCount: edges.length, repoName, subtitle: {all: 'repo + global', projects: 'all projects'}[scope] ?? scope, tabs: ['context', 'outline'], defaultTab: 'context'},
    nodes,
    edges,
  };
}

// Regenerates the page per request instead of watching the store: a refresh is
// all the viewer needs, so no SSE channel here.
export async function serveGraph(resolved, {scope = 'all', port = 4400, open = false, viewer = 'auto', drafts = true} = {}) {
  const viewerDir = viewer === 'svg' ? null : VIEWER_DIR;
  const csrf = randomUUID();
  const stores = new Map();
  const addStore = (store, label, sourceScope) => {
    if (![...stores.values()].some(s => s.store === store)) stores.set(String(stores.size), {store, label, scope: sourceScope});
  };
  if (scope !== 'local') addStore(globalDir(), 'global', 'global');
  if (scope !== 'global' && resolved.repoRoot) addStore(repoDir(resolved.repoRoot), `repo: ${resolved.repoRoot}`, 'repo');
  if (scope === 'projects') for (const root of listProjects()) addStore(repoDir(root), `repo: ${root}`, 'repo');
  const server = createServer(async (req, res) => {
    const [url, query = ''] = (req.url ?? '/').split('?');
    if (viewerDir) {
      if (url === '/api/synthesis' || url === '/api/synthesis/publish') {
        const send = (status, value) => { res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}); res.end(JSON.stringify(value)); };
        const authority = `127.0.0.1:${server.address().port}`, origin = `http://${authority}`;
        if (req.headers.host !== authority || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, {error: 'Synthesis requires a same-origin loopback connection'});
        try {
          if (url === '/api/synthesis') {
            if (req.method !== 'GET') return send(405, {error: 'GET required'});
            const params = new URLSearchParams(query);
            if ([...params.keys()].some(k => !['store', 'run'].includes(k)) || [...new Set(params.keys())].some(k => params.getAll(k).length !== 1)) return send(400, {error: 'Invalid synthesis query'});
            if (!params.has('store')) return send(200, {csrf, stores: [...stores].map(([id, value]) => ({id, label: value.label}))});
            const selected = stores.get(params.get('store'));
            if (!selected) return send(400, {error: 'Unknown synthesis scope'});
            return send(200, synthesisReview({...selected, runId: params.get('run') ?? undefined}));
          }
          if (req.method !== 'POST') return send(405, {error: 'POST required'});
          if (req.headers.origin !== origin || req.headers['x-punk-records-csrf'] !== csrf) return send(403, {error: 'Invalid synthesis publication token'});
          if (query || req.headers['content-type'] !== 'application/json') return send(400, {error: 'JSON required'});
          req.setTimeout(5000, () => req.destroy());
          const body = await new Promise((resolve, reject) => {
            let size = 0, chunks = [];
            req.on('data', chunk => { size += chunk.length; if (size <= 4096) chunks.push(chunk); else chunks = []; });
            req.on('end', () => { if (size > 4096) reject(new Error('body too large')); else { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); } } });
            req.on('error', reject);
          });
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'requestId,reviewId,runId,store' || typeof body.store !== 'string' || typeof body.requestId !== 'string') return send(400, {error: 'Invalid publication request'});
          const selected = stores.get(body.store);
          if (!selected) return send(400, {error: 'Unknown synthesis scope'});
          return send(200, publishSynthesisRun({...selected, runId: body.runId, requestId: body.requestId, reviewId: body.reviewId}));
        } catch { return send(409, {error: 'Synthesis evidence unavailable or changed; refresh and review again'}); }
      }
      if (url === '/episodes') {
        res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
        res.end(fs.readFileSync(path.join(path.dirname(EPISODES), 'sessions.html')));
        return;
      }
      if (url === '/api/data' || url === '/api/session') return episodesApi(url, query, res);
      const asset = VIEWER_ASSETS[url];
      if (asset) {
        res.writeHead(200, {'content-type': asset[1]});
        res.end(fs.readFileSync(path.join(viewerDir, asset[0])));
        return;
      }
      if (url === '/api/context-graph') {
        const graph = contextGraph(collectMemories(resolved, scope, {drafts}), {repoName: resolved.repoName || 'memories', scope});
        res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
        res.end(JSON.stringify(graph));
        return;
      }
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('not found');
      return;
    }
    if (url !== '/' && url !== '/index.html') {
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('not found');
      return;
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(graphHtml(collectMemories(resolved, scope, {drafts}), {title: scope === 'all' ? 'Punk Records' : `Punk Records (${scope})`}));
  });
  let bound = null;
  for (let i = 0; i < 10 && bound === null && port + i <= 65535; i++) {
    bound = await new Promise((resolve, reject) => {
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      const onError = err => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(null); else reject(err);
      };
      server.once('error', onError);
      server.listen(port + i, '127.0.0.1', onListening);
    });
  }
  if (!bound) throw new Error(`no free port in ${port}-${port + 9}`);
  const target = `http://127.0.0.1:${bound}`;
  if (open) openBrowser(target);
  return {
    url: target,
    viewer: viewerDir ? 'interactive' : 'svg',
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
