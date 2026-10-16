import { Service } from '@deepseek-ai/cordis';
import { BrainBridge } from './bridge.mjs';

export const name = 'argon-brain-service';
export const inject = ['sessionController', 'workspaceRegistry'];

class ArgonBrain extends Service {
  constructor(ctx, config) {
    super(ctx, 'argonBrain');
    this.bridge = new BrainBridge(config, {
      sessions: ctx.sessionController, workspaces: ctx.workspaceRegistry,
      emit: (topic, event) => ctx.parallel(topic, event),
    });
    const interval = config.pollIntervalMs ?? 1000;
    if (!Number.isInteger(interval) || interval < 100 || interval > 30000) throw new Error('Invalid polling interval');
    ctx.effect(() => {
      void this.bridge.tick();
      const timer = setInterval(() => { void this.bridge.tick(); }, interval);
      return async () => { clearInterval(timer); await this.bridge.dispose(); };
    });
  }
  snapshot(...args) { return this.bridge.snapshot(...args); }
  run(...args) { return this.bridge.run(...args); }
  status(...args) { return this.bridge.status(...args); }
  follow(...args) { return this.bridge.follow(...args); }
  cancel(...args) { return this.bridge.cancel(...args); }
  pause(...args) { return this.bridge.pause(...args); }
  prepareSession(...args) { return this.bridge.prepareSession(...args); }
  promptSession(...args) { return this.bridge.promptSession(...args); }
}

export function apply(ctx, config) { new ArgonBrain(ctx, config); }
