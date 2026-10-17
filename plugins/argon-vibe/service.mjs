import { readFile } from 'node:fs/promises';
import { safePath } from './shared/bridge.mjs';
import { makeSandboxOpener } from './sandbox.mjs';

export const name = 'argon-vibe';
// Read-only slice: never asks for the session controller. argonBrain is injected
// for the upcoming client-side messaging slice; server routes read through
// argonWorkflow.controller (single loopback brain client).
export const inject = ['webServer', 'connection', 'argonWorkflow', 'argonSdlc', 'argonBrain'];

const failure = (message, status = 400, code = 'BAD_REQUEST') => Object.assign(new Error(message), { status, code });
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
};
const splitLines = text => {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};
const withinRoot = (resolved, root) => {
  const base = root.endsWith('/') ? root : root + '/';
  return resolved === root || resolved.startsWith(base);
};
const pageParam = (raw, fallback, name) => {
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw failure(`无效的分页参数 ${name}`, 400, 'BAD_PAGE');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw failure(`无效的分页参数 ${name}`, 400, 'BAD_PAGE');
  return value;
};

async function snapshotOf(workflow, id) {
  // TaskWorkflow.snapshot validates the id, the owner and the ARGON binding;
  // it throws a 404 for anything that is not this operator's task.
  return workflow.snapshot(id);
}

function contextBody(snap, sdlc) {
  const work = snap.workItem, wf = work.workflow ?? {};
  let closedCurrent = false;
  try { closedCurrent = !!(sdlc && work.workflow?.delivery && sdlc.closedCurrent(work)); } catch { closedCurrent = false; }
  return {
    workItemId: work.workItemId,
    version: work.version,
    phase: wf.phase ?? null,
    paused: !!work.paused,
    blocked: !!work.blocked,
    reason: wf.reason ?? null,
    planSessionId: wf.planSessionId ?? null,
    codeSessionId: wf.codeSessionId ?? null,
    approval: wf.approval ?? null,
    candidateCommit: wf.candidateCommit ?? null,
    baselineOperationId: wf.baselineOperationId ?? null,
    verificationOperationId: wf.verificationOperationId ?? null,
    sandboxId: work.sandboxId ?? null,
    sessionIds: Array.isArray(work.sessionIds) ? work.sessionIds : [],
    delivery: wf.delivery ? {
      id: wf.delivery.id ?? null,
      step: wf.delivery.step ?? null,
      candidateCommit: wf.delivery.candidateCommit ?? null,
      headBranch: wf.delivery.headBranch ?? null,
      pullNumber: wf.delivery.pullNumber ?? null,
      pullUrl: wf.delivery.pullUrl ?? null,
      lastError: wf.delivery.lastError ?? null,
      requestedAt: wf.delivery.requestedAt ?? null,
    } : null,
    deliveryClosedUnmerged: closedCurrent,
    source: work.sourceRecord ?? null,
    workflow: wf,
    cursor: Number.isSafeInteger(snap.cursor) ? snap.cursor : null,
    operations: (snap.operations ?? []).map(op => ({ operationId: op.operationId, state: op.state ?? null, kind: op.kind ?? null })),
  };
}

async function workspaceEvidence(workflow, work) {
  // Authoritative binding: brain evidence is computed inside the bound sandbox
  // and reports the workspace path with the sandboxId it was read from.
  const evidence = await workflow.workspace(work);
  if (!evidence || evidence.sandboxId !== work.sandboxId)
    throw failure('沙箱绑定与任务不一致', 502, 'SANDBOX_BINDING_MISMATCH');
  if (typeof evidence.workspacePath !== 'string' || !evidence.workspacePath.startsWith('/'))
    throw failure('沙箱工作区不可用', 502, 'SANDBOX_UNAVAILABLE');
  return evidence;
}

async function filesBody(workflow, openSandbox, limits, id, url) {
  const requested = url.searchParams.get('path');
  if (requested === null || requested === '') throw failure('缺少 path 参数');
  try { safePath(requested); } catch { throw failure('只允许工作区内的相对路径', 400, 'PATH_ESCAPE'); }
  const offset = pageParam(url.searchParams.get('offset'), 1, 'offset');
  const limit = pageParam(url.searchParams.get('limit'), limits.maxLines, 'limit');
  if (limit > limits.maxLines) throw failure(`limit 不能超过 ${limits.maxLines}`, 400, 'LIMIT_TOO_LARGE');
  const work = (await snapshotOf(workflow, id)).workItem;
  if (!/^sb-[a-z0-9-]+$/.test(work.sandboxId ?? '')) throw failure('任务沙箱尚未绑定', 409, 'SANDBOX_NOT_BOUND');
  const evidence = await workspaceEvidence(workflow, work);
  const workspaceRoot = evidence.workspacePath;
  let fs;
  try { fs = await openSandbox(work.sandboxId, workspaceRoot); }
  catch (error) { throw failure(error?.message ?? '沙箱文件服务不可用', 502, error?.code ?? 'SANDBOX_UNAVAILABLE'); }
  const signal = new AbortController().signal;
  const target = await fs.resolve(requested, { cwd: workspaceRoot });
  const resolved = fs.processPath(target);
  if (!withinRoot(resolved, workspaceRoot)) throw failure('路径解析到沙箱工作区之外', 400, 'PATH_ESCAPE');
  const info = await fs.stat(target, signal);
  if (!info) throw failure('文件不存在', 404, 'NOT_FOUND');
  if (info.type !== 'file') throw failure('目标不是普通文件', 400, 'NOT_A_FILE');
  if (info.size !== undefined && info.size > limits.maxFileBytes)
    throw failure(`文件超过 ${limits.maxFileBytes} 字节上限，拒绝读取`, 413, 'FILE_TOO_LARGE');
  const text = await fs.readText(target, signal);
  if (Buffer.byteLength(text, 'utf8') > limits.maxFileBytes)
    throw failure(`文件超过 ${limits.maxFileBytes} 字节上限，拒绝读取`, 413, 'FILE_TOO_LARGE');
  const lines = splitLines(text);
  const start = offset - 1;
  const page = lines.slice(start, start + limit);
  return {
    path: requested,
    version: String(info.version),
    lines: page,
    offset,
    limit,
    eof: start + limit >= lines.length,
    lineCount: lines.length,
    ...(info.size === undefined ? {} : { bytes: info.size }),
  };
}

async function diffBody(workflow, id, req) {
  const work = (await snapshotOf(workflow, id)).workItem;
  const evidence = await workspaceEvidence(workflow, work);
  const git = evidence.git ?? {};
  const etag = `"${String(work.version)}-${git.headCommit ?? 'none'}"`;
  if (req.headers?.['if-none-match'] === etag) return { etag, notModified: true };
  const wf = work.workflow ?? {};
  return {
    etag,
    body: {
      workItemId: work.workItemId,
      version: work.version,
      phase: wf.phase ?? null,
      sandboxId: work.sandboxId ?? null,
      workspacePath: evidence.workspacePath,
      sourceCommit: wf.candidateCommit ?? git.headCommit ?? null,
      baseCommit: git.baseCommit ?? null,
      headCommit: git.headCommit ?? null,
      branch: git.branch ?? null,
      status: git.status ?? null,
      diff: git.diff ?? null,
      changedFiles: Array.isArray(git.changedFiles) ? git.changedFiles : [],
      testsChanged: Array.isArray(git.testsChanged) ? git.testsChanged : [],
      diffTruncated: git.diffTruncated === true,
    },
  };
}

export function vibeHandler({ connection, workflow, sdlc = null, openSandbox, config = {}, assetReader = rel => readFile(new URL('./' + rel, import.meta.url)) }) {
  if (!connection || !workflow || typeof openSandbox !== 'function') throw new Error('connection, workflow and openSandbox are required');
  const limits = {
    maxLines: config.maxLines ?? 5000,
    maxFileBytes: config.maxFileBytes ?? 512 * 1024,
  };
  if (!Number.isInteger(limits.maxLines) || limits.maxLines < 1 || limits.maxLines > 50000) throw new Error('Invalid maxLines');
  if (!Number.isInteger(limits.maxFileBytes) || limits.maxFileBytes < 1024) throw new Error('Invalid maxFileBytes');
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://dsh.invalid');
      const path = url.pathname.slice('/argon/vibe'.length) || '/';
      const rejection = connection.requestRejection({ headers: req.headers });
      if (rejection) return json(res, rejection, { error: rejection === 401 ? '请先在 DSH 主页面完成登录' : '请求来源不受信任' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Vibe 接口仅开放只读 GET', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
      const assets = { '/bridge-browser.mjs': 'shared/bridge-browser.mjs', '/bridge.mjs': 'shared/bridge.mjs' };
      if (assets[path]) {
        const bytes = await assetReader(assets[path]);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
        return;
      }
      const match = path.match(/^\/tasks\/([^/]+)\/(context|files|diff)$/);
      if (!match) throw failure('接口不存在', 404, 'NOT_FOUND');
      const [, id, route] = match;
      if (route === 'context') return json(res, 200, contextBody(await snapshotOf(workflow, id), sdlc));
      if (route === 'diff') {
        const result = await diffBody(workflow, id, req);
        const headers = { ETag: result.etag, 'Cache-Control': 'no-cache' };
        return result.notModified ? json(res, 304, null, headers) : json(res, 200, result.body, headers);
      }
      return json(res, 200, await filesBody(workflow, openSandbox, limits, id, url));
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      json(res, status, { error: error?.status ? error.message : 'Vibe 服务暂不可用，请刷新重试', code: error?.code ?? (error?.status ? 'REQUEST_FAILED' : 'UNAVAILABLE') });
    }
  };
}

export function apply(ctx, config = {}) {
  const openSandbox = makeSandboxOpener({ ssh: config.ssh ?? {}, maxSessions: config.maxSessions ?? 8, idleTtlMs: config.idleTtlMs ?? 60000 });
  const handler = vibeHandler({
    connection: ctx.connection,
    workflow: ctx.argonWorkflow.controller,
    sdlc: ctx.argonSdlc?.controller ?? null,
    openSandbox,
    config,
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/argon/vibe', handler }));
  ctx.effect(() => () => { void openSandbox.dispose(); });
}
