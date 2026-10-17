import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vibeHandler, inject } from '../plugins/argon-vibe/service.mjs';

const WORK_ID = 'work-' + 'a'.repeat(32);
const ROOT = '/srv/argon/ws-1';
const HEAD = 'c'.repeat(40);
const workItem = {
  workItemId: WORK_ID, ownerId: 'alice', version: 7, paused: false, blocked: false,
  sandboxId: 'sb-demo-1', sessionIds: ['session-plan', 'session-code'],
  workflow: {
    phase: 'AWAITING_REVIEW', planSessionId: 'session-plan', codeSessionId: 'session-code',
    approval: { actor: 'alice', approvedAt: '2026-10-17T00:00:00Z' }, candidateCommit: HEAD,
    baselineOperationId: 'exec-' + 'b'.repeat(32), verificationOperationId: 'exec-' + 'v'.repeat(32),
    delivery: { id: 'dlv-1', step: 'PR_OPEN', candidateCommit: HEAD, headBranch: 'argon/fnd-00001',
      pullNumber: 3, pullUrl: 'http://127.0.0.1:3000/argon/demo/pulls/3', lastError: null,
      requestedAt: '2026-10-17T01:00:00Z' },
    reason: null,
  },
  sourceRecord: { id: 'FND-00001', title: '示例任务', repositoryUrl: 'http://127.0.0.1:3000/argon/demo.git',
    baseCommit: 'b'.repeat(40), sourcePath: 'src/main/java/demo/A.java', risk: 'MEDIUM', revision: 2 },
};
const git = { baseCommit: workItem.sourceRecord.baseCommit, headCommit: HEAD, branch: 'argon/fnd-00001',
  status: '', diff: 'diff --git a/x b/y\n+line', changedFiles: ['src/main/java/demo/A.java'],
  testsChanged: [], diffTruncated: false };
const evidence = { sandboxId: 'sb-demo-1', workspacePath: ROOT, git };

const makeWorkflow = ({ missing = false, evidenceValue = evidence } = {}) => ({
  snapshot: async (id) => {
    if (missing || id !== WORK_ID) { const error = new Error('工作项不存在'); error.status = 404; throw error; }
    return { workItem: structuredClone(workItem), operations: [{ operationId: 'exec-x', state: 'SUCCEEDED', kind: 'VERIFY' }], cursor: 42 };
  },
  workspace: async () => structuredClone(evidenceValue),
});

const makeSdlc = () => ({ closedCurrent: work => work.workflow.delivery.step === 'CLOSED_UNMERGED' });

const makeFs = ({ text = 'l1\nl2\nl3\nl4\nl5\n', size, version = 'v1', resolvedPrefix = ROOT } = {}) => {
  const calls = [];
  return {
    calls,
    resolve: async (path, opts) => { calls.push(['resolve', path, opts?.cwd]); return { key: resolvedPrefix + '/' + path, displayPath: path }; },
    stat: async () => { calls.push(['stat']); return { version, type: 'file', size: size ?? Buffer.byteLength(text) }; },
    readText: async () => { calls.push(['readText']); return text; },
    processPath: target => target.key,
  };
};

const makeOpener = ({ fs, error } = {}) => {
  const calls = [];
  return {
    calls,
    open: async (sandboxId, root) => {
      calls.push([sandboxId, root]);
      if (error) throw error;
      return fs;
    },
  };
};

const makeHandler = ({ workflow = makeWorkflow(), sdlc = makeSdlc(), opener = makeOpener({ fs: makeFs() }), config = {}, connection } = {}) => {
  const calls = { create: 0, prompt: 0 };
  const sessions = { create: () => { calls.create += 1; }, prompt: () => { calls.prompt += 1; } };
  const handler = vibeHandler({
    connection: connection ?? { requestRejection: ({ headers }) => (headers.authorization ? null : 401) },
    workflow, sdlc, openSandbox: opener.open, config,
  });
  return { handler, sessions, calls, opener };
};

const invoke = async (handler, { method = 'GET', path, headers = { authorization: 'ok' } } = {}) => {
  const req = { method, url: path, headers };
  const res = { status: 0, headers: {}, body: '' };
  res.writeHead = (status, headerSet) => { res.status = status; res.headers = headerSet; return res; };
  res.end = body => { res.body = body ?? ''; };
  await handler(req, res);
  let data = null;
  try { data = JSON.parse(res.body); } catch { data = res.body; }
  return { status: res.status, headers: res.headers, data };
};

test('context returns the work item snapshot with workflow, approval, delivery and sessions', async () => {
  const { handler } = makeHandler();
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/context` });
  assert.equal(status, 200);
  assert.equal(data.workItemId, WORK_ID);
  assert.equal(data.phase, 'AWAITING_REVIEW');
  assert.equal(data.planSessionId, 'session-plan');
  assert.equal(data.codeSessionId, 'session-code');
  assert.equal(data.approval.actor, 'alice');
  assert.equal(data.candidateCommit, HEAD);
  assert.equal(data.sandboxId, 'sb-demo-1');
  assert.deepEqual(data.sessionIds, ['session-plan', 'session-code']);
  assert.equal(data.delivery.step, 'PR_OPEN');
  assert.equal(data.delivery.pullUrl, workItem.workflow.delivery.pullUrl);
  assert.equal(data.deliveryClosedUnmerged, false);
  assert.equal(data.source.id, 'FND-00001');
  assert.equal(data.workflow.phase, 'AWAITING_REVIEW');
  assert.equal(data.cursor, 42);
  assert.deepEqual(data.operations, [{ operationId: 'exec-x', state: 'SUCCEEDED', kind: 'VERIFY' }]);
});

test('context reports 404 for a missing task and never creates or prompts a session', async () => {
  const { handler, calls } = makeHandler({ workflow: makeWorkflow({ missing: true }) });
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/context` });
  assert.equal(status, 404);
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt, 0);
});

test('all routes refuse write methods with 405 before touching the workflow', async () => {
  const opener = makeOpener({ fs: makeFs() });
  const { handler, calls } = makeHandler({ opener });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const { status, headers, data } = await invoke(handler, { method, path: `/argon/vibe/tasks/${WORK_ID}/context` });
    assert.equal(status, 405, method);
    assert.equal(headers.Allow, 'GET');
    assert.equal(data.code, 'METHOD_NOT_ALLOWED');
  }
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(opener.calls.length, 0);
});

test('the login gate rejects unauthenticated requests with 401', async () => {
  const { handler } = makeHandler();
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/context`, headers: {} });
  assert.equal(status, 401);
  assert.match(data.error, /登录/);
});

test('no route ever calls the session facade and the plugin injects no session services', async () => {
  const opener = makeOpener({ fs: makeFs() });
  const { handler, calls } = makeHandler({ opener });
  await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/context` });
  await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=src/A.java` });
  await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/diff` });
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt, 0);
  for (const forbidden of ['sessionController', 'sessionProjections', 'workspaceFiles']) {
    assert.equal(inject.includes(forbidden), false, 'inject must not include ' + forbidden);
  }
});

test('files reads a line window with version and eof', async () => {
  const opener = makeOpener({ fs: makeFs() });
  const { handler } = makeHandler({ opener });
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=src/A.java&offset=2&limit=2` });
  assert.equal(status, 200);
  assert.equal(data.path, 'src/A.java');
  assert.equal(data.version, 'v1');
  assert.deepEqual(data.lines, ['l2', 'l3']);
  assert.equal(data.offset, 2);
  assert.equal(data.eof, false);
  assert.equal(data.lineCount, 5);
  assert.deepEqual(opener.calls, [['sb-demo-1', ROOT]]);
});

test('files reaches eof on the last page and defaults to the first page', async () => {
  const { handler } = makeHandler({ opener: makeOpener({ fs: makeFs() }) });
  const first = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt` });
  assert.deepEqual(first.data.lines, ['l1', 'l2', 'l3', 'l4', 'l5']);
  assert.equal(first.data.eof, true);
  const tail = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt&offset=5&limit=10` });
  assert.deepEqual(tail.data.lines, ['l5']);
  assert.equal(tail.data.eof, true);
});

test('files rejects escaped, absolute and malformed paths with 400', async () => {
  const { handler } = makeHandler();
  for (const path of ['../secret', 'a/../../b', '/etc/passwd', 'a\\b', 'a/./b', '.', 'a//b', 'a\nb']) {
    const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=${encodeURIComponent(path)}` });
    assert.equal(status, 400, path);
    assert.equal(data.code, 'PATH_ESCAPE');
  }
});

test('files rejects missing path and out-of-range paging with 400', async () => {
  const { handler } = makeHandler();
  assert.equal((await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files` })).status, 400);
  assert.equal((await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt&offset=0` })).status, 400);
  assert.equal((await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt&offset=x` })).status, 400);
  assert.equal((await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt&limit=99999` })).status, 400);
});

test('files returns 502 when the sandbox session cannot be opened, without host fallback', async () => {
  const error = Object.assign(new Error('ssh dial failed'), { code: 'SANDBOX_UNAVAILABLE' });
  const opener = makeOpener({ error });
  const { handler } = makeHandler({ opener });
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt` });
  assert.equal(status, 502);
  assert.equal(data.code, 'SANDBOX_UNAVAILABLE');
  assert.deepEqual(opener.calls, [['sb-demo-1', ROOT]]);
});

test('files returns 502 when the brain evidence binding does not match the task sandboxId', async () => {
  const workflow = makeWorkflow({ evidenceValue: { ...evidence, sandboxId: 'sb-other-9' } });
  const { handler } = makeHandler({ workflow });
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt` });
  assert.equal(status, 502);
  assert.equal(data.code, 'SANDBOX_BINDING_MISMATCH');
});

test('files returns 409 before any sandbox access when the task has no sandbox yet', async () => {
  const workflow = makeWorkflow();
  workflow.snapshot = async () => ({ workItem: { ...structuredClone(workItem), sandboxId: null }, operations: [], cursor: 0 });
  const opener = makeOpener({ fs: makeFs() });
  const { handler } = makeHandler({ workflow, opener });
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt` });
  assert.equal(status, 409);
  assert.equal(data.code, 'SANDBOX_NOT_BOUND');
  assert.equal(opener.calls.length, 0);
});

test('files refuses oversized files with 413 instead of truncating', async () => {
  const opener = makeOpener({ fs: makeFs({ text: 'x'.repeat(600 * 1024), size: 600 * 1024 }) });
  const { handler } = makeHandler({ opener, config: { maxFileBytes: 512 * 1024 } });
  const { status, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt` });
  assert.equal(status, 413);
  assert.equal(data.code, 'FILE_TOO_LARGE');
});

test('files returns 404 for a missing file and 400 when the resolved path leaves the workspace', async () => {
  const absent = makeOpener({ fs: { ...makeFs(), stat: async () => undefined } });
  const missing = await invoke(makeHandler({ opener: absent }).handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=nope.txt` });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'NOT_FOUND');
  const escaped = makeOpener({ fs: makeFs({ resolvedPrefix: '/etc' }) });
  const outside = await invoke(makeHandler({ opener: escaped }).handler, { path: `/argon/vibe/tasks/${WORK_ID}/files?path=a.txt` });
  assert.equal(outside.status, 400);
  assert.equal(outside.data.code, 'PATH_ESCAPE');
});

test('diff proxies the brain evidence and passes diffTruncated through untouched', async () => {
  const truncated = { ...evidence, git: { ...git, diff: 'diff --truncated', diffTruncated: true } };
  const { handler } = makeHandler({ workflow: makeWorkflow({ evidenceValue: truncated }) });
  const { status, headers, data } = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/diff` });
  assert.equal(status, 200);
  assert.equal(data.workItemId, WORK_ID);
  assert.equal(data.sourceCommit, HEAD);
  assert.equal(data.baseCommit, workItem.sourceRecord.baseCommit);
  assert.equal(data.headCommit, HEAD);
  assert.equal(data.branch, 'argon/fnd-00001');
  assert.equal(data.diff, 'diff --truncated');
  assert.equal(data.diffTruncated, true);
  assert.equal(data.sandboxId, 'sb-demo-1');
  assert.equal(data.workspacePath, ROOT);
  assert.match(headers.ETag, /^"\d+-[0-9a-f]{40}"$/);
});

test('diff answers 304 when If-None-Match matches the evidence etag', async () => {
  const { handler } = makeHandler();
  const first = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/diff` });
  const second = await invoke(handler, { path: `/argon/vibe/tasks/${WORK_ID}/diff`, headers: { authorization: 'ok', 'if-none-match': first.headers.ETag } });
  assert.equal(second.status, 304);
});

test('unknown routes return 404 and the task-not-found check precedes routing payloads', async () => {
  const { handler } = makeHandler();
  assert.equal((await invoke(handler, { path: '/argon/vibe/whatever' })).status, 404);
  assert.equal((await invoke(handler, { path: '/argon/vibe/tasks/x/y' })).status, 404);
  const missing = makeHandler({ workflow: makeWorkflow({ missing: true }) });
  for (const route of ['context', 'files?path=a.txt', 'diff']) {
    assert.equal((await invoke(missing.handler, { path: `/argon/vibe/tasks/${WORK_ID}/${route}` })).status, 404, route);
  }
});

test('bridge-browser.mjs is served as a browser-loadable module and nothing else under the prefix', async () => {
  const { handler } = makeHandler();
  const { status, headers, data } = await invoke(handler, { path: '/argon/vibe/bridge-browser.mjs' });
  assert.equal(status, 200);
  assert.match(headers['Content-Type'], /text\/javascript/);
  const source = await readFile(new URL('../plugins/argon-vibe/shared/bridge-browser.mjs', import.meta.url));
  assert.equal(String(data), String(source));
  assert.match(String(data), /export function acceptMessage/);
  // bridge-browser.mjs statically imports './bridge.mjs'; the browser resolves
  // it to /argon/vibe/bridge.mjs, so the server must serve it too.
  const dep = await invoke(handler, { path: '/argon/vibe/bridge.mjs' });
  assert.equal(dep.status, 200);
  assert.match(dep.headers['Content-Type'], /text\/javascript/);
  const depSource = await readFile(new URL('../plugins/argon-vibe/shared/bridge.mjs', import.meta.url));
  assert.equal(String(dep.data), String(depSource));
  assert.match(String(dep.data), /export function safePath/);
  assert.equal((await invoke(handler, { path: '/argon/vibe/bridge-browser.mjs', method: 'POST' })).status, 405);
  assert.equal((await invoke(handler, { path: '/argon/vibe/../bridge-browser.mjs' })).status, 404);
  assert.equal((await invoke(handler, { path: '/argon/vibe/other.js' })).status, 404);
});
