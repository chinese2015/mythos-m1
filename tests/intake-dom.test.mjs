import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderIntake } from '../plugins/argon-console/public/intake-view.js';

// Minimal tree/event DOM for this module's mounted form contract. append moves
// nodes and coerces non-nodes to text, including undefined, just like native DOM.
class Node {
  constructor(tag = '') { this.tagName = tag.toUpperCase(); this.parentNode = null; this.children = []; this.attributes = {}; this.events = new Map(); }
  append(...nodes) {
    for (let node of nodes) {
      if (!(node instanceof Node)) node = new Text(String(node));
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
      node.parentNode = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
  set textContent(value) { this.replaceChildren(new Text(String(value))); }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'value') this.value = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.setAttribute('id', value); }
  addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(handler); }
  async fire(type) { const event = { type, target: this, preventDefault() {} }; for (const handler of this.events.get(type) || []) await handler(event); }
  focus() { document.activeElement = this; }
  get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
  querySelectorAll(selector) {
    const match = node => selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('[aria-label=')
      ? node.getAttribute('aria-label') === selector.slice(13, -2) : node.tagName === selector.toUpperCase();
    return this.children.flatMap(node => [...(match(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Text extends Node { constructor(value) { super(); this.data = value; } get textContent() { return this.data; } set textContent(value) { this.data = String(value); } }
class Input extends Node { constructor() { super('input'); this.value = ''; this.checked = false; } }
class TextArea extends Node { constructor() { super('textarea'); this.value = ''; } }
class Select extends Node { constructor() { super('select'); this.value = ''; } }
const memoryStorage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/generic-task-spec.json', import.meta.url), 'utf8'));
const repo = { repositoryId: 'repo-' + '1'.repeat(32), revision: 1, enabled: true, config: fixture.repositoryConfig };
const work = { workItemId: 'work-' + 'b'.repeat(32), source: { type: 'MANUAL', id: 'TASK-abcdef123456', revision: 1 } };

function environment(t, storage = memoryStorage(), storageGetter = null) {
  const globals = { document: { body: new Node('body'), createTextNode: text => new Text(text) },
    HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select };
  const prior = new Map();
  for (const [name, value] of Object.entries(globals)) { prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
  prior.set('sessionStorage', Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'));
  Object.defineProperty(globalThis, 'sessionStorage', storageGetter ? { configurable: true, get: storageGetter } : { configurable: true, value: storage });
  t.after(() => { for (const [name, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const el = (tag, attrs = {}, content = '') => {
    const node = tag === 'input' ? new Input() : tag === 'textarea' ? new TextArea() : tag === 'select' ? new Select() : new Node(tag);
    for (const [key, value] of Object.entries(attrs)) { if (key === 'text') node.textContent = value; else if (key === 'class') node.className = value; else node.setAttribute(key, value); }
    if (content) node.textContent = content; return node;
  };
  const notices = [], calls = [], opened = [];
  const mount = async (mutate = async () => work) => {
    const root = el('main'); document.body.append(root);
    const page = renderIntake({ el, panelHead: () => el('header'), notice: (...args) => notices.push(args), goWork: id => opened.push(id),
      request: async (path, options) => { if (path === '/repositories' && !options) return { repositories: [repo] }; calls.push({ path, ...options }); return mutate(path, options); } });
    page.mount(root); await page.load(); return root;
  };
  return { mount, notices, calls, opened, storage };
}
function byLabel(root, label) { return root.querySelector(`[aria-label="${label}"]`); }
function formOf(node) { while (node && node.tagName !== 'FORM') node = node.parentNode; assert.ok(node, 'control is mounted inside a form'); return node; }
function fillTask(root) {
  const title = byLabel(root, '标题'), description = byLabel(root, '描述'), acceptance = byLabel(root, '验收标准');
  assert.ok(acceptance, 'the acceptance criteria textarea must be mounted and editable');
  assert.equal(acceptance.tagName, 'TEXTAREA'); assert.ok(acceptance.isConnected);
  title.value = '修复客户'; description.value = 'Support multiple files'; acceptance.value = 'Tests pass';
  return formOf(title);
}
function button(root, text) { return root.querySelectorAll('button').find(node => node.textContent === text); }

test('mounted manual form submits its editable acceptance criteria in the canonical request', async t => {
  const env = environment(t); const root = await env.mount();
  await fillTask(root).fire('submit');
  assert.equal(env.calls.length, 1); const call = env.calls[0];
  assert.equal(call.path, '/tasks/manual'); assert.equal(call.method, 'POST'); assert.equal(call.mutation, true);
  assert.deepEqual(call.body, { repositoryId: repo.repositoryId, repositoryRevision: 1, title: '修复客户', description: 'Support multiple files', acceptanceCriteria: 'Tests pass' });
  assert.match(call.idempotencyKey, /^[A-Za-z0-9_-]{1,150}$/);
  assert.equal(env.storage.getItem('argon-intent:manual-task'), null);
  assert.ok(env.notices.some(([message, kind]) => kind === 'info' && message.includes('TASK-abcdef123456')));
  await button(root, '打开工作详情').fire('click'); assert.deepEqual(env.opened, [work.workItemId]);
});

test('missing or inaccessible session storage prevents a mounted repository mutation', async t => {
  for (const inaccessible of [false, true]) await t.test(inaccessible ? 'storage getter throws' : 'storage missing', async t => {
    const env = environment(t, null, inaccessible ? () => { throw new Error('storage denied'); } : null);
    const root = await env.mount(); await button(root, '停用').fire('click');
    assert.equal(env.calls.length, 0, 'a mutation needs a durable business intent key');
    assert.ok(env.notices.some(([message, kind]) => kind === 'error' && /存储/.test(message)));
    await fillTask(root).fire('submit');
    assert.equal(env.calls.length, 0, 'manual creation also needs durable intent storage');
    const reg = formOf(byLabel(root, '显示名称'));
    for (const [label, value] of [['显示名称', '客户 API'], ['仓库地址', 'demo/customer-api'], ['基线命令', 'mvn test'],
      ['验收命令', 'mvn test'], ['报告目录', 'target/surefire-reports'], ['允许范围', 'src/']]) byLabel(reg, label).value = value;
    await reg.fire('submit');
    assert.equal(env.calls.length, 0, 'repository registration also needs durable intent storage');
  });
});

test('mounted manual creation fails closed on unreadable, unwritable, or corrupt intent persistence', async t => {
  for (const mode of ['read', 'write', 'corrupt']) await t.test(mode, async t => {
    const storage = memoryStorage();
    if (mode === 'read') storage.getItem = () => { throw new Error('read failed'); };
    if (mode === 'write') storage.setItem = () => { throw new Error('write failed'); };
    if (mode === 'corrupt') storage.setItem('argon-intent:manual-task', '{broken');
    const env = environment(t, storage); const root = await env.mount(); await fillTask(root).fire('submit');
    assert.equal(env.calls.length, 0);
    assert.ok(env.notices.some(([message, kind]) => kind === 'error' && /存储|意向/.test(message)));
  });
});

test('a lost acknowledgement and remount retry reuse the durable key and original task', async t => {
  const env = environment(t); let acceptedKey;
  const first = await env.mount(async (_path, options) => { acceptedKey = options.idempotencyKey; throw new Error('response lost after acceptance'); });
  await fillTask(first).fire('submit');
  assert.equal(env.calls.length, 1); assert.ok(env.storage.getItem('argon-intent:manual-task'));
  const reloaded = await env.mount(async (_path, options) => { assert.equal(options.idempotencyKey, acceptedKey); return work; });
  await fillTask(reloaded).fire('submit');
  assert.equal(env.calls.length, 2); assert.deepEqual(env.calls[1].body, env.calls[0].body);
  assert.equal(env.storage.getItem('argon-intent:manual-task'), null);
  assert.ok(reloaded.textContent.includes('重复提交已按原结果返回'));
});

test('changed pending input requires the mounted explicit abandonment action', async t => {
  const env = environment(t); let attempt = 0;
  const root = await env.mount(async () => { if (++attempt === 1) throw new Error('lost response'); return work; });
  const form = fillTask(root); await form.fire('submit'); const firstKey = env.calls[0].idempotencyKey;
  byLabel(root, '标题').value = 'Different task'; await form.fire('submit');
  assert.equal(env.calls.length, 1); assert.ok(button(root, '放弃当前意向'));
  await button(root, '放弃当前意向').fire('click'); await form.fire('submit');
  assert.equal(env.calls.length, 2); assert.notEqual(env.calls[1].idempotencyKey, firstKey);
});


test('a mounted retry stops while a lost-ACK intent is unreadable and resumes with its original key', async t => {
  const storage = memoryStorage(); const read = storage.getItem; let unreadable = false;
  storage.getItem = key => { if (unreadable) throw new Error('storage read denied'); return read(key); };
  const env = environment(t, storage); let accepted = false;
  const root = await env.mount(async () => { if (!accepted) { accepted = true; throw new Error('response lost after acceptance'); } return work; });
  const form = fillTask(root); await form.fire('submit');
  const key = env.calls[0].idempotencyKey; const pending = read('argon-intent:manual-task');
  unreadable = true; await form.fire('submit');
  assert.equal(env.calls.length, 1); assert.equal(read('argon-intent:manual-task'), pending);
  unreadable = false; await form.fire('submit');
  assert.equal(env.calls.length, 2); assert.equal(env.calls[1].idempotencyKey, key);
});

test('corrupt mounted intent remains untouched until explicit abandonment', async t => {
  const storage = memoryStorage(); storage.setItem('argon-intent:manual-task', '{broken');
  const env = environment(t, storage); const root = await env.mount(); const form = fillTask(root);
  await form.fire('submit'); await form.fire('submit');
  assert.equal(env.calls.length, 0); assert.equal(storage.getItem('argon-intent:manual-task'), '{broken');
  await button(root, '放弃当前意向').fire('click'); await form.fire('submit');
  assert.equal(env.calls.length, 1); assert.equal(storage.getItem('argon-intent:manual-task'), null);
});
