import { Service } from '@deepseek-ai/cordis';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const here = fileURLToPath(new URL('.', import.meta.url));
const allowed = new Set(['read', 'read_image', 'glob', 'grep']);
const codeTools = new Set([...allowed, 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill', 'execution_run', 'execution_status', 'execution_follow', 'execution_cancel', 'work_item_status', 'work_item_pause', 'work_item_resume']);
export const readonlyGuard = exec => allowed.has(exec.name) ? undefined : 'Task planning is read-only until human plan approval';
export const name = 'mythos-task-policy';
export const inject = ['tools', 'mythosWorkflow'];
export function bindTaskAgent(agent, controller, workId, role) {
  const originals = new Map();
  for (const method of ['followup', 'steer']) {
    const original = agent[method];
    if (typeof original !== 'function') continue;
    const wrapped = function (...args) {
      const reason = controller.inputRejection(workId, role, agent.id);
      if (reason) throw new Error(reason);
      return original.apply(this, args);
    };
    agent[method] = wrapped; originals.set(method, { original, wrapped });
  }
  return () => { for (const [method, { original, wrapped }] of originals) if (agent[method] === wrapped) agent[method] = original; };
}
export function apply(ctx, config) {
  // A task's immutable role policy does not accept native UI mode overrides.
  class TaskPolicy extends Service {
    constructor() { super(ctx, 'sandboxPolicy'); }
    resolve(request = {}) {
      const controller = ctx.mythosWorkflow.controller, work = controller.workState.get(config.workId);
      const writable = config.role === 'CODE' && work?.workflow.phase === 'CODING' && !work.paused && !controller.closed;
      return { mode: writable ? 'workspace-write' : 'read-only', workspaceRoot: config.workspacePath, ...(request.session ? { sessionId: request.session.id } : {}) };
    }
    overrideOf() { return undefined; }
  }
  new TaskPolicy();
  ctx.inject(['systemPrompt'], scope => scope.systemPrompt.context({ name: 'mythos:task-policy', order: 999,
    text: () => config.role === 'PLAN' ? 'Task planning is strictly read-only: only read/read_image/glob/grep may run. Human approval creates a separate coding session.' : 'This is the approved task coding session. All tools operate in the task container.' }));
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => bindTaskAgent(agent, ctx.mythosWorkflow.controller, config.workId, config.role));
  });
  if (config.role === 'PLAN') ctx.tools.guard(readonlyGuard);
  else ctx.tools.guard(exec => !codeTools.has(exec.name) ? 'This tool is outside the task coding capabilities' : allowed.has(exec.name) ? undefined :
    ctx.mythosWorkflow.controller.inputRejection(config.workId, config.role, exec.agent?.id));
}
export function taskPreset(work, role, config) {
  if (!['PLAN', 'CODE'].includes(role) || !/^sb-[a-z0-9-]+$/.test(work.sandboxId) || !/^work-[0-9a-f]{32}$/.test(work.workItemId)) throw new Error('Invalid task preset binding');
  const root = config.root;
  const provider = name => resolve(root, '../dsh-run/node_modules/@deepseek-ai', name, 'lib/index.js');
  const plugins = [
    { id: 'policy', name: here + 'session-policy.mjs', config: { workId: work.workItemId, role, workspacePath: config.workspacePath } },
    { id: 'ssh', name: provider('dsh-ssh'), config: { host: 'mythos-' + work.sandboxId, node: '/usr/bin/node',
      helper: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', helperHash: config.helperHash, workspace: config.workspacePath } },
    { id: 'fs', name: provider('dsh-fs-ssh') }, { id: 'subprocess', name: provider('dsh-subprocess-ssh') },
    { id: 'sandbox', name: provider('dsh-sandbox-ssh') },
    { id: 'files', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'search', name: here + 'search.mjs', config: { sampleOverCapGlobResults: false } },
  ];
  if (role === 'CODE') plugins.push(
    { id: 'bash', name: '@deepseek-ai/dsh-bash-sandbox', config: { cwd: config.workspacePath, timeoutMs: 60000 } },
    { id: 'commands', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'brain', name: root + '/plugins/mythos-brain/index.mjs', config: { owner: work.ownerId } },
  );
  return { id: 'mythos-task-' + work.workItemId.slice(5) + '-' + role.toLowerCase(), name: work.source?.id + ' · ' + (role === 'PLAN' ? 'Read-only plan' : 'Coding'),
    description: 'Task-owned ' + role + ' session', plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
        prefix: 'You are the coding agent for a human-approved Mythos task. Work only in the provided task sandbox.',
        suffix: role === 'PLAN' ? 'This is a read-only planning session. Read source and tests, explain the defect, propose the minimal change and validation. Do not modify files or ask for broader tools. Finish with a concrete plan for human approval.' :
          'Implement the approved plan using native file and Bash tools. Do not modify tests, POM, or build configuration, read reference fixes, or access credentials. Commit your actual source change. Use execution_run/status/follow for recorded tests; a queued execution is not a passing test. The workflow will perform independent clean verification.' } },
      { id: 'execution', name: 'cordis:group', group: true,
        isolate: Object.fromEntries(['fs', 'subprocess', 'ssh', 'sandbox', 'shell', 'sandboxPolicy'].map(k => [k, true])), config: plugins },
    ] };
}
