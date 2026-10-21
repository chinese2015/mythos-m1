import { Service } from '@deepseek-ai/cordis';
import { SdlcController } from './controller.mjs';
export const name = 'mythos-sdlc';
export const inject = ['mythosWorkflow'];
class SdlcService extends Service {
  constructor(ctx, config) {
    super(ctx, 'mythosSdlc');
    this.controller = new SdlcController(config, { workflow: ctx.mythosWorkflow.controller, report: (e, id) => ctx.logger.warn('Mythos SDLC ' + id + ': ' + e.message) });
    ctx.effect(() => { const timer = setInterval(() => { void this.controller.tick().catch(e => ctx.logger.warn('Mythos SDLC: ' + e.message)); }, 1500);
      return async () => { clearInterval(timer); await this.controller.dispose(); }; });
  }
}
export function apply(ctx, config) { new SdlcService(ctx, config); }
