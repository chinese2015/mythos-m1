import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as Search from '../plugins/argon-workflow/search.mjs';
test('native glob uses container ripgrep through SSH while retaining native no-config argv and result parsing', async () => {
  const ctx = new Context(), spawns = [];
  class Subprocess extends Service {
    constructor() { super(ctx, 'subprocess'); }
    spawn(request) {
      spawns.push(request);
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {
        stdout: { readFrom: () => ({ text: 'src/Fix.java\n', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) },
      } };
    }
  }
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); new Subprocess();
    await Search.apply(ctx, { sampleOverCapGlobResults: false, globMaxResults: 100, grepMaxMatches: 250, grepMaxLineBytes: 2000,
      searchMetaMaxBytes: 2000, rawOutputMaxBytes: 100000, graceMs: 100, stderrMaxBytes: 2000, timeoutMs: 1000 });
    const result = await ctx.tools.execute({ name: 'glob', arguments: { pattern: '**/*.java' }, callId: 'container-glob', signal: new AbortController().signal });
    assert.equal(spawns.length, 1); assert.equal(spawns[0].argv[0], '/usr/bin/rg'); assert.equal(spawns[0].argv[1], '--no-config');
    assert.match(JSON.stringify(result), /src\/Fix.java/);
  } finally { await ctx.fiber.dispose(); }
});
