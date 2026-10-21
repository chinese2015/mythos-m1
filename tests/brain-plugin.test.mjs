import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { M2Client } from '../plugins/mythos-brain/client.mjs';
import { BrainBridge } from '../plugins/mythos-brain/bridge.mjs';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as ServicePlugin from '../plugins/mythos-brain/service.mjs';
import * as ToolPlugin from '../plugins/mythos-brain/index.mjs';

let fixture, configuration, lines, client;
before(async () => {
  fixture = spawn('python3', ['tests/fixtures/brain_plugin_api.py'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PYTHONPATH: '.' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  lines = createInterface({ input: fixture.stdout });
  [configuration] = await once(lines, 'line').then(([line]) => [JSON.parse(line)]);
  client = new M2Client({ ...configuration, owner: 'alice' });
});
after(async () => {
  await client?.dispose();
  if (fixture) { fixture.stdin.end(); await once(fixture, 'exit'); }
  lines?.close();
});

test('private owner credentials authenticate real API requests', async () => {
  const result = await client.request('GET', '/api/brain/work-items');
  assert.deepEqual(result, { workItems: [] });
  assert.ok(!JSON.stringify(client).includes('alice-private-fixture-token'));
});

test('rejects off-host or credential-bearing backend URLs before any request', () => {
  for (const baseUrl of ['https://example.com', 'http://user:password@127.0.0.1', 'http://127.0.0.1?token=x', 'file:///etc']) {
    assert.throws(() => new M2Client({ ...configuration, owner: 'alice', baseUrl }), /loopback/);
  }
});

test('HTTP failures preserve status and code without leaking bearer values', async () => {
  await assert.rejects(() => client.request('GET', '/api/brain/work-items/missing'), error =>
    error.status === 404 && error.code === 'NOT_FOUND' && !error.message.includes('fixture-token'));
});

test('disposed clients reject new calls', async () => {
  const temporary = new M2Client({ ...configuration, owner: 'bob' });
  await temporary.dispose();
  await assert.rejects(() => temporary.request('GET', '/api/brain/work-items'), /disposed/);
});

const bridgeConfig = () => ({ ...configuration, owners: Object.fromEntries(Object.entries(configuration.records).map(([owner, record]) =>
  [owner, { sandboxId: record.sandbox_id, workspacePath: record.workspace_path, preset: 'mythos-' + owner }])) });
const bridge = (events = []) => new BrainBridge(bridgeConfig(), { emit: (topic, event) => events.push({ topic, event }) });
const call = (callId, signal) => ({ callId, signal });

test('persisted task sessions share their task sandbox and never create a DIRECT work item', async () => {
  const b = bridge();
  const work = { ownerId: 'alice', sessionId: 'task-code', sessionIds: ['task-plan', 'task-code'],
    source: { type: 'MYTHOS', id: 'FND-00009', revision: 2 }, sandboxId: 'sb-new-task',
    workItemId: 'work-' + 'c'.repeat(32), workflow: { approval: { actor: 'alice' } } };
  b.clients.get('alice').request = async (method, path) => {
    assert.equal(method, 'GET');
    return path.endsWith('/work-items') ? { workItems: [work] } : { workItem: work, cursor: 1 };
  };
  try {
    assert.equal((await b.binding('alice', 'task-plan', true)).workItemId, work.workItemId);
    assert.equal((await b.binding('alice', 'task-code', true)).workItemId, work.workItemId);
    assert.throws(() => b.validateWork('alice', 'foreign-session', work), /binding/);
    assert.throws(() => b.validateWork('bob', 'task-code', work), /binding/);
  } finally { await b.dispose(); }
});

test('a MANUAL CODE session binds only through a digest-matching approval', async () => {
  const b = bridge();
  const spec = { specDigest: 'd'.repeat(64) };
  const work = { ownerId: 'alice', sessionIds: ['session-m-code'],
    source: { type: 'MANUAL', id: 'TASK-' + '0'.repeat(12), revision: 1 }, sandboxId: 'sb-manual-task', taskSpec: spec,
    workItemId: 'work-' + 'c'.repeat(32), workflow: { approval: { actor: 'alice', specDigest: spec.specDigest } } };
  b.clients.get('alice').request = async (method, path) => {
    if (method === 'POST') return { operationId: 'exec-' + 'd'.repeat(32), workItemId: work.workItemId, state: 'QUEUED' };
    return path.endsWith('/work-items') ? { workItems: [work] } : { workItem: work, cursor: 1, sessions: [{ sessionId: 'session-m-code', role: 'CODE' }] };
  };
  try {
    assert.equal((await b.binding('alice', 'session-m-code', false)).workItemId, work.workItemId);
    assert.throws(() => b.validateWork('alice', 'session-other', work), /binding/);
    const run = await b.run('alice', 'session-m-code', { command: 'mvn test' }, call('manual-run'));
    assert.ok(run.operationId);
    work.workflow.approval = null;
    await assert.rejects(() => b.run('alice', 'session-m-code', { command: 'mvn test' }, call('manual-run-2')), /approved|审批/);
    work.workflow.approval = { actor: 'alice', specDigest: '0'.repeat(64) };
    await assert.rejects(() => b.run('alice', 'session-m-code', { command: 'mvn test' }, call('manual-run-3')), /[Dd]igest|摘要/);
  } finally { await b.dispose(); }
});

test('read-only status does not create work; run binds one durable session work item', async () => {
  const b = bridge();
  try {
    assert.equal((await b.snapshot('alice', 'session-binding')).bound, false);
    const op = await b.run('alice', 'session-binding', { command: 'echo first' }, call('binding-1'));
    const snap = await b.snapshot('alice', 'session-binding');
    assert.equal(snap.workItem.sessionId, 'session-binding');
    assert.equal(snap.workItem.sandboxId, configuration.records.alice.sandbox_id);
    assert.equal(snap.operations.length, 1);
    await b.cancel('alice', 'session-binding', op.operationId, call('cancel-binding'));
  } finally { await b.dispose(); }
});

test('another session of the same owner cannot read logs or cancel its operation', async () => {
  const b = bridge();
  try {
    const op = await b.run('alice', 'session-private-a', { command: 'echo private' }, call('private-1'));
    const other = await b.run('alice', 'session-private-b', { command: 'echo other private' }, call('private-2'));
    for (const action of [() => b.status('alice', 'session-private-b', op.operationId),
      () => b.follow('alice', 'session-private-b', op.operationId, 0),
      () => b.cancel('alice', 'session-private-b', op.operationId, call('wrong-cancel')),
      () => b.status('bob', 'session-private-a', op.operationId)]) {
      await assert.rejects(action, /bound|session|unavailable/i);
    }
    await b.cancel('alice', 'session-private-a', op.operationId, call('cancel-private'));
    await b.cancel('alice', 'session-private-b', other.operationId, call('cancel-private-other'));
  } finally { await b.dispose(); }
});

test('reloading the bridge retries the same logical call without another operation', async () => {
  let b = bridge();
  const op = await b.run('alice', 'session-reload', { command: 'echo once' }, call('stable-run'));
  await b.dispose(); b = bridge();
  try {
    await b.restore();
    const replay = await b.run('alice', 'session-reload', { command: 'echo once' }, call('stable-run'));
    assert.equal(replay.operationId, op.operationId);
    assert.equal((await b.snapshot('alice', 'session-reload')).operations.length, 1);
    await assert.rejects(() => b.run('alice', 'session-reload', { command: 'echo changed' }, call('stable-run')), /409/);
    await b.cancel('alice', 'session-reload', op.operationId, call('cancel-reload'));
  } finally { await b.dispose(); }
});

test('dispose interrupts a pending admission without cancelling the accepted backend job', async () => {
  let b = bridge();
  const pending = b.run('alice', 'session-lost-ack', { command: 'echo delayed-ack' }, call('same-admission'));
  const rejected = assert.rejects(pending, /interrupted|disposed/);
  const deadline = Date.now() + 3000;
  let op;
  while (Date.now() < deadline) {
    const works = (await client.request('GET', '/api/brain/work-items')).workItems;
    const work = works.find(w => w.sessionId === 'session-lost-ack');
    if (work) {
      const snapshot = await client.request('GET', '/api/brain/work-items/' + work.workItemId);
      if (snapshot.operations.length) { [op] = snapshot.operations; break; }
    }
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(op, 'backend admitted before response was interrupted');
  await b.dispose(); await rejected;
  assert.equal((await client.request('GET', '/api/brain/operations/' + op.operationId)).state, 'QUEUED');
  b = bridge();
  try {
    const replay = await b.run('alice', 'session-lost-ack', { command: 'echo delayed-ack' }, call('same-admission'));
    assert.equal(replay.operationId, op.operationId);
    await b.cancel('alice', 'session-lost-ack', op.operationId, call('cancel-lost-ack'));
  } finally { await b.dispose(); }
});

test('event bridge restores snapshots and delivers ordered events; disposal emits nothing late', async () => {
  const events = []; const b = bridge(events);
  const op = await b.run('alice', 'session-events', { command: 'echo events' }, call('events-1'));
  const response = once(lines, 'line');
  fixture.stdin.write(JSON.stringify({ action: 'finish', operationId: op.operationId, id: 'finish-events' }) + '\n');
  await response;
  await b.tick();
  const delivered = events.filter(e => e.topic === 'mythos-brain/event' && e.event.sessionId === 'session-events');
  assert.ok(delivered.some(e => e.event.event.type === 'execution.succeeded'));
  assert.deepEqual(delivered.map(e => e.event.event.sequence), [...new Set(delivered.map(e => e.event.event.sequence))].sort((a, z) => a - z));
  await b.dispose(); const count = events.length;
  await b.tick();
  assert.equal(events.length, count);
  assert.equal((await client.request('GET', '/api/brain/operations/' + op.operationId)).state, 'SUCCEEDED');
});

test('server session adapter uses stable identities and does not conflate workspaceId and cwd', async () => {
  const created = [], prompts = [];
  const b = new BrainBridge(bridgeConfig(), {
    sessions: { create: async args => { created.push(args); return { sessionId: args.sessionId }; },
      prompt: async args => { prompts.push(args); return { accepted: true }; } },
    workspaces: { create: async path => ({ id: 'workspace-fixture', path }) },
  });
  try {
    const first = await b.prepareSession('alice', 'operator-42');
    const again = await b.prepareSession('alice', 'operator-42');
    assert.equal(first.sessionId, again.sessionId);
    assert.equal(first.workItemId, again.workItemId);
    assert.equal(created[0].workspaceId, 'workspace-fixture');
    assert.equal(created[0].cwd, undefined);
    assert.equal(prompts.length, 0, 'preparation must not start inference');
    await b.promptSession('alice', first.sessionId, 'Inspect only', 'operator-prompt-42');
    assert.equal(prompts[0].sessionId, first.sessionId);
    assert.equal(prompts[0].requestId, 'operator-prompt-42');
  } finally { await b.dispose(); }
});

test('real Cordis unload unregisters the named service and seven native tools while backend records survive', async () => {
  const ctx = new Context();
  ctx.provide('sessionController', {}); ctx.provide('workspaceRegistry', {});
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  const service = await ctx.plugin(ServicePlugin, { ...bridgeConfig(), pollIntervalMs: 100 });
  await ctx.plugin(ToolPlugin, { owner: 'alice' });
  try {
    const names = ctx.tools.schemas().map(s => s.name);
    for (const name of ['execution_run', 'execution_status', 'execution_follow', 'execution_cancel', 'work_item_status', 'work_item_pause', 'work_item_resume']) assert.ok(names.includes(name), name);
    const exec = { agent: { session: { header: { id: 'session-cordis', agentPreset: 'standard' } } },
      callId: 'cordis-run', signal: new AbortController().signal };
    const tool = ctx.tools.get('execution_run');
    const operation = JSON.parse(await tool.execute({ command: 'echo through Cordis' }, exec));
    await assert.rejects(() => tool.execute({ command: 'echo invalid' }, { ...exec, agent: undefined }), /Session/);
    const status = JSON.parse(await ctx.tools.get('execution_status').execute({ operationId: operation.operationId }, exec));
    assert.equal(status.state, 'QUEUED');
    await service.dispose();
    assert.equal(ctx.get('mythosBrain'), undefined);
    assert.equal(ctx.tools.get('execution_run'), undefined);
    assert.equal((await client.request('GET', '/api/brain/operations/' + operation.operationId)).state, 'QUEUED');
    await client.request('POST', '/api/brain/operations/' + operation.operationId + '/cancel', { key: 'cordis-cleanup', body: { expectedVersion: 1 } });
  } finally { await ctx.fiber.dispose(); }
});

test('a failed initial snapshot is retried before subsequent events', async () => {
  const sessionId = 'session-snapshot-retry';
  await client.request('POST', '/api/brain/work-items', { key: 'snapshot-fixture', body: {
    source: { type: 'DIRECT', id: 'DSH:' + sessionId, revision: 1 }, sessionId, sandboxId: configuration.records.alice.sandbox_id } });
  let attempts = 0, delivered = 0;
  const b = new BrainBridge(bridgeConfig(), { emit: (topic, payload) => {
    if (topic === 'mythos-brain/snapshot' && payload.sessionId === sessionId) {
      attempts++; if (attempts === 1) throw new Error('temporary subscriber failure'); delivered++;
    }
  } });
  try { await b.restore(); await b.restore(); assert.equal(attempts, 2); assert.equal(delivered, 1); }
  finally { await b.dispose(); }
});

test('real Cordis awaits async observer failures and retries their snapshot without unhandled rejection', async () => {
  const sessionId = 'session-async-observer';
  await client.request('POST', '/api/brain/work-items', { key: 'async-observer-fixture', body: {
    source: { type: 'DIRECT', id: 'DSH:' + sessionId, revision: 1 }, sessionId, sandboxId: configuration.records.alice.sandbox_id } });
  const ctx = new Context(); let attempts = 0, delivered = 0;
  ctx.provide('sessionController', {}); ctx.provide('workspaceRegistry', {});
  ctx.on('mythos-brain/snapshot', async payload => {
    if (payload.sessionId !== sessionId) return;
    attempts++; await new Promise(r => setTimeout(r, 10));
    if (attempts === 1) throw new Error('async observer failed');
    delivered++;
  });
  try {
    await ctx.plugin(ServicePlugin, { ...bridgeConfig(), pollIntervalMs: 30000 });
    await ctx.get('mythosBrain').bridge.tick();
    await ctx.get('mythosBrain').bridge.restore();
    assert.equal(attempts, 2); assert.equal(delivered, 1);
  } finally { await ctx.fiber.dispose(); }
});

test('disposal releases a pending observer acknowledgement without any later emission', async () => {
  const b = bridge(); let entered;
  const began = new Promise(resolve => { entered = resolve; });
  let release; const observer = new Promise(resolve => { release = resolve; });
  b.emit = async () => { entered(); await observer; };
  const delivery = b.deliver('mythos-brain/event', { eventId: 'evt-pending' });
  await began;
  await b.dispose();
  assert.equal(await delivery, false);
  release();
});

test('a malformed snapshot cursor is rejected and restoration rereads a valid snapshot', async () => {
  const sessionId = 'session-malformed-cursor';
  await client.request('POST', '/api/brain/work-items', { key: 'bad-cursor-fixture', body: {
    source: { type: 'DIRECT', id: 'DSH:' + sessionId, revision: 1 }, sessionId, sandboxId: configuration.records.alice.sandbox_id } });
  const reply = once(lines, 'line');
  fixture.stdin.write(JSON.stringify({ action: 'bad-cursor', sessionId, id: 'bad-cursor' }) + '\n');
  await reply;
  const events = []; const b = bridge(events);
  try {
    await b.restore();
    assert.equal(events.filter(e => e.topic === 'mythos-brain/snapshot' && e.event.sessionId === sessionId).length, 0);
    await b.restore();
    const recovered = events.filter(e => e.topic === 'mythos-brain/snapshot' && e.event.sessionId === sessionId);
    assert.equal(recovered.length, 1);
    assert.ok(Number.isSafeInteger(recovered[0].event.snapshot.cursor));
  } finally { await b.dispose(); }
});
