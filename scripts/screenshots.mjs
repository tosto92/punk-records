#!/usr/bin/env node
// Regenerates the README screenshots in docs/images/ from made-up demo data,
// so they never show anyone's real sessions or memories.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/screenshots.mjs            (CHROMIUM=/path/to/chrome to reuse a browser)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "punk-records");
const OUT = path.join(ROOT, "docs", "images");
const { chromium } = await import("playwright").catch(() => {
  console.error("playwright not found: npm i --no-save playwright && npx playwright install chromium");
  process.exit(2);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punk-records-shots-"));
const home = path.join(tmp, "home");
const env = { ...process.env, HOME: home, PUNK_RECORDS_HOME: path.join(home, "store"), CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" };
const now = Date.now() / 1000;
const day = 86400;

// Demo sessions: [tool, project, title, branch, days ago, prompts]
const sessions = [
  ["claude", "~/code/shop", "Checkout returns 401 after token refresh", "fix/auth-refresh", 0.1, ["users get 401 right after the token refresh", "the refresh handler stores the token before the promise resolves", "add a regression test for the refresh race"]],
  ["codex", "~/code/api", "Rate limiter for public endpoints", "feat/rate-limit", 0.4, ["add a token bucket limiter to /v1", "make the limit configurable per route"]],
  ["claude", "~/code/shop", "Flaky payment webhook test", "main", 1.2, ["the webhook test fails one run in five", "switch to fake timers"]],
  ["claude", "~/code/docs", "Shorter install guide", "docs/install", 2.3, ["rewrite the install guide in half the length", "add a troubleshooting section"]],
  ["codex", "~/code/api", "Upgrade Postgres 15 to 17", "chore/pg17", 3.5, ["plan the Postgres 17 upgrade", "check which extensions need a rebuild"]],
];
const claudeDir = path.join(home, ".claude"), codexDir = path.join(home, ".codex");
fs.mkdirSync(path.join(claudeDir, "projects", "demo"), { recursive: true });
fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
const lines = { claude: [], codex: [], index: [] };
sessions.forEach(([tool, project, title, branch, ago, prompts], i) => {
  const id = `${tool === "claude" ? "c" : "d"}${i}a1b2c3-0000-4000-8000-00000000000${i}`;
  const cwd = project.replace("~", "/home/demo"); // shown as ~/code/… by the page
  prompts.forEach((text, j) => {
    const ts = now - ago * day + j * 540;
    if (tool === "claude") lines.claude.push({ sessionId: id, timestamp: Math.round(ts * 1000), display: text, project: cwd });
    else lines.codex.push({ session_id: id, ts: Math.round(ts), text });
  });
  if (tool === "claude") fs.writeFileSync(path.join(claudeDir, "projects", "demo", `${id}.jsonl`), JSON.stringify({ aiTitle: title, gitBranch: branch, cwd }) + "\n");
  else {
    lines.index.push({ id, thread_name: title });
    fs.writeFileSync(path.join(codexDir, "sessions", `rollout-2026-01-01T00-00-00-${id}.jsonl`), JSON.stringify({ payload: { cwd } }) + "\n");
  }
});
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
fs.writeFileSync(path.join(claudeDir, "history.jsonl"), jsonl(lines.claude));
fs.writeFileSync(path.join(codexDir, "history.jsonl"), jsonl(lines.codex));
fs.writeFileSync(path.join(codexDir, "session_index.jsonl"), jsonl(lines.index));

// Demo memories in one repo plus the global store.
const repo = path.join(home, "code", "shop");
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
const save = (...args) => execFileSync(process.execPath, [BIN, "save", ...args], { cwd: repo, env, stdio: "ignore" });
save("--local", "--type", "solved", "--title", "Login fails after token refresh", "--symptoms", "401 on every request after one hour", "--solution", "await the refresh promise before storing the token", "--files", "src/auth/session.ts", "--tags", "auth");
save("--local", "--type", "attempt_failed", "--title", "Retrying 401s in the fetch wrapper", "--symptoms", "401 loop", "--solution", "hid the race instead of fixing it; reverted", "--files", "src/http/fetch.ts", "--tags", "auth");
save("--local", "--type", "decision", "--title", "Sessions stay in httpOnly cookies", "--solution", "no tokens in localStorage", "--files", "src/auth/session.ts", "--tags", "auth,security");
save("--local", "--type", "note", "--title", "Payment webhook needs the raw body", "--solution", "mount express.raw before express.json", "--files", "src/pay/webhook.ts", "--tags", "payments");
save("--local", "--type", "solved", "--title", "Webhook signature fails behind the proxy", "--solution", "verify against the raw body, not the parsed JSON", "--files", "src/pay/webhook.ts", "--tags", "payments");
save("--global", "--type", "solved", "--title", "Fake timers for flaky time-based tests", "--solution", "vi.useFakeTimers() and advance explicitly", "--tags", "testing");

const serve = (args, port) => {
  // detached: own process group, so killing it also stops the python child of `sessions serve`
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repo, env, stdio: "ignore", detached: true });
  return { child, url: `http://127.0.0.1:${port}/` };
};
const sessionsServer = serve(["sessions", "serve", "18787"], 18787);
const graphServer = serve(["graph", "--serve", "--port", "18788"], 18788);
await new Promise((r) => setTimeout(r, 1500));

fs.mkdirSync(OUT, { recursive: true });
let browser;
try {
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.goto(sessionsServer.url + "sessions");
    await page.waitForSelector(".sess");
    await page.screenshot({ path: path.join(OUT, `sessions-${scheme}.png`) });
    await page.goto(graphServer.url);
    await page.waitForTimeout(2500);
    await page.click("svg.graph g[cursor=pointer] >> text=Login fails after token refresh").catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `memories-${scheme}.png`) });
    await page.close();
  }
} finally {
  await browser?.close();
  for (const { child } of [sessionsServer, graphServer]) { try { process.kill(-child.pid); } catch { /* already gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`screenshots written to ${path.relative(ROOT, OUT)}/`);
