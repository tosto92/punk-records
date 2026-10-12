#!/usr/bin/env python3
"""Episodes: SQLite index of past Claude Code, Codex + OpenCode sessions across all projects.

usage:
  punk-records episodes [filter] [-n N]          recent episodes with resume command
  punk-records episodes timeline [filter] [-d D] day -> project -> episodes, last D days (default 7)
  punk-records episodes projects [filter]        one line per project: where you left off
  punk-records episodes show <id-prefix>         every prompt of one episode
  punk-records serve [--port n]                  web UI (memories + episodes) on http://127.0.0.1:4400/episodes
  sqlite3 ~/.local/share/punk-records/episodes.db  ad-hoc queries for new stores (tables: sessions, prompts; view: v)

Every run syncs incrementally from ~/.claude, ~/.codex and OpenCode's opencode.db
first (CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_DATA_HOME are honoured).
Read-only: agent files are never modified.
"""
import glob, json, os, re, shlex, sqlite3, sys, time
from collections import defaultdict
from pathlib import Path

H = Path.home()
CLAUDE = Path(os.environ.get("CLAUDE_CONFIG_DIR") or H / ".claude")
CODEX = Path(os.environ.get("CODEX_HOME") or H / ".codex")
OPENCODE = Path(os.environ.get("XDG_DATA_HOME") or H / ".local/share") / "opencode/opencode.db"
LEGACY_HOME = H / ".local/share/previously"
DB = Path(os.environ.get("PUNK_RECORDS_HOME") or os.environ.get("PREVIOUSLY_HOME") or
          (LEGACY_HOME if LEGACY_HOME.exists() else H / ".local/share/punk-records")) / "episodes.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, tool TEXT, cwd TEXT, project TEXT, branch TEXT, title TEXT,
  file TEXT, file_mtime REAL);
CREATE TABLE IF NOT EXISTS prompts(
  session_id TEXT, ts REAL, text TEXT, UNIQUE(session_id, ts, text));
CREATE INDEX IF NOT EXISTS prompts_ts ON prompts(ts);
CREATE VIEW IF NOT EXISTS v AS
  SELECT s.*, MIN(p.ts) started, MAX(p.ts) ended, COUNT(*) n,
    (SELECT text FROM prompts WHERE session_id=s.id ORDER BY ts LIMIT 1) first,
    (SELECT text FROM prompts WHERE session_id=s.id ORDER BY ts DESC LIMIT 1) last
  FROM sessions s JOIN prompts p ON p.session_id = s.id GROUP BY s.id;
"""


def jsonl(path):
    try:
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    pass
    except OSError:
        return


def project_of(cwd):
    """Worktrees roll up into their main repo; the branch tells them apart."""
    return re.sub(r"/\.(?:claude/)?worktrees/.*$", "", cwd or "?")


def sync(db):
    # Prompts: both tools keep a clean log of what the user typed.
    for tool, path, sid_k, ts_k, txt_k, scale in (
        ("claude", CLAUDE / "history.jsonl", "sessionId", "timestamp", "display", 1000),
        ("codex", CODEX / "history.jsonl", "session_id", "ts", "text", 1),
    ):
        for d in jsonl(path):
            sid, txt = d.get(sid_k), (d.get(txt_k) or "").strip()
            if not sid or not txt or txt.startswith("/"):  # slash commands are noise
                continue
            db.execute("INSERT OR IGNORE INTO prompts VALUES(?,?,?)", (sid, d.get(ts_k, 0) / scale, txt))
            db.execute("INSERT OR IGNORE INTO sessions(id, tool, cwd) VALUES(?,?,?)", (sid, tool, d.get("project")))

    # Metadata from session files, re-read only when the file changed.
    files = {Path(f).stem: f for f in glob.glob(str(CLAUDE / "projects/*/*.jsonl"))}
    for root, _, names in os.walk(CODEX / "sessions"):
        files.update({n[-42:-6]: os.path.join(root, n) for n in names if n.endswith(".jsonl")})  # rollout-…-<uuid>.jsonl
    codex_titles = {d["id"]: d.get("thread_name") for d in jsonl(CODEX / "session_index.jsonl") if "id" in d}

    for sid, tool, cwd, mtime, proj in db.execute("SELECT id, tool, cwd, file_mtime, project FROM sessions").fetchall():
        if tool == "opencode":
            continue
        f = files.get(sid)
        m = os.path.getmtime(f) if f else None
        # Unchanged file, or file gone (Claude deletes transcripts after ~30 days): keep what we have.
        if (f and m == mtime) or (not f and proj):
            continue
        title, branch = None, None
        if tool == "claude" and f:
            for d in jsonl(f):
                title = d.get("customTitle") or d.get("aiTitle") or title
                branch = d.get("gitBranch") or branch
                cwd = d.get("cwd") or cwd  # last cwd: lands on the worktree actually used
        elif tool == "codex":
            title = codex_titles.get(sid)
            if f:
                cwd = next(jsonl(f), {}).get("payload", {}).get("cwd", cwd)
        if branch == "HEAD":
            branch = None
        db.execute(
            "UPDATE sessions SET cwd=?, project=?, branch=?, title=?, file=?, file_mtime=? WHERE id=?",
            (cwd, project_of(cwd), branch, title, f, m, sid),
        )
    sync_opencode(db)
    db.commit()


def sync_opencode(db):
    if not OPENCODE.is_file():
        return
    source = sqlite3.connect(OPENCODE.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        known = dict(db.execute("SELECT id, file_mtime FROM sessions WHERE tool='opencode'"))
        for sid, cwd, title, updated in source.execute("SELECT id, directory, title, time_updated FROM session"):
            if known.get(sid) == updated:
                continue
            db.execute("""INSERT INTO sessions(id,tool,cwd,project,title,file,file_mtime) VALUES(?,?,?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, project=excluded.project,
                       title=excluded.title, file=excluded.file, file_mtime=excluded.file_mtime""",
                       (sid, "opencode", cwd, project_of(cwd), title, str(OPENCODE), updated))
            prompts = defaultdict(list)
            for mid, ts, message, part in source.execute("""SELECT m.id, m.time_created, m.data, p.data
                    FROM message m JOIN part p ON p.message_id=m.id
                    WHERE m.session_id=? ORDER BY m.time_created, p.id""", (sid,)):
                message, part = json.loads(message), json.loads(part)
                if message.get("role") != "user" or part.get("type") != "text" or part.get("synthetic") or part.get("ignored"):
                    continue
                text = (part.get("text") or "").strip()
                if text and not text.startswith("/"):
                    prompts[(mid, ts)].append(text)
            db.execute("DELETE FROM prompts WHERE session_id=?", (sid,))
            db.executemany("INSERT OR IGNORE INTO prompts VALUES(?,?,?)",
                           ((sid, ts / 1000, "\n".join(parts)) for (_, ts), parts in prompts.items()))
    finally:
        source.close()


def one(t, n=90):
    t = " ".join(str(t or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def short(p):
    return (p or "?").replace(str(H), "~")


def resume(r):
    sid = shlex.quote(r['id'])
    cmd = f"{ {'claude': 'claude --resume', 'codex': 'codex resume', 'opencode': 'opencode --session'}[r['tool']]} {sid}"
    return f"cd {shlex.quote(str(r['cwd']))} && {cmd}"


def hhmm(ts, fmt="%H:%M"):
    return time.strftime(fmt, time.localtime(ts))


FLT = """ AND ((project || ' ' || IFNULL(title,'') || ' ' || IFNULL(branch,'')) LIKE ?
         OR EXISTS (SELECT 1 FROM prompts matched WHERE matched.session_id = v.id AND matched.text LIKE ?))"""


def rows(db, flt, since=0):
    q = "SELECT * FROM v WHERE ended >= ?"
    args = [since]
    if flt:
        q += FLT
        args.extend([f"%{flt}%"] * 2)
    return db.execute(q + " ORDER BY ended DESC", args).fetchall()


B, D, R = ("\033[1m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "", "")


def cmd_recent(db, flt, n):
    for r in rows(db, flt)[:n]:
        br = f" [{r['branch']}]" if r["branch"] else ""
        print(f"{B}{hhmm(r['ended'], '%m-%d %H:%M')}  {r['tool']:6}  {short(r['project'])}{br}{R}")
        if r["title"]:
            print(f"   title: {one(r['title'])}")
        print(f"   first: {one(r['first'])}")
        if r["n"] > 1:
            print(f"   last:  {one(r['last'])}  ({r['n']} prompts)")
        print(f"   {D}{resume(r)}{R}\n")


def timeline_rows(db, flt, days):
    """One row per (day, session): a session spanning days shows on each day it had prompts."""
    q = f"""SELECT v.*, date(p.ts,'unixepoch','localtime') day, MIN(p.ts) t0, MAX(p.ts) t1, COUNT(*) dn
            FROM prompts p JOIN v ON v.id = p.session_id
            WHERE p.ts >= ? AND v.id IN (SELECT id FROM v WHERE 1{FLT if flt else ''})
            GROUP BY day, v.id ORDER BY day DESC, t1 DESC"""
    return db.execute(q, [time.time() - days * 86400] + ([f"%{flt}%"] * 2 if flt else [])).fetchall()


def project_rows(db, flt):
    args = [f"%{flt}%"] * 2 if flt else []
    matched = f" AND s.id IN (SELECT id FROM v WHERE 1{FLT})" if flt else ""
    q = f"""SELECT project, COUNT(*) ns, SUM(n) np, MAX(ended) last_ts,
                  (SELECT COUNT(DISTINCT date(p.ts,'unixepoch','localtime')) FROM prompts p
                   JOIN sessions s ON s.id = p.session_id WHERE s.project = v.project{matched}) days
           FROM v WHERE 1{FLT if flt else ''} GROUP BY project ORDER BY last_ts DESC"""
    out = []
    for p in db.execute(q, args * 2):
        r = db.execute(f"SELECT * FROM v WHERE project=?{FLT if flt else ''} ORDER BY ended DESC LIMIT 1", [p["project"], *args]).fetchone()
        out.append({**dict(p), "last": dict(r)})
    return out


def session_prompts(db, sid):
    s = db.execute("SELECT * FROM v WHERE id = ? OR id LIKE ?", (sid, f"{sid}%")).fetchone()
    ps = db.execute("SELECT ts, text FROM prompts WHERE session_id=? ORDER BY ts", (s["id"],)).fetchall() if s else []
    return s, ps


def cmd_timeline(db, flt, days):
    tree = defaultdict(lambda: defaultdict(list))
    for r in timeline_rows(db, flt, days):
        tree[r["day"]][r["project"]].append(r)
    for day, projects in tree.items():
        print(f"\n{B}── {day} ──{R}")
        for proj, ss in sorted(projects.items(), key=lambda kv: -kv[1][0]["t1"]):
            print(f"  {B}{short(proj)}{R}  {D}{len(ss)} episodes, {sum(s['dn'] for s in ss)} prompts{R}")
            for s in ss:
                br = f" [{s['branch']}]" if s["branch"] else ""
                print(f"    {hhmm(s['t0'])}-{hhmm(s['t1'])}  {s['tool']:6} {one(s['title'] or s['first'], 70)}{D}{br}  {s['id'][:8]}{R}")


def cmd_projects(db, flt):
    for p in project_rows(db, flt):
        r = p["last"]
        print(f"{B}{hhmm(p['last_ts'], '%Y-%m-%d %H:%M')}  {short(p['project'])}{R}  "
              f"{D}{p['ns']} episodes, {p['np']} prompts, {p['days']} days{R}")
        print(f"   last:  {one(r['title'] or r['first'], 80)}")
        print(f"   {D}{resume(r)}{R}")


def cmd_show(db, sid):
    s, ps = session_prompts(db, sid)
    if not s:
        sys.exit(f"sessione {sid} non trovata")
    print(f"{B}{s['tool']}  {short(s['project'])}{' [' + s['branch'] + ']' if s['branch'] else ''}  {s['title'] or ''}{R}")
    for p in ps:
        print(f"{D}{hhmm(p['ts'], '%m-%d %H:%M')}{R}  {p['text']}")
    print(f"\n{D}{resume(s)}{R}")


def open_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    sync(db)
    return db


def api(path, query):
    """JSON for the web UI (served by `punk-records serve` at /episodes)."""
    from urllib.parse import parse_qs
    q = {k: v[0] for k, v in parse_qs(query).items()}
    db = open_db()
    if path == "/api/data":
        flt, days = q.get("q", ""), int(q.get("days", 7))
        tl = [dict(r) | {"resume": resume(r)} for r in timeline_rows(db, flt, days)]
        pr = [p | {"resume": resume(p["last"])} for p in project_rows(db, flt)]
        return {"timeline": tl, "projects": pr}
    if path == "/api/session":
        s, ps = session_prompts(db, q.get("id", ""))
        return {"session": dict(s) | {"resume": resume(s)}, "prompts": [dict(p) for p in ps]} if s else {}
    sys.exit(f"unknown api path: {path}")


def main(argv):
    if argv[:1] in (["-h"], ["--help"], ["help"]):
        return print(__doc__.strip())
    def opt(k, default):
        if k not in argv:
            return default
        i = argv.index(k)
        v = int(argv[i + 1])
        del argv[i : i + 2]
        return v

    n, days = opt("-n", 20), opt("-d", 7)
    if argv[:1] == ["api"]:
        return print(json.dumps(api(argv[1], argv[2] if len(argv) > 2 else "")))
    cmd = argv.pop(0) if argv and argv[0] in ("timeline", "projects", "show") else "recent"
    flt = argv[0] if argv else ""

    db = open_db()
    if cmd == "timeline":
        cmd_timeline(db, flt, days)
    elif cmd == "projects":
        cmd_projects(db, flt)
    elif cmd == "show":
        cmd_show(db, flt)
    else:
        cmd_recent(db, flt, n)

if __name__ == "__main__":
    assert project_of("/p/Repo/.worktrees/feat-x") == "/p/Repo"
    assert project_of("/p/Repo/.claude/worktrees/a/sub") == "/p/Repo"
    assert project_of("/p/Repo") == "/p/Repo"
    try:
        main(sys.argv[1:])
    except BrokenPipeError:
        pass
