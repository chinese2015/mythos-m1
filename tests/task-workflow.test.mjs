import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinding } from '../plugins/argon-workflow/source.mjs';
import { sessionProgress, assertApproval, baselineReproduced } from '../plugins/argon-workflow/rules.mjs';
import { taskPreset, readonlyGuard } from '../plugins/argon-workflow/session-policy.mjs';
import { Context, Service } from '@deepseek-ai/cordis';
import * as TaskPolicy from '../plugins/argon-workflow/session-policy.mjs';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';

const source = { id: 'FND-00009', name: 'SQL injection', risk: 'HIGH', ownerId: 'owner-nova-01', revision: 2,
  repositoryUrl: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git', baseCommit: '7fd32b0535fac3f6ce105a8494e2dcbba7ce355b',
  sourcePath: 'src/main/java/com/example/catalog/CatalogSearchService.java', status: 'Not Started' };
const bolaSource = { id: 'FND-00016', name: "Invoice endpoint exposes another tenant's invoice by ID", risk: 'CRITICAL', ownerId: 'owner-aster-01', revision: 1,
  repositoryUrl: 'http://127.0.0.1:3000/demo/demo-tenant-invoice-api.git', baseCommit: '43e06161b97113cecc9282e67c7a634dc825e310',
  sourcePath: 'src/main/java/com/example/invoice/InvoiceController.java', status: 'Not Started', closed: 'Open' };
test('source adapter enables only exact Nova mapping and disables altered baselines', () => {
  const task = normalizeFinding(source);
  assert.equal(task.enabled, true); assert.equal(task.revision, 2);
  assert.equal(normalizeFinding({ ...source, baseCommit: 'a'.repeat(40) }).enabled, false);
  assert.equal(normalizeFinding({ ...source, repositoryUrl: 'file:///etc' }).enabled, false);
  assert.equal(normalizeFinding({ ...source, id: 'FND-00999' }), null);
});
test('source adapter enables FND-00016 only for its exact invoice repository, baseline, and source path', () => {
  assert.equal(normalizeFinding(bolaSource).enabled, true);
  assert.equal(normalizeFinding({ ...bolaSource, baseCommit: 'a'.repeat(40) }).enabled, false);
  assert.equal(normalizeFinding({ ...bolaSource, sourcePath: 'src/other.java' }).enabled, false);
  assert.equal(normalizeFinding({ ...bolaSource, repositoryUrl: 'http://127.0.0.1:3000/demo/demo-tenant-invoice-api-evil.git' }).enabled, false);
});

const frames = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { source: { rpcId: 'plan-42' }, content: [{ type: 'text', text: 'Plan' }] } },
  { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Use PreparedStatement' }] } } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
test('journal parser waits for real addressed turn completion, not assistant prose', () => {
  assert.equal(sessionProgress({ events: frames.slice(0, 3) }, 'plan-42').completed, false);
  const done = sessionProgress({ events: frames }, 'plan-42');
  assert.equal(done.completed, true); assert.equal(done.text, 'Use PreparedStatement');
  assert.equal(done.endSequence, 4);
  assert.equal(sessionProgress({ events: frames }, 'other-request').found, false);
  const cancelled = sessionProgress({ events: [...frames.slice(0, 3), { ...frames[3], data: { turn: 1, reason: { kind: 'cancelled' } } }] }, 'plan-42');
  assert.equal(cancelled.completed, false); assert.equal(cancelled.failed, true);
});
test('approval requires current version, exact plan, and no newer native user turn', () => {
  const snapshot = { workItem: { version: 7 }, workflow: { phase: 'AWAITING_PLAN_APPROVAL', planHash: 'plan-hash', planEndSequence: 4 } };
  assert.doesNotThrow(() => assertApproval(snapshot, { expectedVersion: 7, planHash: 'plan-hash' }, { completed: true, endSequence: 4, latestUserSequence: 2 }));
  for (const body of [{ expectedVersion: 6, planHash: 'plan-hash' }, { expectedVersion: 7, planHash: 'wrong' }])
    assert.throws(() => assertApproval(snapshot, body, { completed: true, endSequence: 4, latestUserSequence: 2 }), /409/);
  assert.throws(() => assertApproval(snapshot, { expectedVersion: 7, planHash: 'plan-hash' }, { completed: false, latestUserSequence: 6 }), /409/);
});
test('baseline reproduction requires actual expected failing JUnit evidence', () => {
  const operation = { state: 'FAILED', exitCode: 1, evidence: { junit: { tests: 2, failures: 1, errors: 0, skipped: 0, failedTests: ['maliciousInputReturnsNothing'] } } };
  assert.equal(baselineReproduced(operation), true);
  assert.equal(baselineReproduced({ state: 'FAILED', exitCode: 1, evidence: { junit: { tests: 0 } } }), false);
  assert.equal(baselineReproduced({ ...operation, evidence: { junit: { ...operation.evidence.junit, failedTests: ['findsMatchingItems'] } } }), false);
  const bola = { state: 'FAILED', exitCode: 1, evidence: { junit: { tests: 2, failures: 1, errors: 0, skipped: 0, failedTests: ['crossTenantInvoiceReadIsHidden'] } } };
  assert.equal(baselineReproduced(bola, 'FND-00016'), true);
  assert.equal(baselineReproduced({ ...bola, evidence: { junit: { ...bola.evidence.junit, failedTests: ['sameTenantAdminAndAnonymousAccessRemainCorrect'] } } }, 'FND-00016'), false);
});
test('native inbox admission is durable and canceled prompts are never treated as new work', () => {
  const inbox = [{ seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'message', role: 'user', source: { rpcId: 'code-request', kind: 'user' } }] } }];
  assert.equal(sessionProgress({ events: inbox }, 'code-request').pending, true);
  inbox.push({ seq: 2, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } });
  const result = sessionProgress({ events: inbox }, 'code-request');
  assert.equal(result.found, true); assert.equal(result.failed, true); assert.equal(result.reason, 'canceled');
});
test('task presets use the task workspace and separate PLAN from CODE capabilities', () => {
  const work = { workItemId: 'work-' + 'a'.repeat(32), ownerId: 'alice', sandboxId: 'sb-new-task' };
  const config = { root: '/home/hx/argon-m1', helperHash: 'b'.repeat(64), workspacePath: '/home/hx/argon-sandboxes/sb-new-task/workspace' };
  const plan = taskPreset(work, 'PLAN', config), code = taskPreset(work, 'CODE', config);
  const planRows = plan.plugins[1].config, codeRows = code.plugins[1].config;
  assert.equal(planRows.find(x => x.id === 'ssh').config.host, 'argon-sb-new-task');
  assert.equal(planRows.some(x => x.id === 'commands' || x.id === 'brain'), false);
  assert.equal(codeRows.some(x => x.id === 'brain'), true);
  assert.equal(readonlyGuard({ name: 'write' }), 'Task planning is read-only until human plan approval');
  assert.equal(readonlyGuard({ name: 'read' }), undefined);
});
test('native monotonic guard prevents a write tool body even when the model requests it', async () => {
  const ctx = new Context(); let wrote = 0;
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
    ctx.tools.register({ name: 'write', description: 'test mutation', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { wrote++; return []; } });
    ctx.tools.guard(readonlyGuard);
    const result = await ctx.tools.execute({ name: 'write', arguments: {}, callId: 'denied-write', signal: new AbortController().signal });
    assert.equal(wrote, 0); assert.match(JSON.stringify(result), /read-only/);
  } finally { await ctx.fiber.dispose(); }
});
test('CODE filesystem policy becomes read-only during PR publication and review', async () => {
  const ctx = new Context(), work = { workflow: { phase: 'CODING' }, paused: false }, workId = 'work-' + 'a'.repeat(32);
  class Workflow extends Service { constructor() { super(ctx, 'argonWorkflow'); this.controller = { closed: false, workState: new Map([[workId, work]]), inputRejection: () => undefined }; } }
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); new Workflow(); await ctx.plugin(TaskPolicy, { role: 'CODE', workId, workspacePath: '/task' });
    assert.equal(ctx.sandboxPolicy.resolve().mode, 'workspace-write');
    for (const phase of ['PUBLISHING', 'PR_OPEN', 'CLOSING', 'COMPLETED']) { work.workflow.phase = phase; assert.equal(ctx.sandboxPolicy.resolve().mode, 'read-only'); }
  } finally { await ctx.fiber.dispose(); }
});

test('each approved mapped asset uses its own expected failing security tests', () => {
  const op = names => ({ state: 'FAILED', exitCode: 1, evidence: { junit: { tests: 2, failures: names.length, errors: 0, skipped: 0, failedTests: names } } });
  assert.equal(baselineReproduced(op(['blocksTraversalOutsideReportDirectory']), 'FND-00015'), true);
  assert.equal(baselineReproduced(op(['maliciousInputReturnsNothing']), 'FND-00015'), false);
  assert.equal(baselineReproduced(op(['noHardcodedAdminPassword','leakedDemoPasswordNotPresent']), 'FND-00003'), true);
  assert.equal(baselineReproduced(op(['unrelatedTest','leakedDemoPasswordNotPresent']), 'FND-00003'), false);
  assert.equal(baselineReproduced(op(['maliciousInputReturnsNothing']), 'FND-99999'), false);
});
test('provider quota failures give an actionable explanation without exposing the raw response', () => {
  const events = [...frames.slice(0, 3), { ...frames[3], data: { turn: 1, reason: { kind: 'error', error: {
    code: 'AUTH', message: '403 permission_error: reached your weekly (7-day) usage limit; private-response' } } } }];
  const progress = sessionProgress({ events }, 'plan-42');
  assert.equal(progress.failed, true); assert.match(progress.reason, /额度已用尽/); assert.ok(!progress.reason.includes('private-response'));
});
