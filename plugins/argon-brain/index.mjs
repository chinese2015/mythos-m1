import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'argon-brain-tools';
export const inject = ['tools', 'argonBrain'];
const opParameter = { operationId: { type: 'string', required: true, description: 'operationId returned by execution_run in this Session.' } };
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
export const operationView = op => ({ operationId: op.operationId, workItemId: op.workItemId,
  state: op.state, kind: op.kind, sandboxId: op.runtime?.sandboxId ?? op.sandboxId, version: op.version,
  sourceCommit: op.evidence?.sourceCommit ?? op.sourceCommit, exitCode: op.exitCode, reason: op.reason,
  ...(op.evidence ? { junit: { tests: op.evidence.junit.tests, failures: op.evidence.junit.failures,
    errors: op.evidence.junit.errors, skipped: op.evidence.junit.skipped, invalidReports: op.evidence.junit.invalidReports },
    stdoutSha256: op.evidence.stdoutSha256, stderrSha256: op.evidence.stderrSha256 } : {}),
  ...(op.runtime?.cleanup ? { cleanup: op.runtime.cleanup } : {}),
});

export function apply(ctx, config) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.owner)) throw new Error('Operator-configured owner is required');
  const owner = config.owner;
  const identity = exec => {
    const sessionId = exec?.agent?.session?.header?.id;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('A real DSH Session is required');
    return sessionId;
  };
  const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({
    name, description, parameters, output, timeoutMs: 15000,
    async execute(args, exec) { return JSON.stringify(await execute(args, identity(exec), exec), null, 2); },
  }));
  register('execution_run',
    'Submit a durable asynchronous command in this Session sandbox. Returns operationId and actual recorded state; accepted/QUEUED is not completed. Use execution_status/follow. Stop Agent or plugin unload does not cancel accepted execution. After interruption inspect work_item_status before resubmitting with a new call.', {
      command: { type: 'string', required: true, description: 'Shell command executed as runner inside the configured sandbox.' },
      kind: { type: 'string', enum: ['COMMAND', 'UNIT_TEST', 'VERIFY'], description: 'VERIFY builds a fresh container from sourceCommit. Test kinds require new passing JUnit evidence.' },
      timeoutSeconds: { type: 'integer', description: 'Execution timeout: 1..3600 seconds. This is separate from tool/HTTP timeout.' },
      sourceCommit: { type: 'string', description: 'Full lowercase commit SHA; required for VERIFY. Only committed source is verified.' },
    }, async (args, sessionId, exec) => operationView(await ctx.argonBrain.run(owner, sessionId, args, exec)));
  register('execution_status', 'Read real execution state, exit code and evidence for an operation belonging to this Session.', opParameter,
    async (args, sessionId, exec) => operationView(await ctx.argonBrain.status(owner, sessionId, args.operationId, exec.signal)));
  register('execution_follow', 'Read a page of actual execution log previews. Resume with nextCursor. Full log bytes remain in M2; this tool previews at most 4096 characters per chunk.', {
    ...opParameter, after: { type: 'integer', description: 'Nonnegative log cursor, initially 0.' },
  }, async (args, sessionId, exec) => {
    const page = await ctx.argonBrain.follow(owner, sessionId, args.operationId, args.after ?? 0, exec.signal);
    return { ...page, logs: page.logs.map(log => ({ sequence: log.sequence, stream: log.stream, offset: log.offset,
      text: log.text.slice(0, 4096), previewTruncated: log.text.length > 4096 })) };
  });
  register('execution_cancel', 'Explicitly request cancellation of this Session execution. CANCEL_REQUESTED is not confirmed cancellation; use execution_status until terminal.', opParameter,
    async (args, sessionId, exec) => operationView(await ctx.argonBrain.cancel(owner, sessionId, args.operationId, exec)));
  register('work_item_status', 'Read the current Session Work Item and its operations. An unbound Session is reported without creating a task.', {},
    async (_args, sessionId, exec) => {
      const snapshot = await ctx.argonBrain.snapshot(owner, sessionId, exec.signal);
      if (!snapshot.bound) return snapshot;
      return { bound: true, workItem: snapshot.workItem, cursor: snapshot.cursor, operations: snapshot.operations.map(operationView) };
    });
  for (const paused of [true, false]) register(paused ? 'work_item_pause' : 'work_item_resume',
    paused ? 'Pause subsequent Work Item dispatch. Running executions continue; use execution_cancel to stop one.' :
      'Explicitly resume subsequent dispatch after pause or confirmed failure/cancellation. UNKNOWN sandbox quarantine remains.', {},
    (_args, sessionId, exec) => ctx.argonBrain.pause(owner, sessionId, paused, exec));
}
