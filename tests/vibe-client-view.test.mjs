import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the shipped client with its real bridge; only the browser DOM and
// remote task/file responses are substituted. CSS layout is checked in-browser.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.events = new Map(); this.dataset = {};
    this.className = ''; this.hidden = false; this.disabled = false; this._text = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => this.classList.toggle(name, true),
      remove: name => this.classList.toggle(name, false),
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  click() { assert.equal(this.disabled, false); this.events.get('click')?.({ preventDefault() {} }); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1))
      : selector === '[data-av-warn]' ? node.dataset.avWarn !== undefined : node.tagName === selector.toUpperCase();
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const workItemId = 'work-' + 'a'.repeat(32);
const fileA = 'src/main/A.java', fileB = 'src/test/ATest.java';
let clientImport = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
const file = path => ({ path, version: 'v1', offset: 1, limit: 400, lines: [path === fileA ? 'class A {}' : 'class ATest {}'], eof: true, lineCount: 1 });

async function mount(t, { deferFile = null, deferContext = null, rich = false, sourceLines = null, fileLayout = null } = {}) {
  const body = new Element('body'), timers = [], cleanups = [], errors = [];
  let contextEntered;
  const contextStarted = new Promise(resolve => { contextEntered = resolve; });
  let mounted = true;
  const layoutEffects = [];
  const flatten = node => node == null ? '' : typeof node !== 'object' ? String(node)
    : typeof node.type === 'function' ? flatten(node.type(node.props)) : node.children.map(flatten).join('');
  const richModules = {
    react: { Fragment: Symbol(), createElement: (type, props, ...children) => ({ type, props, children }), useLayoutEffect: callback => { layoutEffects.push(callback); } },
    'react-dom/client': { createRoot: node => ({
      render(tree) {
        if (!mounted) throw new Error('Cannot update an unmounted root.');
        node.textContent = flatten(tree);
        for (const effect of layoutEffects.splice(0)) effect();
      },
      unmount() { mounted = false; },
    }) },
    '@deepseek-ai/dsh-client-ui-primitives': {
      languageForPath: () => 'java',
      // Characterize tokenizers that normalize CRLF, while exercising our real renderer.
      useCodeHighlighter: () => text => text.split('\n').map(line => [{ text: line.replace(/\r$/, ''), style: { color: 'red' } }]),
    },
  };
  let plugin;
  const globals = {
    window: {
      matchMedia: fileLayout ? () => fileLayout : undefined,
      __MYTHOS_VIBE_BRIDGE__: new URL('../plugins/mythos-vibe/shared/bridge-browser.mjs', import.meta.url).href,
      __ModuleLoader__: { load: ({ factory }) => { plugin = factory(name => rich ? richModules[name] || {} : {}); } },
    },
    document: { body, hidden: false, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    location: { search: '?mythosVibeTask=' + workItemId }, URLSearchParams,
    crypto: { randomUUID: () => 'binding-view-test' },
    console: { error: (...args) => errors.push(args) },
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {},
    fetch: async address => {
      const url = new URL(address, 'http://localhost');
      if (url.pathname.endsWith('/context')) { contextEntered(); return deferContext || response({ workItemId, version: 1, phase: 'CODING', source: { id: 'TASK-demo', sourcePath: fileA } }); }
      if (url.pathname.endsWith('/diff')) return response({ changedFiles: [fileA, fileB], diff: '+ changed source' });
      if (url.pathname.endsWith('/files')) {
        const path = url.searchParams.get('path');
        if (deferFile && path === fileB) return deferFile;
        return response({ ...file(path), ...(sourceLines && path === fileA ? { lines: sourceLines, lineCount: sourceLines.length } : {}) });
      }
      throw new Error('Unexpected request: ' + address);
    },
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  t.after(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  await import(new URL('../plugins/mythos-vibe/client.js?viewTest=' + ++clientImport, import.meta.url));
  const ready = plugin.apply({
    effect: effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    slots: { inject() {}, register() {} },
    sidebarRightTabs: { register() { return () => {}; } },
  });
  if (deferContext) await contextStarted; else await ready;
  assert.deepEqual(errors, [], 'client activation must succeed');
  const root = body.querySelector('.av-root');
  assert.ok(root);
  return {
    root,
    tab: text => root.querySelectorAll('.av-tab').find(node => node.textContent === text),
    file: path => root.querySelectorAll('.av-file').find(node => node.title === path),
    source: () => root.querySelector('.av-src').textContent,
    refresh: async () => { timers[0](); await settle(); },
    ready, contextStarted, errors,
    dispose: () => { for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

test('the task view opens its first known source file instead of an empty editor', async t => {
  const view = await mount(t);
  assert.match(view.source(), /class A \{\}/);
});

test('opening a file from Diff selects Source and shows that file', async t => {
  const view = await mount(t);
  await view.tab('Diff').click();
  await view.file(fileB).click(); await settle();
  assert.equal(view.tab('Source').getAttribute('aria-selected'), 'true');
  assert.equal(view.tab('Diff').getAttribute('aria-selected'), 'false');
  assert.match(view.source(), /class ATest \{\}/);
});

test('a file response arriving after a switch to Diff cannot replace the visible diff', async t => {
  let resolveFile;
  const view = await mount(t, { deferFile: new Promise(resolve => { resolveFile = resolve; }) });
  await view.file(fileB).click();
  await view.tab('Diff').click();
  resolveFile(response(file(fileB))); await settle();
  assert.equal(view.source(), '+ changed source');
  await view.tab('Source').click();
  assert.match(view.source(), /class ATest \{\}/, 'the loaded file remains available on returning to Source');
});

test('context polling keeps unchanged file buttons mounted so keyboard focus is retained', async t => {
  const view = await mount(t);
  const original = view.file(fileA);
  await view.refresh();
  assert.equal(view.file(fileA), original);
});

test('disposing during startup cannot update an unmounted syntax renderer', async t => {
  let resolveContext;
  const view = await mount(t, { rich: true, deferContext: new Promise(resolve => { resolveContext = resolve; }) });
  await view.contextStarted;
  view.dispose();
  resolveContext(response({ workItemId, version: 1, phase: 'CODING', source: { sourcePath: fileA } }));
  await assert.doesNotReject(view.ready);
  assert.deepEqual(view.errors, []);
});

test('syntax tokens preserve source CRLF characters so selection offsets stay exact', async t => {
  const view = await mount(t, { rich: true, sourceLines: ['class A {\r', '  int count = 2;\r', '}'] });
  assert.equal(view.source(), 'class A {\r\n  int count = 2;\r\n}');
});

test('collapsed directories expose their files when the explorer becomes a narrow file strip', async t => {
  const listeners = new Set();
  const media = { matches: false, addEventListener: (_event, fn) => listeners.add(fn), removeEventListener: (_event, fn) => listeners.delete(fn) };
  const view = await mount(t, { fileLayout: media });
  const group = view.root.querySelector('details');
  group.open = false;
  media.matches = true;
  for (const listener of listeners) listener();
  assert.equal(group.open, true);
});
