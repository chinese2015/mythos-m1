import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { codingHandler } from '../plugins/argon-coding/index.mjs';
const id = 'work-' + 'a'.repeat(32);
async function server(t) {
  const calls = [];
  const workflow = { detail: async key => { if (key !== id) throw Object.assign(new Error('not owned'), { status: 404 }); return { workItem: { workItemId: key }, session: { sessionId: 'session-owned' } }; } };
  const files = { list: async (...args) => { calls.push(args); return { entries: [] }; }, read: async (...args) => { calls.push(args); return { text: 'sandbox content' }; } };
  const handler = codingHandler({ workflow, files, connection: { requestRejection: ({ headers }) => headers.cookie !== 'owned' ? 401 : headers.origin === 'https://foreign.example' ? 403 : null }, assetReader: async () => Buffer.from('asset') });
  const app = createServer(handler); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  const base = 'http://127.0.0.1:' + app.address().port;
  const call = (path, options={}) => fetch(base + '/argon/coding' + path, { headers: { cookie: 'owned', ...options.headers }, ...options });
  return { call, calls };
}
test('coding routes retain authentication, origin checks and task owner authority', async t => {
  const h = await server(t);
  assert.equal((await h.call('/api/work-items/'+id+'/context', { headers: {} })).status, 401);
  assert.equal((await h.call('/api/work-items/'+id+'/context', { headers: { cookie:'owned', origin:'https://foreign.example' } })).status, 403);
  assert.equal((await h.call('/api/work-items/work-'+'b'.repeat(32)+'/context')).status, 404);
  const response = await h.call('/api/work-items/'+id+'/context'); assert.equal(response.status,200); assert.equal((await response.json()).session.sessionId,'session-owned');
  assert.equal(h.calls.length,0);
});
test('read endpoints accept only bounded relative path inputs and refuse all mutation methods', async t => {
  const h = await server(t), prefix='/api/work-items/'+id;
  for (const path of [prefix+'/files?path=src',prefix+'/file?path=src%2FFix.java']) assert.equal((await h.call(path)).status,200);
  assert.equal(h.calls[0][0],id); assert.equal(h.calls[1][1],'src/Fix.java'); assert.equal(h.calls[1][2] instanceof AbortSignal,true);
  for (const path of [prefix+'/file',prefix+'/file?path=a&path=b',prefix+'/file?path=a&sessionId=other',prefix+'/files?offset=-1']) assert.equal((await h.call(path)).status,400);
  for (const method of ['POST','PUT','DELETE']) assert.equal((await h.call(prefix+'/file?path=a',{method})).status,405);
  assert.equal((await h.call('/api/unknown')).status,404);
});
test('only exact assets are served with a same-origin policy and safe upstream errors', async t => {
  const h = await server(t);
  const asset=await h.call('/app.js'); assert.equal(asset.status,200); assert.match(asset.headers.get('content-security-policy'),/frame-src 'self'/);
  assert.equal((await h.call('/private.json')).status,404);
  assert.equal((await h.call('/client.js')).status,404);
});
