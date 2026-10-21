import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { sourceFacts, evidenceLine } from '../plugins/mythos-console/public/intake-view.js';

// Test-local mounted tree; runs the actual app route/detail renderer, while
// unrelated delivery/monitor/intake panels and the HTTP boundary are isolated.
class Element {
  constructor(tag = '', text = null) { this.tagName = tag.toUpperCase(); this.nodeType = text === null ? 1 : 3; this.data = text; this.childNodes = []; this.attrs = new Map(); this.events = new Map(); this.dataset = {}; this.classList = { toggle() {} }; }
  append(...nodes) { for (let node of nodes) { if (!(node instanceof Element)) node = new Element('', String(node)); if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.childNodes.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChild(node, old) { const index = this.childNodes.indexOf(old); if (node.parentNode) node.parentNode.removeChild(node); this.childNodes[index] = node; node.parentNode = this; old.parentNode = null; return old; }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.append(...nodes); }
  set textContent(value) { if (this.nodeType === 3) this.data = String(value); else this.replaceChildren(new Element('', String(value))); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join(''); }
  set innerHTML(_value) { this.replaceChildren(); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'class') this.className = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get firstElementChild() { return this.childNodes.find(node => node.nodeType === 1) || null; }
  get lastChild() { return this.childNodes.at(-1); }
  addEventListener(name, handler) { this.events.set(name, handler); }
  querySelectorAll(selector) { return this.childNodes.flatMap(node => [...(node.tagName === selector.toUpperCase() ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const wid = 'work-' + 'a'.repeat(32), sid = 'session-code-displayed';
async function mountedDetail(type, overrides = {}) {
  const nodes = Object.fromEntries(['view', 'notice', 'breadcrumbs', 'nav-count', 'refresh-button'].map(id => [id, new Element('div')]));
  const document = { getElementById: id => nodes[id], querySelectorAll: () => [], createElement: tag => new Element(tag), activeElement: null };
  const nativeUrl = '/?mythosSession=session-native-existing&mythosEmbedded=1';
  const detail = { workItem: { workItemId: wid, ownerId: 'alice', version: 17, source: { type, id: type === 'MANUAL' ? 'TASK-abcdef123456' : 'FND-00009' }, sourceRecord: { title: 'Task', repositoryUrl: 'http://127.0.0.1:3000/demo/customer-api.git' }, workflow: { phase: 'AWAITING_REVIEW' } },
    source: { id: 'Task', title: 'Task' }, workflow: { phase: 'AWAITING_REVIEW' }, session: { sessionId: sid, role: 'CODE', url: nativeUrl }, operations: [], evidence: [] };
  if (overrides.work) Object.assign(detail.workItem, overrides.work);
  if (overrides.phase) detail.workflow.phase = overrides.phase;
  if (overrides.operations) detail.operations = overrides.operations;
  const calls = []; const confirmations = [];
  const code = (await readFile(new URL('../plugins/mythos-console/public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  runInNewContext(code, { document, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, location: { hash: '#/work/' + wid },
    renderDelivery: () => new Element('aside'), renderMonitor: () => new Element('aside'), renderIntake: () => ({ mount() {}, load() {} }), sourceFacts, evidenceLine,
    fetch: async (path, options) => { calls.push([path, options]); return { ok: true, status: 200, json: async () => detail }; },
    setInterval: () => 1, clearInterval() {}, URL, URLSearchParams, console, crypto: { randomUUID: () => 'explicit-recovery-key' }, confirm: message => { confirmations.push(message); return overrides.confirm !== false; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.notice.textContent, '', 'the actual detail renderer must finish without a runtime error');
  return { root: nodes.view, nativeUrl, calls, confirmations };
}

test('mounted legacy and manual details offer a separate work-and-session-bound read-only workbench link', async t => {
  for (const type of ['MYTHOS', 'MANUAL']) await t.test(type, async () => {
    const { root, nativeUrl, calls } = await mountedDetail(type);
    const anchors = root.querySelectorAll('a');
    const native = anchors.find(node => node.textContent === '在 DSH 中打开 ↗');
    assert.equal(native?.getAttribute('href'), nativeUrl);
    assert.equal(root.querySelector('iframe')?.getAttribute('src'), nativeUrl, 'native session frame is preserved');
    const coding = anchors.find(node => /只读.*工作台/.test(node.textContent));
    assert.ok(coding, 'the mounted caption must expose the read-only coding workbench entry');
    assert.equal(coding.parentNode, native.parentNode, 'both links belong to the displayed Session caption');
    const url = new URL(coding.getAttribute('href'), 'http://localhost:3093');
    assert.equal(url.origin, 'http://localhost:3093'); assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.get('mythosVibeTask'), wid);
    assert.equal(url.searchParams.get('mythosSession'), sid, 'bind the displayed session, rather than copying a different native URL');
    assert.equal(url.searchParams.get('mythosEmbedded'), '1');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['mythosEmbedded', 'mythosSession', 'mythosVibeTask']);
    assert.equal(coding.getAttribute('target'), '_blank'); assert.match(coding.getAttribute('rel'), /noopener/);
    assert.ok(calls.every(([, options]) => options.method === 'GET'), 'rendering this entry cannot create/start/prompt anything');
  });
});

test('the mounted workbench URL retains native catalog navigation without creating a replacement Session', async () => {
  const { root } = await mountedDetail('MANUAL');
  const coding = root.querySelectorAll('a').find(node => /只读.*工作台/.test(node.textContent));
  assert.ok(coding, 'read-only caption entry must exist');
  const url = new URL(coding.getAttribute('href'), 'http://localhost:3093');
  let plugin; const callbacks = new Set(), cleanups = [], opened = [], errors = [], catalog = { byId: {} };
  runInNewContext(await readFile(new URL('../plugins/mythos-console/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(); } } }, location: { search: url.search }, URLSearchParams,
    console: { error: (...args) => errors.push(args) },
  });
  plugin.apply({ effect(fn) { cleanups.push(fn()); }, sessions: { list: { getSnapshot: () => catalog, subscribe(fn) { callbacks.add(fn); return () => callbacks.delete(fn); } }, create() { throw new Error('must not create'); } }, uiWorkspace: { openSession(id) { opened.push(id); } } });
  assert.deepEqual(opened, []);
  catalog.byId[sid] = {}; for (const callback of callbacks) callback(); await Promise.resolve();
  assert.deepEqual(opened, [sid]); assert.deepEqual(errors, []);
  for (const cleanup of cleanups) cleanup?.();
});


test('a top-level known failure offers explicit recovery and explains that queued work has not run', async () => {
  const { root, calls, confirmations } = await mountedDetail('MANUAL', { work: { blocked: true, stage: 'BLOCKED' }, phase: 'CODING',
    operations: [{ operationId: 'exec-failed', state: 'FAILED', exitCode: 1 }, { operationId: 'exec-waiting', state: 'QUEUED' }] });
  assert.ok(root.textContent.includes('排队操作尚未运行'));
  const resume = root.querySelectorAll('button').find(node => node.textContent === '检查后恢复执行');
  assert.ok(resume, 'known failed execution can be resumed by an explicit operator action');
  assert.ok(calls.every(([, options]) => options.method === 'GET'), 'render does not automatically resume');
  await resume.events.get('click')();
  const mutations = calls.filter(([, options]) => options.method === 'POST');
  assert.equal(confirmations.length, 1); assert.equal(mutations.length, 1);
  assert.equal(mutations[0][0], '/mythos/api/work-items/' + wid + '/resume');
  assert.deepEqual(JSON.parse(mutations[0][1].body), { expectedVersion: 17 });
});

test('explicit recovery never appears for UNKNOWN, active execution, or workflow BLOCKED', async t => {
  for (const [phase, state] of [['CODING', 'UNKNOWN'], ['CODING', 'RUNNING'], ['BLOCKED', 'FAILED']]) await t.test(phase + '/' + state, async () => {
    const { root, calls } = await mountedDetail('MANUAL', { work: { blocked: true, stage: 'BLOCKED' }, phase,
      operations: [{ operationId: 'exec-known', state: 'FAILED' }, { operationId: 'exec-current', state }] });
    assert.equal(root.querySelectorAll('button').some(node => node.textContent === '检查后恢复执行'), false);
    assert.ok(calls.every(([, options]) => options.method === 'GET'));
  });
});


test('known failure recovery also covers PLANNING and honors a cancelled operator confirmation', async () => {
  for (const phase of ['PLANNING', 'CODING']) {
    const { root, calls, confirmations } = await mountedDetail('MANUAL', { work: { blocked: true, stage: 'BLOCKED' }, phase, confirm: false,
      operations: [{ operationId: 'exec-failed', state: 'FAILED', exitCode: 1 }] });
    const resume = root.querySelectorAll('button').find(node => node.textContent === '检查后恢复执行');
    assert.ok(resume); await resume.events.get('click')();
    assert.equal(confirmations.length, 1); assert.ok(calls.every(([, options]) => options.method === 'GET'));
  }
});
