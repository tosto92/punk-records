// Files a Claude Code / Codex tool call proves it wrote. Only tools whose input
// names the file count, as in the OpenCode plugin's WRITE_TOOLS table.

// tool_name of Codex file edits in PostToolUse payloads (docs/claude-codex-compatibility.md F4).
export const CODEX_PATCH_TOOL = 'apply_patch';
const PATCH_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
const one = v => (typeof v === 'string' && v.trim() ? [v.trim()] : []);

function patchFiles(input) {
  const texts = [input?.input, input?.patch, input?.command].flat().filter(v => typeof v === 'string');
  const text = texts.find(t => t.includes('*** Begin Patch')) ?? '';
  return [...text.matchAll(PATCH_LINE)].map(m => m[1].trim()).filter(Boolean);
}

const TOOLS = {
  claude: {
    Write: i => one(i?.file_path),
    Edit: i => one(i?.file_path),
    MultiEdit: i => one(i?.file_path),
    NotebookEdit: i => one(i?.notebook_path),
  },
  codex: {[CODEX_PATCH_TOOL]: patchFiles},
};

export const MATCHERS = Object.fromEntries(Object.entries(TOOLS).map(([agent, tools]) => [agent, Object.keys(tools).join('|')]));

export function writtenFiles(agent, tool, input) {
  if (!Object.hasOwn(TOOLS, agent) || !Object.hasOwn(TOOLS[agent], tool)) return [];
  try { return TOOLS[agent][tool](input); } catch { return []; }
}
