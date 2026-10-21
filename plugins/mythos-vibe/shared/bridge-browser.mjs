// Browser-safe port of poc/vibe-coding-plugin/shared/bridge.js (client slice).
// No Node builtins: the vibe service serves this file to the client plugin.
import { safePath } from './bridge.mjs';

export { safePath };

const types = new Set(['native.ready', 'native.error', 'context.insert', 'context.ack', 'file.open', 'agent.activity']);

export async function openKnownSession(sessions, sessionId, navigate, isCurrent = () => true) {
  await sessions.refresh();
  if (!isCurrent()) return;
  if (sessions.list.getSnapshot().phase === 'pending') await new Promise((resolve, reject) => {
    let dispose = () => {};
    const timer = setTimeout(() => { dispose(); reject(new Error('Timed out waiting for the native session catalog')); }, 10000);
    const observe = () => { if (sessions.list.getSnapshot().phase !== 'pending') { clearTimeout(timer); dispose(); resolve(); } };
    dispose = sessions.list.subscribe(observe);
    observe();
  });
  if (!isCurrent()) return;
  if (!sessions.list.getSnapshot().byId[sessionId]) throw new Error('Session not yet in the catalog: ' + sessionId);
  navigate(sessionId);
}

export function acceptMessage(data, context) {
  if (context.origin !== context.expectedOrigin || context.source !== context.expectedSource) return false;
  if (!data || data.protocol !== 1 || !types.has(data.type) || typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 128) return false;
  for (const key of ['workItemId', 'sessionId', 'bindingId']) if (data[key] !== context.binding[key]) return false;
  if (data.type === 'context.insert' && (typeof data.text !== 'string' || !data.text || data.text.length > 16000)) return false;
  return true;
}

export function referenceText({ path, startLine, endLine, version, text }) {
  safePath(path);
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine || typeof text !== 'string' || text.length > 14000 || typeof version !== 'string') throw new Error('Invalid quote range');
  return `[${path}:${startLine}-${endLine} · ${version} · read-only snapshot]\n${text}`;
}

// Offsets refer to the original source, never to syntax token nodes or gutters.
export function referenceFromOffsets({ path, offset = 1, version, source, start, end }) {
  if (typeof source !== 'string' || !Number.isSafeInteger(offset) || offset < 1
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > source.length) throw new Error('Invalid quote range');
  return referenceText({
    path, version,
    startLine: offset + source.slice(0, start).split('\n').length - 1,
    endLine: offset + source.slice(0, end - 1).split('\n').length - 1,
    text: source.slice(start, end),
  });
}

export function fileNavigation(address, sessionId, params = {}) {
  try {
    const url = new URL(address);
    const prefix = '/session/' + encodeURIComponent(sessionId) + '/';
    if (url.protocol !== 'dsh-resource:' || url.host !== 'file' || !url.pathname.startsWith(prefix)) return null;
    const path = safePath(decodeURIComponent(url.pathname.slice(prefix.length)));
    const line = Number.isSafeInteger(params.line) && params.line > 0 ? params.line : 1;
    return { path, line };
  } catch { return null; }
}
