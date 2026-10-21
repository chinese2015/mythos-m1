import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskWorkflow } from '../plugins/mythos-workflow/controller.mjs';
import { consoleHandler } from '../plugins/mythos-console/index.mjs';
import { createServer } from 'node:http';
import { bindTaskAgent } from '../plugins/mythos-workflow/session-policy.mjs';
import { findingBinding } from '../plugins/mythos-subscribe/triage.mjs';
const id = 'work-' + 'a'.repeat(32);
function harness() {
  const work = { workItemId: id, ownerId: 'alice', source: { type: 'MYTHOS', id: 'FND-00009' }, sourceRecord: { baseCommit: 'b'.repeat(40), sourcePath: 'src/Fix.java' }, sessionIds: [], sandboxId: 'sb-task', version: 1, blocked: false, workflow: { phase: 'CLAIMED' } };
  const ops = new Map(), keys = new Map(); let lostAck = false;
  const client = { dispose: async () => {}, request: async (method, path, options = {}) => {
    if (method === 'GET' && path.endsWith('/workspace')) return { workspacePath: '/home/demo/workspace', git: { headCommit: work.sourceRecord.baseCommit, status: '', changedFiles: [], testsChanged: [] } };
    if (method === 'GET' && path.endsWith('/work-items')) return { workItems: [structuredClone(work)] };
    if (method === 'GET' && path.includes('/operations/')) return ops.get(path.split('/').at(-1));
    if (method === 'GET') return { workItem: structuredClone(work), operations: [...ops.values()], sessions: [] };
    if (path.endsWith('/workflow')) {
      assert.equal(options.body.expectedVersion, work.version);
      work.workflow = options.body.workflow; work.blocked = options.body.blocked; work.version++; return structuredClone(work);
    }
    if (path.endsWith('/operations')) {
      if (keys.has(options.key)) return keys.get(options.key);
      const op = { operationId: 'exec-' + 'd'.repeat(32), workItemId: id, state: 'QUEUED' }; keys.set(options.key, op); ops.set(op.operationId, op); work.version++;
      if (lostAck) { lostAck = false; throw new Error('lost acknowledgement'); } return op;
    }
    throw new Error('Unexpected route ' + path);
  } };
  const events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source: { rpcId: 'plan' } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Approved plan' }] } } }, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const sessions = { inspect: async () => ({ events }), list: async () => ({ items: [{ sessionId: 'session-code', running: false }] }) };
  const controller = new TaskWorkflow({ owner: 'alice' }, { client, sessions, source: {}, workspaces: {}, presets: {} });
  return { controller, client, work, ops, events, keys, loseAck: () => { lostAck = true; } };
}
test('plan approval persists the authenticated actor before a CODE session can exist and rejects stale decisions', async () => {
  const { controller, work, events } = harness();
  work.workflow = { phase: 'AWAITING_PLAN_APPROVAL', planHash: 'hash', planEndSequence: 4, planRequestId: 'plan', planSessionId: 'session-plan' };
  await assert.rejects(() => controller.approve(id, { expectedVersion: 0, planHash: 'hash' }, 'bad'), /409/);
  assert.equal(work.workflow.codeSessionId, undefined);
  await controller.approve(id, { expectedVersion: 1, planHash: 'hash', actor: 'mallory' }, 'approve');
  assert.equal(work.workflow.approval.actor, 'alice'); assert.equal(work.workflow.phase, 'CODING');
  const version = work.version;
  await controller.approve(id, { expectedVersion: 1, planHash: 'hash' }, 'approve'); assert.equal(work.version, version);
  events.push({ seq: 5, type: 'user/message', data: { source: { rpcId: 'new' } } });
  await assert.rejects(() => controller.approve(id, { expectedVersion: version, planHash: 'hash' }, 'another'), /409/);
});
test('lost operation acknowledgement is reconciled by a new controller without duplicate dispatch', async () => {
  const h = harness(); h.work.workflow = { phase: 'BASELINE' }; h.loseAck();
  await assert.rejects(() => h.controller.step(structuredClone(h.work)), /lost acknowledgement/);
  const restarted = new TaskWorkflow({ owner: 'alice' }, { client: h.client, sessions: {}, source: {}, workspaces: {}, presets: {} });
  await restarted.step(structuredClone(h.work));
  assert.equal(h.keys.size, 1); assert.equal(h.work.workflow.baselineOperationId, 'exec-' + 'd'.repeat(32));
});
test('passing model prose cannot make a failed independent verification review-ready', async () => {
  const h = harness(), opId = 'exec-' + 'd'.repeat(32);
  h.work.workflow = { phase: 'VERIFYING', verificationOperationId: opId, candidateCommit: 'c'.repeat(40) };
  h.ops.set(opId, { state: 'FAILED', evidence: { junit: { tests: 2, failures: 1, errors: 0 } } });
  await h.controller.step(structuredClone(h.work)); assert.equal(h.work.workflow.phase, 'BLOCKED');
});
test('a second supplemental input is rejected until the first durable intent has been admitted', async () => {
  const h = harness(); h.work.workflow = { phase: 'PLANNING', planSessionId: 'session-plan', planRequestId: 'plan' }; h.work.sessionIds = ['session-plan'];
  await h.controller.message(id, { text: 'First instruction' }, 'first');
  await assert.rejects(() => h.controller.message(id, { text: 'Second instruction' }, 'second'), /409/);
  assert.equal(h.work.workflow.pendingMessage.text, 'First instruction');
});
test('verification cannot report ready when native CODE input is newer than its completed turn', async () => {
  const h = harness(), opId = 'exec-' + 'd'.repeat(32); h.work.sourceRecord.baseCommit = 'c'.repeat(40);
  h.work.workflow = { phase: 'VERIFYING', verificationOperationId: opId, candidateCommit: 'c'.repeat(40), codeSessionId: 'session-code', codeRequestId: 'plan', codeEndSequence: 4 };
  h.events.push({ seq: 5, type: 'user/message', data: { source: { rpcId: 'new-code' } } });
  h.ops.set(opId, { state: 'SUCCEEDED', evidence: { sourceCommit: 'c'.repeat(40), junit: { tests: 2, failures: 0, errors: 0, skipped: 0, invalidReports: [] } } });
  h.controller.workspace = async () => ({ git: { headCommit: 'c'.repeat(40), status: '', changedFiles: ['src/Fix.java'], testsChanged: [] } });
  await h.controller.step(structuredClone(h.work)); assert.notEqual(h.work.workflow.phase, 'AWAITING_REVIEW');
});
test('approval holds a native admission fence through async Git and CAS, then seals the approved PLAN', async () => {
  const h = harness(); h.work.workflow = { phase: 'AWAITING_PLAN_APPROVAL', planHash: 'hash', planEndSequence: 4, planRequestId: 'plan', planSessionId: 'session-plan' };
  let admitted = 0; const agent = { id: 'session-plan', followup() { admitted++; } };
  const release = bindTaskAgent(agent, h.controller, id, 'PLAN');
  const workspace = h.controller.workspace.bind(h.controller);
  h.controller.workspace = async (...args) => { assert.throws(() => agent.followup(), /决策处理中/); await Promise.resolve(); return workspace(...args); };
  try {
    await h.controller.approve(id, { expectedVersion: 1, planHash: 'hash' }, 'approval');
    assert.throws(() => agent.followup(), /计划已批准/); assert.equal(admitted, 0);
  } finally { release(); }
});
test('real passing evidence with an empty invalidReports list can reach review readiness', async () => {
  const h = harness(), opId = 'exec-' + 'd'.repeat(32);
  h.work.workflow = { phase: 'VERIFYING', verificationOperationId: opId, candidateCommit: 'c'.repeat(40), codeSessionId: 'session-code', codeRequestId: 'plan', codeEndSequence: 4 };
  h.ops.set(opId, { state: 'SUCCEEDED', evidence: { sourceCommit: 'c'.repeat(40), sourceDirty: false, junit: { tests: 2, failures: 0, errors: 0, skipped: 0, invalidReports: [] } } });
  h.controller.workspace = async () => ({ git: { headCommit: 'c'.repeat(40), status: '', changedFiles: ['src/Fix.java'], testsChanged: [] } });
  await h.controller.step(structuredClone(h.work)); assert.equal(h.work.workflow.phase, 'AWAITING_REVIEW');
});
test('restart restores both native preset definitions at a review stop without admitting another prompt', async () => {
  const h = harness(), restored = [];
  h.work.workflow = { phase: 'AWAITING_REVIEW', planSessionId: 'session-plan', codeSessionId: 'session-code', codeEndSequence: 4 };
  h.work.sessionIds = ['session-plan', 'session-code'];
  h.controller.ensurePreset = async (_work, role) => { restored.push(role); };
  await h.controller.step(structuredClone(h.work)); assert.deepEqual(restored, ['PLAN', 'CODE']);
  assert.equal(h.work.version, 1);
});
test('a delayed old read cannot reopen native PLAN input after approval', async () => {
  const h = harness();
  h.controller.remember({ ...h.work, version: 5, workflow: { phase: 'CODING', approval: { actor: 'alice' } } });
  h.controller.remember({ ...h.work, version: 4, workflow: { phase: 'AWAITING_PLAN_APPROVAL' } });
  assert.match(h.controller.inputRejection(id, 'PLAN', 'session-plan'), /计划已批准/);
});
test('console authenticates and fences origins before reading data or admitting mutations', async () => {
  let admitted = 0;
  const server = createServer(consoleHandler({ connection: { requestRejection: ({ headers }) => headers.origin === 'http://evil.invalid' ? 403 : headers.cookie === 'session=valid' ? undefined : 401 },
    workflow: { tasks: async () => { admitted++; return { tasks: [] }; }, start: async () => { admitted++; return { workItemId: id }; } } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(url + '/mythos/api/tasks')).status, 401);
    assert.equal((await fetch(url + '/mythos/api/tasks', { headers: { cookie: 'session=valid', origin: 'http://evil.invalid' } })).status, 403);
    assert.equal((await fetch(url + '/mythos/api/tasks/FND-00009/start', { method: 'POST', headers: { cookie: 'session=valid', 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
    assert.equal(admitted, 0);
    assert.equal((await fetch(url + '/mythos/api/tasks/FND-00009/start', { method: 'POST', headers: { cookie: 'session=valid', 'Content-Type': 'application/json', 'X-Mythos-Action': '1', 'Idempotency-Key': 'action-42' }, body: '{"expectedRevision":2}' })).status, 202);
    assert.equal(admitted, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('console proxies work-item events with cursor validation and auth fencing', async () => {
  let seen = null;
  const server = createServer(consoleHandler({ connection: { requestRejection: ({ headers }) => headers.cookie === 'session=valid' ? undefined : 401 },
    workflow: { events: async (workId, after) => { seen = { workId, after }; return { events: [{ sequence: 7, type: 'execution.started' }], nextCursor: 7 }; } } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(url + '/mythos/api/work-items/work-x/events')).status, 401);
    assert.equal((await fetch(url + '/mythos/api/work-items/work-x/events?after=-1', { headers: { cookie: 'session=valid' } })).status, 400);
    assert.equal((await fetch(url + '/mythos/api/work-items/work-x/events?after=1.5', { headers: { cookie: 'session=valid' } })).status, 400);
    const ok = await fetch(url + '/mythos/api/work-items/work-x/events?after=5', { headers: { cookie: 'session=valid' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { events: [{ sequence: 7, type: 'execution.started' }], nextCursor: 7 });
    assert.deepEqual(seen, { workId: 'work-x', after: 5 });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('new tasks fail closed before approval; existing work stays accessible', async () => {
  const { controller, client, work } = harness();
  const task = { id: 'FND-00015', title: 'Traversal', enabled: true, revision: 2 };
  let intakes = [], claims = 0;
  client.request = async (method, path) => {
    if (path.endsWith('/source-intakes')) return { intakes };
    if (path.endsWith('/work-items')) return { workItems: [] };
    claims++; return { workItemId: id };
  };
  controller.source = { get: async () => task, list: async () => [task] };
  await assert.rejects(() => controller.start(task.id, { expectedRevision: 2 }, 'none'), e => e.status === 409);
  intakes = [{ findingId: task.id, revision: 2, state: 'AWAITING_OWNER', triage: { result: 'CONFIRMED' } }];
  assert.equal((await controller.tasks()).tasks[0].startable, false);
  await assert.rejects(() => controller.start(task.id, { expectedRevision: 2 }, 'pending'), e => e.status === 409);
  assert.equal(claims, 0);
  client.request = async () => ({ workItems: [work] });
  assert.equal((await controller.start(work.source.id, {}, 'existing')).workItemId, work.workItemId);
});
test('console intake decisions use the same authentication and mutation fences', async () => {
  const decisions = [];
  const server = createServer(consoleHandler({ connection: { requestRejection: ({ headers }) => headers.cookie === 'session=valid' ? undefined : 401 },
    subscribe: { decide: async (...args) => { decisions.push(args); return { state: 'APPROVED' }; } } }));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const url = 'http://127.0.0.1:' + server.address().port + '/mythos/api/tasks/FND-00015/decide';
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = { cookie: 'session=valid', 'Content-Type':'application/json', 'X-Mythos-Action':'1', 'Idempotency-Key':'decision-42' };
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"decision":"APPROVE","expectedRevision":2}' })).status, 200);
    assert.deepEqual(decisions, [['FND-00015', { decision: 'APPROVE', expectedRevision: 2 }, 'decision-42']]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('approved exact assets start once while changed owner bindings stay gated', async () => {
  const { controller, client } = harness();
  const task = { id: 'FND-00015', title: 'Traversal', enabled: true, revision: 2, ownerId: 'owner-pixel-01' };
  const intake = { findingId: task.id, revision: 2, state: 'APPROVED', triage: { result: 'CONFIRMED', binding: findingBinding(task) }, decision: { binding: findingBinding(task) } };
  let claims = 0;
  client.request = async (method, path) => {
    if (path.endsWith('/source-intakes')) return { intakes: [intake] };
    if (path.endsWith('/work-items')) return { workItems: [] };
    claims++; return { workItemId: id };
  };
  controller.source = { get: async () => task, list: async () => [task] };
  assert.equal((await controller.tasks()).tasks[0].startable, true);
  assert.equal((await controller.start(task.id, { expectedRevision: 2 }, 'approved')).workItemId, id);
  task.ownerId = 'another-owner';
  intake.triage.binding = findingBinding(task); // In-flight poll refreshed the source after old-owner approval.
  assert.equal((await controller.tasks()).tasks[0].startable, false);
  await assert.rejects(() => controller.start(task.id, { expectedRevision: 2 }, 'changed'), e => e.status === 409);
  assert.equal(claims, 1);
});
