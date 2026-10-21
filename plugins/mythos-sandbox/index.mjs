// Agent-facing sandbox lifecycle tools for the M1 control plane.
// Every call is owner-bound: the owner comes from the session's mythos-* preset,
// never from model-supplied arguments, and the broker re-checks ownership anyway.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PYTHON = '/usr/bin/python3';
const BROKER = new URL('../../sandbox.py', import.meta.url).pathname;
const BROKER_TIMEOUT_MS = 15000;
const EXEC_TIMEOUT_MAX_MS = 120000;

const broker = (argv, timeoutMs = BROKER_TIMEOUT_MS) =>
  run(PYTHON, [BROKER, ...argv], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    .then((result) => JSON.parse(result.stdout));

// Owner resolution: the operator-controlled preset config is authoritative.
// SessionHeader.agentPreset is only a fallback because Web UI created sessions
// have been observed to record 'standard' there even when the mythos preset
// composed the session's tools.
const ownerOf = (exec, configured) => {
  if (typeof configured === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(configured)) return configured;
  const preset = exec?.agent?.session?.header?.agentPreset;
  const match = typeof preset === 'string' && /^mythos-([a-z0-9][a-z0-9-]{0,63})$/.exec(preset);
  if (!match) throw new Error('sandbox tools are only available in an mythos-<owner> preset session');
  return match[1];
};

const asText = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
const recordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sandboxId: { type: 'string' },
    ownerId: { type: 'string' },
    workspaceId: { type: 'string' },
    workspacePath: { type: 'string' },
    state: { type: 'string' },
    containerName: { type: 'string' }
  }
};
const sandboxIdParam = { sandboxId: { type: 'string', required: true, description: 'The sandboxId returned by sandbox_create' } };

export const name = 'mythos-sandboxctl';
export const inject = ['tools'];
export function apply(ctx, config = {}) {
  const resolveOwner = (exec) => ownerOf(exec, config.owner);
  ctx.tools.register(defineTool({
    name: 'sandbox_create',
    description: 'Create an isolated Docker sandbox bound to you: fresh workspace, optional git clone, confined execution environment. Subject to per-owner quota (default 2).',
    parameters: {
      workspaceId: { type: 'string', required: true, description: 'Task label, e.g. nova-fix-2. Lowercase letters, digits, dashes.' },
      repoUrl: { type: 'string', description: 'Optional git URL to clone into the sandbox workspace (must be on the allowed list).' }
    },
    output: { schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = resolveOwner(exec);
      const argv = ['create', '--owner', owner, '--workspace', args.workspaceId];
      if (args.repoUrl) argv.push('--source', args.repoUrl);
      return broker(argv).then((r) => JSON.stringify({
        sandboxId: r.sandbox_id, ownerId: r.owner_id, workspaceId: r.workspace_id,
        workspacePath: r.workspace_path, state: r.state, containerName: r.container_name
      }, null, 2));
    }
  }));

  ctx.tools.register(defineTool({
    name: 'sandbox_exec',
    description: 'Run a shell command inside your sandbox and return its real stdout/stderr/exitCode. Commands run as the sandbox user in the sandbox workspace. Note: killing a timed-out call does not guarantee the in-container process stopped.',
    parameters: {
      ...sandboxIdParam,
      command: { type: 'string', required: true, description: 'Shell command to run in the sandbox workspace.' },
      timeoutMs: { type: 'number', description: `Per-call timeout in milliseconds, max ${EXEC_TIMEOUT_MAX_MS}.` }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' }
        }
      },
      render: (_args, value) => asText({ ...value, note: value.exitCode === 0 ? undefined : `exit code: ${value.exitCode}` })
    },
    timeoutMs: EXEC_TIMEOUT_MAX_MS + BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = resolveOwner(exec);
      const timeout = Math.min(args.timeoutMs ?? 60000, EXEC_TIMEOUT_MAX_MS);
      // argparse.REMAINDER swallows everything after the positional sandbox_id,
      // so every optional flag must precede it.
      return broker(['exec', '--owner', owner, '--timeout', String(timeout / 1000), args.sandboxId, '--',
        'sh', '-c', args.command], timeout + BROKER_TIMEOUT_MS);
    }
  }));

  ctx.tools.register(defineTool({
    name: 'sandbox_stop',
    description: 'Stop your sandbox. Its container is removed; the registry record stays for audit.',
    parameters: { ...sandboxIdParam },
    output: { schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = resolveOwner(exec);
      return broker(['stop', '--owner', owner, args.sandboxId]).then((r) => JSON.stringify({
        sandboxId: r.sandbox_id, ownerId: r.owner_id, workspaceId: r.workspace_id,
        workspacePath: r.workspace_path, state: r.state, containerName: r.container_name
      }, null, 2));
    }
  }));

  ctx.tools.register(defineTool({
    name: 'sandbox_status',
    description: 'Show your sandbox record(s): state, workspace path, container. Without sandboxId, lists all sandboxes owned by you.',
    parameters: { sandboxId: { type: 'string', description: sandboxIdParam.sandboxId.description + ' Omit to list all sandboxes owned by you.' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    timeoutMs: BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = resolveOwner(exec);
      const argv = ['status', '--owner', owner];
      if (args.sandboxId) argv.push(args.sandboxId);
      return broker(argv)
        .then((result) => ({ records: Array.isArray(result) ? result : [result] }))
        .then((value) => JSON.stringify(value, null, 2));
    }
  }));
}
