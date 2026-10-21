import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { M2Client } from '../plugins/mythos-brain/client.mjs';
import { SubscribeController } from '../plugins/mythos-subscribe/service.mjs';
const finding = () => ({ id: 'FND-00015', name: 'Path traversal', risk: 'HIGH', ownerId: 'owner-pixel-01', revision: 1, status: 'Not Started', closed: 'Open', triageResult: 'UNTRIAGED', repositoryUrl: 'http://127.0.0.1:3000/demo/demo-pixel-reports-batch.git', baseCommit: '0a67ffc801aad448a0992ba84aabc5d47d63c478', sourcePath: 'src/main/java/com/example/reports/ReportImporter.java' });
async function fixture(t) {
  const child = spawn('python3', ['tests/fixtures/brain_plugin_api.py'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PYTHONPATH: '.' }, stdio: ['pipe','pipe','inherit'] });
  const lines = createInterface({ input: child.stdout }); const [line] = await once(lines, 'line');
  const client = new M2Client({ ...JSON.parse(line), owner: 'alice' });
  t.after(async () => { await client.dispose(); child.stdin.end(); await once(child, 'exit'); lines.close(); });
  const row = finding(), writes = []; let fail = '', notices = 0;
  const mock = { async request(path, method = 'GET', body) {
    if (method === 'GET') return path === '/api/findings' ? [structuredClone(row)] : structuredClone(row);
    const { intakes } = await client.request('GET', '/api/brain/source-intakes');
    assert.ok(intakes.some(i => i.findingId === row.id), 'no external mutation before durable intake');
    writes.push({ path, method, body });
    if (fail === method) { fail = ''; throw new Error('source write failed'); }
    if (method === 'PATCH') { assert.deepEqual(body, { triageResult: 'CONFIRMED' }); Object.assign(row, body); row.revision++; return structuredClone(row); }
    assert.ok(path.endsWith('/notify-owner')); assert.equal(row.triageResult, 'CONFIRMED'); notices++; return { delivered: true, preview: true };
  } };
  const controller = new SubscribeController({ owner: 'alice' }, { client, mock });
  return { client, row, writes, controller, fail: method => { fail = method; }, notices: () => notices };
}
test('subscription persists before external writes, recovers notification errors, and restart does not notify twice', async t => {
  const h = await fixture(t); h.fail('POST');
  await h.controller.syncOnce();
  let intake = (await h.client.request('GET','/api/brain/source-intakes')).intakes[0];
  assert.equal(intake.state, 'AWAITING_OWNER'); assert.ok(intake.lastError); assert.equal(intake.notifiedAt, null); assert.equal(h.row.status, 'Not Started');
  await h.controller.syncOnce();
  intake = (await h.client.request('GET','/api/brain/source-intakes')).intakes[0];
  assert.ok(intake.notifiedAt); assert.equal(intake.lastError, null); assert.equal(h.notices(), 1);
  const restarted = new SubscribeController({ owner: 'alice' }, { client: h.client, mock: h.controller.mock });
  await restarted.syncOnce(); assert.equal(h.notices(), 1); assert.equal(h.writes.filter(x => x.method === 'PATCH').length, 1);
});
test('decisions require the displayed revision, are idempotent and never start repairs', async t => {
  const h = await fixture(t); await h.controller.syncOnce();
  const intake = (await h.client.request('GET','/api/brain/source-intakes')).intakes[0];
  await assert.rejects(() => h.controller.decide(h.row.id, { decision: 'APPROVE', expectedRevision: 99 }, 'stale'), e => e.status === 409);
  const body = { decision: 'APPROVE', expectedRevision: intake.revision };
  const first = await h.controller.decide(h.row.id, body, 'approve');
  assert.equal(first.state, 'APPROVED'); assert.deepEqual(await h.controller.decide(h.row.id, body, 'approve'), first);
  await h.controller.syncOnce(); assert.equal(h.notices(), 1); assert.equal(h.row.status, 'Not Started');
  assert.deepEqual((await h.client.request('GET','/api/brain/work-items')).workItems, []);
});
test('mapped drift is persisted for review without notifying or starting work', async t => {
  const h = await fixture(t); h.row.baseCommit = 'a'.repeat(40); h.row.triageResult = 'NEEDS_REVIEW';
  await h.controller.syncOnce();
  const intake = (await h.client.request('GET','/api/brain/source-intakes')).intakes[0];
  assert.equal(intake.state, 'NEEDS_REVIEW'); assert.ok(intake.triage.reasons.length); assert.equal(h.notices(), 0); assert.equal(h.writes.length, 0);
});
test('existing work is grandfathered without new claims, patches or notifications', async t => {
  const h = await fixture(t);
  const { id, risk, ownerId, revision, repositoryUrl, baseCommit, sourcePath } = h.row;
  await h.client.request('POST','/api/brain/tasks/claim', { key: 'old-work', body: { sourceRecord: { id, risk, ownerId, revision, repositoryUrl, baseCommit, sourcePath, title: h.row.name }, expectedRevision: 1 } });
  h.row.status = 'In Progress';
  await h.controller.syncOnce();
  assert.equal((await h.client.request('GET','/api/brain/source-intakes')).intakes[0].state, 'APPROVED');
  assert.equal(h.writes.length, 0);
});
test('pending owner change generates a new bound notification instead of reusing the old receipt', async t => {
  const h = await fixture(t); await h.controller.syncOnce();
  const first = (await h.client.request('GET','/api/brain/source-intakes')).intakes[0];
  h.row.ownerId = 'owner-pixel-02'; h.row.revision++;
  await h.controller.syncOnce();
  const updated = (await h.client.request('GET','/api/brain/source-intakes')).intakes[0];
  assert.equal(h.notices(), 2); assert.ok(updated.notifiedAt);
  assert.notEqual(updated.triage.binding, first.triage.binding);
});
