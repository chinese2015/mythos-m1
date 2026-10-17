import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalFs from '@deepseek-ai/dsh-fs-local';
import { TaskFiles } from '../plugins/argon-coding/files.mjs';
import { ReaderPool } from '../plugins/argon-coding/ssh.mjs';
import * as sshReaders from '../plugins/argon-coding/ssh.mjs';

const id = 'work-' + 'a'.repeat(32);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'argon-coding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'); await mkdir(join(remote, 'src'), { recursive: true });
  await writeFile(join(remote, 'src/Fix.java'), 'REMOTE workspace\nsecond line\n');
  await writeFile(join(root, 'Fix.java'), 'HOST same basename');
  const ctx = new Context(); await ctx.plugin(LocalFs, { cwd: remote }); t.after(() => ctx.fiber.dispose());
  let snapshots = 0, opens = 0;
  const work = { workItemId: id, ownerId: 'alice', sandboxId: 'sb-test' };
  const workflow = { snapshot: async target => { snapshots++; if (target !== id) throw Object.assign(new Error('not owned'), { status: 404 }); return { workItem: work }; }, workspace: async () => ({ workspacePath: remote }) };
  const files = new TaskFiles({ workflow, openFs: async () => { opens++; return { fs: ctx.fs }; } });
  return { files, root, remote, fs: ctx.fs, work, workflow, get opens() { return opens; }, get snapshots() { return snapshots; } };
}
test('reads only the task provider and emits stable relative content identity', async t => {
  const f = await fixture(t), file = await f.files.read(id, 'src/Fix.java');
  assert.equal(file.text, 'REMOTE workspace\nsecond line\n'); assert.equal(file.path, 'src/Fix.java'); assert.equal(file.lines, 2);
  assert.match(file.contentHash, /^sha256:[0-9a-f]{64}$/); assert.equal(file.eof, true); assert.equal('absolutePath' in file, false);
  const list = await f.files.list(id, 'src'); assert.equal(list.entries[0].name, 'Fix.java'); assert.equal('target' in list.entries[0], false);
  assert.equal(f.snapshots, 2);
});
test('rejects unowned, unprepared, invalid paths and symlink parents before content access', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.files.read('other', 'src/Fix.java'), { status: 404 }); assert.equal(f.opens, 0);
  for (const path of ['../Fix.java', '/etc/passwd', 'src\\Fix.java', '.git/config', 'src/../Fix.java', 'src//Fix.java', 'src/\0x']) await assert.rejects(() => f.files.read(id, path), { status: 400 });
  await symlink(f.root, join(f.remote, 'escape'));
  await symlink(join(f.remote, 'src/Fix.java'), join(f.remote, 'alias'));
  for (const path of ['escape/Fix.java', 'alias']) await assert.rejects(() => f.files.read(id, path), { status: 403 });
  f.work.sandboxId = null; await assert.rejects(() => f.files.list(id, ''), { status: 409 });
});
test('refuses binary, oversized and non-regular content without truncating it into a valid file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.remote, 'binary'), Buffer.from([0,1,255]));
  await writeFile(join(f.remote, 'large'), 'x'.repeat(512*1024+1));
  await writeFile(join(f.remote, 'many'), 'x\n'.repeat(16001));
  await assert.rejects(() => f.files.read(id, 'binary'), { status: 415 });
  await assert.rejects(() => f.files.read(id, 'large'), { status: 413 });
  await assert.rejects(() => f.files.read(id, 'many'), { status: 413 });
  await assert.rejects(() => f.files.read(id, 'src'), { status: 415 });
  await assert.rejects(() => f.files.read(id, 'absent'), { status: 404 });
});
test('a concurrent real rewrite is a conflict and a cancelled request never returns content', async t => {
  const f = await fixture(t), read = f.fs.streamText.bind(f.fs);
  f.fs.streamText = async (...args) => { const stream = await read(...args); return (async function* () { for await (const chunk of stream) { yield chunk; await writeFile(join(f.remote, 'src/Fix.java'), 'changed after read, longer\n'); } })(); };
  await assert.rejects(() => f.files.read(id, 'src/Fix.java'), { status: 409 });
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => f.files.read(id, 'src/Fix.java', controller.signal), { name: 'AbortError' });
});
test('reader pool shares concurrent acquisitions, evicts only idle readers and closes on unload', async () => {
  const disposed = [];
  const pool = new ReaderPool(async key => ({ fs: { key }, dispose: async () => disposed.push(key) }), 1);
  const [a,b] = await Promise.all([pool.open('a'), pool.open('a')]); assert.equal(a.fs, b.fs);
  await assert.rejects(() => pool.open('b'), { status: 503 });
  a.release(); b.release(); const c = await pool.open('b'); assert.deepEqual(disposed, ['a']);
  c.release(); await pool.dispose(); assert.deepEqual(disposed, ['a','b']); await assert.rejects(() => pool.open('c'), { status: 503 });
});
test('an asynchronous eviction reserves capacity before a different reader can race it', async () => {
  let finish;
  const disposing = new Promise(resolve => { finish = resolve; });
  const pool = new ReaderPool(async key => ({ fs: { key }, dispose: async () => { if (key === 'a') await disposing; } }), 1);
  const a = await pool.open('a'); a.release();
  const b = pool.open('b');
  let c; try { c = await pool.open('c'); } catch (error) { assert.equal(error.status, 503); }
  finish(); const selected = await b;
  assert.equal(c, undefined);
  selected.release(); await pool.dispose();
});
test('task reader composition provides the official read-only policy required by SSH fs', async () => {
  const ctx=await sshReaders.readOnlyContext('/task/workspace');
  try { assert.equal(ctx.sandboxPolicy.resolve().mode,'read-only'); assert.equal(ctx.sandboxPolicy.workspaceRoot,'/task/workspace'); }
  finally { await ctx.fiber.dispose(); }
});
