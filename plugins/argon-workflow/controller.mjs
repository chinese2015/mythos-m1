import { createHash } from 'node:crypto';
import { M2Client } from '../argon-brain/client.mjs';
import { FindingSource, sourceRecord } from './source.mjs';
import { sessionProgress, assertApproval, baselineReproduced, conflict, transcript } from './rules.mjs';
import { taskPreset } from './session-policy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const route = id => '/api/brain/work-items/' + id;
const opRoute = id => '/api/brain/operations/' + id;
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN']);
const identity = (work, role) => {
  const h = hash([work.workItemId, role]);
  return 'session-' + [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20,32)].join('-');
};
export class TaskWorkflow {
  constructor(config, { sessions, workspaces, presets, client, source, report = () => {} }) {
    this.config = config; this.owner = config.owner ?? 'alice'; this.sessions = sessions; this.workspaces = workspaces; this.presets = presets;
    this.client = client ?? new M2Client({ ...config, owner: this.owner, timeoutMs: 30000 });
    this.source = source ?? new FindingSource(config.sourceUrl); this.report = report;
    this.registered = new Map(); this.workspaceCache = new Map(); this.queue = Promise.resolve(); this.polling = null; this.closed = false;
    this.workState = new Map(); this.inputFences = new Set();
  }
  inputRejection(workId, role, sessionId) {
    if (this.closed) return '任务工作流暂不可用';
    const work = this.workState.get(workId);
    if (this.inputFences.has(sessionId)) return '任务决策处理中，请稍后重试输入';
    if (!work) return '任务状态加载中，请稍后重试输入';
    if (work.paused) return '请先在任务工作台恢复工作流';
    if (role === 'PLAN' && work.workflow.approval) return '计划已批准，请向编码会话发送后续说明';
    if (role === 'CODE' && (!work.workflow.approval || work.workflow.phase !== 'CODING')) return '编码输入会使验证失效，请从任务工作台发送补充说明';
  }
  async fence(sessionId, fn) {
    this.inputFences.add(sessionId);
    try { return await fn(); } finally { this.inputFences.delete(sessionId); }
  }
  remember(work) {
    const previous = this.workState.get(work.workItemId);
    if (!previous || previous.version <= work.version) this.workState.set(work.workItemId, work);
  }
  serial(fn) {
    const result = this.queue.then(() => { if (this.closed) throw new Error('Workflow disposed'); return fn(); });
    this.queue = result.catch(() => {}); return result;
  }
  key(...parts) { return 'task-' + hash(parts); }
  async snapshot(id) {
    if (!/^work-[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('工作项不存在'), { status: 404 });
    const snap = await this.client.request('GET', route(id));
    if (snap.workItem.ownerId !== this.owner || snap.workItem.source?.type !== 'ARGON' || !snap.workItem.sourceRecord || !snap.workItem.workflow) throw Object.assign(new Error('工作项不存在'), { status: 404 });
    this.remember(snap.workItem);
    return snap;
  }
  async listWorks() { return (await this.client.request('GET', '/api/brain/work-items')).workItems.filter(w => w.source?.type === 'ARGON' && w.sourceRecord && w.workflow); }
  async tasks() {
    const [tasks, works] = await Promise.all([this.source.list(), this.listWorks()]);
    return { tasks: tasks.map(task => { const work = works.find(w => w.source.id === task.id); return { ...task,
      ...(work ? { workItemId: work.workItemId, workStage: work.paused ? 'PAUSED' : work.workflow?.phase } : {}) }; }),
      operator: { id: this.owner, label: '演示操作员 ' + this.owner } };
  }
  start(id, body, key) { return this.serial(async () => {
    const existing = (await this.listWorks()).find(w => w.source.id === id);
    if (existing) return existing;
    const task = await this.source.get(id);
    if (!task?.enabled) throw conflict('此来源任务暂未开放执行，或仓库基线已变化');
    return this.client.request('POST', '/api/brain/tasks/claim', { key: this.key('claim', id, key), body: { sourceRecord: sourceRecord(task), expectedRevision: body.expectedRevision } });
  }); }
  async update(work, changes, { blocked = work.blocked, key } = {}) {
    const result = await this.client.request('POST', route(work.workItemId) + '/workflow', { key: key ?? this.key('workflow', work.workItemId, work.version, changes),
      body: { expectedVersion: work.version, workflow: { ...work.workflow, ...changes }, stage: changes.phase ?? work.workflow.phase, blocked } });
    this.remember(result); return result;
  }
  async workspace(work, fresh = false) {
    const cache = this.workspaceCache.get(work.workItemId);
    if (!fresh && cache && Date.now() - cache.at < 3000) return cache.value;
    const value = await this.client.request('GET', route(work.workItemId) + '/workspace');
    this.workspaceCache.set(work.workItemId, { at: Date.now(), value }); return value;
  }
  async detail(id) {
    const snap = await this.snapshot(id), work = snap.workItem;
    const operations = await Promise.all(snap.operations.map(op => this.client.request('GET', opRoute(op.operationId))));
    const result = { ...snap, operations, workflow: work.workflow, source: work.sourceRecord };
    if (work.sandboxId) result.git = (await this.workspace(work)).git;
    const role = work.workflow.codeSessionId ? 'CODE' : 'PLAN'; const sid = work.workflow[role.toLowerCase() + 'SessionId'];
    if (sid && work.sessionIds.includes(sid)) {
      const inspected = await this.sessions.inspect(sid);
      const requestId = work.workflow[role.toLowerCase() + 'RequestId']; const progress = sessionProgress(inspected, requestId);
      const { items } = await this.sessions.list({}); const row = items.find(x => x.sessionId === sid);
      result.session = { sessionId: sid, role, running: !!row?.running, activity: progress.completed ? '本轮已完成' : row?.running ? 'Agent 运行中' : '等待输入',
        transcript: transcript(inspected), url: '/?argonSession=' + encodeURIComponent(sid) + '&argonEmbedded=1' };
    }
    return result;
  }
  approve(id, body, key) { return this.serial(async () => {
    const snap = await this.snapshot(id), work = snap.workItem, wf = work.workflow;
    // A replay is valid only for the exact approval decision already stored.
    if (wf.approval?.key === key && wf.approval.planHash === body.planHash && wf.approval.expectedVersion === body.expectedVersion) return work;
    if (!wf.planSessionId) throw conflict('只读方案尚未完成');
    return this.fence(wf.planSessionId, async () => {
    const progress = sessionProgress(await this.sessions.inspect(wf.planSessionId), wf.planRequestId);
    assertApproval(snap, body, progress);
    if (work.paused) throw conflict('请先恢复工作流');
    const git = (await this.workspace(work, true)).git;
    if (git.headCommit !== work.sourceRecord.baseCommit || git.status || git.changedFiles.length) throw conflict('审批前工作区出现变更，需要人工检查');
    return this.update(work, { phase: 'CODING', reason: null, approval: { actor: this.owner, approvedAt: new Date().toISOString(), planHash: body.planHash, expectedVersion: body.expectedVersion, key },
      pendingMessage: null, codeSessionId: identity(work, 'CODE'), codeRequestId: this.key('prompt', id, 'CODE', 1) }, { blocked: false, key: this.key('approve', id, key) });
    });
  }); }
  pause(id, paused, body, key) { return this.serial(async () => {
    const { workItem } = await this.snapshot(id);
    if (!paused && workItem.workflow.phase === 'BLOCKED') throw conflict('任务已阻塞。请查看原因；会话中断可发送补充说明明确继续，执行状态未知需先检查沙箱');
    const result = await this.client.request('POST', route(id) + (paused ? '/pause' : '/resume'), { key: this.key('pause', id, key), body });
    this.remember(result); return result;
  }); }
  message(id, body, key) { return this.serial(async () => {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw Object.assign(new Error('请输入 1–16000 字的补充说明'), { status: 400 });
    const snap = await this.snapshot(id), work = snap.workItem, wf = work.workflow;
    if (work.paused || snap.operations.some(o => o.state === 'UNKNOWN')) throw conflict('请先检查或恢复暂停/未知的执行');
    if (['PUBLISHING', 'PR_OPEN', 'CLOSING', 'COMPLETED'].includes(wf.phase)) throw conflict('当前候选正在交付、审核或已完成。需要修改时，请先在 Gitea 关闭未合并的 PR，再发送补充说明');
    const role = wf.approval ? 'CODE' : 'PLAN'; const sid = wf[role.toLowerCase() + 'SessionId'];
    if (!sid || !work.sessionIds.includes(sid)) throw conflict('当前还没有可接收说明的工作会话');
    const requestId = this.key('message', id, key);
    if (wf.pendingMessage && wf.pendingMessage.requestId !== requestId && !(role === 'CODE' && wf.pendingMessage.requestId === wf.planRequestId)) {
      const previous = sessionProgress(await this.sessions.inspect(sid), wf.pendingMessage.requestId);
      if (!previous.found) throw conflict('上一条补充说明正在投递，请稍后再发送');
    }
    if (wf[role.toLowerCase() + 'RequestId'] !== requestId) await this.update(work, {
      phase: role === 'CODE' ? 'CODING' : 'PLANNING', reason: null,
      [role.toLowerCase() + 'RequestId']: requestId, pendingMessage: { requestId, text: body.text, role },
      ...(role === 'PLAN' ? { planHash: null } : { verificationOperationId: null }),
    }, { blocked: false, key: this.key('message-intent', id, key) });
    // Tick dispatches this persisted intent; disconnecting this request cannot lose it.
    return { accepted: true, requestId };
  }); }
  async operation(id) {
    if (!/^exec-[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('操作不存在'), { status: 404 });
    const op = await this.client.request('GET', opRoute(id)); await this.snapshot(op.workItemId); return op;
  }
  async logs(id, after) { await this.operation(id); return this.client.request('GET', opRoute(id) + '/logs?after=' + after + '&limit=100'); }
  cancel(id, body, key) { return this.serial(async () => { await this.operation(id); return this.client.request('POST', opRoute(id) + '/cancel', { body, key: this.key('cancel', id, key) }); }); }
  async ensurePreset(work, role) {
    const location = await this.workspace(work);
    const definition = taskPreset(work, role, { ...this.config, workspacePath: location.workspacePath });
    if (!this.registered.has(definition.id)) {
      const dispose = await this.presets.register(definition); this.registered.set(definition.id, dispose);
    }
    return { definition, location };
  }
  async ensureSession(work, role) {
    const { definition, location } = await this.ensurePreset(work, role);
    const sid = work.workflow[role.toLowerCase() + 'SessionId'];
    const workspace = await this.workspaces.create(location.workspacePath, work.source.id);
    await this.sessions.create({ sessionId: sid, workspaceId: workspace.id, agentPreset: definition.id });
    if (!work.sessionIds.includes(sid)) {
      work = (await this.snapshot(work.workItemId)).workItem;
      work = await this.client.request('POST', route(work.workItemId) + '/sessions', { key: this.key('session', work.workItemId, role),
        body: { sessionId: sid, role, expectedVersion: work.version } });
      await this.sessions.rename({ sessionId: sid, title: work.source.id + (role === 'PLAN' ? ' · 计划' : ' · 编码') });
    }
    return work;
  }
  prompt(work, role) {
    const wf = work.workflow, source = work.sourceRecord;
    if (wf.pendingMessage?.requestId === wf[role.toLowerCase() + 'RequestId']) return wf.pendingMessage.text;
    const context = `任务 ${source.id}: ${source.title}\n仓库基线 ${source.baseCommit}\n只允许修改 ${source.sourcePath}。禁止读取参考修复分支，不修改测试/POM/构建配置，不创建 PR。\n已复现真实失败测试：maliciousInputReturnsNothing。`;
    return role === 'PLAN' ? `${context}\n请用只读工具检查源码和现有测试，输出具体修改方案、风险与验证步骤，完成后等待人工审批。` :
      `${context}\n人工已批准方案：\n${wf.plan}\n请实际完成源码修改，保持现有测试不变，运行必要测试并用 git 提交你的修改；最后报告提交 SHA 和测试事实。独立 clean verify 将由工作流在新的容器执行。`;
  }
  async observe(work, role) {
    work = await this.ensureSession(work, role);
    const wf = work.workflow, sid = wf[role.toLowerCase() + 'SessionId'], requestId = wf[role.toLowerCase() + 'RequestId'];
    const inspected = await this.sessions.inspect(sid), progress = sessionProgress(inspected, requestId);
    if (!progress.found) {
      await this.sessions.prompt({ sessionId: sid, requestId, mode: 'queue', content: [{ type: 'text', text: this.prompt(work, role) }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
      return;
    }
    if (progress.failed) return this.block(work, 'DSH 会话本轮未正常完成：' + progress.reason + '。可发送补充说明明确继续。');
    if (wf.pendingMessage?.requestId === requestId) return this.update(work, { pendingMessage: null });
    if (!progress.completed) {
      if (progress.pending) return;
      const { items } = await this.sessions.list({}); const row = items.find(x => x.sessionId === sid);
      if (row && !row.running) return this.block(work, 'DSH 会话已中断，未自动重放。可发送补充说明明确继续。');
      return;
    }
    if (progress.latestUserSequence > progress.endSequence) {
      const latest = inspected.events.filter(e => e.type === 'user/message').at(-1);
      if (latest.data?.source?.rpcId) return this.update(work, { [role.toLowerCase() + 'RequestId']: latest.data.source.rpcId });
      return this.block(work, '会话有新的人工输入，请发送说明明确下一步');
    }
    if (role === 'PLAN') {
      if (!progress.text.trim()) return this.block(work, '计划会话未产出可供审批的方案');
      const git = (await this.workspace(work, true)).git;
      if (git.headCommit !== work.sourceRecord.baseCommit || git.status || git.changedFiles.length) return this.block(work, '计划阶段工作区发生变化，需要人工检查');
      return this.update(work, { phase: 'AWAITING_PLAN_APPROVAL', plan: progress.text, planHash: hash([sid, requestId, progress.endSequence, progress.text]), planEndSequence: progress.endSequence });
    }
    const snap = await this.snapshot(work.workItemId);
    if (snap.operations.some(op => !terminal.has(op.state))) return;
    const git = (await this.workspace(work, true)).git;
    if (git.headCommit === work.sourceRecord.baseCommit || git.status || git.testsChanged.length || git.changedFiles.length !== 1 || git.changedFiles[0] !== work.sourceRecord.sourcePath)
      return this.block(snap.workItem, '编码结束，但候选提交必须已提交、工作区干净且只修改指定源文件。可发送说明修正后继续。');
    return this.update(snap.workItem, { phase: 'VERIFYING', candidateCommit: git.headCommit, codeEndSequence: progress.endSequence, verificationOperationId: null }, { blocked: false });
  }
  async block(work, reason) { return this.update(work, { returnPhase: work.workflow.phase, phase: 'BLOCKED', reason }, { blocked: true }); }
  async submitFixed(work, kind, command, slot, sourceCommit) {
    const op = await this.client.request('POST', route(work.workItemId) + '/operations', {
      key: this.key('fixed-operation', work.workItemId, slot, slot === 'baselineOperationId' ? 1 : work.workflow.codeRequestId),
      body: { command, kind, timeoutSeconds: 300, sourceCommit, expectedVersion: work.version } });
    const current = (await this.snapshot(work.workItemId)).workItem;
    await this.update(current, { [slot]: op.operationId });
  }
  async step(work) {
    // Reinstall definitions for persisted sessions even at approval/review stops.
    // This restores native chat access after a plugin or host restart without replaying prompts.
    if (work.sandboxId) for (const role of ['PLAN', 'CODE']) {
      const sid = work.workflow[role.toLowerCase() + 'SessionId'];
      if (sid && work.sessionIds.includes(sid)) await this.ensurePreset(work, role);
    }
    if (work.paused) return;
    const wf = work.workflow;
    if (wf.phase === 'CLAIMED') {
      if (!wf.sourceClaimed) { await this.source.claim(work); return this.update(work, { sourceClaimed: true, phase: 'PREPARING' }); }
      return this.update(work, { phase: 'PREPARING' });
    }
    if (wf.phase === 'PREPARING') {
      const prepared = await this.client.request('POST', route(work.workItemId) + '/prepare', { key: this.key('prepare', work.workItemId), body: { expectedVersion: work.version } });
      if (prepared.sandboxId) return this.update(prepared, { phase: 'BASELINE' });
      if (['FAILED', 'UNKNOWN'].includes(prepared.workspaceProvision?.state)) return this.block(prepared, '工作区准备失败：' + prepared.workspaceProvision.error);
      return;
    }
    if (wf.phase === 'BASELINE') {
      if (!wf.baselineOperationId) return this.submitFixed(work, 'UNIT_TEST', 'mvn -B -o -s .cache/settings.xml test', 'baselineOperationId', work.sourceRecord.baseCommit);
      const op = await this.client.request('GET', opRoute(wf.baselineOperationId));
      if (!terminal.has(op.state)) return;
      if (!baselineReproduced(op)) return this.block(work, '基线测试未复现预期失败，请检查操作日志和环境；没有将环境错误视为漏洞复现。');
      return this.update(work, { phase: 'PLANNING', baselineReproduced: true, planSessionId: identity(work, 'PLAN'), planRequestId: this.key('prompt', work.workItemId, 'PLAN', 1) }, { blocked: false });
    }
    if (wf.phase === 'PLANNING') return this.observe(work, 'PLAN');
    if (wf.phase === 'CODING') return this.observe(work, 'CODE');
    if (wf.phase === 'AWAITING_PLAN_APPROVAL' || wf.phase === 'AWAITING_REVIEW') {
      const role = wf.phase === 'AWAITING_PLAN_APPROVAL' ? 'plan' : 'code';
      // Native DSH input is also an explicit human action and must invalidate stale readiness.
      const inspected = await this.sessions.inspect(wf[role + 'SessionId']); const latest = inspected.events.filter(e => e.type === 'user/message').at(-1);
      if (latest?.seq > wf[role + 'EndSequence'] && latest.data?.source?.rpcId) return this.update(work, {
        phase: role === 'plan' ? 'PLANNING' : 'CODING', [role + 'RequestId']: latest.data.source.rpcId,
        ...(role === 'plan' ? { planHash: null } : { verificationOperationId: null }),
      }, { blocked: false });
      return;
    }
    if (wf.phase === 'VERIFYING') {
      const inspected = await this.sessions.inspect(wf.codeSessionId), progress = sessionProgress(inspected, wf.codeRequestId);
      const { items } = await this.sessions.list({});
      if (!progress.completed || progress.latestUserSequence > wf.codeEndSequence || progress.pendingInputs.length || items.some(r => r.sessionId === wf.codeSessionId && r.running))
        return this.block(work, '验证期间编码会话有新的活动，旧验证结果不会发布为待审核。请从任务工作台发送说明继续。');
      if (!wf.verificationOperationId) return this.submitFixed(work, 'VERIFY', 'mvn -B -o -s .cache/settings.xml clean verify', 'verificationOperationId', wf.candidateCommit);
      const op = await this.client.request('GET', opRoute(wf.verificationOperationId));
      if (!terminal.has(op.state)) return;
      const j = op.evidence?.junit, git = (await this.workspace(work, true)).git;
      if (op.state !== 'SUCCEEDED' || op.evidence?.sourceCommit !== wf.candidateCommit || op.evidence?.sourceDirty || j?.tests !== 2 || j.failures || j.errors || j.skipped || j.invalidReports?.length ||
          git.headCommit !== wf.candidateCommit || git.status || git.testsChanged.length || git.changedFiles.length !== 1 || git.changedFiles[0] !== work.sourceRecord.sourcePath)
        return this.block(work, '独立验证未通过，或候选提交/测试完整性已变化。请检查日志与差异。');
      return this.update(work, { phase: 'AWAITING_REVIEW', reason: null, verifiedAt: new Date().toISOString() });
    }
  }
  tick() {
    if (this.closed) return Promise.resolve(); if (this.polling) return this.polling;
    this.polling = this.serial(async () => {
      for (const listed of await this.listWorks()) {
        try { await this.step((await this.snapshot(listed.workItemId)).workItem); }
        catch (error) { this.report(error, listed.workItemId); }
      }
    }).finally(() => { this.polling = null; });
    return this.polling;
  }
  async dispose() {
    this.closed = true; await this.client.dispose(); await this.queue;
    await Promise.allSettled([...this.registered.values()].map(dispose => dispose())); this.registered.clear();
  }
}
