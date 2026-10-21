import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryIdentity, verifiedCandidate, closureGate } from '../plugins/mythos-sdlc/policy.mjs';
const work = { workItemId: 'work-' + '1'.repeat(32), sandboxId: 'sb-source', source: { id: 'FND-00009' }, sourceRecord: { repositoryUrl: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git', sourcePath: 'src/Fix.java' },
  workflow: { phase: 'AWAITING_REVIEW', approval: { actor: 'alice' }, candidateCommit: 'b'.repeat(40), verificationOperationId: 'exec-' + '2'.repeat(32) } };
const op = { operationId: work.workflow.verificationOperationId, kind: 'VERIFY', state: 'SUCCEEDED', sourceCommit: work.workflow.candidateCommit,
  runtime: { sandboxId: 'sb-fresh', freshTargetAbsent: true }, evidence: { sourceCommit: work.workflow.candidateCommit, sourceDirty: false, junit: { tests: 2, failures: 0, errors: 0, skipped: 0, invalidReports: [] } } };
const git = { headCommit: work.workflow.candidateCommit, status: '', changedFiles: ['src/Fix.java'], testsChanged: [] };
test('publication binds deterministic unique branch and exact independent clean evidence', () => {
  const d = deliveryIdentity(work);
  assert.equal(d.id.length, 64); assert.equal(d.headBranch, 'mythos/fnd-00009-11111111-bbbbbbbbbbbb');
  assert.equal(verifiedCandidate(work, op, git), true);
  assert.equal(verifiedCandidate(work, { ...op, runtime: { sandboxId: 'sb-source', freshTargetAbsent: true } }, git), false);
  assert.equal(verifiedCandidate(work, op, { ...git, status: ' M src/Fix.java' }), false);
  assert.equal(verifiedCandidate(work, { ...op, evidence: { ...op.evidence, sourceCommit: 'c'.repeat(40) } }, git), false);
});
test('closed, changed head, bot merge or changed merge tree cannot close a source Finding', () => {
  const d = { ...deliveryIdentity(work), candidateTree: 'e'.repeat(40), policy: { minApprovals: 0, requiredStatusContexts: [], requireHumanMerge: true } };
  const facts = { pull: { number: 1, state: 'closed', merged: true, merged_by: { login: 'human' }, merge_commit_sha: 'c'.repeat(40), head: { ref: d.headBranch, sha: d.candidateCommit, repo: { full_name: d.repository } }, base: { ref: 'main', repo: { full_name: d.repository } } }, reviews: [], statuses: [], candidateTree: d.candidateTree, mergedTree: d.candidateTree };
  assert.equal(closureGate(d, facts, 'mythos-agent').allowed, true);
  for (const changed of [ { ...facts, pull: { ...facts.pull, merged: false } }, { ...facts, pull: { ...facts.pull, merged_by: { login: 'mythos-agent' } } },
    { ...facts, mergedTree: 'f'.repeat(40) }, { ...facts, pull: { ...facts.pull, head: { ...facts.pull.head, sha: 'a'.repeat(40) } } } ])
    assert.equal(closureGate(d, changed, 'mythos-agent').allowed, false);
});
test('configured CI/review gates require exact successful checks and fresh non-author approval', () => {
  const d = { ...deliveryIdentity(work), candidateTree: 'e'.repeat(40), policy: { minApprovals: 1, requiredStatusContexts: ['ci/test'], requireHumanMerge: true } };
  const facts = { pull: { merged: true, merged_by: { login: 'human' }, merge_commit_sha: 'c'.repeat(40), head: { ref: d.headBranch, sha: d.candidateCommit, repo: { full_name: d.repository } }, base: { ref: 'main', repo: { full_name: d.repository } }, user: { login: 'mythos-agent' } }, candidateTree: d.candidateTree, mergedTree: d.candidateTree,
    reviews: [{ id: 1, state: 'APPROVED', user: { login: 'reviewer' }, commit_id: d.candidateCommit, stale: false, dismissed: false }], statuses: [{ id: 1, context: 'ci/test', status: 'success' }] };
  assert.equal(closureGate(d, facts, 'mythos-agent').allowed, true);
  assert.equal(closureGate(d, { ...facts, statuses: [] }, 'mythos-agent').allowed, false);
  assert.equal(closureGate(d, { ...facts, reviews: [{ ...facts.reviews[0], stale: true }] }, 'mythos-agent').allowed, false);
});
