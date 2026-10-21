import { readFile } from 'node:fs/promises';
export const name = 'mythos-console';
export const inject = ['webServer', 'connection', 'mythosWorkflow', 'mythosSdlc', 'mythosSubscribe'];
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/intake-view.js', ['intake-view.js', 'text/javascript; charset=utf-8']], ['/delivery-view.js', ['delivery-view.js', 'text/javascript; charset=utf-8']], ['/monitor-view.js', ['monitor-view.js', 'text/javascript; charset=utf-8']], ['/monitor-state.js', ['monitor-state.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
for (const asset of ['plan-view.js', 'plan-markdown.js', 'vendor/markdown-it.esm.min.mjs']) assets.set('/' + asset, [asset, 'text/javascript; charset=utf-8']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
async function bodyOf(req, maxBytes = 20000) {
  if (req.headers['x-mythos-action'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw failure('JSON workspace action request required', 415);
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(key)) throw failure('Missing a valid action idempotency key');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw failure('Request too large', 413); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw failure('Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Request body must be an object');
  return { body, key };
}
export function consoleHandler({ connection, workflow, sdlc, subscribe, assetReader = name => readFile(new URL('./public/' + name, import.meta.url)) }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://dsh.invalid');
      if (url.pathname === '/mythos') { res.writeHead(302, { Location: '/mythos/' }); res.end(); return; }
      const path = url.pathname.slice('/mythos'.length);
      // The push intake endpoint is unauthenticated for the demo: the mock source and IM links have no DSH session.
      const rejection = path === '/api/source-findings' ? null : connection.requestRejection({ headers: req.headers });
      if (rejection) return json(res, rejection, { error: rejection === 401 ? 'Sign in on the DSH main page first' : 'Request origin is not trusted' });
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' || !assets.has(path)) throw failure('Page not found', 404);
        const [name, type] = assets.get(path);
        const bytes = await assetReader(name);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" });
        res.end(bytes); return;
      }
      const parts = path.slice(5).split('/');
      if (req.method === 'GET') {
        if (path === '/api/tasks') return json(res, 200, await workflow.tasks());
        if (path === '/api/repositories') return json(res, 200, await workflow.intake.repositories());
        if (path === '/api/work-items') return json(res, 200, { workItems: await workflow.listWorks() });
        if (parts[0] === 'work-items' && parts.length === 2) return json(res, 200, await workflow.detail(parts[1]));
        if (parts[0] === 'operations' && parts.length === 3 && parts[2] === 'logs') {
          const after = Number(url.searchParams.get('after') ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw failure('Invalid log cursor');
          return json(res, 200, await workflow.logs(parts[1], after));
        }
        if (parts[0] === 'work-items' && parts.length === 3 && parts[2] === 'events') {
          const after = Number(url.searchParams.get('after') ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw failure('Invalid event cursor');
          return json(res, 200, await workflow.events(parts[1], after));
        }
      }
      if (req.method === 'POST') {
        const workAction = parts[0] === 'work-items' && parts.length === 3;
        const intakeAction = parts[0] === 'repositories' || (parts[0] === 'tasks' && parts[1] === 'manual');
        const maxBytes = workAction && parts[2] === 'modify-plan' ? 400000 : workAction && parts[2] === 'message' ? 100000 : intakeAction ? 65536 : 20000;
        const { body, key } = await bodyOf(req, maxBytes);
        if (parts[0] === 'source-findings' && parts.length === 1) return json(res, 202, await workflow.ingest(body, key));
        if (path === '/api/repositories') return json(res, 201, await workflow.intake.register(body, key));
        if (path === '/api/tasks/manual') return json(res, 202, await workflow.intake.create(body, key));
        if (parts[0] === 'repositories' && parts.length === 3 && parts[2] === 'revisions') return json(res, 200, await workflow.intake.revise(parts[1], body, key));
        if (parts[0] === 'repositories' && parts.length === 3 && parts[2] === 'check') return json(res, 200, await workflow.intake.check(parts[1]));
        if (parts[0] === 'tasks' && parts[2] === 'decide' && parts.length === 3) return json(res, 200, await subscribe.decide(parts[1], body, key));
        if (parts[0] === 'tasks' && parts[2] === 'start' && parts.length === 3) return json(res, 202, await workflow.start(parts[1], body, key));
        if (parts[0] === 'work-items' && parts.length === 3) {
          if (parts[2] === 'publish-pr') return json(res, 202, await sdlc.publish(parts[1], body, key));
          if (parts[2] === 'refresh-pr') return json(res, 200, await sdlc.refresh(parts[1], body, key));
          if (parts[2] === 'approve-plan') return json(res, 202, await workflow.approve(parts[1], body, key));
          if (parts[2] === 'modify-plan') return json(res, 200, await workflow.modifyPlan(parts[1], body, key));
          if (['pause','resume'].includes(parts[2])) return json(res, 200, await workflow.pause(parts[1], parts[2] === 'pause', body, key));
          if (parts[2] === 'message') return json(res, 202, await workflow.message(parts[1], body, key));
        }
        if (parts[0] === 'operations' && parts[2] === 'cancel' && parts.length === 3) return json(res, 202, await workflow.cancel(parts[1], body, key));
      }
      throw failure('Endpoint not found', 404);
    } catch (error) {
      const status = error.status >= 400 && error.status <= 599 ? error.status : 503;
      json(res, status, { error: error.status ? error.message : 'Workflow service temporarily unavailable, refresh to see the latest state' });
    }
  };
}
export function apply(ctx) {
  const handler = consoleHandler({ connection: ctx.connection, workflow: ctx.mythosWorkflow.controller, sdlc: ctx.mythosSdlc.controller, subscribe: ctx.mythosSubscribe.controller });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/mythos', handler }));
}
