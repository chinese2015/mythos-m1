export function conflict(message) { const error = new Error('409 ' + message); error.status = 409; return error; }
const plain = content => (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
export function sessionProgress(inspection, requestId) {
  const events = inspection?.events ?? [];
  const latestUserSequence = Math.max(0, ...events.filter(e => e.type === 'user/message').map(e => e.seq));
  const index = events.findIndex(e => e.type === 'user/message' && e.data?.source?.rpcId === requestId);
  if (index < 0) return { found: false, completed: false, failed: false, latestUserSequence };
  let start = index;
  while (start >= 0 && events[start].type !== 'turn/start') start--;
  const turn = events[start]?.data?.turn;
  const endIndex = events.findIndex((e, i) => i > index && e.type === 'turn/end' && e.data?.turn === turn);
  const addressed = events.slice(index, endIndex < 0 ? undefined : endIndex + 1);
  const text = addressed.filter(e => e.type === 'assistant/message').map(e => plain(e.data?.message?.content)).filter(Boolean).join('\n\n');
  const end = endIndex >= 0 ? events[endIndex] : null;
  return { found: true, completed: end?.data?.reason?.kind === 'completed', failed: !!end && end.data?.reason?.kind !== 'completed',
    latestUserSequence, endSequence: end?.seq, text, reason: end?.data?.reason?.kind };
}
export function assertApproval(snapshot, body, progress) {
  const w = snapshot.workflow ?? snapshot.workItem.workflow;
  if (body.expectedVersion !== snapshot.workItem.version || w.phase !== 'AWAITING_PLAN_APPROVAL' ||
      body.planHash !== w.planHash || !progress.completed || progress.endSequence !== w.planEndSequence ||
      progress.latestUserSequence > w.planEndSequence) throw conflict('方案已更新，请刷新并重新确认');
}
export function baselineReproduced(operation) {
  const j = operation?.evidence?.junit;
  return operation?.state === 'FAILED' && operation.exitCode !== 0 && j?.tests === 2 && j.failures === 1 && j.errors === 0 && j.skipped === 0 &&
    (j.failedTests ?? []).some(name => name === 'maliciousInputReturnsNothing' || name.endsWith('.maliciousInputReturnsNothing'));
}
export function transcript(inspection) {
  return (inspection?.events ?? []).filter(e => ['user/message', 'assistant/message', 'tool/result', 'turn/end'].includes(e.type)).slice(-100).map(e => ({
    seq: e.seq, type: e.type, text: e.type === 'assistant/message' ? plain(e.data?.message?.content) : plain(e.data?.content) || e.data?.reason?.kind || '',
  }));
}
