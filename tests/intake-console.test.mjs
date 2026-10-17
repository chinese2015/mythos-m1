import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { consoleHandler } from '../plugins/argon-console/index.mjs';
import { TaskWorkflow } from '../plugins/argon-workflow/controller.mjs';
import { TaskIntake } from '../plugins/argon-workflow/intake.mjs';
import { findingBinding } from '../plugins/argon-subscribe/triage.mjs';
import { buildManualInput, buildRepositoryConfig, createIntentKey, evidenceLine, sourceFacts, IntentLedger } from '../plugins/argon-console/public/intake-view.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/generic-task-spec.json', import.meta.url), 'utf8'));
const REPO_ID = 'repo-' + '1'.repeat(32);

const memoryStorage = () => { const map = new Map(); return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } }; };

// ---- console proxy: auth gates, 401/403/415, key/body/version passthrough ----
// The intake object is the real TaskIntake over a recording M2 client, so proxy
// tests also exercise the client-side route validation and key/body passthrough.
function intakeServer({ repositories = [] } = {}) {
  const calls = [];
  const registered = { repositoryId: REPO_ID, ownerId: 'alice', revision: 1, enabled: true, config: fixture.repositoryConfig, createdAt: 't', updatedAt: 't' };
  const client = { request: async (method, path, options = {}) => {
    calls.push([method, path, options]);
    if (method === 'GET' && path === '/api/brain/repositories') return { repositories };
    if (method === 'POST' && path === '/api/brain/repositories') return registered;
    if (method === 'POST' && path.endsWith('/revisions')) {
      const id = path.split('/')[4];
      return { ...registered, repositoryId: id, revision: options.body.expectedRevision + 1, enabled: options.body.enabled ?? true, config: options.body.config ?? registered.config };
    }
    if (method === 'POST' && path.endsWith('/check')) return { fullName: 'demo/customer-api', defaultBranch: 'main', pushPermission: true };
    if (method === 'POST' && path === '/api/brain/tasks/manual') return { workItemId: 'work-' + 'b'.repeat(32), source: { type: 'MANUAL', id: 'TASK-abcdef123456', revision: 1 } };
    throw new Error('Unexpected brain route ' + path);
  } };
  const intake = new TaskIntake(client);
  const server = createServer(consoleHandler({ connection: { requestRejection: ({ headers }) => headers.origin === 'http://evil.invalid' ? 403 : headers.cookie === 'session=valid' ? undefined : 401 }, workflow: { intake } }));
  return { server, calls };
}
async function withServer(fixture, fn) {
  await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + fixture.server.address().port;
  try { await fn(url); } finally { await new Promise(resolve => fixture.server.close(resolve)); }
}
const auth = { cookie: 'session=valid' };
const action = body => ({ method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Argon-Action': '1', 'Idempotency-Key': 'op-1' }, body: JSON.stringify(body) });

test('intake proxies fence authentication, origin, JSON action header and idempotency key before admitting', async () => {
  const f = intakeServer();
  await withServer(f, async url => {
    assert.equal((await fetch(url + '/argon/api/repositories')).status, 401);
    assert.equal((await fetch(url + '/argon/api/repositories', { headers: { ...auth, origin: 'http://evil.invalid' } })).status, 403);
    const noJson = await fetch(url + '/argon/api/repositories', { method: 'POST', headers: auth, body: '{}' });
    assert.equal(noJson.status, 415);
    const wrongType = await fetch(url + '/argon/api/repositories', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(wrongType.status, 415);
    const noKey = await fetch(url + '/argon/api/repositories', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Argon-Action': '1' }, body: '{}' });
    assert.equal(noKey.status, 400);
    const badKey = await fetch(url + '/argon/api/repositories', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Argon-Action': '1', 'Idempotency-Key': 'bad key!' }, body: '{}' });
    assert.equal(badKey.status, 400);
    const manualNoKey = await fetch(url + '/argon/api/tasks/manual', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Argon-Action': '1' }, body: '{}' });
    assert.equal(manualNoKey.status, 400);
    assert.equal(f.calls.length, 0);
  });
});

test('intake proxies pass repository list, register, revision, check and manual create through with status codes', async () => {
  const f = intakeServer(); const config = fixture.repositoryConfig;
  await withServer(f, async url => {
    const list = await fetch(url + '/argon/api/repositories', { headers: auth });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { repositories: [] });
    const register = await fetch(url + '/argon/api/repositories', action(config));
    assert.equal(register.status, 201);
    assert.equal((await register.json()).repositoryId, REPO_ID);
    const revise = await fetch(url + `/argon/api/repositories/${REPO_ID}/revisions`, action({ expectedRevision: 1, enabled: false }));
    assert.equal(revise.status, 200);
    const check = await fetch(url + `/argon/api/repositories/${REPO_ID}/check`, action({}));
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), { fullName: 'demo/customer-api', defaultBranch: 'main', pushPermission: true });
    const create = await fetch(url + '/argon/api/tasks/manual', action(fixture.manualInput));
    assert.equal(create.status, 202);
    assert.deepEqual(f.calls, [
      ['GET', '/api/brain/repositories', {}],
      ['POST', '/api/brain/repositories', { key: 'op-1', body: config }],
      ['POST', `/api/brain/repositories/${REPO_ID}/revisions`, { key: 'op-1', body: { expectedRevision: 1, enabled: false } }],
      ['POST', `/api/brain/repositories/${REPO_ID}/check`, { body: {} }],
      ['POST', '/api/brain/tasks/manual', { key: 'op-1', body: fixture.manualInput }],
    ]);
  });
});

test('intake proxy surfaces invalid repository ids as 400 without reaching the brain', async () => {
  const f = intakeServer();
  await withServer(f, async url => {
    const response = await fetch(url + '/argon/api/repositories/not-a-repo/revisions', action({ expectedRevision: 1, enabled: false }));
    assert.equal(response.status, 400);
    assert.equal(f.calls.length, 0);
  });
});

// ---- canonical request shapes from valid form input ----
const validForm = {
  displayName: '客户 API', fullName: 'demo/customer-api', defaultBranch: 'main',
  runtimeProfile: 'java17-maven-offline-v1',
  baselineCommand: 'mvn -B -o test', verificationCommand: 'mvn -B -o clean verify', baselineMode: 'must-fail',
  timeoutSeconds: '300', evidenceFormat: 'junit', reportDirs: 'target/surefire-reports', minTests: '2', allowSkipped: false,
  allowedPaths: 'src/', allowTestChanges: false, maxFiles: '100', minApprovals: '0', requiredStatusContexts: '',
};
test('valid register form input produces the canonical repository request with fixed connection and no token/path settings', () => {
  const config = buildRepositoryConfig(validForm);
  assert.deepEqual(config, {
    displayName: '客户 API', connectionId: 'local-gitea', fullName: 'demo/customer-api', defaultBranch: 'main',
    runtimeProfile: 'java17-maven-offline-v1',
    execution: { baselineCommand: 'mvn -B -o test', verificationCommand: 'mvn -B -o clean verify', baselineMode: 'must-fail', timeoutSeconds: 300,
      evidence: { format: 'junit', reportDirs: ['target/surefire-reports'], minTests: 2, allowSkipped: false } },
    changePolicy: { allowedPaths: ['src/'], allowTestChanges: false, maxFiles: 100 },
    reviewPolicy: { minApprovals: 0, requiredStatusContexts: [] },
  });
  assert.ok(!JSON.stringify(config).match(/token|secret|password/i), 'form output must not carry credentials');
  assert.deepEqual(Object.keys(config).sort(), ['changePolicy', 'connectionId', 'defaultBranch', 'displayName', 'execution', 'fullName', 'reviewPolicy', 'runtimeProfile']);
});
test('command evidence fixes reportDirs to empty and minTests to zero', () => {
  const config = buildRepositoryConfig({ ...validForm, evidenceFormat: 'command', reportDirs: 'target/surefire-reports', minTests: '5' });
  assert.deepEqual(config.execution.evidence, { format: 'command', reportDirs: [], minTests: 0, allowSkipped: false });
});
test('register form rejects unknown runtime profiles, bad full names and unsafe paths', () => {
  assert.throws(() => buildRepositoryConfig({ ...validForm, runtimeProfile: 'custom' }), /runtimeProfile|运行时/);
  assert.throws(() => buildRepositoryConfig({ ...validForm, fullName: '../escape' }), /fullName/);
  assert.throws(() => buildRepositoryConfig({ ...validForm, allowedPaths: '.git/' }), /路径|path/i);
  assert.throws(() => buildRepositoryConfig({ ...validForm, baselineMode: 'whatever' }), /baselineMode|基线/);
});
test('valid task form input produces the canonical manual request, omitting empty optional fields', () => {
  const repository = { repositoryId: REPO_ID, revision: 3, enabled: true, config: fixture.repositoryConfig };
  const minimal = buildManualInput({ title: '修复客户', description: 'Support multiple files', acceptanceCriteria: 'Tests pass', baseBranch: '', baseCommit: '', allowedPaths: '', allowTestChanges: false }, repository);
  assert.deepEqual(minimal, { repositoryId: REPO_ID, repositoryRevision: 3, title: '修复客户', description: 'Support multiple files', acceptanceCriteria: 'Tests pass' });
  const permissive = { ...repository, config: { ...fixture.repositoryConfig, changePolicy: { ...fixture.repositoryConfig.changePolicy, allowTestChanges: true } } };
  const full = buildManualInput({ title: '修复客户', description: 'd', acceptanceCriteria: 'a', baseBranch: 'release/1.0', baseCommit: 'a'.repeat(40), allowedPaths: 'src/, src/main/', allowTestChanges: true }, permissive);
  assert.deepEqual(full, { repositoryId: REPO_ID, repositoryRevision: 3, title: '修复客户', description: 'd', acceptanceCriteria: 'a', baseBranch: 'release/1.0', baseCommit: 'a'.repeat(40), allowedPaths: ['src/', 'src/main/'], allowTestChanges: true });
  assert.throws(() => buildManualInput({ title: 't', description: 'd', acceptanceCriteria: 'a', allowTestChanges: true }, repository), /测试|许可/);
  assert.throws(() => buildManualInput({ title: 't', description: 'd', acceptanceCriteria: 'a', baseCommit: 'abc123' }, repository), /baseCommit|SHA/);
  assert.throws(() => buildManualInput({ title: 't', description: 'd', acceptanceCriteria: 'a', allowedPaths: '../' }, repository), /路径|path/i);
});

// ---- intent idempotency ledger: reuse until acknowledged, explicit new intent on change ----
test('intent ledger reuses one key across retries and reloads until success, then clears', () => {
  const storage = memoryStorage();
  const first = new IntentLedger('manual-task', storage);
  const a = first.intent('fp-A');
  assert.match(a.key, /^[A-Za-z0-9_-]{1,150}$/);
  const retry = first.intent('fp-A');
  assert.equal(retry.key, a.key, 'a retry must reuse the admitted intent key, not mint a random one');
  const reloaded = new IntentLedger('manual-task', storage);
  assert.equal(reloaded.intent('fp-A').key, a.key, 'a page reload must reuse the same intent key until acknowledged');
  first.succeed();
  const after = new IntentLedger('manual-task', storage);
  const b = after.intent('fp-A');
  assert.notEqual(b.key, a.key, 'an acknowledged intent is cleared; the next submit starts a fresh key');
});
test('changed business input cannot silently reuse an unacknowledged intent; an explicit reset starts a new one', () => {
  const storage = memoryStorage();
  const ledger = new IntentLedger('manual-task', storage);
  const a = ledger.intent('fp-A');
  assert.throws(() => ledger.intent('fp-B'), error => error.code === 'INTENT_CHANGED');
  ledger.reset();
  const b = ledger.intent('fp-B');
  assert.notEqual(b.key, a.key);
});
test('unacknowledged intent survives an error outcome so a safe retry reuses the key', () => {
  const storage = memoryStorage();
  const ledger = new IntentLedger('register', storage);
  const a = ledger.intent('fp-A');
  // Simulate a lost acknowledgement: no success confirmation arrived.
  const reopened = new IntentLedger('register', storage);
  assert.equal(reopened.intent('fp-A').key, a.key);
});
test('ledger scopes keep repository registration and manual task intents apart', () => {
  const storage = memoryStorage();
  const reg = new IntentLedger('register', storage).intent('fp-R');
  const task = new IntentLedger('manual-task', storage).intent('fp-T');
  assert.notEqual(reg.key, task.key);
});
test('intent keys are well formed for the console mutation gate', () => {
  for (let i = 0; i < 50; i++) assert.match(createIntentKey(), /^[A-Za-z0-9_-]{1,150}$/);
});

// ---- truthful rendering helpers ----
test('evidence lines stay truthful: missing JUnit reports never render as zero passed', () => {
  assert.equal(evidenceLine('junit', null), '未产出 JUnit 报告');
  assert.equal(evidenceLine('junit', { tests: 3, failures: 0, errors: 0 }), 'JUnit：3 项 · 0 失败 · 0 错误');
  assert.equal(evidenceLine('command', null), null, 'command evidence must not fabricate a JUnit line');
});
test('manual work items expose scope and evidence without fake risk or a single source file', () => {
  const record = { id: 'TASK-abcdef123456', title: 't', risk: undefined, sourcePath: '', sourcePaths: ['src/'] };
  const facts = sourceFacts(record, fixture.taskSpec);
  assert.equal(facts.riskLabel, null);
  assert.equal(facts.singleFile, false);
  assert.equal(facts.scopeLabel, 'src/');
  assert.equal(facts.evidenceLabel, 'JUnit · 至少 1 项');
  const legacy = sourceFacts({ id: 'FND-1', risk: 'HIGH', sourcePath: 'src/Fix.java', sourcePaths: undefined }, null);
  assert.equal(legacy.riskLabel, '高风险');
  assert.equal(legacy.singleFile, true);
  assert.equal(legacy.evidenceLabel, null);
});

// ---- list regression: findings unchanged, manual rows carry no fake fields ----
function tasksHarness({ works = [], findings = [], intakes = [] } = {}) {
  const client = { dispose: async () => {}, request: async (method, path) => {
    if (path.endsWith('/work-items')) return { workItems: works };
    if (path.endsWith('/source-intakes')) return { intakes };
    throw new Error('Unexpected route ' + path);
  } };
  const controller = new TaskWorkflow({ owner: 'alice' }, { client, sessions: {}, source: { list: async () => findings }, workspaces: {}, presets: {} });
  return controller;
}
test('task list keeps legacy finding rows intact and lists manual work items without re-start or fake risk', async () => {
  const work = { workItemId: 'work-' + 'a'.repeat(32), ownerId: 'alice', paused: false,
    source: { type: 'MANUAL', id: 'TASK-abcdef123456', revision: 1 },
    sourceRecord: { id: 'TASK-abcdef123456', title: '修复客户', description: 'd', ownerId: 'alice', repositoryUrl: 'http://127.0.0.1:3000/demo/customer-api.git', baseCommit: 'a'.repeat(40), revision: 1, sourcePath: '', sourcePaths: ['src/'] },
    taskSpec: fixture.taskSpec, sessionIds: [], workflow: { phase: 'PLANNING' } };
  const finding = { id: 'FND-00009', title: 'Traversal', risk: 'HIGH', enabled: true, revision: 2, baseCommit: 'b'.repeat(40), repositoryUrl: 'http://127.0.0.1:3000/demo/catalog.git', ownerId: 'owner-1' };
  const controller = tasksHarness({ works: [work], findings: [finding], intakes: [{ findingId: finding.id, revision: 2, state: 'APPROVED', triage: { result: 'CONFIRMED' }, decision: { binding: findingBinding(finding) } }] });
  const { tasks } = await controller.tasks();
  assert.equal(tasks.length, 2);
  const manual = tasks.find(t => t.manual);
  assert.ok(manual, 'manual work item appears in the task list');
  assert.equal(manual.startable, true);
  assert.equal(manual.workItemId, work.workItemId);
  assert.equal(manual.risk, undefined);
  assert.equal(manual.intake, undefined);
  assert.equal(manual.sourcePath, undefined);
  const legacy = tasks.find(t => !t.manual);
  assert.equal(legacy.risk, 'HIGH');
  assert.equal(legacy.intake.state, 'APPROVED');
  assert.equal(legacy.startable, true);
  // The manual row is already a work item: opening it must not offer a re-Start action.
  assert.ok(manual.workItemId && manual.startable);
});
