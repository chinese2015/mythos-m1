// Explicit remote Docker/Cordis lifecycle acceptance. No model call here.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as ServicePlugin from '../plugins/mythos-brain/service.mjs';
import * as ToolPlugin from '../plugins/mythos-brain/index.mjs';
import { M2Client } from '../plugins/mythos-brain/client.mjs';

const records = JSON.parse(await readFile(new URL('../state/sandboxes.json', import.meta.url), 'utf8'));
const sessions = JSON.parse(await readFile(new URL('../state/poc-sessions.json', import.meta.url), 'utf8'));
const config = { baseUrl: 'http://127.0.0.1:3081', tokenFile: homedir() + '/.mythos-brain/tokens.json', pollIntervalMs: 200,
  owners: Object.fromEntries(Object.entries(records).map(([owner, record]) => [owner,
    { sandboxId: record.sandbox_id, workspacePath: record.workspace_path, preset: 'mythos-' + owner }])) };
const client = new M2Client({ ...config, owner: 'alice' });
const ctx = new Context();
const nonce = randomUUID();
const exec = { agent: { session: { header: { id: sessions.alice.sessionId } } }, callId: 'lifecycle-' + nonce,
  signal: new AbortController().signal };
const command = 'echo start-' + nonce + '; sleep 4; echo end-' + nonce;
const wait = async predicate => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Lifecycle acceptance timed out');
};
try {
  ctx.provide('sessionController', {}); ctx.provide('workspaceRegistry', {});
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  let service = await ctx.plugin(ServicePlugin, config);
  await ctx.plugin(ToolPlugin, { owner: 'alice' });
  const op = JSON.parse(await ctx.tools.get('execution_run').execute({ command }, exec));
  await wait(async () => (await client.request('GET', '/api/brain/operations/' + op.operationId + '/logs')).logs.length);
  await service.dispose();
  assert.equal(ctx.get('mythosBrain'), undefined);
  assert.equal(ctx.tools.get('execution_run'), undefined);
  const during = await client.request('GET', '/api/brain/operations/' + op.operationId);
  assert.equal(during.state, 'RUNNING');
  service = await ctx.plugin(ServicePlugin, config);
  await wait(() => ctx.tools.get('execution_run'));
  const replay = JSON.parse(await ctx.tools.get('execution_run').execute({ command }, exec));
  assert.equal(replay.operationId, op.operationId);
  const result = await wait(async () => {
    const result = await client.request('GET', '/api/brain/operations/' + op.operationId);
    return result.state === 'SUCCEEDED' ? result : null;
  });
  const logs = await client.request('GET', '/api/brain/operations/' + op.operationId + '/logs');
  const text = logs.logs.map(x => x.text).join('');
  assert.equal(text.split('start-' + nonce).length - 1, 1);
  assert.equal(text.split('end-' + nonce).length - 1, 1);
  const snapshot = JSON.parse(await ctx.tools.get('work_item_status').execute({}, exec));
  assert.ok(snapshot.operations.some(x => x.operationId === op.operationId && x.state === 'SUCCEEDED'));
  const report = { sessionId: sessions.alice.sessionId, workItemId: op.workItemId, operationId: op.operationId,
    pluginRemoved: true, toolsRemoved: true, duringUnload: during.state, reloadedOperationId: replay.operationId,
    finalState: result.state, exitCode: result.exitCode, startCount: 1, endCount: 1 };
  await writeFile(new URL('../state/brain-plugin-lifecycle.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await ctx.fiber.dispose(); await client.dispose(); }
