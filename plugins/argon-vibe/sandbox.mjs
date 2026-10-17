// Read-only sandbox file sessions: one dsh-fs-ssh context per sandboxId, LRU-evicted.
// The SSH packages only exist on the deployment host; imports stay lazy so the
// handler module and its unit tests load anywhere.
const failure = (message, code) => Object.assign(new Error(message), { code });

async function createSandboxFs(sandboxId, workspaceRoot, ssh) {
  const [{ Context }, Projections, Ssh, Fs, Policy] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/dsh-ssh'),
    import('@deepseek-ai/dsh-fs-ssh'),
    import('@deepseek-ai/dsh-sandbox-policy'),
  ]);
  const ctx = new Context();
  try {
    await ctx.plugin(Projections.default ?? Projections);
    await ctx.plugin(Ssh.default ?? Ssh, {
      host: 'argon-' + sandboxId, node: ssh.node ?? '/usr/bin/node',
      helper: ssh.helper ?? '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
      ...(ssh.helperHash ? { helperHash: ssh.helperHash } : {}),
      workspace: workspaceRoot,
    });
    await ctx.plugin(Policy.default ?? Policy, { mode: 'read-only', workspaceRoot });
    await ctx.plugin(Fs.default ?? Fs);
    return { fs: ctx.fs, dispose: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose().catch(() => {});
    throw failure('沙箱文件服务不可用：' + (error?.message ?? String(error)), 'SANDBOX_UNAVAILABLE');
  }
}

export function makeSandboxOpener({ ssh = {}, maxSessions = 8, idleTtlMs = 60000 } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) throw new Error('Invalid sandbox session cap');
  const live = new Map();
  let disposed = false;
  const evict = async (sandboxId) => {
    const entry = live.get(sandboxId);
    if (!entry) return;
    live.delete(sandboxId);
    clearTimeout(entry.timer);
    await entry.dispose().catch(() => {});
  };
  const open = async (sandboxId, workspaceRoot) => {
    if (disposed) throw failure('沙箱文件服务已关闭', 'SANDBOX_UNAVAILABLE');
    if (!/^sb-[a-z0-9-]+$/.test(sandboxId)) throw failure('沙箱标识无效', 'SANDBOX_UNAVAILABLE');
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.startsWith('/')) throw failure('沙箱工作区路径无效', 'SANDBOX_UNAVAILABLE');
    const existing = live.get(sandboxId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => { void evict(sandboxId); }, idleTtlMs);
      return existing.fs;
    }
    const created = await createSandboxFs(sandboxId, workspaceRoot, ssh);
    if (live.size >= maxSessions) await evict(live.keys().next().value);
    live.set(sandboxId, { fs: created.fs, dispose: created.dispose, timer: setTimeout(() => { void evict(sandboxId); }, idleTtlMs) });
    return created.fs;
  };
  open.dispose = async () => {
    disposed = true;
    for (const sandboxId of [...live.keys()]) await evict(sandboxId);
  };
  return open;
}
