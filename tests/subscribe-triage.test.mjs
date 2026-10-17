import test from 'node:test';
import assert from 'node:assert/strict';
import { triageFinding } from '../plugins/argon-subscribe/triage.mjs';
const mapping = ['demo-pixel-reports-batch', '0a67ffc801aad448a0992ba84aabc5d47d63c478', 'src/main/java/com/example/reports/ReportImporter.java'];
const row = { id: 'FND-00015', repositoryUrl: 'http://127.0.0.1:3000/demo/demo-pixel-reports-batch.git', baseCommit: mapping[1], sourcePath: mapping[2], risk: 'HIGH', status: 'Not Started', closed: 'Open', ownerId: 'owner-pixel-01', revision: 1 };
test('triage confirms exact eligible assets and explains drift or ineligible findings', () => {
  assert.equal(triageFinding(row, mapping).result, 'CONFIRMED');
  for (const change of [{ repositoryUrl: 'file:///etc' }, { baseCommit: 'x' }, { sourcePath: 'elsewhere' }, { risk: 'LOW' }, { closed: 'Closed' }, { status: 'In Progress' }, { workItemId: 'foreign' }, { ownerId: '' }, { revision: null }]) {
    const triage = triageFinding({ ...row, ...change }, mapping);
    assert.equal(triage.result, 'NEEDS_REVIEW', JSON.stringify(change)); assert.ok(triage.reasons.length);
  }
  assert.equal(triageFinding(row, undefined).result, 'NEEDS_REVIEW');
});
