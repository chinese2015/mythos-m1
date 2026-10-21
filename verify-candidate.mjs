import { Context } from '@deepseek-ai/cordis';
import Ssh from '@deepseek-ai/dsh-ssh';
import Fs from '@deepseek-ai/dsh-fs-ssh';
import Subprocess from '@deepseek-ai/dsh-subprocess-ssh';
import Sandbox from '@deepseek-ai/dsh-sandbox-ssh';
import Policy from '@deepseek-ai/dsh-sandbox-policy';
import Bash from '@deepseek-ai/dsh-bash-sandbox';
import * as Projections from '@deepseek-ai/dsh-session-projection';
import { readFile, writeFile } from 'node:fs/promises';

const item = JSON.parse(await readFile(new URL('./state/verifier.json', import.meta.url), 'utf8'));
const ctx = new Context();
try {
  await ctx.plugin(Projections.default ?? Projections);
  await ctx.plugin(Ssh, { host: 'mythos-' + item.sandbox_id, node: '/usr/bin/node',
    helper: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', helperHash: item.helper_hash, workspace: item.workspace_path });
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: item.workspace_path });
  await ctx.plugin(Fs);
  await ctx.plugin(Subprocess);
  await ctx.plugin(Sandbox);
  await ctx.plugin(Bash, { cwd: item.workspace_path, timeoutMs: 90000 });
  const command = 'mkdir -p .cache/jansi && mvn -B -o -s .cache/settings.xml -Dmaven.repo.local=' +
    item.workspace_path + '/.cache/m2/repository -Djansi.tmpdir=' + item.workspace_path + '/.cache/jansi clean verify';
  const execution = await ctx.shell.execute(ctx.shell.resolve({ command }));
  const result = await execution.result();
  await writeFile(new URL('./state/verification.json', import.meta.url), JSON.stringify({ sandboxId: item.sandbox_id,
    sourceCommit: item.sourceCommit, command, exitCode: result.exitCode, stdout: result.stdout.text,
    stderr: result.stderr.text, reports: {} }, null, 2));
  console.log('VERIFIER_COMMAND_RESULT', result.exitCode, result.stdout.text.slice(-3500), result.stderr.text.slice(-1000));
  const directory = await ctx.fs.resolve('target/surefire-reports', { cwd: item.workspace_path });
  const reports = {};
  if (await ctx.fs.stat(directory)) {
    for (const file of await ctx.fs.listDir(directory)) {
      if (file.name.startsWith('TEST-') && file.name.endsWith('.xml')) reports[file.name] = await ctx.fs.readText(file.target);
    }
  }
  await writeFile(new URL('./state/verification.json', import.meta.url), JSON.stringify({ sandboxId: item.sandbox_id,
    sourceCommit: item.sourceCommit, command, exitCode: result.exitCode, stdout: result.stdout.text,
    stderr: result.stderr.text, reports }, null, 2));
  console.log(JSON.stringify({ sandboxId: item.sandbox_id, sourceCommit: item.sourceCommit, exitCode: result.exitCode,
    junitReportCount: Object.keys(reports).length, stdoutTail: result.stdout.text.slice(-1600) }));
  if (result.exitCode !== 0 || Object.keys(reports).length === 0) process.exitCode = 1;
} finally { await ctx.fiber.dispose(); }
