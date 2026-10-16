// Agent-facing sandbox lifecycle tools for the M1 control plane.
// Every call is owner-bound: the owner comes from the session's argon-* preset,
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

const ownerOf = (exec) => {
  // SessionHeader.agentPreset is the durable preset id; never trust model input.
  const preset = exec?.agent?.session?.header?.agentPreset;
  const match = typeof preset === 'string' && /^argon-([a-z0-9][a-z0-9-]{0,63})$/.exec(preset);
  if (!match) throw new Error('sandbox tools are only available in an argon-<owner> preset session');
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

export const name = 'argon-sandboxctl';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'sandbox_create',
    description: 'Create an isolated Docker sandbox bound to you: fresh workspace, optional git clone, confined execution environment. Subject to per-owner quota (default 2).',
    parameters: {
      workspaceId: { type: 'string', required: true, description: 'Task label, e.g. nova-fix-2. Lowercase letters, digits, dashes.' },
      repoUrl: { type: 'string', description: 'Optional git URL to clone into the sandbox workspace (must be on the allowed list).' }
    },
    output: { schema: recordSchema, render: asText },
    timeoutMs: BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = ownerOf(exec);
      const argv = ['create', '--owner', owner, '--workspace', args.workspaceId];
      if (args.repoUrl) argv.push('--source', args.repoUrl);
      return broker(argv).then((r) => ({
        sandboxId: r.sandbox_id, ownerId: r.owner_id, workspaceId: r.workspace_id,
        workspacePath: r.workspace_path, state: r.state, containerName: r.container_name
      }));
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
      const owner = ownerOf(exec);
      const timeout = Math.min(args.timeoutMs ?? 60000, EXEC_TIMEOUT_MAX_MS);
      return broker(['exec', '--owner', owner, args.sandboxId, '--timeout', String(timeout / 1000), '--',
        'sh', '-c', args.command], timeout + BROKER_TIMEOUT_MS);
    }
  }));

  ctx.tools.register(defineTool({
    name: 'sandbox_stop',
    description: 'Stop your sandbox. Its container is removed; the registry record stays for audit.',
    parameters: { ...sandboxIdParam },
    output: { schema: recordSchema, render: asText },
    timeoutMs: BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = ownerOf(exec);
      return broker(['stop', '--owner', owner, args.sandboxId]).then((r) => ({
        sandboxId: r.sandbox_id, ownerId: r.owner_id, workspaceId: r.workspace_id,
        workspacePath: r.workspace_path, state: r.state, containerName: r.container_name
      }));
    }
  }));

  ctx.tools.register(defineTool({
    name: 'sandbox_status',
    description: 'Show your sandbox record(s): state, workspace path, container. Without sandboxId, lists all sandboxes owned by you.',
    parameters: { sandboxId: { type: 'string', description: sandboxIdParam.sandboxId.description + ' Omit to list all sandboxes owned by you.' } },
    output: { schema: { type: 'json' }, render: asText },
    timeoutMs: BROKER_TIMEOUT_MS,
    execute(args, exec) {
      const owner = ownerOf(exec);
      const argv = ['status', '--owner', owner];
      if (args.sandboxId) argv.push(args.sandboxId);
      return broker(argv);
    }
  }));
}
