import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskWorkflow } from '../plugins/argon-workflow/controller.mjs';
import { TaskIntake } from '../plugins/argon-workflow/intake.mjs';
import { isManagedWork, effectivePolicy, admittedChangePolicy, candidateAllowed, baselineReady, verifiedTaskCandidate } from '../plugins/argon-workflow/task-spec.mjs';
import { taskPreset } from '../plugins/argon-workflow/session-policy.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/generic-task-spec.json', import.meta.url), 'utf8'));
const TASK_ID = 'TASK-' + '0'.repeat(12);
const candidate = 'b'.repeat(40);

// Canonical digest parity with Python: recursive key sort, no spaces, non-ASCII raw, specDigest excluded.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = spec => createHash('sha256').update(canonical(Object.fromEntries(Object.entries(spec).filter(([k]) => k !== 'specDigest'))), 'utf8').digest('hex');

function manualWork(overrides = {}) {
  const spec = overrides.taskSpec ?? fixture.taskSpec;
  const work = {
    workItemId: 'work-' + 'a'.repeat(32), ownerId: 'alice', sandboxId: 'sb-source', version: 1, paused: false, blocked: false,
    source: { type: 'MANUAL', id: TASK_ID, revision: 1 },
    sourceRecord: { id: TASK_ID, title: spec.task.title, description: spec.task.description, ownerId: 'alice',
      repositoryUrl: spec.repository.cloneUrl, baseCommit: spec.baseCommit, revision: 1, sourcePath: '', sourcePaths: spec.changePolicy.allowedPaths },
    taskSpec: spec, sessionIds: [],
    workflow: { phase: 'CLAIMED', approval: { actor: 'alice', specDigest: spec.specDigest } },
  };
  return work;
}
const cleanGit = (changedFiles = ['src/main/A.java'], testsChanged = []) => ({ headCommit: candidate, status: '', changedFiles, testsChanged });

test('Node recomputes the exact frozen specDigest recorded by Python', () => {
  assert.equal(digest(fixture.taskSpec), fixture.taskSpec.specDigest);
  for (const c of fixture.testPermissionCases) assert.equal(digest(c.taskSpec), c.taskSpec.specDigest);
});

test('Node and Python agree on every shared fixture change gate', () => {
  for (const c of fixture.changeCases)
    assert.equal(candidateAllowed(manualWork(), { headCommit: fixture.taskSpec.baseCommit, status: '', changedFiles: c.paths, testsChanged: [] }), c.allowed, c.paths.join(','));
});

test('a rename out of tests still includes and rejects the deleted test source path', () => {
  const work = manualWork();
  assert.equal(candidateAllowed(work, {
    headCommit: candidate,
    status: '',
    changedFiles: ['src/hidden.java', 'tests/test_hidden.py'],
    testsChanged: [],
  }), false);
});

test('Node and Python agree on every shared fixture verification case', () => {
  const work = manualWork({ taskSpec: { ...fixture.taskSpec, changePolicy: { ...fixture.taskSpec.changePolicy, allowTestChanges: true } } });
  work.workflow.candidateCommit = candidate;
  for (const c of fixture.verificationCases)
    assert.equal(verifiedTaskCandidate(work, { ...structuredClone(c.operation), evidence: structuredClone(c.evidence) }, cleanGit()), c.passes, c.name);
});

test('Node and Python agree on test permission cases and the digest frozen policy', () => {
  for (const c of fixture.testPermissionCases) {
    assert.equal(c.taskSpec.changePolicy.allowTestChanges, c.allowTestChanges, c.name);
    const work = manualWork({ taskSpec: c.taskSpec });
    assert.equal(candidateAllowed(work, { headCommit: c.taskSpec.baseCommit, status: '', changedFiles: ['src/test/ATest.java'], testsChanged: [] }), c.allowTestChanges, c.name);
  }
});

test('Node and Python agree on build permission admission and change gates', () => {
  for (const c of fixture.buildPermissionCases) {
    if (c.admitted) {
      const policy = admittedChangePolicy(c.repositoryConfig, c.manualInput);
      const work = manualWork({ taskSpec: { ...fixture.taskSpec, changePolicy: policy } });
      assert.equal(candidateAllowed(work, { headCommit: fixture.taskSpec.baseCommit, status: '', changedFiles: c.changedPaths, testsChanged: [] }), c.changeAllowed, c.name);
    } else {
      assert.throws(() => admittedChangePolicy(c.repositoryConfig, c.manualInput), /任务|Task|permission|权限|scope|范围/, c.name);
    }
  }
});

test('task permission cannot widen beyond the repository ceiling', () => {
  assert.throws(() => admittedChangePolicy(fixture.repositoryConfig, { ...fixture.manualInput, allowedPaths: ['other/'] }), /narrow|收窄|范围|scope/);
  assert.throws(() => admittedChangePolicy(fixture.repositoryConfig, { ...fixture.manualInput, allowTestChanges: true }), /test|测试|permission|权限/);
  const inherited = admittedChangePolicy(fixture.repositoryConfig, fixture.manualInput);
  assert.deepEqual(inherited.allowedPaths, ['src/']);
  assert.equal(inherited.allowTestChanges, false);
});

const LEGACY = { workItemId: 'work-' + 'f'.repeat(32), ownerId: 'alice', sandboxId: 'sb-task',
  source: { type: 'ARGON', id: 'FND-00009' }, sourceRecord: { sourcePath: 'src/main/java/com/example/catalog/CatalogSearchService.java' },
  workflow: { approval: { actor: 'alice' } } };
test('legacy works keep the original single-file policy and baseline contract', () => {
  assert.equal(isManagedWork(LEGACY), false);
  assert.equal(isManagedWork(manualWork()), true);
  assert.equal(isManagedWork({ source: { type: 'MANUAL' } }), false);
  assert.deepEqual(effectivePolicy(LEGACY), { allowedPaths: ['src/main/java/com/example/catalog/CatalogSearchService.java'], allowTestChanges: false, maxFiles: 1 });
  const good = { headCommit: 'c'.repeat(40), status: '', changedFiles: ['src/main/java/com/example/catalog/CatalogSearchService.java'], testsChanged: [] };
  assert.equal(candidateAllowed(LEGACY, good), true);
  assert.equal(candidateAllowed(LEGACY, { ...good, changedFiles: ['a.java', 'b.java'] }), false);
  assert.equal(candidateAllowed(LEGACY, { ...good, testsChanged: ['src/test/X.java'] }), false);
  const failing = { state: 'FAILED', exitCode: 1, evidence: { junit: { tests: 2, failures: 1, errors: 0, skipped: 0, failedTests: ['maliciousInputReturnsNothing'] } } };
  assert.equal(baselineReady(LEGACY, failing), true);
  assert.equal(baselineReady(LEGACY, { state: 'FAILED', exitCode: 1, evidence: { junit: { tests: 0 } } }), false);
});

test('baseline readiness follows the frozen baselineMode and rejects UNKNOWN or environment loss', () => {
  const mode = m => manualWork({ taskSpec: { ...fixture.taskSpec, execution: { ...fixture.taskSpec.execution, baselineMode: m } } });
  const op = (work, state, exitCode, { tests = 4, failures = state === 'FAILED' ? 1 : 0, errors = 0, ...changes } = {}) => {
    const command = work.taskSpec.execution.baselineCommand;
    const sourceCommit = work.sourceRecord.baseCommit;
    const junit = { reports: [{ path: 'target/surefire-reports/TEST-baseline.xml' }], invalidReports: [],
      tests, failures, errors, skipped: 0 };
    return { operationId: 'exec-' + 'd'.repeat(32), kind: 'UNIT_TEST', state, exitCode, command,
      timeoutSeconds: work.taskSpec.execution.timeoutSeconds, sourceCommit, sandboxId: work.sandboxId, reason: null,
      evidence: { sourceCommit, expectedSourceCommit: sourceCommit, sourceDirty: false, command, exitCode,
        kind: 'UNIT_TEST', sandboxId: work.sandboxId, junit }, ...changes };
  };
  const rec = mode('record'), pass = mode('must-pass'), failMode = mode('must-fail');
  const ok = op(pass, 'SUCCEEDED', 0), fail = op(rec, 'FAILED', 1), env = { ...op(rec, 'FAILED', 127), reason: 'preflight_or_supervisor_error' }, unknown = { state: 'UNKNOWN' };
  assert.equal(baselineReady(mode('record'), ok), true);
  assert.equal(baselineReady(mode('record'), fail), true);
  assert.equal(baselineReady(rec, env), false);
  assert.equal(baselineReady(rec, unknown), false);
  assert.equal(baselineReady(pass, ok), true);
  assert.equal(baselineReady(pass, fail), false);
  assert.equal(baselineReady(failMode, op(failMode, 'FAILED', 1)), true);
  assert.equal(baselineReady(failMode, ok), false);
  assert.equal(baselineReady(failMode, unknown), false);

  const invalidReports = op(rec, 'FAILED', 127);
  invalidReports.evidence.junit = { reports: [], invalidReports: [], tests: 0, failures: 0, errors: 0, skipped: 0 };
  const invalidXml = op(rec, 'FAILED', 0);
  invalidXml.evidence.junit = { reports: [], invalidReports: [{ path: 'TEST-broken.xml' }], tests: 0, failures: 0, errors: 0, skipped: 0 };
  const wrongCommand = op(rec, 'FAILED', 1, { command: 'mvn -q test' });
  const wrongSource = op(rec, 'FAILED', 1, { sourceCommit: 'c'.repeat(40) });
  const passingExitFailure = op(rec, 'FAILED', 1, { failures: 0, errors: 0 });
  assert.equal(baselineReady(rec, invalidReports), false);
  assert.equal(baselineReady(rec, invalidXml), false);
  assert.equal(baselineReady(rec, wrongCommand), false);
  assert.equal(baselineReady(rec, wrongSource), false);
  assert.equal(baselineReady(rec, passingExitFailure), false);
});

// ---- Workflow harness for MANUAL works ----
function harness(work, { events = [] } = {}) {
  const ops = new Map(); const posted = []; let lostAck = false;
  const sessions = { inspect: async () => ({ events }), list: async () => ({ items: [] }), create: async args => ({ sessionId: args.sessionId }) };
  const client = { dispose: async () => {}, request: async (method, path, options = {}) => {
    if (method === 'GET' && path.endsWith('/work-items')) return { workItems: [structuredClone(work)] };
    if (method === 'GET' && path.endsWith('/workspace')) return { workspacePath: '/home/demo/workspace', git: harness.git };
    if (method === 'GET' && path.includes('/operations/')) return structuredClone(ops.get(path.split('/').at(-1)));
    if (method === 'GET') return { workItem: structuredClone(work), operations: [...ops.values()].map(o => structuredClone(o)), sessions: [] };
    if (path.endsWith('/prepare')) return { ...structuredClone(work), sandboxId: 'sb-manual' };
    if (path.endsWith('/operations')) { posted.push(structuredClone(options)); const op = { operationId: 'exec-' + 'd'.repeat(32), workItemId: work.workItemId, kind: options.body.kind, command: options.body.command,
      timeoutSeconds: options.body.timeoutSeconds, sourceCommit: options.body.sourceCommit, state: 'QUEUED' }; ops.set(op.operationId, op); work.version++;
      if (lostAck) { lostAck = false; throw new Error('lost acknowledgement'); } return structuredClone(op); }
    if (path.endsWith('/workflow')) { work.workflow = structuredClone(options.body.workflow); work.blocked = options.body.blocked; work.version++; return structuredClone(work); }
    if (path.endsWith('/sessions')) { work.sessionIds = [...work.sessionIds, options.body.sessionId]; work.version++; return structuredClone(work); }
    throw new Error('Unexpected route ' + path);
  } };
  const controller = new TaskWorkflow({ owner: 'alice', root: '/home/demo' }, { client, sessions, source: {}, workspaces: { create: async (p, id) => ({ id: 'ws-' + id, path: p }) }, presets: { register: async () => async () => {} } });
  harness.git = { headCommit: work.sourceRecord.baseCommit, status: '', changedFiles: [], testsChanged: [] };
  return { controller, work, ops, posted, loseAck: () => { lostAck = true; } };
}

test('MANUAL work enters list, detail, PLAN and CODE with the correct Session binding', async () => {
  const work = manualWork();
  work.workflow = { phase: 'PLANNING', planSessionId: 'session-plan-x', planRequestId: 'req-plan', approval: { actor: 'alice', specDigest: work.taskSpec.specDigest } };
  work.sessionIds = ['session-plan-x'];
  const h = harness(work, { events: [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: 'req-plan' }, content: [{ type: 'text', text: 'Plan' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Change src/main/A.java' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }] });
  const listed = await h.controller.listWorks();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source.type, 'MANUAL');
  const detail = await h.controller.detail(work.workItemId);
  assert.equal(detail.session.sessionId, 'session-plan-x');
  assert.equal(detail.session.role, 'PLAN');
  await h.controller.step(structuredClone(h.work));
  assert.equal(h.work.workflow.phase, 'AWAITING_PLAN_APPROVAL');
  await h.controller.approve(work.workItemId, { expectedVersion: h.work.version, planHash: h.work.workflow.planHash }, 'approve-1');
  assert.equal(h.work.workflow.phase, 'CODING');
  assert.equal(h.work.workflow.approval.specDigest, work.taskSpec.specDigest);
  assert.ok(h.work.workflow.codeSessionId.startsWith('session-'));
});

test('BASELINE submits the frozen command and timeout, then advances per record/must-pass/must-fail', async () => {
  for (const [mode, terminal, expected] of [['record', { state: 'FAILED', exitCode: 1 }, 'PLANNING'], ['record', { state: 'UNKNOWN' }, 'BLOCKED'],
    ['must-pass', { state: 'SUCCEEDED', exitCode: 0 }, 'PLANNING'], ['must-pass', { state: 'FAILED', exitCode: 1 }, 'BLOCKED'],
    ['must-fail', { state: 'FAILED', exitCode: 1 }, 'PLANNING'], ['must-fail', { state: 'SUCCEEDED', exitCode: 0 }, 'BLOCKED']]) {
    const work = manualWork({ taskSpec: { ...fixture.taskSpec, execution: { ...fixture.taskSpec.execution, baselineMode: mode } } });
    work.workflow.phase = 'BASELINE';
    const h = harness(work);
    await h.controller.step(structuredClone(h.work));
    assert.equal(h.posted.length, 1, mode + ' ' + terminal.state);
    assert.equal(h.posted[0].body.command, fixture.taskSpec.execution.baselineCommand);
    assert.equal(h.posted[0].body.timeoutSeconds, fixture.taskSpec.execution.timeoutSeconds);
    assert.equal(h.posted[0].body.sourceCommit, fixture.taskSpec.baseCommit);
    const op = h.ops.get(h.work.workflow.baselineOperationId); Object.assign(op, terminal);
    if (terminal.state !== 'UNKNOWN') {
      op.sandboxId = h.work.sandboxId; op.reason = null;
      op.evidence = { sourceCommit: fixture.taskSpec.baseCommit, expectedSourceCommit: fixture.taskSpec.baseCommit,
        sourceDirty: false, command: fixture.taskSpec.execution.baselineCommand, exitCode: terminal.exitCode,
        kind: 'UNIT_TEST', sandboxId: h.work.sandboxId,
        junit: { reports: [{ path: 'target/surefire-reports/TEST-baseline.xml' }], invalidReports: [],
          tests: 4, failures: terminal.state === 'FAILED' ? 1 : 0, errors: 0, skipped: 0 } };
    }
    await h.controller.step(structuredClone(h.work));
    assert.equal(h.work.workflow.phase, expected, mode + ' ' + terminal.state);
  }
});

test('taskSpec summary binds approval and survives a controller restart replay', async () => {
  const work = manualWork();
  work.workflow = { phase: 'AWAITING_PLAN_APPROVAL', planHash: 'hash', planEndSequence: 4, planRequestId: 'plan', planSessionId: 'session-plan',
    approval: { actor: 'alice', planHash: 'hash', expectedVersion: 1, key: 'approve-1', specDigest: work.taskSpec.specDigest } };
  work.sessionIds = ['session-plan'];
  work.sandboxId = 'sb-manual';
  const events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source: { rpcId: 'plan' } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const h = harness(work, { events });
  h.controller.workspace = async () => ({ git: { headCommit: work.sourceRecord.baseCommit, status: '', changedFiles: [], testsChanged: [] } });
  // Exact replay of the stored decision (same key/decision/version) does not bump the version, even after restart.
  const version = h.work.version;
  await h.controller.approve(work.workItemId, { expectedVersion: 1, planHash: 'hash' }, 'approve-1');
  assert.equal(h.work.version, version);
  const restarted = new TaskWorkflow({ owner: 'alice' }, { client: h.controller.client, sessions: h.controller.sessions, source: {}, workspaces: {}, presets: {} });
  restarted.workspace = h.controller.workspace;
  await restarted.approve(work.workItemId, { expectedVersion: 1, planHash: 'hash' }, 'approve-1');
  assert.equal(h.work.version, version);
  // A decision recorded against a different frozen digest cannot enter CODE.
  h.work.workflow.approval.specDigest = '0'.repeat(64);
  await assert.rejects(() => restarted.approve(work.workItemId, { expectedVersion: 1, planHash: 'hash' }, 'approve-2'), /409/);
});

test('multi-file and approved test changes reach VERIFYING; out-of-scope changes block CODE', async () => {
  const codingWork = () => { const work = manualWork({ taskSpec: { ...fixture.taskSpec, changePolicy: { ...fixture.taskSpec.changePolicy, allowTestChanges: true } } });
    work.workflow = { phase: 'CODING', approval: { actor: 'alice', specDigest: work.taskSpec.specDigest }, plan: 'Plan',
      planSessionId: 'session-plan', planRequestId: 'plan', codeSessionId: 'session-code', codeRequestId: 'req-code' };
    work.sessionIds = ['session-code']; work.sandboxId = 'sb-manual'; return work; };
  const done = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source: { rpcId: 'req-code' } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const h = harness(codingWork(), { events: done });
  h.controller.workspace = async () => ({ git: { headCommit: candidate, status: '', changedFiles: ['src/main/A.java', 'src/test/ATest.java'], testsChanged: ['src/test/ATest.java'] } });
  await h.controller.step(structuredClone(h.work));
  assert.equal(h.work.workflow.phase, 'VERIFYING');
  assert.equal(h.work.workflow.candidateCommit, candidate);
  // Out-of-scope build file change blocks.
  const h2 = harness(codingWork(), { events: done });
  h2.controller.workspace = async () => ({ git: { headCommit: candidate, status: '', changedFiles: ['src/main/A.java', 'pom.xml'], testsChanged: [] } });
  await h2.controller.step(structuredClone(h2.work));
  assert.equal(h2.work.workflow.phase, 'BLOCKED');
});

test('frozen verification command and real report counts decide review readiness', async () => {
  const verifyingWork = () => { const work = manualWork({ taskSpec: { ...fixture.taskSpec, changePolicy: { ...fixture.taskSpec.changePolicy, allowTestChanges: true } } });
    work.workflow = { phase: 'VERIFYING', approval: { actor: 'alice', specDigest: work.taskSpec.specDigest }, candidateCommit: candidate,
      verificationOperationId: null, codeSessionId: 'session-code', codeRequestId: 'req-code', codeEndSequence: 4 };
    work.sessionIds = ['session-code']; work.sandboxId = 'sb-manual'; return work; };
  const done = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source: { rpcId: 'req-code' } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const h = harness(verifyingWork(), { events: done });
  h.controller.workspace = async () => ({ git: cleanGit(['src/main/A.java', 'src/test/ATest.java'], ['src/test/ATest.java']) });
  await h.controller.step(structuredClone(h.work)); // submits frozen VERIFY command
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].body.command, fixture.taskSpec.execution.verificationCommand);
  assert.equal(h.posted[0].body.timeoutSeconds, fixture.taskSpec.execution.timeoutSeconds);
  const op = h.ops.get(h.work.workflow.verificationOperationId);
  Object.assign(op, { state: 'SUCCEEDED', exitCode: 0, sourceCommit: candidate, command: fixture.taskSpec.execution.verificationCommand,
    sandboxId: 'sb-manual', runtime: { sandboxId: 'sb-fresh', freshTargetAbsent: true },
    evidence: { exitCode: 0, sourceCommit: candidate, sourceDirty: false, sandboxId: 'sb-fresh',
      junit: { reports: [{ path: 'target/surefire-reports/TEST-customer.xml' }], invalidReports: [], tests: 3, failures: 0, errors: 0, skipped: 0 } } });
  await h.controller.step(structuredClone(h.work));
  assert.equal(h.work.workflow.phase, 'AWAITING_REVIEW');
  // A masqueraded command can never reach review.
  const h2 = harness(verifyingWork(), { events: done });
  h2.controller.workspace = h.controller.workspace;
  await h2.controller.step(structuredClone(h2.work));
  const op2 = h2.ops.get(h2.work.workflow.verificationOperationId);
  Object.assign(op2, { state: 'SUCCEEDED', exitCode: 0, sourceCommit: candidate, command: 'true',
    sandboxId: 'sb-manual', runtime: { sandboxId: 'sb-fresh', freshTargetAbsent: true },
    evidence: { exitCode: 0, sourceCommit: candidate, sourceDirty: false, sandboxId: 'sb-fresh', junit: { reports: [{ path: 'target/surefire-reports/TEST-customer.xml' }], invalidReports: [], tests: 3, failures: 0, errors: 0, skipped: 0 } } });
  await h2.controller.step(structuredClone(h2.work));
  assert.equal(h2.work.workflow.phase, 'BLOCKED');
});

test('generic prompt states the frozen scope without single-file or forbid-all-tests claims', () => {
  const unusedClient = { dispose: async () => {}, request: async () => { throw new Error('unused'); } };
  const work = manualWork({ taskSpec: { ...fixture.taskSpec, changePolicy: { ...fixture.taskSpec.changePolicy, allowTestChanges: true } } });
  work.workflow = { ...work.workflow, plan: 'Do it', planRequestId: 'req-plan', codeRequestId: 'req-code' };
  const plan = new TaskWorkflow({ owner: 'alice' }, { client: unusedClient, sessions: {}, source: {}, workspaces: {}, presets: {} }).prompt(work, 'PLAN');
  assert.match(plan, /src\//);
  assert.match(plan, /修复客户/);
  assert.doesNotMatch(plan, /只允许修改 \S+\.(java|xml)/);
  assert.doesNotMatch(plan, /不修改测试|禁止修改测试|保持现有测试不变/);
  const code = new TaskWorkflow({ owner: 'alice' }, { client: unusedClient, sessions: {}, source: {}, workspaces: {}, presets: {} }).prompt(work, 'CODE');
  assert.match(code, /mvn test/);
  assert.match(code, /允许按获批范围修改测试|获批测试/);
  // Legacy prompts keep their original single-file, no-test-change contract.
  const legacy = new TaskWorkflow({ owner: 'alice' }, { client: unusedClient, sessions: {}, source: {}, workspaces: {}, presets: {} })
    .prompt({ ...LEGACY, workflow: { ...LEGACY.workflow, plan: 'x', planRequestId: 'req-plan', codeRequestId: 'req-code' }, sourceRecord: { ...LEGACY.sourceRecord, id: 'FND-00009', title: 'SQL', baseCommit: 'b'.repeat(40), sourcePath: LEGACY.sourceRecord.sourcePath } }, 'CODE');
  assert.match(legacy, /只允许修改 src\/main\/java\/com\/example\/catalog\/CatalogSearchService\.java/);
  assert.match(legacy, /保持现有测试不变/);
});

test('task preset persona for MANUAL reflects the frozen policy instead of hardcoded test bans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argon-preset-'));
  writeFileSync(join(dir, 'package.json'), '{}');
  const managed = manualWork();
  managed.sandboxId = 'sb-manual';
  const preset = taskPreset(managed, 'CODE', { root: dir, helperHash: 'b'.repeat(64), workspacePath: '/ws' });
  const persona = preset.plugins[0].config.suffix;
  assert.match(persona, /src\//);
  assert.doesNotMatch(persona, /Do not modify tests, POM, or build configuration/);
  const legacyPreset = taskPreset({ ...LEGACY, workItemId: managed.workItemId, sandboxId: 'sb-manual' }, 'CODE', { root: dir, helperHash: 'b'.repeat(64), workspacePath: '/ws' });
  assert.match(legacyPreset.plugins[0].config.suffix, /Do not modify tests, POM, or build configuration/);
});

test('TaskIntake wraps register, revise, check and manual create with idempotency keys', async () => {
  const calls = [];
  const client = { request: async (method, path, options = {}) => { calls.push({ method, path, options }); return { ok: true }; } };
  const intake = new TaskIntake(client);
  await intake.repositories();
  await intake.register(fixture.repositoryConfig, 'reg-1');
  await intake.revise('repo-' + '1'.repeat(32), { expectedRevision: 1, enabled: false }, 'rev-1');
  await intake.check('repo-' + '1'.repeat(32));
  await intake.create(fixture.manualInput, 'create-1');
  assert.deepEqual(calls.map(c => c.method + ' ' + c.path), [
    'GET /api/brain/repositories',
    'POST /api/brain/repositories',
    'POST /api/brain/repositories/repo-' + '1'.repeat(32) + '/revisions',
    'POST /api/brain/repositories/repo-' + '1'.repeat(32) + '/check',
    'POST /api/brain/tasks/manual']);
  assert.equal(calls[1].options.key, 'reg-1');
  assert.equal(calls[4].options.key, 'create-1');
  assert.deepEqual(calls[4].options.body, fixture.manualInput);
  const workflow = new TaskWorkflow({ owner: 'alice' }, { client, sessions: {}, source: {}, workspaces: {}, presets: {} });
  assert.equal(workflow.intake.constructor, TaskIntake);
});
