import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function loadPlugin(search) {
  let plugin = null;
  const errors = [];
  runInNewContext(await readFile(new URL('../plugins/mythos-vibe/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(require => ({ react: {} }[require] ?? {})); } } },
    URLSearchParams,
    location: { search },
    console: { error: (...args) => errors.push(args) },
    crypto: { randomUUID: () => 'binding-smoke' },
  });
  return { plugin, errors };
}

test('the vibe client bundle declares the public extension points and stays silent outside a task window', async () => {
  const { plugin, errors } = await loadPlugin('?');
  assert.ok(plugin, 'factory must be registered with the module loader');
  assert.equal(plugin.inject.join(','), 'uiWorkspace,sessions,slots,conversation,sidebarRight,sidebarRightTabs');
  await plugin.apply({});
  assert.deepEqual(errors, [], 'no activation error outside a task window');
});

test('an invalid task binding is rejected before any DOM or network work', async () => {
  const { plugin, errors } = await loadPlugin('?mythosVibeTask=not-a-work-item');
  await plugin.apply({});
  assert.deepEqual(errors, []);
});

test('a valid task binding attempts to load the served bridge module', async () => {
  const { plugin } = await loadPlugin('?mythosVibeTask=work-' + 'a'.repeat(32));
  // vm contexts cannot dynamic-import; activation must surface that as a logged error, not hang.
  await assert.rejects(() => plugin.apply({}), /import|not supported|disallow/i);
});
