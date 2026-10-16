import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, displayState, formatJUnit, formatEvent, staleNote } from '../plugins/argon-console/public/monitor-state.js';

test('mergeEvents dedupes overlapping sequences and sorts ascending', () => {
  const existing = [{ sequence: 1, type: 'execution.queued' }, { sequence: 3, type: 'execution.started' }];
  const page = { events: [{ sequence: 2, type: 'execution.starting' }, { sequence: 3, type: 'execution.started' }], nextCursor: 3 };
  const merged = mergeEvents(existing, page);
  assert.deepEqual(merged.events.map(e => e.sequence), [1, 2, 3]);
  assert.equal(merged.events.length, 3);
  assert.equal(merged.cursor, 3);
});

test('mergeEvents keeps the previous cursor on an empty page', () => {
  const merged = mergeEvents([{ sequence: 5, type: 'execution.output' }], { events: [], nextCursor: 5 });
  assert.equal(merged.events.length, 1);
  assert.equal(merged.cursor, 5);
});

test('mergeEvents falls back to the last sequence when nextCursor is missing', () => {
  const merged = mergeEvents([], { events: [{ sequence: 4, type: 'execution.failed' }] });
  assert.equal(merged.cursor, 4);
  const empty = mergeEvents([], {});
  assert.equal(empty.cursor, 0);
  assert.deepEqual(empty.events, []);
});

test('displayState keeps cancel-requested distinct from cancelled and unknown explained', () => {
  const requested = displayState('CANCEL_REQUESTED');
  assert.match(requested.label, /等待进程终止/);
  assert.equal(requested.cls, 'cancel-pending');
  const cancelled = displayState('CANCELLED');
  assert.equal(cancelled.label, '已取消');
  assert.notEqual(requested.label, cancelled.label);
  const unknown = displayState('UNKNOWN');
  assert.match(unknown.label, /未自动重放/);
  assert.equal(unknown.cls, 'unknown');
  assert.equal(displayState('SOMETHING_NEW').label, 'SOMETHING_NEW');
  assert.equal(displayState('').cls, 'unknown');
});

test('displayState maps known terminal and active states', () => {
  assert.deepEqual(displayState('SUCCEEDED'), { label: '已完成', cls: 'succeeded' });
  assert.deepEqual(displayState('FAILED'), { label: '失败', cls: 'failed' });
  assert.equal(displayState('RUNNING').label, '运行中');
  assert.equal(displayState('QUEUED').label, '排队中');
});

test('formatJUnit renders counts or null', () => {
  assert.equal(formatJUnit({ tests: 2, failures: 1, errors: 0 }), 'JUnit：2 项 · 1 失败 · 0 错误');
  assert.equal(formatJUnit(null), null);
  assert.equal(formatJUnit({}), null);
});

test('formatEvent folds execution.output away and details failures', () => {
  assert.equal(formatEvent({ type: 'execution.output', sequence: 3 }), null);
  const failed = formatEvent({ type: 'execution.failed', occurredAt: '2026-10-17T08:00:00Z', payload: { exitCode: 23, reason: 'boom' }, correlation: { operationId: 'exec-a' } }, opId => '验证');
  assert.match(failed, /exitCode 23/);
  assert.match(failed, /boom/);
  assert.match(failed, /验证/);
  const requested = formatEvent({ type: 'execution.cancel_requested', occurredAt: '2026-10-17T08:00:01Z' });
  assert.match(requested, /已请求取消/);
  const ready = formatEvent({ type: 'workspace.ready', occurredAt: '2026-10-17T08:00:02Z' });
  assert.match(ready, /工作区就绪/);
  const odd = formatEvent({ type: 'mystery.event', occurredAt: '2026-10-17T08:00:03Z' });
  assert.match(odd, /mystery\.event/);
});

test('staleNote reports seconds-old snapshots or nothing', () => {
  assert.equal(staleNote(null), null);
  const note = staleNote(Date.now() - 9000);
  assert.match(note, /连接中断/);
  assert.match(note, /9 秒前/);
});

test('shouldAutoExpand honors a manual collapse for active operations', async () => {
  const { shouldAutoExpand } = await import('../plugins/argon-console/public/monitor-state.js');
  assert.equal(shouldAutoExpand(true, false), true);
  assert.equal(shouldAutoExpand(true, true), false);
  assert.equal(shouldAutoExpand(false, false), false);
});
