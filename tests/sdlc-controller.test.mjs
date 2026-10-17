import test from 'node:test';
import assert from 'node:assert/strict';
import { SdlcController } from '../plugins/argon-sdlc/controller.mjs';
import { TaskWorkflow } from '../plugins/argon-workflow/controller.mjs';
const id = 'work-' + 'a'.repeat(32), candidate = 'b'.repeat(40), operationId = 'exec-' + 'c'.repeat(32), tree = 'e'.repeat(40);
function fixture() {
  const work = { workItemId: id, ownerId: 'alice', sandboxId: 'sb-source', version: 1, paused: false, source: { type: 'ARGON', id: 'FND-00009' },
    sourceRecord: { id: 'FND-00009', title: 'Fix SQL injection', ownerId: 'source-owner', repositoryUrl: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git', sourcePath: 'src/Fix.java', baseCommit: 'd'.repeat(40) },
    workflow: { phase: 'AWAITING_REVIEW', approval: { actor: 'alice' }, candidateCommit: candidate, verificationOperationId: operationId, codeSessionId: 'session-code', codeRequestId: 'request-code', codeEndSequence: 4 } };
  const op = { operationId, kind: 'VERIFY', state: 'SUCCEEDED', sourceCommit: candidate, runtime: { sandboxId: 'sb-fresh', freshTargetAbsent: true },
    evidence: { sourceCommit: candidate, sourceDirty: false, junit: { tests: 2, failures: 0, errors: 0, skipped: 0, invalidReports: [] } } };
  const git = { headCommit: candidate, status: '', changedFiles: ['src/Fix.java'], testsChanged: [] };
  const events = [{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'user/message', data: { source: { rpcId: 'request-code' } } }, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const state = { pushes: 0, creates: 0, sourceWrites: 0, loseSourceAck: false, sourceComplete: false, merged: false, closed: false, prReads: 0 };
  const client = { dispose: async () => {}, async request(method, path, opts = {}) {
    if (method === 'GET' && path.includes('/operations/')) return structuredClone(op);
    if (method === 'GET' && path.endsWith('/work-items')) return {workItems:[structuredClone(work)]};
    if (method === 'GET') return { workItem: structuredClone(work), operations: [structuredClone(op)], sessions: [] };
    if (path.endsWith('/workflow')) { assert.equal(opts.body.expectedVersion, work.version); work.workflow = structuredClone(opts.body.workflow); work.version++; work.blocked = opts.body.blocked; return structuredClone(work); }
    if (path.endsWith('/publish-branch')) { state.pushes++; return { deliveryId: work.workflow.delivery.id, repositoryUrl: work.sourceRecord.repositoryUrl, candidateCommit: candidate, candidateTree: tree, branch: work.workflow.delivery.headBranch, remoteCommit: candidate, reconciled: false }; }
    throw new Error('Unexpected route ' + path);
  } };
  const workflow = new TaskWorkflow({ owner: 'alice' }, { client, source: {}, sessions: { inspect: async () => ({ events }), list: async () => ({ items: [{ sessionId: 'session-code', running: false }] }) }, presets: {}, workspaces: {} });
  workflow.workspace = async () => ({ git: structuredClone(git) });
  const forge = { botLogin: 'argon-agent', baseUrl: 'http://127.0.0.1:3000', dispose: async () => {},
    async ensurePull(_repo, d) { state.creates++; return { number: 3, html_url: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api/pulls/3', state: 'open' }; },
    async facts(_repo, d) { state.prReads++; return { pull: { number: 3, html_url: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api/pulls/3', state: state.merged || state.closed ? 'closed' : 'open', merged: state.merged, merge_commit_sha: state.merged ? 'f'.repeat(40) : null,
      merged_by: state.merged ? { login: 'human' } : null, user: { login: 'argon-agent' }, head: { sha: candidate, ref: d.headBranch, repo: { full_name: d.repository } }, base: { ref: 'main', repo: { full_name: d.repository } } }, candidateTree: tree, mergedTree: state.merged ? tree : null, reviews: [], statuses: [] }; } };
  const source = { async complete() { if (!state.sourceComplete) { state.sourceComplete = true; state.sourceWrites++; } if (state.loseSourceAck) { state.loseSourceAck = false; throw new Error('lost source acknowledgement'); } return { id: 'FND-00009', status: 'Resolved', verificationResult: 'PASSED', codeFixCommit: candidate, workItemId: id }; } };
  const make = () => new SdlcController({ minApprovals: 0, requiredStatusContexts: [] }, { workflow, forge, source });
  return { work, op, git, events, state, make, controller: make() };
}
test('publication commits an intent before Git/PR writes and duplicate requests reuse it', async () => {
  const f = fixture(); await f.controller.publish(id, { expectedVersion: 1 }, 'publish-1');
  assert.equal(f.work.workflow.phase, 'PUBLISHING'); assert.equal(f.state.pushes, 0); assert.equal(f.state.creates, 0);
  await f.controller.publish(id, { expectedVersion: 1 }, 'publish-1'); assert.equal(f.work.version, 2);
  await f.controller.step(structuredClone(f.work)); assert.equal(f.state.pushes, 1);
  await f.controller.step(structuredClone(f.work)); assert.equal(f.state.creates, 1); assert.equal(f.work.workflow.phase, 'PR_OPEN');
  await f.make().step(structuredClone(f.work)); assert.equal(f.state.creates, 1); assert.equal(f.state.sourceWrites, 0);
});
test('paused, dirty, failed verify or newer CODE input cannot be published', async () => {
  for (const mutate of [f => { f.work.paused = true; }, f => { f.git.status = ' M src/Fix.java'; }, f => { f.op.state = 'FAILED'; }, f => { f.events.push({ seq: 6, type: 'user/message', data: { source: { rpcId: 'new-input' } } }); }]) {
    const f = fixture(); mutate(f); await assert.rejects(() => f.controller.publish(id, { expectedVersion: 1 }, 'bad'), /409/); assert.equal(f.state.pushes, 0);
  }
});
test('merged source completion survives lost acknowledgement and restart without an extra source write', async () => {
  const f = fixture(); await f.controller.publish(id, { expectedVersion: 1 }, 'publish');
  await f.controller.step(structuredClone(f.work)); await f.controller.step(structuredClone(f.work));
  f.state.merged = true; await f.controller.step(structuredClone(f.work)); assert.equal(f.work.workflow.phase, 'CLOSING');
  f.state.loseSourceAck = true; await f.controller.step(structuredClone(f.work)); assert.notEqual(f.work.workflow.phase, 'COMPLETED');
  f.work.workflow.delivery.nextAttemptAt = null; await f.make().step(structuredClone(f.work));
  assert.equal(f.work.workflow.phase, 'COMPLETED'); assert.equal(f.state.sourceWrites, 1); assert.equal(f.state.creates, 1);
});
test('external reopen is reconciled by refresh and can then complete after a real merge fact', async () => {
  const f=fixture();await f.controller.publish(id,{expectedVersion:1},'publish');await f.controller.step(structuredClone(f.work));await f.controller.step(structuredClone(f.work));
  f.state.closed=true;await f.controller.step(structuredClone(f.work));assert.equal(f.work.workflow.delivery.step,'CLOSED_UNMERGED');
  const before=f.state.prReads;f.state.closed=false;await f.controller.refresh(id,{expectedVersion:f.work.version});
  assert.equal(f.state.prReads,before+1);assert.equal(f.work.workflow.phase,'PR_OPEN');
  f.state.merged=true;await f.controller.step(structuredClone(f.work));await f.controller.step(structuredClone(f.work));assert.equal(f.work.workflow.phase,'COMPLETED');
});
test('closed current deliveries stay observable in the background, superseded candidates cannot resume them', async () => {
  const f=fixture();await f.controller.publish(id,{expectedVersion:1},'publish');await f.controller.step(structuredClone(f.work));await f.controller.step(structuredClone(f.work));
  f.state.closed=true;await f.controller.step(structuredClone(f.work));f.state.closed=false;await f.make().tick();assert.equal(f.work.workflow.phase,'PR_OPEN');
  f.state.closed=true;await f.controller.step(structuredClone(f.work));f.work.workflow.candidateCommit='f'.repeat(40);
  await assert.rejects(()=>f.controller.refresh(id,{expectedVersion:f.work.version}),/409/);assert.equal(f.state.sourceWrites,0);
});
