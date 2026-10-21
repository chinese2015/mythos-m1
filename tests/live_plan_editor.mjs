// Local browser acceptance; requires Playwright on NODE_PATH. No live tasks or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { consoleHandler } from '../plugins/mythos-console/index.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const workId = 'work-' + 'a'.repeat(32);
const work = { workItemId: workId, version: 1, source: { id: 'FND-00003' }, sourceRecord: { title: 'Configuration repair' },
  workflow: { phase: 'AWAITING_PLAN_APPROVAL', plan: '## 缺陷分析\n\n- **Fix configuration**\n\n```java\nString value = "' + 'x'.repeat(240) + '";\n```', planHash: 'hash-1', planRevision: 1 } };
const calls = [];
let failNextSave = true;
const workflow = {
  detail: async () => ({ workItem: structuredClone(work), workflow: structuredClone(work.workflow), operations: [], evidence: [],
    session: { sessionId: 'session-plan', role: 'PLAN', transcript: [], running: false } }),
  events: async () => ({ events: [], nextCursor: 0 }),
  modifyPlan: async (id, body) => { assert.equal(id, workId); assert.equal(body.planHash, work.workflow.planHash); assert.equal(body.expectedVersion, work.version);
    if (failNextSave) { failNextSave = false; throw Object.assign(new Error('Save conflict, retry with your draft'), { status: 409 }); }
    calls.push(['save', body]); work.version++; Object.assign(work.workflow, { plan: body.plan, planHash: 'hash-' + work.version, planRevision: work.workflow.planRevision + 1 }); return structuredClone(work); },
  message: async (id, body) => { calls.push(['message', body]); work.version++; work.workflow.phase = 'PLANNING'; work.workflow.planHash = null; return { accepted: true }; },
  approve: async (id, body) => { assert.equal(body.planHash, work.workflow.planHash); calls.push(['approve', body]); work.version++; work.workflow.phase = 'CODING'; work.workflow.approval = { actor: 'alice' }; return structuredClone(work); },
};
const server = createServer(consoleHandler({ connection: { requestRejection: () => undefined }, workflow }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/mythos/#/work/' + workId);
  const plan = page.locator('[data-plan-work-id]');
  await plan.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Long code must scroll inside its block, not widen the mobile page');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await plan.getByRole('button', { name: 'Modify', exact: true }).click();
  const editor = plan.getByRole('textbox', { name: 'Implementation plan Markdown' });
  const draft = '## 手动修改\n\n1. **Use environment**\n\n```java\nString password;\n```';
  await editor.fill(draft);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await assert.doesNotReject(() => editor.waitFor());
  assert.equal(await editor.inputValue(), draft);
  await editor.focus();
  await page.waitForTimeout(2100); // Cover the real automatic refresh with an active draft.
  assert.equal(await editor.inputValue(), draft);
  assert.equal(await editor.evaluate(node => node === document.activeElement), true);
  assert.equal(await plan.locator('.plan-preview h2').textContent(), '手动修改');
  if (process.env.PLAN_SCREENSHOT_DIR) {
    await mkdir(process.env.PLAN_SCREENSHOT_DIR, { recursive: true });
    await plan.screenshot({ path: process.env.PLAN_SCREENSHOT_DIR + '/plan-edit-preview.png' });
  }
  await plan.getByRole('button', { name: 'Save changes', exact: true }).click();
  await plan.getByText('Save conflict, retry with your draft', { exact: false }).waitFor();
  assert.equal(await editor.inputValue(), draft);
  await plan.getByRole('button', { name: 'Save changes', exact: true }).click();
  await plan.getByRole('button', { name: 'Modify', exact: true }).waitFor();
  assert.equal(calls.filter(([kind]) => kind === 'save').length, 1);
  assert.equal(calls[0][1].plan, draft);
  assert.equal(await plan.locator('.plan-markdown h2').textContent(), '手动修改');
  await plan.getByRole('button', { name: 'Ask model', exact: true }).click();
  await plan.getByRole('textbox', { name: 'Requested plan changes' }).fill('请补充验证步骤');
  await plan.getByRole('button', { name: 'Generate revised plan', exact: true }).click();
  await plan.getByText('The model is updating the plan', { exact: false }).waitFor();
  assert.equal(calls.filter(([kind]) => kind === 'message').length, 1);
  assert.equal(calls.find(([kind]) => kind === 'message')[1].text, '请补充验证步骤');
  Object.assign(work.workflow, { phase: 'AWAITING_PLAN_APPROVAL', plan: '## Model revision\n\n- Run validation', planHash: 'model-hash', planRevision: 3 }); work.version++;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await plan.locator('.plan-markdown h2').getByText('Model revision', { exact: true }).waitFor();
  await plan.getByRole('button', { name: 'Modify', exact: true }).click();
  await editor.fill('Unsaved changes');
  work.version++;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await plan.getByText('The plan changed while you were editing.', { exact: false }).waitFor();
  assert.equal(await editor.inputValue(), 'Unsaved changes');
  assert.equal(await plan.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
  await plan.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await plan.locator('.plan-markdown h2').textContent(), 'Model revision');
  page.once('dialog', dialog => dialog.accept());
  await plan.getByRole('button', { name: 'Approve plan & start execution', exact: true }).click();
  await plan.getByText('Approved by alice', { exact: false }).waitFor();
  assert.equal(calls.find(([kind]) => kind === 'approve')[1].planHash, 'model-hash');
  assert.equal(await plan.getByRole('button', { name: 'Modify', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: Markdown, draft/focus across refresh, failed-save draft retention, save, model revision, concurrent update, cancel, latest approval');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
