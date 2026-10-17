export function conflict(message) { const error = new Error('409 ' + message); error.status = 409; return error; }
const plain = content => (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
export function sessionProgress(inspection, requestId) {
  const events = inspection?.events ?? [];
  const queues = { 'next-turn': [], 'next-step': [] }, admissions = new Map(); let latestUserSequence = 0;
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data, queue = queues[splice.target];
      if (!queue) continue;
      const removed = queue.splice(splice.start, splice.removedCount ?? 0, ...(splice.inserted ?? []));
      for (const message of removed) if (message.source?.rpcId) admissions.set(message.source.rpcId, { state: splice.outcome === 'canceled' ? 'canceled' : 'consumed' });
      for (const message of splice.inserted ?? []) if (message.source?.rpcId) {
        admissions.set(message.source.rpcId, { state: 'pending' }); latestUserSequence = Math.max(latestUserSequence, event.seq);
      }
    }
    if (event.type === 'user/message') latestUserSequence = Math.max(latestUserSequence, event.seq);
  }
  const pendingInputs = Object.values(queues).flat().filter(m => m.source?.rpcId).map(m => m.source.rpcId);
  const index = events.findIndex(e => e.type === 'user/message' && e.data?.source?.rpcId === requestId);
  if (index < 0) { const state = admissions.get(requestId)?.state; return { found: !!state, pending: state === 'pending', completed: false,
    failed: state === 'canceled', reason: state === 'canceled' ? 'canceled' : undefined, latestUserSequence, pendingInputs }; }
  let start = index;
  while (start >= 0 && events[start].type !== 'turn/start') start--;
  const turn = events[start]?.data?.turn;
  const endIndex = events.findIndex((e, i) => i > index && e.type === 'turn/end' && e.data?.turn === turn);
  const addressed = events.slice(index, endIndex < 0 ? undefined : endIndex + 1);
  const text = addressed.filter(e => e.type === 'assistant/message').map(e => plain(e.data?.message?.content)).filter(Boolean).join('\n\n');
  const end = endIndex >= 0 ? events[endIndex] : null;
  return { found: true, completed: end?.data?.reason?.kind === 'completed', failed: !!end && end.data?.reason?.kind !== 'completed',
    latestUserSequence, pendingInputs, endSequence: end?.seq, text, reason: end?.data?.reason?.kind };
}
export function assertApproval(snapshot, body, progress) {
  const w = snapshot.workflow ?? snapshot.workItem.workflow;
  if (body.expectedVersion !== snapshot.workItem.version || w.phase !== 'AWAITING_PLAN_APPROVAL' ||
      body.planHash !== w.planHash || !progress.completed || progress.endSequence !== w.planEndSequence ||
      progress.latestUserSequence > w.planEndSequence || progress.pendingInputs?.length) throw conflict('方案已更新，请刷新并重新确认');
}
export const baselineExpectations = {
  'FND-00009': ['maliciousInputReturnsNothing'],
  'FND-00015': ['blocksTraversalOutsideReportDirectory'],
  'FND-00003': ['noHardcodedAdminPassword', 'leakedDemoPasswordNotPresent'],
};
export function baselineReproduced(operation, findingId = 'FND-00009') {
  const j = operation?.evidence?.junit;
  const expected = baselineExpectations[findingId];
  return !!expected && operation?.state === 'FAILED' && Number.isInteger(operation.exitCode) && operation.exitCode !== 0 && j?.tests === 2 && j.failures === expected.length && j.errors === 0 && j.skipped === 0 && !j.invalidReports?.length &&
    expected.every(test => (j.failedTests ?? []).some(name => name === test || name.endsWith('.' + test)));
}
export function transcript(inspection) {
  return (inspection?.events ?? []).filter(e => ['user/message', 'assistant/message', 'tool/result', 'turn/end'].includes(e.type)).slice(-100).map(e => ({
    seq: e.seq, type: e.type, text: e.type === 'assistant/message' ? plain(e.data?.message?.content) : plain(e.data?.content) || e.data?.reason?.kind || '',
  }));
}
