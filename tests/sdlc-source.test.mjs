import test from 'node:test';
import assert from 'node:assert/strict';
import { FindingSource } from '../plugins/argon-workflow/source.mjs';
const work = { workItemId: 'work-' + 'a'.repeat(32), source: { id: 'FND-00009' }, sourceRecord: { ownerId: 'source-owner', repositoryUrl: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api.git', baseCommit: 'b'.repeat(40), sourcePath: 'src/Fix.java' } };
const delivery = { candidateCommit: 'c'.repeat(40), pullUrl: 'http://127.0.0.1:3000/demo/demo-nova-catalog-api/pulls/3' };
function fixture() {
  const state = { ...work.sourceRecord, id: work.source.id, workItemId: work.workItemId, remediationJobId: work.workItemId, revision: 3, status: 'In Progress', closed: 'Open', verificationResult: 'NOT_RUN' };
  let writes = 0, loseAck = false;
  class Source extends FindingSource {
    async request(path, method = 'GET', body) {
      if (method === 'GET') return structuredClone(state);
      assert.equal(method, 'POST'); assert.equal(path, '/api/findings/FND-00009/ai-completion'); assert.equal(body.expectedRevision, state.revision);
      writes++; Object.assign(state, body, { status: 'Resolved', closed: 'Closed', verificationResult: 'PASSED', revision: state.revision + 1 });
      if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); } return structuredClone(state);
    }
  }
  return { source: new Source(), state, writes: () => writes, loseAck: () => { loseAck = true; } };
}
test('source completion uses one atomic versioned request and reconciles a lost acknowledgement by exact read', async () => {
  const f = fixture(); f.loseAck(); await assert.rejects(() => f.source.complete(work, delivery), /lost acknowledgement/);
  const result = await f.source.complete(work, delivery); assert.equal(result.status, 'Resolved'); assert.equal(f.writes(), 1);
});
test('changed source ownership or a different resolved target never authorizes a completion write', async () => {
  for (const mutate of [s => { s.ownerId = 'other'; }, s => { s.status = 'Risk Accepted'; }, s => { s.status = 'Resolved'; s.codeFixCommit = 'f'.repeat(40); }]) {
    const f = fixture(); mutate(f.state); await assert.rejects(() => f.source.complete(work, delivery), /409/); assert.equal(f.writes(), 0);
  }
});
