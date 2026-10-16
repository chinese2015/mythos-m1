import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { M2Client } from '../plugins/argon-brain/client.mjs';
import { BrainBridge } from '../plugins/argon-brain/bridge.mjs';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as ServicePlugin from '../plugins/argon-brain/service.mjs';
import * as ToolPlugin from '../plugins/argon-brain/index.mjs';

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
  [owner, { sandboxId: record.sandbox_id, workspacePath: record.workspace_path, preset: 'argon-' + owner }])) });
const bridge = (events = []) => new BrainBridge(bridgeConfig(), { emit: (topic, event) => events.push({ topic, event }) });
const call = (callId, signal) => ({ callId, signal });

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
    for (const action of [() => b.status('alice', 'session-private-b', op.operationId),
      () => b.follow('alice', 'session-private-b', op.operationId, 0),
      () => b.cancel('alice', 'session-private-b', op.operationId, call('wrong-cancel')),
      () => b.status('bob', 'session-private-a', op.operationId)]) {
      await assert.rejects(action, /bound|session|unavailable/i);
    }
    await b.cancel('alice', 'session-private-a', op.operationId, call('cancel-private'));
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
  const delivered = events.filter(e => e.topic === 'argon-brain/event' && e.event.sessionId === 'session-events');
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
    assert.equal(ctx.get('argonBrain'), undefined);
    assert.equal(ctx.tools.get('execution_run'), undefined);
    assert.equal((await client.request('GET', '/api/brain/operations/' + operation.operationId)).state, 'QUEUED');
    await client.request('POST', '/api/brain/operations/' + operation.operationId + '/cancel', { key: 'cordis-cleanup', body: { expectedVersion: 1 } });
  } finally { await ctx.fiber.dispose(); }
});
