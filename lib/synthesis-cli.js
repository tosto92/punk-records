import {resolveScopes, globalDir, repoDir} from './paths.js';
import {prepareSynthesis, applySynthesis, synthesisStatus, removeSynthesis, readSynthesisJSON} from './synthesis.js';

export function runSynthesis(args) {
  const [command, ...flags] = args;
  if (!['prepare', 'apply', 'status', 'remove'].includes(command)) throw new Error('synth requires prepare, apply, status or remove');
  let explicit = null, group, input, memoryRefs, files;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--global' || flag === '--local') {
      const selected = flag.slice(2);
      if (explicit && explicit !== selected) throw new Error('--global and --local are mutually exclusive');
      explicit = selected; continue;
    }
    if (!['--group', '--input', '--memory', '--file'].includes(flag)) throw new Error(`unknown synth flag: ${flag}`);
    const value = flags[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--group') group = value;
    if (flag === '--input') input = value;
    if (flag === '--memory') (memoryRefs ??= []).push(value);
    if (flag === '--file') (files ??= []).push(value);
  }
  if (command !== 'prepare' && (memoryRefs || files) || command !== 'apply' && input || ['apply', 'status'].includes(command) && group) throw new Error('flags do not apply to this synth command');
  const resolved = resolveScopes({explicit}), local = resolved.writes[0] === 'local';
  if (local && !resolved.repoRoot) throw new Error('local scope requested outside a project');
  const options = {store: local ? repoDir(resolved.repoRoot) : globalDir(), scope: local ? 'repo' : 'global'};
  if (command === 'prepare') return prepareSynthesis({...options, group, memoryRefs, files});
  if (command === 'apply') {
    if (!input) throw new Error('synth apply requires --input response.json');
    return applySynthesis({...options, response: readSynthesisJSON(input)});
  }
  if (command === 'remove') return removeSynthesis({...options, group});
  return synthesisStatus(options);
}
