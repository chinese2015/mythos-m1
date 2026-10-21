// Pure state helpers for the run monitor panel. No DOM access — node-test imports this directly.
const STATE_LABELS = {
  SUCCEEDED: ['Succeeded', 'succeeded'],
  COMPLETED: ['Completed', 'succeeded'],
  FAILED: ['Failed', 'failed'],
  RUNNING: ['Running', 'running'],
  QUEUED: ['Queued', 'queued'],
  STARTING: ['Starting', 'queued'],
  CANCEL_REQUESTED: ['Cancel requested, waiting for the process to exit', 'cancel-pending'],
  CANCELLED: ['Cancelled', 'cancelled'],
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
  if (!value) return { label: 'State unknown · executor lost, no automatic replay', cls: 'unknown' };
  if (value === 'UNKNOWN') return { label: 'State unknown · executor lost, no automatic replay', cls: 'unknown' };
  return { label: value, cls: 'unknown' };
}

export function formatJUnit(junit) {
  if (!junit || !Number.isSafeInteger(junit.tests)) return null;
  return `JUnit: ${junit.tests} tests · ${junit.failures ?? '?'} failures · ${junit.errors ?? '?'} errors`;
}

const EVENT_LABELS = {
  'execution.queued': () => 'Queued',
  'execution.starting': () => 'Starting',
  'execution.started': () => 'Run started',
  'execution.prepared': () => 'Execution environment ready',
  'execution.succeeded': payload => `Run succeeded${payload && payload.exitCode != null ? ` · exitCode ${payload.exitCode}` : ''}`,
  'execution.failed': payload => `Run failed${payload && payload.exitCode != null ? ` · exitCode ${payload.exitCode}` : ''}${payload && payload.reason ? ` · ${payload.reason}` : ''}`,
  'execution.cancel_requested': () => 'Cancel requested, waiting for the process to exit',
  'execution.cancelled': payload => `Cancelled${payload && payload.exitCode != null ? ` · exitCode ${payload.exitCode}` : ''}`,
  'execution.unknown': () => 'Executor lost, state unknown, no automatic replay',
  'execution.cleanup': () => 'Cleaning up execution environment',
  'workspace.preparation_started': () => 'Workspace preparation started',
  'workspace.ready': () => 'Workspace ready',
  'workspace.failed': payload => `Workspace preparation failed${payload && payload.reason ? ` · ${payload.reason}` : ''}`,
  'workspace.unknown': () => 'Workspace state unknown',
  'work_item.created': () => 'Work item created',
  'work_item.claimed': () => 'Work item claimed',
  'work_item.session_bound': () => 'Work session bound',
  'work_item.workflow_updated': () => 'Workflow state updated',
  'work_item.paused': () => 'Workflow paused',
  'work_item.resumed': () => 'Workflow resumed',
};

export function formatEvent(event, operationLabel = () => 'operation') {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'execution.output') return null;
  const time = event.occurredAt ? new Date(event.occurredAt).toLocaleString('en-US') : '';
  const summarize = EVENT_LABELS[event.type];
  const subject = event.correlation && event.correlation.operationId ? `${operationLabel(event.correlation.operationId)} ${event.correlation.operationId.slice(0, 12)}` : null;
  const summary = summarize ? summarize(event.payload) : event.type;
  return [time, subject, summary].filter(Boolean).join(' · ');
}

export function staleNote(lastErrorAt, now = Date.now()) {
  if (!lastErrorAt) return null;
  const seconds = Math.max(1, Math.round((now - lastErrorAt) / 1000));
  return `Connection lost, showing a snapshot from ${seconds} seconds ago`;
}

export function shouldAutoExpand(isActive, manuallyCollapsed) {
  return isActive === true && manuallyCollapsed !== true;
}
