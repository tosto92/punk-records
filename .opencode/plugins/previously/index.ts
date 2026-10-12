// Punk Records OpenCode plugin: smart recall + automatic session capture.
// Capture writes ONE draft per session (type note, outcome open, tags [auto])
// when the session goes idle — promoted later via `punk-records save --ref <slug>`.
// Same default export serves OpenCode V1 (`server`) and V2 (`setup`); the two
// adapters share recall, save and capture from lib/, and never spawn the CLI
// (the host may be a compiled Bun binary, not Node).
import fs from "node:fs";
import path from "node:path";
import { createCapture, diagnostic } from "../../../lib/capture.js";
import { recallBlock, relative } from "../../../lib/recall.js";

// Only tools whose native result names the written file prove a session edit.
const autosave = () => process.env.PREVIOUSLY_AUTOSAVE !== "0";
const paths = (candidates: any[]) => candidates.filter((f) => typeof f === "string" && f.trim());
const WRITE_TOOLS: Record<string, (input: any, output: any) => any[]> = {
  write: (i, o) => paths([i?.filePath, i?.path, o?.target, o?.metadata?.filepath]),
  edit: (i, o) => [
    ...paths([i?.filePath, i?.path, o?.filediff?.file, o?.file, o?.metadata?.filediff?.file]),
    ...(Array.isArray(o?.files) ? o.files : []).map((f: any) => f?.file ?? f),
  ],
  patch: (_, o) => (Array.isArray(o?.files) ? o.files : []).map((f: any) => f?.file),
  apply_patch: (_, o) => (Array.isArray(o?.metadata?.files) ? o.metadata.files : []).map((f: any) => f?.file),
  multiedit: (i) => (Array.isArray(i?.filePath) ? i.filePath : paths([i?.filePath, i?.path])),
};

function promptText(...candidates: any[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    const text = c?.prompt?.text ?? c?.text ?? c?.message?.content;
    if (typeof text === "string" && text.trim()) return text.trim();
    const parts = c?.parts;
    if (Array.isArray(parts)) {
      const joined = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join(" ")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

function inject(output: any, block: string, asTextObject: boolean): void {
  if (!block || !Array.isArray(output?.system)) return;
  // V1 system entries are plain strings; V2 uses {type:"text", text} objects.
  output.system.push(asTextObject ? { type: "text", text: block } : block);
}

// ---------------------------------------------------------------- V1 adapter
async function server(input: any) {
  const cwd = typeof input?.directory === "string" && input.directory ? input.directory : process.cwd();
  const capture = createCapture({ cwd });
  const prompts = new Map<string, string>();
  // Sessions seen outside this project must never write into its store.
  const foreign = new Set<string>();
  const deleted = new Set<string>();
  const owns = (sid: unknown): sid is string =>
    typeof sid === "string" && !!sid && !foreign.has(sid) && !deleted.has(sid);

  return {
    "chat.message": async (hookInput: any, hookOutput: any) => {
      try {
        const sid = hookInput?.sessionID;
        if (owns(sid)) {
          const text = promptText(hookOutput, hookInput);
          if (text) {
            prompts.set(sid, text);
            capture.prompt(sid, text);
          }
        }
      } catch {
        /* never throw */
      }
    },

    // Recall: push top-3 hits into the system prompt. Fail-open.
    "experimental.chat.system.transform": async (hookInput: any, output: any) => {
      try {
        const sid = hookInput?.sessionID;
        inject(output, await recallBlock(owns(sid) ? prompts.get(sid) ?? "" : "", cwd), false);
      } catch {
        /* never throw from a hook */
      }
    },

    "tool.execute.after": async (hookInput: any, output: any) => {
      try {
        const sid = hookInput?.sessionID;
        const pick = WRITE_TOOLS[hookInput?.tool];
        // A tool that threw produced no file; an unattributed shell run produced none either.
        if (!owns(sid) || !pick || !autosave() || output?.error) return;
        const files = pick(hookInput.args, output).map((f) => relative(cwd, f)).filter(Boolean) as string[];
        if (files.length) capture.edit(sid, files);
      } catch {
        /* never throw */
      }
    },

    event: async ({ event }: any) => {
      try {
        const info = event?.properties?.info;
        const sid = event?.properties?.sessionID ?? info?.id ?? event?.sessionID;
        const type = event?.type;
        if (typeof sid !== "string" || !sid) return;
        if (type === "session.created") {
          const dir = info?.directory ?? event?.properties?.directory;
          if (typeof dir === "string" && path.resolve(dir) !== path.resolve(cwd)) foreign.add(sid);
        } else if (type === "session.deleted") {
          deleted.add(sid);
          capture.forget(sid);
          prompts.delete(sid);
        } else if (type === "session.idle") {
          await capture.idle(sid);
        }
      } catch (err: any) {
        diagnostic(err?.message ?? String(err));
      }
    },
  };
}

// ---------------------------------------------------------------- V2 adapter
async function setup(ctx: any) {
  const cwd =
    typeof ctx?.location?.directory === "string" && ctx.location.directory
      ? ctx.location.directory
      : process.cwd();
  const capture = createCapture({ cwd });
  const prompts = new Map<string, string>();
  const owns = new Map<string, boolean>(); // sessionID -> belongs to this project
  const registrations: any[] = [];
  const waits = new Map<string, AbortController>();
  const events = new AbortController();

  const owned = async (sid: unknown): Promise<boolean> => {
    if (typeof sid !== "string" || !sid) return false;
    if (!owns.has(sid)) {
      try {
        const session = await ctx?.session?.get?.({ sessionID: sid });
        const dir = session?.location?.directory;
        owns.set(sid, typeof dir === "string" && path.resolve(dir) === path.resolve(cwd));
      } catch {
        owns.set(sid, false);
      }
    }
    return owns.get(sid) === true;
  };

  // V2 has no idle event hook: wait for the turn boundary in the background so
  // the tool hook never waits on the session it is reporting for.
  const awaitIdle = (sid: string) => {
    if (waits.has(sid)) return;
    const controller = new AbortController();
    waits.set(sid, controller);
    void ctx.session
      .wait({ sessionID: sid }, { signal: controller.signal })
      .then(() => capture.idle(sid))
      .catch(() => {})
      .finally(() => waits.delete(sid));
  };

  const register = async (name: string, fn: any) => {
    try {
      const registration = await ctx?.tool?.hook?.(name, fn);
      if (registration) registrations.push(registration);
    } catch (err: any) {
      diagnostic(err?.message ?? String(err));
    }
  };

  await register("execute.after", async (event: any) => {
    try {
      const sid = event?.sessionID;
      const pick = WRITE_TOOLS[event?.tool];
      if (!pick || !autosave() || event?.status !== "completed" || !(await owned(sid))) return;
      const result = event?.result?.output ?? {};
      const files = pick(event.input, result).map((f) => relative(cwd, f))
        .filter(Boolean) as string[];
      if (!files.length) return;
      capture.edit(sid, files);
      awaitIdle(sid);
    } catch (err: any) {
      diagnostic(err?.message ?? String(err));
    }
  });

  try {
    const onPrompt = await ctx?.session?.hook?.("prompt", async (event: any) => {
      const sid = event?.sessionID;
      if (!(await owned(sid))) return;
      const text = promptText(event).slice(0, 500);
      prompts.set(sid, text);
      if (text) capture.prompt(sid, text);
    });
    if (onPrompt) registrations.push(onPrompt);
    const onContext = await ctx?.session?.hook?.("context", async (event: any) => {
      const sid = event?.sessionID;
      inject(event, await recallBlock((await owned(sid)) ? prompts.get(sid) ?? "" : "", cwd), true);
    });
    if (onContext) registrations.push(onContext);
  } catch (err: any) {
    diagnostic(err?.message ?? String(err));
  }

  try {
    const stream = ctx?.event?.subscribe?.({ signal: events.signal });
    if (stream?.[Symbol.asyncIterator]) {
      void (async () => {
        try {
          for await (const event of stream) {
            const sid = event?.data?.sessionID ?? event?.data?.info?.id;
            if (typeof sid !== "string" || !sid) continue;
            if (event?.type === "session.deleted") {
              owns.delete(sid);
              prompts.delete(sid);
              waits.get(sid)?.abort();
              capture.forget(sid);
            }
          }
        } catch {
          /* aborted or fail-silent */
        }
      })();
    }
  } catch (err: any) {
    diagnostic(err?.message ?? String(err));
  }

  return () => {
    events.abort();
    for (const controller of waits.values()) controller.abort();
    waits.clear();
    for (const registration of registrations) registration?.dispose?.();
    registrations.length = 0;
    capture.dispose();
  };
}

export default { id: "punk-records", server, setup };
