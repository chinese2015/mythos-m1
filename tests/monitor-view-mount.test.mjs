import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMonitor } from '../plugins/mythos-console/public/monitor-view.js';

// ---- 轻量 fake DOM（无 jsdom 依赖） --------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.className = '';
    this.hidden = false;
    this._text = '';
    this.listeners = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { const list = this.parent.children; const index = list.indexOf(this); if (index >= 0) list.splice(index, 1); this.parent = null; } }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === this.ownerDocument?.root || node.isRoot === true; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attr = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/i);
    if (!attr) return false;
    if (!this.attributes.has(attr[1])) return false;
    return attr[2] === undefined || this.attributes.get(attr[1]) === attr[2];
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
FakeNode.prototype.ownerDocument = null;

class FakeDocument {
  constructor() { this.root = new FakeNode('#document'); this.root.isRoot = true; }
  createElement(tag) { return new FakeNode(tag); }
  querySelector(selector) { return this.root.querySelector(selector); }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function makeCtx(workItemId, requests, eventsPage, logsPage) {
  return {
    workItemId,
    workflow: { phase: 'CODING' },
    operations: [{ operationId: 'op-' + workItemId, status: 'SUCCEEDED', kind: 'VERIFY' }],
    session: null,
    workItem: { paused: false },
    el: (tag, attrs = {}) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node._text = String(value);
        else node.setAttribute(key, value);
      }
      return node;
    },
    panelHead: (title, sub) => {
      const head = document.createElement('div');
      head.append(Object.assign(document.createElement('h2'), { _text: title }), Object.assign(document.createElement('small'), { _text: sub || '' }));
      return head;
    },
    request: async path => {
      requests.push(path);
      if (path.includes('/events?')) return eventsPage;
      if (path.includes('/logs?')) return logsPage;
      throw new Error('unexpected request ' + path);
    },
    notice: () => {},
    phaseText: phase => phase,
    opLabel: () => '验证',
  };
}

function mount(workItemId, container, requests, eventsPage, logsPage) {
  const panel = renderMonitor(makeCtx(workItemId, requests, eventsPage, logsPage), { container });
  container.append(panel);
  return panel;
}

const eventsPageFor = (workItemId, type) => ({ events: [{ sequence: 1, type, occurredAt: '2026-10-17T00:00:00Z', payload: {}, correlation: {} }], nextCursor: 2 });

test('a scoped mount writes poll results only inside its own container, never a sibling task or a global panel', async () => {
  const previousDocument = globalThis.document;
  const previousCSS = globalThis.CSS;
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.CSS = { escape: value => String(value).replace(/["\\\]]/g, '\\$&') };
  try {
    const decoy = doc.createElement('section');
    decoy.setAttribute('data-panel', 'monitor');
    const decoyStream = doc.createElement('div');
    decoyStream.className = 'event-stream';
    decoyStream._text = 'decoy-sentinel';
    decoy.append(decoyStream);
    doc.root.append(decoy);

    const containerA = doc.createElement('div');
    const containerB = doc.createElement('div');
    doc.root.append(containerA, containerB);

    const requestsA = [], requestsB = [];
    const panelA = mount('work-aaaa', containerA, requestsA, eventsPageFor('work-aaaa', 'work_item.claimed'));
    const panelB = mount('work-bbbb', containerB, requestsB, eventsPageFor('work-bbbb', 'work_item.paused'));
    await flush();
    await flush();

    assert.ok(requestsA.some(path => path.startsWith('/work-items/work-aaaa/events?')), 'A polls its own work item');
    assert.ok(requestsB.some(path => path.startsWith('/work-items/work-bbbb/events?')), 'B polls its own work item');
    const streamA = panelA.querySelector('.event-stream');
    const streamB = panelB.querySelector('.event-stream');
    assert.match(streamA.textContent, /已领取/);
    assert.doesNotMatch(streamA.textContent, /已暂停/, 'A must not show B’s events');
    assert.match(streamB.textContent, /已暂停/);
    assert.doesNotMatch(streamB.textContent, /已领取/, 'B must not show A’s events');
    assert.equal(decoyStream.textContent, 'decoy-sentinel', 'a global panel outside the container is never touched');
  } finally {
    globalThis.document = previousDocument;
    globalThis.CSS = previousCSS;
  }
});

test('a detached container receives no late writes and does not throw', async () => {
  const previousDocument = globalThis.document;
  const previousCSS = globalThis.CSS;
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.CSS = { escape: value => String(value) };
  try {
    const container = doc.createElement('div');
    doc.root.append(container);
    const requests = [];
    const panel = mount('work-late', container, requests, eventsPageFor('work-late', 'work_item.claimed'));
    const stream = panel.querySelector('.event-stream');
    container.remove(); // simulate the task view being torn down before the poll lands
    await flush();
    await flush();
    assert.match(stream.textContent, /正在读取事件|暂无事件/, 'the late poll wrote nothing into the detached container');
  } finally {
    globalThis.document = previousDocument;
    globalThis.CSS = previousCSS;
  }
});

test('without a container the legacy global selector path is unchanged', async () => {
  const previousDocument = globalThis.document;
  const previousCSS = globalThis.CSS;
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.CSS = { escape: value => String(value) };
  try {
    const requests = [];
    const panel = renderMonitor(makeCtx('work-legacy', requests, eventsPageFor('work-legacy', 'work_item.resumed')));
    doc.root.append(panel); // console caller appends the returned panel into the document
    await flush();
    await flush();
    assert.match(panel.querySelector('.event-stream').textContent, /已恢复/);
    assert.ok(requests.some(path => path.startsWith('/work-items/work-legacy/events?')));
  } finally {
    globalThis.document = previousDocument;
    globalThis.CSS = previousCSS;
  }
});
