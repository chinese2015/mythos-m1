import { Service } from '@deepseek-ai/cordis';
import { SubscribeController } from './service.mjs';
export const name = 'argon-subscribe';
class SubscribeService extends Service {
  constructor(ctx, config) {
    super(ctx, 'argonSubscribe');
    this.controller = new SubscribeController(config, { report: (error, id) => ctx.logger?.warn('Argon intake ' + id + ': ' + error.message) });
    ctx.effect(() => async () => { await this.controller.dispose(); });
  }
}
export function apply(ctx, config) { new SubscribeService(ctx, config); }
