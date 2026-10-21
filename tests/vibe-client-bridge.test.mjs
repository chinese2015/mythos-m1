import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptMessage, referenceText, fileNavigation } from '../plugins/mythos-vibe/shared/bridge-browser.mjs';
import * as bridge from '../plugins/mythos-vibe/shared/bridge-browser.mjs';

const frame = {};
const binding = { workItemId: 'poc-nova', sessionId: 'session-poc-nova', bindingId: 'binding-one' };
const context = { origin: 'http://localhost:3092', source: frame, expectedOrigin: 'http://localhost:3092', expectedSource: frame, binding };
const envelope = { protocol: 1, type: 'context.insert', ...binding, requestId: 'req-one', text: 'Catalog.java:3' };

test('bridge refuses other origins, windows, stale bindings and unknown message types', () => {
  assert.equal(acceptMessage(envelope, context), true);
  for (const change of [{ origin: 'https://other.example' }, { source: {} }, { binding: { ...binding, sessionId: 'session-other' } }, { binding: { ...binding, bindingId: 'binding-old' } }]) {
    assert.equal(acceptMessage(envelope, { ...context, ...change }), false);
  }
  for (const change of [{ protocol: 2 }, { type: 'shell.execute' }, { text: 'x'.repeat(17000) }, { requestId: null }]) {
    assert.equal(acceptMessage({ ...envelope, ...change }, context), false);
  }
});

test('selection reference names exact file, one-based lines, content version and captured text', () => {
  assert.equal(referenceText({ path: 'src/Catalog.java', startLine: 2, endLine: 3, version: 'sha256:abc', text: 'first\nsecond' }), '[src/Catalog.java:2-3 · sha256:abc · read-only snapshot]\nfirst\nsecond');
  assert.throws(() => referenceText({ path: '../secret', startLine: 1, endLine: 1, version: 'v1', text: 'x' }));
  assert.throws(() => referenceText({ path: 'src/A.java', startLine: 0, endLine: 1, version: 'v1', text: 'x' }));
});

test('file navigation only accepts this session and workspace-relative regular paths', () => {
  assert.deepEqual(fileNavigation('dsh-resource://file/session/session-poc-nova/src%2FCatalog.java', 'session-poc-nova', { line: 8 }), { path: 'src/Catalog.java', line: 8 });
  for (const address of ['https://other.example/x', 'dsh-resource://file/session/session-other/src%2FA.java', 'dsh-resource://file/session/session-poc-nova/..%2Fsecret', 'dsh-resource://file/session/session-poc-nova/%2Fetc%2Fpasswd']) {
    assert.equal(fileNavigation(address, 'session-poc-nova'), null);
  }
});

test('navigation waits for the authoritative catalog and never creates a replacement session', async () => {
  const actions = [];
  const sessions = { refresh: async () => { actions.push('refresh'); }, list: { getSnapshot: () => ({ byId: { 'session-known': {} } }) } };
  await bridge.openKnownSession(sessions, 'session-known', id => actions.push('open:' + id));
  assert.deepEqual(actions, ['refresh', 'open:session-known']);
  await assert.rejects(() => bridge.openKnownSession(sessions, 'session-missing', () => actions.push('wrong')), /Session not yet in the catalog/);
  assert.equal(actions.includes('wrong'), false);
});

test('a disposed embedding cannot navigate after a late catalog response', async () => {
  let current = true, opened = false;
  const sessions = { refresh: async () => { current = false; }, list: { getSnapshot: () => ({ byId: { 'session-known': {} } }) } };
  await bridge.openKnownSession(sessions, 'session-known', () => { opened = true; }, () => current);
  assert.equal(opened, false);
});

test('navigation observes the published catalog after refresh resolves before projection', async () => {
  let snapshot = { phase: 'pending', byId: {} }, opened = false;
  const sessions = { refresh: async () => {}, list: { getSnapshot: () => snapshot, subscribe(listener) { queueMicrotask(() => { snapshot = { phase: 'ready', byId: { 'session-known': {} } }; listener(); }); return () => {}; } } };
  await bridge.openKnownSession(sessions, 'session-known', () => { opened = true; });
  assert.equal(opened, true);
});
