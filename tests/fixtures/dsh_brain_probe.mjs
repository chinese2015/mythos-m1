// Optional trusted operator acceptance bridge in the existing DSH Web Host.
// Never register this as an Agent tool or expose its files in a sandbox.
import { readFile, writeFile } from 'node:fs/promises';
export const name = 'mythos-brain-acceptance-probe';
export const inject = ['mythosBrain', 'sessionController'];
const requestFile = new URL('../../state/brain-host-request.json', import.meta.url);
const resultFile = new URL('../../state/brain-host-result.json', import.meta.url);
export function apply(ctx) {
  let busy = false, closed = false;
  const pump = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      let request;
      try { request = JSON.parse(await readFile(requestFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      try { if (JSON.parse(await readFile(resultFile, 'utf8')).requestId === request.requestId) return; } catch {}
      let result;
      if (request.action === 'prepare') result = await ctx.mythosBrain.prepareSession(request.owner, request.requestId);
      else if (request.action === 'prompt') result = await ctx.mythosBrain.promptSession(request.owner, request.sessionId, request.prompt, request.requestId);
      else if (request.action === 'inspect') result = await ctx.sessionController.inspect(request.sessionId);
      else if (request.action === 'dispose') result = { disposed: true };
      else throw new Error('Unknown acceptance action');
      if (!closed) await writeFile(resultFile, JSON.stringify({ requestId: request.requestId, ok: true, result }, null, 2), { mode: 0o600 });
      if (request.action === 'dispose') { closed = true; queueMicrotask(() => { void ctx.fiber.dispose(); }); }
    } catch (error) {
      if (!closed) await writeFile(resultFile, JSON.stringify({ ok: false, message: String(error.message) }), { mode: 0o600 });
    } finally { busy = false; }
  };
  ctx.effect(() => { const timer = setInterval(() => { void pump(); }, 250); return () => { closed = true; clearInterval(timer); }; });
}
