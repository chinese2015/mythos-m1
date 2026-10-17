import { Context } from '@deepseek-ai/cordis';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fault } from './files.mjs';
import Policy from '@deepseek-ai/dsh-sandbox-policy';
import * as Projections from '@deepseek-ai/dsh-session-projection';
export async function readOnlyContext(workspacePath) {
  const ctx=new Context();
  try {
    await ctx.plugin(Projections.default??Projections);
    await ctx.plugin(Policy,{mode:'read-only',workspaceRoot:workspacePath});
    return ctx;
  } catch(error) { await ctx.fiber.dispose(); throw error; }
}
export class ReaderPool {
  constructor(create, limit = 8) { this.create = create; this.limit = limit; this.entries = new Map(); this.closed = false; }
  async open(key) {
    if (this.closed) throw fault('文件服务已卸载', 503);
    let entry = this.entries.get(key);
    if (!entry) {
      let eviction;
      if (this.entries.size >= this.limit) {
        const idle = [...this.entries].find(([, value]) => value.refs === 0);
        if (!idle) throw fault('文件连接繁忙，请稍后重试', 503);
        this.entries.delete(idle[0]); eviction = idle[1].promise.then(reader => reader.dispose());
      }
      entry = { refs: 0, promise: Promise.resolve().then(async () => { await eviction; if (this.closed) throw fault('文件服务已卸载', 503); return this.create(key); }) };
      this.entries.set(key, entry);
    }
    entry.refs++;
    let reader;
    try { reader = await entry.promise; } catch (error) { entry.refs--; if (this.entries.get(key) === entry) this.entries.delete(key); throw error; }
    if (this.closed) { entry.refs--; throw fault('文件服务已卸载', 503); }
    let released = false;
    return { fs: reader.fs, release: () => { if (!released) { released = true; entry.refs--; } } };
  }
  async dispose() {
    this.closed = true;
    const entries = [...this.entries.values()]; this.entries.clear();
    await Promise.allSettled(entries.map(async entry => (await entry.promise).dispose()));
  }
}
export function createSshReaders(config) {
  const specs = new Map();
  const pool = new ReaderPool(async key => {
    const { work, location } = specs.get(key);
    const provider = name => import(pathToFileURL(resolve(config.root, '../dsh-run/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
    const [{ default: Ssh }, { default: Fs }] = await Promise.all([provider('dsh-ssh'), provider('dsh-fs-ssh')]);
    const ctx = await readOnlyContext(location.workspacePath);
    try {
      await ctx.plugin(Ssh, { host: 'argon-' + work.sandboxId, node: '/usr/bin/node', helper: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', helperHash: config.helperHash, workspace: location.workspacePath });
      await ctx.plugin(Fs);
      if (!ctx.fs) throw fault('官方任务 SSH 文件服务未激活', 503);
      return { fs: ctx.fs, dispose: () => ctx.fiber.dispose() };
    } catch (error) { await ctx.fiber.dispose(); throw error; }
  });
  return {
    async open(work, location) {
      if (!/^sb-[a-z0-9-]+$/.test(work.sandboxId) || typeof location.workspacePath !== 'string' || !location.workspacePath.startsWith('/') || !config.helperHash) throw fault('任务 SSH 绑定不可用', 503);
      const key = work.sandboxId + ':' + location.workspacePath;
      specs.set(key, { work, location });
      try { return await pool.open(key); } finally { specs.delete(key); }
    },
    dispose: () => pool.dispose(),
  };
}
