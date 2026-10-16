// Operator-host acceptance of task tools over the real sandbox SSH providers.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Context, Service } from '@deepseek-ai/cordis';
import Ssh from '@deepseek-ai/dsh-ssh';
import Fs from '@deepseek-ai/dsh-fs-ssh';
import Subprocess from '@deepseek-ai/dsh-subprocess-ssh';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as Projections from '@deepseek-ai/dsh-session-projection';
import * as Files from '@deepseek-ai/dsh-tool-fs';
import * as Policy from '../plugins/argon-workflow/session-policy.mjs';
import * as Search from '../plugins/argon-workflow/search.mjs';
import { TaskWorkflow } from '../plugins/argon-workflow/controller.mjs';
const root = new URL('..', import.meta.url);
const snapshot = JSON.parse(await readFile(new URL('artifacts/task-acceptance.json', root), 'utf8'));
const record = JSON.parse(await readFile(new URL('state/sandboxes.json', root), 'utf8')).alice;
const work = snapshot.workItem, path = '/home/hx/argon-sandboxes/' + work.sandboxId + '/workspace';
const controller = new TaskWorkflow({ owner: 'alice', tokenFile: '/home/hx/.argon-brain/tokens.json' }, { sessions: {}, workspaces: {}, presets: {}, source: {} });
await controller.snapshot(work.workItemId);
const ctx = new Context();
class Workflow extends Service { constructor() { super(ctx, 'argonWorkflow'); this.controller = controller; } }
try {
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Projections.default ?? Projections); new Workflow();
  await ctx.plugin(Policy, { role: 'PLAN', workId: work.workItemId, workspacePath: path });
  await ctx.plugin(Ssh, { host: 'argon-' + work.sandboxId, node: '/usr/bin/node', helper: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', helperHash: record.helper_hash, workspace: path });
  await ctx.plugin(Fs); await ctx.plugin(Subprocess); await ctx.plugin(Files);
  await Search.apply(ctx, { sampleOverCapGlobResults: false, globMaxResults: 100, grepMaxMatches: 250, grepMaxLineBytes: 2000,
    searchMetaMaxBytes: 2000, rawOutputMaxBytes: 100000, graceMs: 100, stderrMaxBytes: 2000, timeoutMs: 10000 });
  const agent = { id: work.workflow.planSessionId, ctx, session: { id: work.workflow.planSessionId, header: { id: work.workflow.planSessionId, cwd: path } }, followup() { throw new Error('Should not reach native admission'); } };
  const execute = (name, args) => ctx.tools.execute({ agent, name, arguments: args, callId: 'task-native-' + name, signal: new AbortController().signal });
  const glob = await execute('glob', { pattern: 'src/**/*.java' });
  assert.ok(!glob.isError, JSON.stringify(glob)); assert.match(JSON.stringify(glob), /CatalogSearchServiceTest/);
  const read = await execute('read', { file_path: work.sourceRecord.sourcePath });
  assert.ok(!read.isError, JSON.stringify(read)); assert.match(JSON.stringify(read), /PreparedStatement/);
  const denied = await execute('write', { file_path: '.cache/plan-guard-must-not-exist.txt', content: 'must be denied' });
  assert.match(JSON.stringify(denied), /planning is read-only/);
  const target = await ctx.fs.resolve('.cache/plan-guard-must-not-exist.txt', { cwd: path });
  await assert.rejects(() => ctx.fs.readText(target));
  const restore = Policy.bindTaskAgent(agent, controller, work.workItemId, 'PLAN');
  try { assert.throws(() => agent.followup(), /计划已批准/); } finally { restore(); }
  const result = { sandboxId: work.sandboxId, nativeRead: true, nativeGlob: true, planWriteDenied: true, deniedFileAbsent: true, approvedPlanInputSealed: true };
  await writeFile(new URL('artifacts/task-native-acceptance.json', root), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await ctx.fiber.dispose(); await controller.dispose(); }
