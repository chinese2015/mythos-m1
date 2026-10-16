// Pure state helpers for the run monitor panel. No DOM access — node-test imports this directly.
const STATE_LABELS = {
  SUCCEEDED: ['已完成', 'succeeded'],
  COMPLETED: ['已完成', 'succeeded'],
  FAILED: ['失败', 'failed'],
  RUNNING: ['运行中', 'running'],
  QUEUED: ['排队中', 'queued'],
  STARTING: ['启动中', 'queued'],
  CANCEL_REQUESTED: ['取消已请求，等待进程终止', 'cancel-pending'],
  CANCELLED: ['已取消', 'cancelled'],
};

export function mergeEvents(existing = [], page = {}) {
  const bySequence = new Map();
  for (const event of existing || []) if (event && Number.isSafeInteger(event.sequence)) bySequence.set(event.sequence, event);
  const incoming = Array.isArray(page.events) ? page.events : [];
  for (const event of incoming) if (event && Number.isSafeInteger(event.sequence)) bySequence.set(event.sequence, event);
  const events = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  const last = events.length ? events[events.length - 1].sequence : 0;
  const cursor = Number.isSafeInteger(page.nextCursor) ? page.nextCursor : last;
  return { events, cursor };
}

export function displayState(state) {
  const value = String(state == null ? '' : state).toUpperCase();
  if (STATE_LABELS[value]) { const [label, cls] = STATE_LABELS[value]; return { label, cls }; }
  if (!value) return { label: '状态未知 · 执行器失联，未自动重放', cls: 'unknown' };
  if (value === 'UNKNOWN') return { label: '状态未知 · 执行器失联，未自动重放', cls: 'unknown' };
  return { label: value, cls: 'unknown' };
}

export function formatJUnit(junit) {
  if (!junit || !Number.isSafeInteger(junit.tests)) return null;
  return `JUnit：${junit.tests} 项 · ${junit.failures ?? '?'} 失败 · ${junit.errors ?? '?'} 错误`;
}

const EVENT_LABELS = {
  'execution.queued': () => '已排队',
  'execution.starting': () => '正在启动',
  'execution.started': () => '开始运行',
  'execution.prepared': () => '执行环境就绪',
  'execution.succeeded': payload => `运行成功${payload && payload.exitCode != null ? ` · exitCode ${payload.exitCode}` : ''}`,
  'execution.failed': payload => `运行失败${payload && payload.exitCode != null ? ` · exitCode ${payload.exitCode}` : ''}${payload && payload.reason ? ` · ${payload.reason}` : ''}`,
  'execution.cancel_requested': () => '已请求取消，等待进程终止',
  'execution.cancelled': payload => `已取消${payload && payload.exitCode != null ? ` · exitCode ${payload.exitCode}` : ''}`,
  'execution.unknown': () => '执行器失联，状态未知，未自动重放',
  'execution.cleanup': () => '正在清理执行环境',
  'workspace.preparation_started': () => '开始准备工作区',
  'workspace.ready': () => '工作区就绪',
  'workspace.failed': payload => `工作区准备失败${payload && payload.reason ? ` · ${payload.reason}` : ''}`,
  'workspace.unknown': () => '工作区状态未知',
  'work_item.created': () => '工作项已创建',
  'work_item.claimed': () => '工作项已领取',
  'work_item.session_bound': () => '已绑定工作会话',
  'work_item.workflow_updated': () => '工作流状态已更新',
  'work_item.paused': () => '工作流已暂停',
  'work_item.resumed': () => '工作流已恢复',
};

export function formatEvent(event, operationLabel = () => '操作') {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'execution.output') return null;
  const time = event.occurredAt ? new Date(event.occurredAt).toLocaleString('zh-CN') : '';
  const summarize = EVENT_LABELS[event.type];
  const subject = event.correlation && event.correlation.operationId ? `${operationLabel(event.correlation.operationId)} ${event.correlation.operationId.slice(0, 12)}` : null;
  const summary = summarize ? summarize(event.payload) : event.type;
  return [time, subject, summary].filter(Boolean).join(' · ');
}

export function staleNote(lastErrorAt, now = Date.now()) {
  if (!lastErrorAt) return null;
  const seconds = Math.max(1, Math.round((now - lastErrorAt) / 1000));
  return `连接中断，显示的是 ${seconds} 秒前的快照`;
}

export function shouldAutoExpand(isActive, manuallyCollapsed) {
  return isActive === true && manuallyCollapsed !== true;
}
