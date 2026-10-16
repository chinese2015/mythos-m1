import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCapture, guardSessionEvents, guardToolCapture } from '../change-boundary.mjs';
const root = '/home/hx/argon-sandboxes';

test('all sandbox sessions are excluded from host change capture', () => {
  assert.equal(shouldCapture({ header: { cwd: '/home/hx/argon-sandboxes/sb-1/workspace' } }, root), false);
  assert.equal(shouldCapture({ header: { cwd: '/home/hx/argon-sandboxes' } }, root), false);
  assert.equal(shouldCapture({ header: { cwd: '/home/hx/gitea' } }, root), true);
  assert.equal(shouldCapture({ header: { cwd: '/home/hx/argon-sandboxes-other/project' } }, root), true);
  assert.equal(shouldCapture({ header: { cwd: '/home/hx/gitea', agentPreset: 'argon-alice' } }, root), false);
});

test('an actual sandbox preset cannot enter host pre-execution file capture even with a different session cwd', async () => {
  let captured = 0, continued = 0;
  const callback = guardToolCapture(() => { captured++; }, context => context.preset);
  await callback({ agent: { ctx: { preset: 'argon-alice' } } }, () => { continued++; });
  assert.equal(captured, 0);
  assert.equal(continued, 1);
  await callback({ agent: { ctx: { preset: 'standard' } } }, () => { continued++; });
  assert.equal(captured, 1);
});

test('a sandbox event cannot create a host recorder but ordinary events remain visible', () => {
  let calls = 0;
  const wrapped = guardSessionEvents(() => { calls++; }, root);
  wrapped({ header: { cwd: '/home/hx/argon-sandboxes/sb-1/workspace' } }, { type: 'turn/start' });
  wrapped({ header: { cwd: '/home/hx/argon-sandboxes/sb-1/workspace' } }, { type: 'tool/result' });
  assert.equal(calls, 0);
  wrapped({ header: { cwd: '/home/hx/gitea' } }, { type: 'turn/start' });
  assert.equal(calls, 1);
});
