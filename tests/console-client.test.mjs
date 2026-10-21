import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
async function fixture({ reentrant = false } = {}) {
  let plugin; const callbacks = new Set(), cleanups = [], opened = [];
  const state = { byId: {} };
  runInNewContext(await readFile(new URL('../plugins/mythos-console/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(); } } }, URLSearchParams,
    location: { search: '?mythosSession=session-code&mythosEmbedded=1' }, console,
  });
  const ctx = { effect(fn) { cleanups.push(fn()); },
    sessions: { list: { getSnapshot: () => state, subscribe(fn) { callbacks.add(fn); return () => callbacks.delete(fn); } } },
    uiWorkspace: { openSession(id) { assert.ok(state.byId[id], 'must not retain a session before the authoritative catalog knows it'); if (reentrant) for (const fn of callbacks) fn(); opened.push(id); } },
  };
  return { plugin, ctx, state, opened, notify: () => { for (const fn of callbacks) fn(); }, dispose: () => { for (const fn of cleanups) fn?.(); } };
}
test('native task navigation waits for the catalog before retaining a Session and selects it once', async () => {
  const f = await fixture(); assert.doesNotThrow(() => f.plugin.apply(f.ctx)); assert.deepEqual(f.opened, []);
  f.state.byId['session-code'] = {}; f.notify(); f.notify(); assert.deepEqual(f.opened, ['session-code']); f.dispose();
});
test('disposing the client before catalog arrival removes pending navigation', async () => {
  const f = await fixture(); f.plugin.apply(f.ctx); f.dispose(); f.state.byId['session-code'] = {}; f.notify(); assert.deepEqual(f.opened, []);
});
test('synchronous session retention notifications cannot reenter task navigation', async () => {
  const f = await fixture({ reentrant: true }); f.plugin.apply(f.ctx);
  f.state.byId['session-code'] = {};
  assert.doesNotThrow(() => f.notify());
  assert.deepEqual(f.opened, ['session-code']); f.dispose();
});
