import { Service } from '@deepseek-ai/cordis';
import { SubscribeController } from './service.mjs';
export const name = 'mythos-subscribe';
class SubscribeService extends Service {
  constructor(ctx, config) {
    super(ctx, 'mythosSubscribe');
    this.controller = new SubscribeController(config, { report: (error, id) => ctx.logger?.warn('Mythos intake ' + id + ': ' + error.message) });
    ctx.effect(() => {
      const sync = () => { void this.controller.syncOnce().catch(error => ctx.logger?.warn('Mythos subscription: ' + error.message)); };
      const timer = setInterval(sync, config.pollIntervalMs ?? 30000);
      return async () => { clearInterval(timer); await this.controller.dispose(); };
    });
  }
}
export function apply(ctx, config) { new SubscribeService(ctx, config); }
