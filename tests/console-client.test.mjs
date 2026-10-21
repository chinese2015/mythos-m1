import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
async function fixture({ reentrant = false, nativeRestore = false, failOnce = false } = {}) {
  let plugin; const callbacks = new Set(), cleanups = [], opened = [];
  const errors = [];
  let current = 'session-plan', restored = false;
  const state = { byId: {} };
  if (nativeRestore) callbacks.add(() => {
    if (restored || !state.byId['session-code']) return;
    restored = true;
    // Native replaceMain retains a Session (publishing the catalog) before setting selection.
    for (const callback of callbacks) callback();
    current = 'session-plan';
  });
  runInNewContext(await readFile(new URL('../plugins/mythos-console/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(); } } }, URLSearchParams,
    location: { search: '?mythosSession=session-code&mythosEmbedded=1' }, console: { error: (...args) => errors.push(args) },
  });
  const ctx = { effect(fn) { cleanups.push(fn()); },
    sessions: { list: { getSnapshot: () => state, subscribe(fn) { callbacks.add(fn); return () => callbacks.delete(fn); } } },
    uiWorkspace: { openSession(id) { assert.ok(state.byId[id], 'must not retain a session before the authoritative catalog knows it'); if (failOnce) { failOnce = false; throw new Error('temporary retention failure'); } if (reentrant) for (const fn of callbacks) fn(); opened.push(id); current = id; } },
  };
  return { plugin, ctx, state, opened, errors, current: () => current, notify: () => { for (const fn of callbacks) fn(); }, dispose: () => { for (const fn of cleanups) fn?.(); } };
}
test('native task navigation waits for the catalog before retaining a Session and selects it once', async () => {
  const f = await fixture(); assert.doesNotThrow(() => f.plugin.apply(f.ctx)); assert.deepEqual(f.opened, []);
  f.state.byId['session-code'] = {}; f.notify(); f.notify(); await Promise.resolve(); assert.deepEqual(f.opened, ['session-code']); f.dispose();
});
test('disposing the client before catalog arrival removes pending navigation', async () => {
  const f = await fixture(); f.plugin.apply(f.ctx); f.dispose(); f.state.byId['session-code'] = {}; f.notify(); await Promise.resolve(); assert.deepEqual(f.opened, []);
});
test('synchronous session retention notifications cannot reenter task navigation', async () => {
  const f = await fixture({ reentrant: true }); f.plugin.apply(f.ctx);
  f.state.byId['session-code'] = {};
  assert.doesNotThrow(() => f.notify());
  await Promise.resolve();
  assert.deepEqual(f.opened, ['session-code']); f.dispose();
});
test('task deep link wins after native restoration publishes a retained-session catalog', async () => {
  const f = await fixture({ nativeRestore: true }); f.plugin.apply(f.ctx);
  f.state.byId['session-code'] = {}; f.notify(); await Promise.resolve();
  assert.equal(f.current(), 'session-code'); assert.deepEqual(f.opened, ['session-code']); f.dispose();
});
test('a failed deferred navigation is reported locally and can retry on catalog change', async () => {
  const f = await fixture({ failOnce: true }); f.plugin.apply(f.ctx);
  f.state.byId['session-code'] = {}; await Promise.resolve(); await Promise.resolve();
  assert.equal(f.errors.length, 1); assert.deepEqual(f.opened, []);
  f.notify(); await Promise.resolve();
  assert.deepEqual(f.opened, ['session-code']); f.dispose();
});
