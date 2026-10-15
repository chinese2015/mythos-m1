import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';

const defaultRoot = resolve(homedir(), 'argon-sandboxes');
const under = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel));
};

export const isSandboxPreset = (preset) =>
  typeof preset === 'string' && /^(preset-)?argon(-|$)/.test(preset);

export function shouldCapture(session, root = defaultRoot) {
  // Sandbox-preset sessions never touch host change capture, even if a
  // session header cwd resolves outside the protected sandbox root.
  if (isSandboxPreset(session?.header?.agentPreset)) return false;
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string') return true;
  root = resolve(root);
  if (under(root, resolve(cwd))) return false;
  try {
    if (under(root, realpathSync(cwd))) return false;
  } catch {
    // Missing ordinary paths retain upstream behavior; sandbox lexical paths
    // were already excluded, including links that point outside the container.
  }
  return true;
}

export function guardSessionEvents(listener, root = defaultRoot) {
  return function (session, ...args) {
    if (!shouldCapture(session, root)) return;
    return listener.call(this, session, ...args);
  };
}

// Pre-execution file capture runs before file-tool edits. Resolve the preset
// from the agent context so a sandbox preset cannot create a host recorder
// even when the session cwd is not under the sandbox root.
export function guardToolCapture(capture, getPreset = (context) => context?.preset) {
  return async function (context, proceed) {
    const preset = context?.agent?.ctx?.preset;
    const resolved = preset === undefined ? context : { ...context, preset };
    if (isSandboxPreset(getPreset(resolved))) {
      await proceed?.call(this, context);
      return;
    }
    await capture.call(this, context, proceed);
  };
}
