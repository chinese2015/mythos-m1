import { Service } from '@deepseek-ai/cordis';
import { TaskWorkflow } from './controller.mjs';
export const name = 'mythos-workflow';
export const inject = ['sessionController', 'workspaceRegistry', 'agentPresets', 'mythosBrain'];
class WorkflowService extends Service {
  constructor(ctx, config) {
    super(ctx, 'mythosWorkflow');
    this.controller = new TaskWorkflow(config, { sessions: ctx.sessionController, workspaces: ctx.workspaceRegistry, presets: ctx.agentPresets,
      report: (error, id) => ctx.logger?.warn('Mythos workflow ' + id + ': ' + error.message) });
    ctx.effect(() => {
      // Register dynamic presets after host activation has settled (Loader.await is reentrant).
      const timer = setInterval(() => { void this.controller.tick().catch(error => ctx.logger?.warn('Mythos workflow: ' + error.message)); }, config.pollIntervalMs ?? 1800);
      return async () => { clearInterval(timer); await this.controller.dispose(); };
    });
  }
}
export function apply(ctx, config) { new WorkflowService(ctx, config); }
