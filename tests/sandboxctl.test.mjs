import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../plugins/mythos-sandbox/index.mjs';

const stubCtx = () => {
  const registered = [];
  return { registered, ctx: { tools: { register: (tool) => registered.push(tool) } } };
};
const execAs = (preset) => ({ agent: { session: { header: { agentPreset: preset } } }, callId: 'call-1', signal: new AbortController().signal });
const byName = (registered, name) => registered.find((tool) => tool.name === name);

test('registers the four sandbox tools', () => {
  const { registered, ctx } = stubCtx();
  apply(ctx);
  assert.deepEqual(registered.map((tool) => tool.name).sort(),
    ['sandbox_create', 'sandbox_exec', 'sandbox_status', 'sandbox_stop']);
});

test('rejects a session without an mythos preset before touching the broker', async () => {
  const { registered, ctx } = stubCtx();
  apply(ctx);
  const status = byName(registered, 'sandbox_status');
  await assert.rejects(() => status.execute({}, execAs('standard')),
    /mythos-<owner> preset/);
  await assert.rejects(() => status.execute({}, execAs(undefined)),
    /mythos-<owner> preset/);
});

test('an mythos preset session passes owner resolution', async () => {
  const { registered, ctx } = stubCtx();
  apply(ctx);
  const status = byName(registered, 'sandbox_status');
  // Redirect the broker root so the CLI is hermetic on any machine.
  const previous = process.env.HOME;
  process.env.HOME = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp('/tmp/mythos-sandboxctl-test-'));
  try {
    const text = await status.execute({}, execAs('mythos-alice'));
    const parsed = JSON.parse(text);
    assert.ok(Array.isArray(parsed.records), 'owner resolution passed and broker returned a list');
  } finally {
    process.env.HOME = previous;
  }
});

test('parameter validation happens before owner resolution', async () => {
  const { registered, ctx } = stubCtx();
  apply(ctx);
  const exec = byName(registered, 'sandbox_exec');
  await assert.rejects(() => exec.execute({ sandboxId: 'sb-x' }, execAs('mythos-alice')));
});
