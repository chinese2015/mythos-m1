// Preserve native Host change capture for ordinary sessions only.
// Sandbox sessions use native inline edit diffs and Git diff inside the container.
import * as Native from '@deepseek-ai/dsh-workspace-changes';
import { guardSessionEvents } from './change-boundary.mjs';

export const name = 'argon-safe-host-changes';
export const Config = Native.Config;
export const inject = Native.inject;

export function apply(ctx, config) {
  const filtered = ctx.extend();
  Object.defineProperty(filtered, 'on', {
    value(event, callback) {
      return ctx.on(event, event === 'session/event' ? guardSessionEvents(callback) : callback);
    },
  });
  return Native.apply(filtered, config);
}
