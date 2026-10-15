// Private operator-file bridge into the existing Web Host. No HTTP endpoint.
// The state directory is outside every sandbox mount and is never model-writable.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const name = 'argon-operator-poc-bridge';
export const inject = ['sessionController', 'workspaceRegistry', 'agentPresets'];
const state = new URL('./state/', import.meta.url);
const load = async (file, fallback) => {
  try { return JSON.parse(await readFile(new URL(file, state), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const save = (file, data) => writeFile(new URL(file, state), JSON.stringify(data, null, 2), { mode: 0o600 });

export function apply(ctx) {
  let busy = false;
  let closed = false;
  const pump = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      const records = await load('sandboxes.json', {});
      const sessions = await load('poc-sessions.json', {});
      const handled = await load('poc-handled.json', {});
      const requests = await load('poc-requests.json', []);
      for (const request of requests) {
        if (closed || handled[request.requestId]) continue;
        const record = records[request.ownerId];
        if (!record || record.sandbox_id !== request.sandboxId || typeof request.prompt !== 'string') {
          throw new Error('Operator request has no matching sandbox owner binding');
        }
        if (!sessions[request.ownerId]) {
          const workspace = await ctx.workspaceRegistry.create(record.workspace_path, 'Sandbox ' + request.ownerId);
          const session = await ctx.sessionController.create({ workspaceId: workspace.id, cwd: record.workspace_path, agentPreset: 'argon-' + request.ownerId });
          sessions[request.ownerId] = { ...session, sandboxId: record.sandbox_id };
          await save('poc-sessions.json', sessions);
          await ctx.sessionController.rename({ sessionId: session.sessionId, title: 'M1 Sandbox ' + request.ownerId + ' / Nova' });
        }
        await ctx.sessionController.prompt({
          requestId: request.requestId,
          sessionId: sessions[request.ownerId].sessionId,
          mode: 'queue', content: [{ type: 'text', text: request.prompt }], clientTimeZone: 'Asia/Shanghai',
        }, new AbortController().signal);
        handled[request.requestId] = { accepted: true, sessionId: sessions[request.ownerId].sessionId };
        await save('poc-handled.json', handled);
      }
      for (const [owner, session] of Object.entries(sessions)) {
        const workspace = await ctx.workspaceRegistry.create(records[owner].workspace_path, 'Sandbox ' + owner);
        await workspace.attachSession(session.sessionId);
        const inspection = await ctx.sessionController.inspect(session.sessionId);
        await save('session-' + owner + '.json', inspection);
      }
    } catch (error) {
      await save('bridge-error.json', { message: error.message });
    } finally { busy = false; }
  };
  ctx.effect(() => {
    const timer = setInterval(() => { void pump(); }, 1500);
    return () => { closed = true; clearInterval(timer); };
  });
}
