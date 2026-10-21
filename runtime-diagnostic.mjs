import { writeFileSync } from 'node:fs';

export const name = 'mythos-runtime-diagnostic';
export const inject = ['agentPresets'];
export function apply(ctx) {
  const save = async () => {
    const fibers = [...ctx.registry.values()].flatMap(r => [...r.fibers].map(f => ({ name: f.name, state: f.state, inject: Object.keys(f.inject) })));
    const presets = (await ctx.agentPresets.list()).map(p => ({ id: p.id, name: p.name, broken: p.broken }));
    writeFileSync(new URL('./state/runtime-diagnostic.json', import.meta.url), JSON.stringify({ presets, fibers }, null, 2));
  };
  ctx.effect(() => {
    const timer = setInterval(() => { void save().catch(error => console.error('mythos diagnostic:', error.message)); }, 1000);
    return () => clearInterval(timer);
  });
}
