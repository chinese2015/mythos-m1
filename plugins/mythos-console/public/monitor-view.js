import { mergeEvents, displayState, formatJUnit, formatEvent, staleNote, shouldAutoExpand } from './monitor-state.js';

const ACTIVE = new Set(['QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED']);
const MAX_EVENTS = 200, MAX_LOG_LINES = 200, MAX_EVENTS_IN_STATE = 500;
const stateByWork = new Map();

function stateFor(workItemId) {
  if (!stateByWork.has(workItemId)) stateByWork.set(workItemId, {
    eventCursor: 0, events: [], fetchedEvents: false, fetchingEvents: false,
    logCursors: new Map(), logText: new Map(), fetchingLogs: new Set(), terminalFetched: new Set(),
    expanded: new Set(), collapsed: new Set(), cancelled: new Set(), lastErrorAt: null,
  });
  return stateByWork.get(workItemId);
}
const opIdOf = op => op.operationId || op.id;
function panelRoot() { return document.querySelector('[data-panel="monitor"]'); }
// A late poll must write only inside the container of its own render. Without
// an explicit container the legacy global selector keeps the old behavior.
function makeScope(mount = {}) {
  return () => {
    const root = mount.container ?? panelRoot();
    if (!root) return null;
    if (mount.container && root.isConnected === false) return null;
    return root;
  };
}

function renderStream(stream, st, ctx) {
  const { el, opLabel } = ctx;
  stream.replaceChildren();
  const subtle = text => el('div', { class: 'subtle', text });
  if (!st.fetchedEvents) { stream.append(subtle('Reading events…')); return; }
  const outputs = st.events.filter(e => e.type === 'execution.output').length;
  if (outputs) stream.append(subtle(`Collapsed ${outputs} output events (live logs are above)`));
  const lines = st.events.map(e => formatEvent(e, opLabel)).filter(Boolean).slice(-MAX_EVENTS);
  if (!lines.length) stream.append(subtle('No events yet.'));
  else { const box = el('div'); box.textContent = lines.join('\n'); stream.append(box); }
}

async function pollEvents(ctx, st, scope) {
  if (st.fetchingEvents) return;
  st.fetchingEvents = true;
  try {
    const page = await ctx.request(`/work-items/${encodeURIComponent(ctx.workItemId)}/events?after=${st.eventCursor}`);
    const merged = mergeEvents(st.events, page);
    st.events = merged.events.slice(-MAX_EVENTS_IN_STATE);
    st.eventCursor = merged.cursor;
    st.fetchedEvents = true;
    st.lastErrorAt = null;
    const root = scope();
    const stream = root && root.querySelector('.event-stream');
    if (stream) renderStream(stream, st, ctx);
    const stale = root && root.querySelector('[data-stale-note]');
    if (stale) stale.hidden = true;
  } catch (_) {
    st.lastErrorAt = Date.now();
    const root = scope();
    const stale = root && root.querySelector('[data-stale-note]');
    if (stale) { const note = staleNote(st.lastErrorAt); if (note) { stale.textContent = note; stale.hidden = false; } }
  } finally { st.fetchingEvents = false; }
}

async function tailLog(ctx, st, op, scope) {
  const opId = opIdOf(op);
  if (st.fetchingLogs.has(opId)) return;
  st.fetchingLogs.add(opId);
  try {
    const after = st.logCursors.get(opId) ?? 0;
    const page = await ctx.request(`/operations/${encodeURIComponent(opId)}/logs?after=${after}`);
    const rows = Array.isArray(page.logs) ? page.logs : [];
    if (rows.length) {
      const incoming = rows.map(row => row.text ?? '').filter(text => text !== '');
      if (incoming.length) {
        const merged = ((st.logText.get(opId) || '').split('\n').filter(Boolean)).concat(incoming).slice(-MAX_LOG_LINES);
        st.logText.set(opId, merged.join('\n'));
      }
      const last = rows[rows.length - 1];
      st.logCursors.set(opId, Number.isSafeInteger(page.nextCursor) ? page.nextCursor : ((last.offset ?? after) + 1));
      const root = scope();
      const box = root && root.querySelector(`[data-monitor-log="${CSS.escape(opId)}"]`);
      if (box) { const text = st.logText.get(opId); if (box.textContent !== text) box.textContent = text; }
    }
    st.lastErrorAt = null;
  } catch (_) {
    st.lastErrorAt = Date.now();
  } finally { st.fetchingLogs.delete(opId); }
}

function tailActiveLogs(ctx, st, operations, scope) {
  for (const op of operations) {
    const opId = opIdOf(op);
    const active = ACTIVE.has(String(op.status || '').toUpperCase());
    if (active) { if (shouldAutoExpand(true, st.collapsed.has(opId))) { st.expanded.add(opId); tailLog(ctx, st, op, scope); } }
    else if (!st.terminalFetched.has(opId)) { st.terminalFetched.add(opId); if (st.expanded.has(opId)) tailLog(ctx, st, op, scope); }
  }
}

export function renderMonitor(ctx, mount = {}) {
  const { workItemId, workflow, operations = [], session, workItem, panelHead, phaseText } = ctx;
  const st = stateFor(workItemId);
  const panel = ctx.el('section', { class: 'panel', 'data-panel': 'monitor' });
  panel.append(panelHead('Run monitor', 'Work item phase · Agent activity · Execution facts'));
  const body = ctx.el('div', { class: 'panel-body' });
  const statusLine = ctx.el('div', { class: 'operation-details' });
  statusLine.append(ctx.el('span', { text: `Phase ${phaseText(workflow.phase || 'CLAIMED')}` }), ctx.el('span', { text: `Agent activity: ${(session && session.activity) || '—'}` }));
  if (workItem && workItem.paused) statusLine.append(ctx.el('span', { text: 'Workflow paused, observing only' }));
  body.append(statusLine);
  const stale = ctx.el('div', { class: 'warning-box', 'data-stale-note': '1' });
  const note = staleNote(st.lastErrorAt);
  stale.textContent = note || '';
  stale.hidden = !note;
  body.append(stale);
  const ops = operations.filter(op => op && opIdOf(op));
  if (!ops.length) body.append(ctx.el('div', { class: 'subtle', text: 'No operations yet.' }));
  for (const op of ops) body.append(renderOperation(ctx, st, op));
  body.append(ctx.el('div', { class: 'monitor-divider', text: `Event stream (${st.events.length} loaded on this page, new events appear within ~2 seconds)` }));
  const stream = ctx.el('div', { class: 'event-stream' });
  renderStream(stream, st, ctx);
  body.append(stream);
  panel.append(body);
  const scope = makeScope(mount);
  queueMicrotask(() => { tailActiveLogs(ctx, st, ops, scope); pollEvents(ctx, st, scope); });
  return panel;
}

function renderOperation(ctx, st, op) {
  const opId = opIdOf(op);
  const row = ctx.el('div', { class: 'operation', 'data-monitor-op': opId });
  const shown = displayState(op.status);
  const top = ctx.el('div', { class: 'operation-top' });
  top.append(ctx.el('span', { class: 'operation-name', text: ctx.opLabel(op) }), ctx.el('span', { class: `operation-status ${shown.cls}`, text: shown.label }));
  row.append(top);
  const details = ctx.el('div', { class: 'operation-details' });
  details.append(ctx.el('span', { class: 'mono', text: `ID ${opId}` }));
  if (op.exitCode !== undefined && op.exitCode !== null) details.append(ctx.el('span', { text: `Exit code ${op.exitCode}` }));
  if (op.startedAt) details.append(ctx.el('span', { text: `Started ${new Date(op.startedAt).toLocaleString('en-US')}` }));
  if (op.finishedAt) details.append(ctx.el('span', { text: `Finished ${new Date(op.finishedAt).toLocaleString('en-US')}` }));
  const junit = formatJUnit(op.junit);
  if (junit) details.append(ctx.el('span', { text: junit }));
  row.append(details);
  const active = ACTIVE.has(String(op.status || '').toUpperCase());
  const tools = ctx.el('div', { class: 'operation-details' });
  const expanded = st.expanded.has(opId);
  const toggle = ctx.el('button', { class: 'text-button', type: 'button', text: expanded ? 'Collapse log' : 'View live log' });
  toggle.addEventListener('click', () => {
    if (st.expanded.has(opId)) { st.expanded.delete(opId); st.collapsed.add(opId); }
    else { st.expanded.add(opId); st.collapsed.delete(opId); tailLog(ctx, st, op); }
    const box = row.querySelector(`[data-monitor-log="${CSS.escape(opId)}"]`);
    if (box) box.hidden = !st.expanded.has(opId);
    toggle.textContent = st.expanded.has(opId) ? 'Collapse log' : 'View live log';
  });
  tools.append(toggle);
  if (active && !st.cancelled.has(opId)) {
    const cancel = ctx.el('button', { class: 'text-button', type: 'button', text: 'Cancel this operation' });
    cancel.addEventListener('click', async () => {
      if (!confirm('Cancel this operation? The request is sent, then wait for the process to actually exit.')) return;
      cancel.disabled = true;
      try {
        await ctx.request(`/operations/${encodeURIComponent(opId)}/cancel`, { method: 'POST', body: { expectedVersion: op.version }, mutation: true });
        st.cancelled.add(opId);
        cancel.textContent = 'Cancel requested';
      } catch (error) {
        if (ctx.notice) ctx.notice(error.message, 'error'); else alert(error.message);
        if (cancel.isConnected) cancel.disabled = false;
      }
    });
    tools.append(cancel);
  }
  row.append(tools);
  const box = ctx.el('div', { class: 'log-box', 'data-monitor-log': opId });
  box.hidden = !expanded;
  box.textContent = st.logText.get(opId) || (active ? 'Reading log…' : '');
  row.append(box);
  return row;
}
