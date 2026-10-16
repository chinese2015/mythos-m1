import { mergeEvents, displayState, formatJUnit, formatEvent, staleNote } from './monitor-state.js';

const ACTIVE = new Set(['QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED']);
const MAX_EVENTS = 200, MAX_LOG_LINES = 200, MAX_EVENTS_IN_STATE = 500;
const stateByWork = new Map();

function stateFor(workItemId) {
  if (!stateByWork.has(workItemId)) stateByWork.set(workItemId, {
    eventCursor: 0, events: [], fetchedEvents: false, fetchingEvents: false,
    logCursors: new Map(), logText: new Map(), fetchingLogs: new Set(), terminalFetched: new Set(),
    expanded: new Set(), cancelled: new Set(), lastErrorAt: null,
  });
  return stateByWork.get(workItemId);
}
const opIdOf = op => op.operationId || op.id;
function panelRoot() { return document.querySelector('[data-panel="monitor"]'); }

function renderStream(stream, st, ctx) {
  const { el, opLabel } = ctx;
  stream.replaceChildren();
  const subtle = text => el('div', { class: 'subtle', text });
  if (!st.fetchedEvents) { stream.append(subtle('正在读取事件…')); return; }
  const outputs = st.events.filter(e => e.type === 'execution.output').length;
  if (outputs) stream.append(subtle(`已折叠 ${outputs} 条输出事件（实时日志见上方操作日志）`));
  const lines = st.events.map(e => formatEvent(e, opLabel)).filter(Boolean).slice(-MAX_EVENTS);
  if (!lines.length) stream.append(subtle('暂无事件。'));
  else { const box = el('div'); box.textContent = lines.join('\n'); stream.append(box); }
}

async function pollEvents(ctx, st) {
  if (st.fetchingEvents) return;
  st.fetchingEvents = true;
  try {
    const page = await ctx.request(`/work-items/${encodeURIComponent(ctx.workItemId)}/events?after=${st.eventCursor}`);
    const merged = mergeEvents(st.events, page);
    st.events = merged.events.slice(-MAX_EVENTS_IN_STATE);
    st.eventCursor = merged.cursor;
    st.fetchedEvents = true;
    st.lastErrorAt = null;
    const root = panelRoot();
    const stream = root && root.querySelector('.event-stream');
    if (stream) renderStream(stream, st, ctx);
    const stale = root && root.querySelector('[data-stale-note]');
    if (stale) stale.hidden = true;
  } catch (_) {
    st.lastErrorAt = Date.now();
    const root = panelRoot();
    const stale = root && root.querySelector('[data-stale-note]');
    if (stale) { const note = staleNote(st.lastErrorAt); if (note) { stale.textContent = note; stale.hidden = false; } }
  } finally { st.fetchingEvents = false; }
}

async function tailLog(ctx, st, op) {
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
      const root = panelRoot();
      const box = root && root.querySelector(`[data-monitor-log="${CSS.escape(opId)}"]`);
      if (box) { const text = st.logText.get(opId); if (box.textContent !== text) box.textContent = text; }
    }
    st.lastErrorAt = null;
  } catch (_) {
    st.lastErrorAt = Date.now();
  } finally { st.fetchingLogs.delete(opId); }
}

function tailActiveLogs(ctx, st, operations) {
  for (const op of operations) {
    const opId = opIdOf(op);
    const active = ACTIVE.has(String(op.status || '').toUpperCase());
    if (active) { st.expanded.add(opId); tailLog(ctx, st, op); }
    else if (!st.terminalFetched.has(opId)) { st.terminalFetched.add(opId); if (st.expanded.has(opId)) tailLog(ctx, st, op); }
  }
}

export function renderMonitor(ctx) {
  const { workItemId, workflow, operations = [], session, workItem, panelHead, phaseText } = ctx;
  const st = stateFor(workItemId);
  const panel = ctx.el('section', { class: 'panel', 'data-panel': 'monitor' });
  panel.append(panelHead('运行监控', 'Work Item 阶段 · Agent 活动 · 执行事实'));
  const body = ctx.el('div', { class: 'panel-body' });
  const statusLine = ctx.el('div', { class: 'operation-details' });
  statusLine.append(ctx.el('span', { text: `阶段 ${phaseText(workflow.phase || 'CLAIMED')}` }), ctx.el('span', { text: `Agent 活动：${(session && session.activity) || '—'}` }));
  if (workItem && workItem.paused) statusLine.append(ctx.el('span', { text: '工作流已暂停，仅观察不派发' }));
  body.append(statusLine);
  const stale = ctx.el('div', { class: 'warning-box', 'data-stale-note': '1' });
  const note = staleNote(st.lastErrorAt);
  stale.textContent = note || '';
  stale.hidden = !note;
  body.append(stale);
  const ops = operations.filter(op => op && opIdOf(op));
  if (!ops.length) body.append(ctx.el('div', { class: 'subtle', text: '还没有执行操作。' }));
  for (const op of ops) body.append(renderOperation(ctx, st, op));
  body.append(ctx.el('div', { class: 'monitor-divider', text: `事件流（本页已载 ${st.events.length} 条，新事件约 2 秒内出现）` }));
  const stream = ctx.el('div', { class: 'event-stream' });
  renderStream(stream, st, ctx);
  body.append(stream);
  panel.append(body);
  queueMicrotask(() => { tailActiveLogs(ctx, st, ops); pollEvents(ctx, st); });
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
  if (op.exitCode !== undefined && op.exitCode !== null) details.append(ctx.el('span', { text: `退出码 ${op.exitCode}` }));
  if (op.startedAt) details.append(ctx.el('span', { text: `开始 ${new Date(op.startedAt).toLocaleString('zh-CN')}` }));
  if (op.finishedAt) details.append(ctx.el('span', { text: `结束 ${new Date(op.finishedAt).toLocaleString('zh-CN')}` }));
  const junit = formatJUnit(op.junit);
  if (junit) details.append(ctx.el('span', { text: junit }));
  row.append(details);
  const active = ACTIVE.has(String(op.status || '').toUpperCase());
  const tools = ctx.el('div', { class: 'operation-details' });
  const expanded = st.expanded.has(opId);
  const toggle = ctx.el('button', { class: 'text-button', type: 'button', text: expanded ? '收起日志' : '查看实时日志' });
  toggle.addEventListener('click', () => {
    if (st.expanded.has(opId)) st.expanded.delete(opId);
    else { st.expanded.add(opId); tailLog(ctx, st, op); }
    const box = row.querySelector(`[data-monitor-log="${CSS.escape(opId)}"]`);
    if (box) box.hidden = !st.expanded.has(opId);
    toggle.textContent = st.expanded.has(opId) ? '收起日志' : '查看实时日志';
  });
  tools.append(toggle);
  if (active && !st.cancelled.has(opId)) {
    const cancel = ctx.el('button', { class: 'text-button', type: 'button', text: '取消此操作' });
    cancel.addEventListener('click', async () => {
      if (!confirm('确定取消这条操作？取消请求发出后需等待进程实际终止。')) return;
      cancel.disabled = true;
      try {
        await ctx.request(`/operations/${encodeURIComponent(opId)}/cancel`, { method: 'POST', body: { expectedVersion: op.version }, mutation: true });
        st.cancelled.add(opId);
        cancel.textContent = '已请求取消';
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
  box.textContent = st.logText.get(opId) || (active ? '正在读取日志…' : '');
  row.append(box);
  return row;
}
