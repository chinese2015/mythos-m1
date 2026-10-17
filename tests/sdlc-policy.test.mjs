import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliveryIdentity, verifiedCandidate, closureGate, pullBody } from '../plugins/argon-sdlc/policy.mjs';
const generic = JSON.parse(readFileSync(new URL('./fixtures/generic-task-spec.json', import.meta.url), 'utf8'));
const work = { workItemId: 'work-' + '1'.repeat(32), sandboxId: 'sb-source', source: { id: 'FND-00009' }, sourceRecord: { repositoryUrl: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git', sourcePath: 'src/Fix.java' },
  workflow: { phase: 'AWAITING_REVIEW', approval: { actor: 'alice' }, candidateCommit: 'b'.repeat(40), verificationOperationId: 'exec-' + '2'.repeat(32) } };
const op = { operationId: work.workflow.verificationOperationId, kind: 'VERIFY', state: 'SUCCEEDED', sourceCommit: work.workflow.candidateCommit,
  runtime: { sandboxId: 'sb-fresh', freshTargetAbsent: true }, evidence: { sourceCommit: work.workflow.candidateCommit, sourceDirty: false, junit: { tests: 2, failures: 0, errors: 0, skipped: 0, invalidReports: [] } } };
const git = { headCommit: work.workflow.candidateCommit, status: '', changedFiles: ['src/Fix.java'], testsChanged: [] };
test('publication binds deterministic unique branch and exact independent clean evidence', () => {
  const d = deliveryIdentity(work);
  assert.equal(d.id.length, 64); assert.equal(d.headBranch, 'argon/fnd-00009-11111111-bbbbbbbbbbbb');
  assert.equal(verifiedCandidate(work, op, git), true);
  assert.equal(verifiedCandidate(work, { ...op, runtime: { sandboxId: 'sb-source', freshTargetAbsent: true } }, git), false);
  assert.equal(verifiedCandidate(work, op, { ...git, status: ' M src/Fix.java' }), false);
  assert.equal(verifiedCandidate(work, { ...op, evidence: { ...op.evidence, sourceCommit: 'c'.repeat(40) } }, git), false);
});
test('closed, changed head, bot merge or changed merge tree cannot close a source Finding', () => {
  const d = { ...deliveryIdentity(work), candidateTree: 'e'.repeat(40), policy: { minApprovals: 0, requiredStatusContexts: [], requireHumanMerge: true } };
  const facts = { pull: { number: 1, state: 'closed', merged: true, merged_by: { login: 'human' }, merge_commit_sha: 'c'.repeat(40), head: { ref: d.headBranch, sha: d.candidateCommit, repo: { full_name: d.repository } }, base: { ref: 'main', repo: { full_name: d.repository } } }, reviews: [], statuses: [], candidateTree: d.candidateTree, mergedTree: d.candidateTree };
  assert.equal(closureGate(d, facts, 'argon-agent').allowed, true);
  for (const changed of [ { ...facts, pull: { ...facts.pull, merged: false } }, { ...facts, pull: { ...facts.pull, merged_by: { login: 'argon-agent' } } },
    { ...facts, mergedTree: 'f'.repeat(40) }, { ...facts, pull: { ...facts.pull, head: { ...facts.pull.head, sha: 'a'.repeat(40) } } } ])
    assert.equal(closureGate(d, changed, 'argon-agent').allowed, false);
});
test('configured CI/review gates require exact successful checks and fresh non-author approval', () => {
  const d = { ...deliveryIdentity(work), candidateTree: 'e'.repeat(40), policy: { minApprovals: 1, requiredStatusContexts: ['ci/test'], requireHumanMerge: true } };
  const facts = { pull: { merged: true, merged_by: { login: 'human' }, merge_commit_sha: 'c'.repeat(40), head: { ref: d.headBranch, sha: d.candidateCommit, repo: { full_name: d.repository } }, base: { ref: 'main', repo: { full_name: d.repository } }, user: { login: 'argon-agent' } }, candidateTree: d.candidateTree, mergedTree: d.candidateTree,
    reviews: [{ id: 1, state: 'APPROVED', user: { login: 'reviewer' }, commit_id: d.candidateCommit, stale: false, dismissed: false }], statuses: [{ id: 1, context: 'ci/test', status: 'success' }] };
  assert.equal(closureGate(d, facts, 'argon-agent').allowed, true);
  assert.equal(closureGate(d, { ...facts, statuses: [] }, 'argon-agent').allowed, false);
  assert.equal(closureGate(d, { ...facts, reviews: [{ ...facts.reviews[0], stale: true }] }, 'argon-agent').allowed, false);
});

const spec = { ...generic.taskSpec, changePolicy: { ...generic.taskSpec.changePolicy, allowTestChanges: true } };
const manualWork = { workItemId: 'work-' + '1'.repeat(32), ownerId: 'alice', sandboxId: 'sb-manual', source: { type: 'MANUAL', id: 'TASK-' + '0'.repeat(12), revision: 1 },
  sourceRecord: { id: 'TASK-' + '0'.repeat(12), title: spec.task.title, repositoryUrl: spec.repository.cloneUrl, baseCommit: spec.baseCommit, sourcePath: '', sourcePaths: spec.changePolicy.allowedPaths },
  taskSpec: spec,
  workflow: { approval: { actor: 'alice', specDigest: spec.specDigest }, candidateCommit: 'b'.repeat(40), verificationOperationId: 'exec-' + '2'.repeat(32) } };
const manualOp = { operationId: manualWork.workflow.verificationOperationId, kind: 'VERIFY', state: 'SUCCEEDED', exitCode: 0,
  command: spec.execution.verificationCommand, timeoutSeconds: 300, sourceCommit: 'b'.repeat(40), sandboxId: 'sb-manual',
  runtime: { sandboxId: 'sb-fresh', freshTargetAbsent: true },
  evidence: { exitCode: 0, sourceCommit: 'b'.repeat(40), sourceDirty: false, sandboxId: 'sb-fresh',
    junit: { reports: [{ path: 'target/surefire-reports/TEST-customer.xml' }], invalidReports: [], tests: 3, failures: 0, errors: 0, skipped: 0 } } };
const manualGit = { headCommit: 'b'.repeat(40), status: '', changedFiles: ['src/main/A.java', 'src/test/ATest.java'], testsChanged: ['src/test/ATest.java'] };
test('manual delivery identity comes from the frozen repository snapshot and binds the digest', () => {
  const d = deliveryIdentity(manualWork);
  assert.equal(d.repository, 'demo/customer-api');
  assert.equal(d.repositoryUrl, 'http://127.0.0.1:3000/demo/customer-api.git');
  assert.equal(d.baseBranch, 'main');
  assert.equal(d.headBranch, 'argon/task-' + '0'.repeat(12) + '-11111111-' + 'b'.repeat(12));
  assert.equal(verifiedCandidate(manualWork, manualOp, manualGit), true);
  assert.equal(verifiedCandidate(manualWork, { ...manualOp, command: 'true' }, manualGit), false);
  assert.equal(verifiedCandidate(manualWork, { ...manualOp, runtime: { sandboxId: 'sb-manual', freshTargetAbsent: true } }, manualGit), false);
  assert.equal(verifiedCandidate(manualWork, manualOp, { ...manualGit, changedFiles: ['src/main/A.java', 'pom.xml'], testsChanged: [] }), false);
  assert.throws(() => deliveryIdentity({ ...manualWork, workflow: { ...manualWork.workflow, approval: { actor: 'alice', specDigest: '0'.repeat(64) } } }), /digest|摘要/);
  assert.throws(() => deliveryIdentity({ ...manualWork, taskSpec: { ...spec, repository: { ...spec.repository, origin: 'http://evil.invalid' } } }), /仓库|origin/);
});
test('PR body is generated from actual frozen commands, report format and real counts', () => {
  const d = deliveryIdentity(manualWork);
  const body = pullBody(manualWork, d, manualOp);
  assert.match(body, /mvn test/);
  assert.match(body, /JUnit 3 tests \/ 0 failures \/ 0 errors/);
  assert.doesNotMatch(body, /2 tests/);
  assert.doesNotMatch(body, /clean verify/);
  const commandOp = { ...manualOp, evidence: { exitCode: 0, sourceCommit: 'b'.repeat(40), sourceDirty: false, sandboxId: 'sb-fresh', junit: null } };
  const commandSpec = { ...spec, execution: { ...spec.execution, evidence: { format: 'command', reportDirs: [], minTests: 0, allowSkipped: false } } };
  const commandBody = pullBody({ ...manualWork, taskSpec: commandSpec }, d, commandOp);
  assert.match(commandBody, /command/);
  assert.match(commandBody, /退出码 0/);
  assert.doesNotMatch(commandBody, /JUnit \d+ tests/);
  const legacyBody = pullBody(work, deliveryIdentity(work), op);
  assert.match(legacyBody, /JUnit 2 tests \/ 0 failures \/ 0 errors/);
  assert.match(legacyBody, /仅修改 src\/Fix\.java/);
});
