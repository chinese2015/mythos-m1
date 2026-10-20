import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { M2Client } from '../plugins/argon-brain/client.mjs';
import { TaskWorkflow } from '../plugins/argon-workflow/controller.mjs';
import { findingBinding } from '../plugins/argon-subscribe/triage.mjs';
const finding = () => ({ id: 'FND-00015', name: 'Path traversal', risk: 'HIGH', ownerId: 'owner-pixel-01', revision: 1, status: 'Not Started', closed: 'Open', workItemId: null, description: 'zip slip on import', repositoryUrl: 'http://127.0.0.1:3000/demo/demo-pixel-reports-batch.git', baseCommit: '0a67ffc801aad448a0992ba84aabc5d47d63c478', sourcePath: 'src/main/java/com/example/reports/ReportImporter.java' });
async function fixture(t, row = finding()) {
  const child = spawn('python3', ['tests/fixtures/brain_plugin_api.py'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PYTHONPATH: '.' }, stdio: ['pipe','pipe','inherit'] });
  const lines = createInterface({ input: child.stdout }); const [line] = await once(lines, 'line');
  const client = new M2Client({ ...JSON.parse(line), owner: 'alice' });
  t.after(async () => { await client.dispose(); child.stdin.end(); await once(child, 'exit'); lines.close(); });
  const source = { request: async path => { if (path === '/api/findings/' + row.id) return structuredClone(row); throw new Error('unexpected source route ' + path); } };
  const controller = new TaskWorkflow({ owner: 'alice' }, { client, sessions: {}, workspaces: {}, presets: {}, source });
  return { client, row, controller };
}
test('a pushed finding starts the workflow without polling or manual approval', async t => {
  const h = await fixture(t);
  const result = await h.controller.ingest({ findingId: h.row.id, expectedRevision: 1, finding: h.row }, 'push-1');
  assert.equal(result.status, 'STARTED'); assert.match(result.workItemId, /^work-[a-f0-9]{32}$/);
  const { workItems } = await h.client.request('GET', '/api/brain/work-items');
  assert.equal(workItems.length, 1); assert.equal(workItems[0].source.id, h.row.id);
  assert.equal(workItems[0].sourceRecord.description, 'zip slip on import');
  const intake = (await h.client.request('GET', '/api/brain/source-intakes')).intakes[0];
  assert.equal(intake.state, 'APPROVED'); assert.equal(intake.decision.binding, findingBinding(h.row));
});
test('a repeated push returns the running work item without a second claim', async t => {
  const h = await fixture(t);
  const first = await h.controller.ingest({ findingId: h.row.id, finding: h.row }, 'push-1');
  const again = await h.controller.ingest({ findingId: h.row.id, finding: h.row }, 'push-2');
  assert.equal(again.status, 'ALREADY_RUNNING'); assert.equal(again.workItemId, first.workItemId);
  assert.equal((await h.client.request('GET', '/api/brain/work-items')).workItems.length, 1);
});
test('a stale expectedRevision is rejected and nothing is registered', async t => {
  const h = await fixture(t);
  await assert.rejects(() => h.controller.ingest({ findingId: h.row.id, expectedRevision: 99, finding: h.row }, 'push-1'), e => e.status === 409);
  assert.deepEqual((await h.client.request('GET', '/api/brain/source-intakes')).intakes, []);
  assert.deepEqual((await h.client.request('GET', '/api/brain/work-items')).workItems, []);
});
test('a drifted baseline is recorded for review and the workflow does not start', async t => {
  const h = await fixture(t); h.row.baseCommit = 'a'.repeat(40);
  await assert.rejects(() => h.controller.ingest({ findingId: h.row.id, finding: h.row }, 'push-1'), /Triage did not pass/);
  const intake = (await h.client.request('GET', '/api/brain/source-intakes')).intakes[0];
  assert.equal(intake.state, 'NEEDS_REVIEW'); assert.ok(intake.triage.reasons.length);
  assert.deepEqual((await h.client.request('GET', '/api/brain/work-items')).workItems, []);
});
test('unmapped findings are not accepted', async t => {
  const h = await fixture(t);
  await assert.rejects(() => h.controller.ingest({ findingId: 'FND-99999' }, 'push-1'), e => e.status === 404);
});
test('the intake falls back to the mock source when the push carries no finding payload', async t => {
  const h = await fixture(t);
  const result = await h.controller.ingest({ findingId: h.row.id, expectedRevision: 1 }, 'push-1');
  assert.equal(result.status, 'STARTED');
});
