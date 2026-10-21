import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { safePath } from './shared/bridge.mjs';
import { makeSandboxOpener } from './sandbox.mjs';

export const name = 'mythos-vibe';
// Read-only slice: never asks for the session controller. mythosBrain is injected
// for the upcoming client-side messaging slice; server routes read through
// mythosWorkflow.controller (single loopback brain client).
export const inject = ['webServer', 'connection', 'mythosWorkflow', 'mythosSdlc', 'mythosBrain'];

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
  if (!/^[0-9]+$/.test(raw)) throw failure(`Invalid paging parameter ${name}`, 400, 'BAD_PAGE');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw failure(`Invalid paging parameter ${name}`, 400, 'BAD_PAGE');
  return value;
};

async function snapshotOf(workflow, id) {
  // TaskWorkflow.snapshot validates the id, the owner and the MYTHOS binding;
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
    throw failure('Sandbox binding does not match the task', 502, 'SANDBOX_BINDING_MISMATCH');
  if (typeof evidence.workspacePath !== 'string' || !evidence.workspacePath.startsWith('/'))
    throw failure('Sandbox workspace unavailable', 502, 'SANDBOX_UNAVAILABLE');
  return evidence;
}

async function filesBody(workflow, openSandbox, limits, id, url) {
  const requested = url.searchParams.get('path');
  if (requested === null || requested === '') throw failure('Missing path parameter');
  try { safePath(requested); } catch { throw failure('Only workspace-relative paths are allowed', 400, 'PATH_ESCAPE'); }
  const offset = pageParam(url.searchParams.get('offset'), 1, 'offset');
  const limit = pageParam(url.searchParams.get('limit'), limits.maxLines, 'limit');
  if (limit > limits.maxLines) throw failure(`limit must not exceed ${limits.maxLines}`, 400, 'LIMIT_TOO_LARGE');
  const work = (await snapshotOf(workflow, id)).workItem;
  if (!/^sb-[a-z0-9-]+$/.test(work.sandboxId ?? '')) throw failure('Task sandbox not bound yet', 409, 'SANDBOX_NOT_BOUND');
  const evidence = await workspaceEvidence(workflow, work);
  const workspaceRoot = evidence.workspacePath;
  let fs;
  try { fs = await openSandbox(work.sandboxId, workspaceRoot); }
  catch (error) { throw failure(error?.message ?? 'Sandbox file service unavailable', 502, error?.code ?? 'SANDBOX_UNAVAILABLE'); }
  const signal = new AbortController().signal;
  const target = await fs.resolve(requested, { cwd: workspaceRoot });
  const resolved = fs.processPath(target);
  if (!withinRoot(resolved, workspaceRoot)) throw failure('Path resolves outside the sandbox workspace', 400, 'PATH_ESCAPE');
  const info = await fs.stat(target, signal);
  if (!info) throw failure('File not found', 404, 'NOT_FOUND');
  if (info.type !== 'file') throw failure('Target is not a regular file', 400, 'NOT_A_FILE');
  if (info.size !== undefined && info.size > limits.maxFileBytes)
    throw failure(`File exceeds the ${limits.maxFileBytes}-byte limit; read refused`, 413, 'FILE_TOO_LARGE');
  const text = await fs.readText(target, signal);
  if (Buffer.byteLength(text, 'utf8') > limits.maxFileBytes)
    throw failure(`File exceeds the ${limits.maxFileBytes}-byte limit; read refused`, 413, 'FILE_TOO_LARGE');
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
  const fingerprint = createHash('sha256').update(JSON.stringify({
    branch: git.branch ?? null,
    status: git.status ?? null,
    diffHash: git.diffHash ?? git.diff ?? null,
    changedFiles: Array.isArray(git.changedFiles) ? git.changedFiles : [],
  })).digest('hex');
  const etag = `"${String(work.version)}-${git.headCommit ?? 'none'}-${fingerprint}"`;
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
      const path = url.pathname.slice('/mythos/vibe'.length) || '/';
      const rejection = connection.requestRejection({ headers: req.headers });
      if (rejection) return json(res, rejection, { error: rejection === 401 ? 'Please log in on the DSH main page first' : 'Untrusted request origin' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Vibe API is read-only GET only', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
      const assets = { '/bridge-browser.mjs': 'shared/bridge-browser.mjs', '/bridge.mjs': 'shared/bridge.mjs' };
      if (assets[path]) {
        const bytes = await assetReader(assets[path]);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
        return;
      }
      const match = path.match(/^\/tasks\/([^/]+)\/(context|files|diff)$/);
      if (!match) throw failure('Route not found', 404, 'NOT_FOUND');
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
      json(res, status, { error: error?.status ? error.message : 'Vibe service unavailable, please refresh and retry', code: error?.code ?? (error?.status ? 'REQUEST_FAILED' : 'UNAVAILABLE') });
    }
  };
}

export function apply(ctx, config = {}) {
  const openSandbox = makeSandboxOpener({ ssh: config.ssh ?? {}, maxSessions: config.maxSessions ?? 8, idleTtlMs: config.idleTtlMs ?? 60000 });
  const handler = vibeHandler({
    connection: ctx.connection,
    workflow: ctx.mythosWorkflow.controller,
    sdlc: ctx.mythosSdlc?.controller ?? null,
    openSandbox,
    config,
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/mythos/vibe', handler }));
  ctx.effect(() => () => { void openSandbox.dispose(); });
}
