import { Context } from '@deepseek-ai/cordis';
import Ssh from '@deepseek-ai/dsh-ssh';
import Fs from '@deepseek-ai/dsh-fs-ssh';
import Subprocess from '@deepseek-ai/dsh-subprocess-ssh';
import Sandbox from '@deepseek-ai/dsh-sandbox-ssh';
import Policy from '@deepseek-ai/dsh-sandbox-policy';
import Bash from '@deepseek-ai/dsh-bash-sandbox';
import * as Projections from '@deepseek-ai/dsh-session-projection';
import { readFile, writeFile } from 'node:fs/promises';

const records = JSON.parse(await readFile(new URL('./state/sandboxes.json', import.meta.url), 'utf8'));
const contexts = [];
const reports = [];
try {
  for (const [owner, item] of Object.entries(records)) {
    const ctx = new Context();
    contexts.push(ctx);
    await ctx.plugin(Projections.default ?? Projections);
    await ctx.plugin(Ssh, {
      host: 'mythos-' + item.sandbox_id,
      node: '/usr/bin/node',
      helper: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
      helperHash: item.helper_hash,
      workspace: item.workspace_path,
    });
    await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: item.workspace_path });
    await ctx.plugin(Fs);
    await ctx.plugin(Subprocess);
    await ctx.plugin(Sandbox);
    await ctx.plugin(Bash, { cwd: item.workspace_path, timeoutMs: 30000 });
    console.log(owner, 'providers ready');
    const target = await ctx.fs.resolve('sandbox-proof.txt', { cwd: item.workspace_path });
    console.log(owner, 'target resolved');
    await ctx.fs.writeText(target, owner + '\n');
    console.log(owner, 'file written');
    const text = await ctx.fs.readText(target);
    if (text !== owner + '\n') throw new Error('Filesystem provider returned wrong owner content');
    const command = await ctx.shell.execute(ctx.shell.resolve({
      command: 'id && cat sandbox-proof.txt && test ! -e /var/run/docker.sock && test ! -e /home/hx/.dsh/.credentials.yaml',
      workdir: item.workspace_path,
    }));
    const result = await command.result();
    if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
    reports.push({ owner, sandboxId: item.sandbox_id, content: text, result });
    console.log(JSON.stringify({ owner, fsReadWrite: true, exitCode: result.exitCode, stdout: result.stdout.text }));
  }
  const results = await Promise.all(contexts.map(async (ctx, i) => {
    const item = Object.values(records)[i];
    const other = Object.values(records)[1 - i];
    const execution = await ctx.shell.execute(ctx.shell.resolve({
      command: `test ! -e '${other.workspace_path}' && sleep 1 && cat sandbox-proof.txt`,
      workdir: item.workspace_path,
    }));
    return (await execution.result()).exitCode;
  }));
  if (results.some(code => code !== 0)) throw new Error('Concurrent sandbox isolation failed');
  await writeFile(new URL('./state/native-smoke.json', import.meta.url), JSON.stringify(reports, null, 2));
  console.log('CONCURRENT_NATIVE_PROVIDERS_OK');
} finally {
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()));
}
