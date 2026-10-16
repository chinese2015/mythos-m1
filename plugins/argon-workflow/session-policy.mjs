import { Service } from '@deepseek-ai/cordis';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const allowed = new Set(['read', 'read_image', 'glob', 'grep']);
export const readonlyGuard = exec => allowed.has(exec.name) ? undefined : 'Task planning is read-only until human plan approval';
export const name = 'argon-task-policy';
export const inject = ['tools'];
export function apply(ctx, config) {
  ctx.tools.restrict({ allow: [] });
  // A task's immutable role policy does not accept native UI mode overrides.
  class TaskPolicy extends Service {
    constructor() { super(ctx, 'sandboxPolicy'); }
    resolve() { return { mode: config.role === 'PLAN' ? 'read-only' : 'workspace-write', workspaceRoot: config.workspacePath }; }
    overrideOf() { return undefined; }
  }
  new TaskPolicy();
  if (config.role === 'PLAN') ctx.tools.guard(readonlyGuard);
}
export function taskPreset(work, role, config) {
  if (!['PLAN', 'CODE'].includes(role) || !/^sb-[a-z0-9-]+$/.test(work.sandboxId) || !/^work-[0-9a-f]{32}$/.test(work.workItemId)) throw new Error('Invalid task preset binding');
  const root = config.root;
  const plugins = [
    { id: 'policy', name: here + 'session-policy.mjs', config: { role, workspacePath: config.workspacePath } },
    { id: 'ssh', name: '@deepseek-ai/dsh-ssh', config: { host: 'argon-' + work.sandboxId, node: '/usr/bin/node',
      helper: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', helperHash: config.helperHash, workspace: config.workspacePath } },
    { id: 'fs', name: '@deepseek-ai/dsh-fs-ssh' }, { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-ssh' },
    { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-ssh' },
    { id: 'files', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  ];
  if (role === 'CODE') plugins.push(
    { id: 'bash', name: '@deepseek-ai/dsh-bash-sandbox', config: { cwd: config.workspacePath, timeoutMs: 60000 } },
    { id: 'commands', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'brain', name: root + '/plugins/argon-brain/index.mjs', config: { owner: work.ownerId } },
  );
  return { id: 'argon-task-' + work.workItemId.slice(5) + '-' + role.toLowerCase(), name: work.source?.id + ' · ' + (role === 'PLAN' ? '只读计划' : '编码'),
    description: 'Task-owned ' + role + ' session', plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
        prefix: 'You are the coding agent for a human-approved Argon task. Work only in the provided task sandbox. Respond in Chinese.',
        suffix: role === 'PLAN' ? 'This is a read-only planning session. Read source and tests, explain the defect, propose the minimal change and validation. Do not modify files or ask for broader tools. Finish with a concrete plan for human approval.' :
          'Implement the approved plan using native file and Bash tools. Do not modify tests, POM, or build configuration, read reference fixes, or access credentials. Commit your actual source change. Use execution_run/status/follow for recorded tests; a queued execution is not a passing test. The workflow will perform independent clean verification.' } },
      { id: 'execution', name: 'cordis:group', group: true,
        isolate: Object.fromEntries(['fs', 'subprocess', 'ssh', 'sandbox', 'shell', 'sandboxPolicy'].map(k => [k, true])), config: plugins },
    ] };
}
