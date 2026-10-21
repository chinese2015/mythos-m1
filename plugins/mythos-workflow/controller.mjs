import { createHash } from 'node:crypto';
import { M2Client } from '../mythos-brain/client.mjs';
import { FindingSource, sourceRecord } from './source.mjs';
import { sessionProgress, assertApproval, baselineReproduced, baselineExpectations, conflict, transcript } from './rules.mjs';
import { findingBinding } from '../mythos-subscribe/triage.mjs';
import { taskPreset } from './session-policy.mjs';
import { isManagedWork, effectivePolicy, candidateAllowed, baselineReady, verifiedTaskCandidate } from './task-spec.mjs';
import { TaskIntake } from './intake.mjs';

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
    this.intake = new TaskIntake(this.client);
    this.registered = new Map(); this.workspaceCache = new Map(); this.queue = Promise.resolve(); this.polling = null; this.closed = false;
    this.workState = new Map(); this.inputFences = new Set();
  }
  inputRejection(workId, role, sessionId) {
    if (this.closed) return 'Task workflow is temporarily unavailable';
    const work = this.workState.get(workId);
    if (this.inputFences.has(sessionId)) return 'A task decision is in progress, retry the input shortly';
    if (!work) return 'Task state is loading, retry the input shortly';
    if (work.paused) return 'Resume the workflow from the Task Workspace first';
    if (role === 'PLAN' && work.workflow.approval) return 'Plan approved; send follow-up notes to the coding session';
    if (role === 'CODE' && (!work.workflow.approval || work.workflow.phase !== 'CODING')) return 'Input during coding would invalidate verification; send supplementary notes from the Task Workspace';
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
    if (!/^work-[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('Work item not found'), { status: 404 });
    const snap = await this.client.request('GET', route(id));
    const type = snap.workItem.source?.type;
    if (snap.workItem.ownerId !== this.owner || !['MYTHOS', 'MANUAL'].includes(type) || !snap.workItem.sourceRecord || !snap.workItem.workflow) throw Object.assign(new Error('Work item not found'), { status: 404 });
    this.remember(snap.workItem);
    return snap;
  }
  async listWorks() { return (await this.client.request('GET', '/api/brain/work-items')).workItems.filter(w => ['MYTHOS', 'MANUAL'].includes(w.source?.type) && w.sourceRecord && w.workflow); }
  async tasks() {
    const [tasks, works, { intakes }] = await Promise.all([this.source.list(), this.listWorks(), this.client.request('GET', '/api/brain/source-intakes')]);
    const rows = tasks.map(task => { const work = works.find(w => w.source.id === task.id), intake = intakes.find(i => i.findingId === task.id) ?? null; return { ...task,
      intake, startable: !!work || !!(task.enabled && intake?.state === 'APPROVED' && intake.triage?.result === 'CONFIRMED' && intake.decision?.binding === findingBinding(task)),
      ...(work ? { workItemId: work.workItemId, workStage: work.paused ? 'PAUSED' : work.workflow?.phase } : {}) }; });
    for (const work of works.filter(isManagedWork)) {
      if (rows.some(row => row.workItemId === work.workItemId)) continue;
      const record = work.sourceRecord;
      rows.push({ id: work.source.id, title: record.title, description: record.description ?? '', ownerId: record.ownerId,
        repositoryUrl: record.repositoryUrl, baseCommit: record.baseCommit, revision: record.revision, manual: true, enabled: true,
        workItemId: work.workItemId, workStage: work.paused ? 'PAUSED' : work.workflow?.phase, startable: true });
    }
    return { tasks: rows, operator: { id: this.owner, label: 'Demo operator ' + this.owner } };
  }
  start(id, body, key) { return this.serial(async () => {
    const existing = (await this.listWorks()).find(w => w.source.id === id);
    if (existing) return existing;
    const task = await this.source.get(id);
    if (!task?.enabled) throw conflict('This source task is not open for execution yet, or the repository baseline has changed');
    const { intakes } = await this.client.request('GET', '/api/brain/source-intakes');
    const intake = intakes.find(i => i.findingId === id);
    if (intake?.state !== 'APPROVED' || intake.triage?.result !== 'CONFIRMED' || intake.decision?.binding !== findingBinding(task)) throw conflict('Wait for the Owner to approve takeover in the Task Center');
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
      result.session = { sessionId: sid, role, running: !!row?.running, activity: progress.completed ? 'Round complete' : row?.running ? 'Agent running' : 'Awaiting input',
        transcript: transcript(inspected), url: '/?mythosSession=' + encodeURIComponent(sid) + '&mythosEmbedded=1' };
    }
    return result;
  }
  approve(id, body, key) { return this.serial(async () => {
    const snap = await this.snapshot(id), work = snap.workItem, wf = work.workflow;
    // A stored decision whose specDigest drifted from the immutable frozen TaskSpec means
    // tampering, not a stale plan: block even a fresh approval request. A legitimately
    // changed plan requires a new Work Item; do not reorder this before the replay check.
    if (isManagedWork(work) && wf.approval && wf.approval.specDigest !== work.taskSpec.specDigest) throw conflict('The frozen task policy changed; refresh and approve again');
    // A replay is valid only for the exact approval decision already stored.
    if (wf.approval?.key === key && wf.approval.planHash === body.planHash && wf.approval.expectedVersion === body.expectedVersion) return work;
    if (!wf.planSessionId) throw conflict('The read-only plan is not complete yet');
    return this.fence(wf.planSessionId, async () => {
    const progress = sessionProgress(await this.sessions.inspect(wf.planSessionId), wf.planRequestId);
    assertApproval(snap, body, progress);
    if (work.paused) throw conflict('Resume the workflow first');
    const git = (await this.workspace(work, true)).git;
    if (git.headCommit !== work.sourceRecord.baseCommit || git.status || git.changedFiles.length) throw conflict('Workspace changed before approval; manual inspection required');
    return this.update(work, { phase: 'CODING', reason: null, approval: { actor: this.owner, approvedAt: new Date().toISOString(), planHash: body.planHash, expectedVersion: body.expectedVersion, key,
      ...(isManagedWork(work) ? { specDigest: work.taskSpec.specDigest } : {}) },
      pendingMessage: null, codeSessionId: identity(work, 'CODE'), codeRequestId: this.key('prompt', id, 'CODE', 1) }, { blocked: false, key: this.key('approve', id, key) });
    });
  }); }
  pause(id, paused, body, key) { return this.serial(async () => {
    const { workItem } = await this.snapshot(id);
    if (!paused && workItem.workflow.phase === 'BLOCKED') throw conflict('Task is blocked. Check the reason; if the session was interrupted, send supplementary notes to continue explicitly; if the execution state is unknown, inspect the sandbox first');
    const result = await this.client.request('POST', route(id) + (paused ? '/pause' : '/resume'), { key: this.key('pause', id, key), body });
    this.remember(result); return result;
  }); }
  message(id, body, key) { return this.serial(async () => {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw Object.assign(new Error('Enter supplementary notes of 1–16000 characters'), { status: 400 });
    const snap = await this.snapshot(id), work = snap.workItem, wf = work.workflow;
    if (work.paused || snap.operations.some(o => o.state === 'UNKNOWN')) throw conflict('Inspect or resume the paused/unknown execution first');
    if (['PUBLISHING', 'PR_OPEN', 'CLOSING', 'COMPLETED'].includes(wf.phase)) throw conflict('The current candidate is being delivered, under review, or completed. To modify it, close the unmerged PR in Gitea first, then send supplementary notes');
    const role = wf.approval ? 'CODE' : 'PLAN'; const sid = wf[role.toLowerCase() + 'SessionId'];
    if (!sid || !work.sessionIds.includes(sid)) throw conflict('No active work session can receive notes right now');
    const requestId = this.key('message', id, key);
    if (wf.pendingMessage && wf.pendingMessage.requestId !== requestId && !(role === 'CODE' && wf.pendingMessage.requestId === wf.planRequestId)) {
      const previous = sessionProgress(await this.sessions.inspect(sid), wf.pendingMessage.requestId);
      if (!previous.found) throw conflict('The previous supplementary note is still being delivered; send again shortly');
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
    if (!/^exec-[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('Operation not found'), { status: 404 });
    const op = await this.client.request('GET', opRoute(id)); await this.snapshot(op.workItemId); return op;
  }
  async logs(id, after) { await this.operation(id); return this.client.request('GET', opRoute(id) + '/logs?after=' + after + '&limit=100'); }
  async events(id, after) { const { workItem } = await this.snapshot(id); return this.client.request('GET', route(workItem.workItemId) + '/events?after=' + after + '&limit=200'); }
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
      await this.sessions.rename({ sessionId: sid, title: work.source.id + (role === 'PLAN' ? ' · Plan' : ' · Code') });
    }
    return work;
  }
  prompt(work, role) {
    const wf = work.workflow, source = work.sourceRecord;
    if (wf.pendingMessage?.requestId === wf[role.toLowerCase() + 'RequestId']) return wf.pendingMessage.text;
    if (isManagedWork(work)) return this.managedPrompt(work, role);
    const expected = baselineExpectations[source.id]?.join(', ') ?? 'Consult the JUnit evidence of the baseline operation';
    const context = `Task ${source.id}: ${source.title}\nRepository baseline ${source.baseCommit}\nOnly ${source.sourcePath} may be modified. Reading the reference fix branch is forbidden; do not modify tests, POM, or build configuration, and do not create PRs.\nReproduced real failing tests: ${expected}.`;
    return role === 'PLAN' ? `${context}\nUse read-only tools to inspect the source and existing tests, then output a concrete change plan, risks, and validation steps, and wait for human approval when done.` :
      `${context}\nA human has approved the plan:\n${wf.plan}\nActually complete the source modification, keep the existing tests unchanged, run the necessary tests, and commit your changes with git; finally report the commit SHA and test facts. The workflow will run independent clean verification in a fresh container.`;
  }
  managedPrompt(work, role) {
    const wf = work.workflow, spec = work.taskSpec, policy = effectivePolicy(work);
    const scope = `Allowed change scope: ${policy.allowedPaths.join(', ')} (at most ${policy.maxFiles} files${policy.allowTestChanges ? ', test changes allowed within the approved scope' : ', test changes not allowed'})`;
    const context = `Task ${work.source.id}: ${spec.task.title}\nRepository ${spec.repository.fullName} baseline ${spec.baseCommit} (branch ${spec.repository.baseBranch})\n${scope}.\n` +
      `Baseline command: ${spec.execution.baselineCommand} (${spec.execution.baselineMode}); verification command: ${spec.execution.verificationCommand} (timeout ${spec.execution.timeoutSeconds}s).\n` +
      `Description: ${spec.task.description}\nAcceptance criteria: ${spec.task.acceptanceCriteria}`;
    return role === 'PLAN' ? `${context}\nUse read-only tools to inspect the source, then output a concrete change plan, risks, and validation steps, and wait for human approval when done.` :
      `${context}\nA human has approved the plan:\n${wf.plan}\nActually complete the changes within that scope (multiple files allowed), run the verification command, and commit your changes with git; finally report the commit SHA and the real test facts. The workflow will run independent verification of the frozen verification command in a fresh container.`;
  }
  async observe(work, role) {
    work = await this.ensureSession(work, role);
    const wf = work.workflow, sid = wf[role.toLowerCase() + 'SessionId'], requestId = wf[role.toLowerCase() + 'RequestId'];
    const inspected = await this.sessions.inspect(sid), progress = sessionProgress(inspected, requestId);
    if (!progress.found) {
      await this.sessions.prompt({ sessionId: sid, requestId, mode: 'queue', content: [{ type: 'text', text: this.prompt(work, role) }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
      return;
    }
    if (progress.failed) return this.block(work, 'DSH session did not complete this round: ' + progress.reason + '. Send supplementary notes to continue explicitly.');
    if (wf.pendingMessage?.requestId === requestId) return this.update(work, { pendingMessage: null });
    if (!progress.completed) {
      if (progress.pending) return;
      const { items } = await this.sessions.list({}); const row = items.find(x => x.sessionId === sid);
      if (row && !row.running) return this.block(work, 'DSH session was interrupted and not auto-replayed. Send supplementary notes to continue explicitly.');
      return;
    }
    if (progress.latestUserSequence > progress.endSequence) {
      const latest = inspected.events.filter(e => e.type === 'user/message').at(-1);
      if (latest.data?.source?.rpcId) return this.update(work, { [role.toLowerCase() + 'RequestId']: latest.data.source.rpcId });
      return this.block(work, 'The session has new human input; send notes to clarify the next step');
    }
    if (role === 'PLAN') {
      if (!progress.text.trim()) return this.block(work, 'The planning session produced no approvable plan');
      const git = (await this.workspace(work, true)).git;
      if (git.headCommit !== work.sourceRecord.baseCommit || git.status || git.changedFiles.length) return this.block(work, 'Workspace changed during planning; manual inspection required');
      return this.update(work, { phase: 'AWAITING_PLAN_APPROVAL', plan: progress.text, planHash: hash([sid, requestId, progress.endSequence, progress.text]), planEndSequence: progress.endSequence });
    }
    const snap = await this.snapshot(work.workItemId);
    if (snap.operations.some(op => !terminal.has(op.state))) return;
    const git = (await this.workspace(work, true)).git;
    if (git.headCommit === work.sourceRecord.baseCommit || git.status || !candidateAllowed(snap.workItem, git))
      return this.block(snap.workItem, isManagedWork(snap.workItem)
        ? 'Coding finished, but the candidate must be committed, the workspace clean, and all changes within the frozen task scope. Send notes to fix and continue.'
        : 'Coding finished, but the candidate must be committed, the workspace clean, and only the designated source file modified. Send notes to fix and continue.');
    return this.update(snap.workItem, { phase: 'VERIFYING', candidateCommit: git.headCommit, codeEndSequence: progress.endSequence, verificationOperationId: null }, { blocked: false });
  }
  async block(work, reason) { return this.update(work, { returnPhase: work.workflow.phase, phase: 'BLOCKED', reason }, { blocked: true }); }
  async submitFixed(work, kind, command, slot, sourceCommit, timeoutSeconds = 300) {
    const op = await this.client.request('POST', route(work.workItemId) + '/operations', {
      key: this.key('fixed-operation', work.workItemId, slot, slot === 'baselineOperationId' ? 1 : work.workflow.codeRequestId),
      body: { command, kind, timeoutSeconds, sourceCommit, expectedVersion: work.version } });
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
    const wf = work.workflow, managed = isManagedWork(work), execution = managed ? work.taskSpec.execution : null;
    if (wf.phase === 'CLAIMED') {
      if (managed) return this.update(work, { phase: 'PREPARING' });
      if (!wf.sourceClaimed) { await this.source.claim(work); return this.update(work, { sourceClaimed: true, phase: 'PREPARING' }); }
      return this.update(work, { phase: 'PREPARING' });
    }
    if (wf.phase === 'PREPARING') {
      const prepared = await this.client.request('POST', route(work.workItemId) + '/prepare', { key: this.key('prepare', work.workItemId), body: { expectedVersion: work.version } });
      if (prepared.sandboxId) return this.update(prepared, { phase: 'BASELINE' });
      if (['FAILED', 'UNKNOWN'].includes(prepared.workspaceProvision?.state)) return this.block(prepared, 'Workspace preparation failed: ' + prepared.workspaceProvision.error);
      return;
    }
    if (wf.phase === 'BASELINE') {
      if (!wf.baselineOperationId) return this.submitFixed(work, 'UNIT_TEST', managed ? execution.baselineCommand : 'mvn -B -o -s .cache/settings.xml test',
        'baselineOperationId', work.sourceRecord.baseCommit, managed ? execution.timeoutSeconds : 300);
      const op = await this.client.request('GET', opRoute(wf.baselineOperationId));
      if (!terminal.has(op.state)) return;
      if (!baselineReady(work, op)) return this.block(work, managed
        ? 'Baseline execution is not ready: unknown results or environment failures cannot proceed to triage. Check the operation logs and environment.'
        : 'Baseline tests did not reproduce the expected failure; check the operation logs and environment. Environment errors were not counted as vulnerability reproduction.');
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
        return this.block(work, 'The coding session had new activity during verification; the stale verification result will not be published for review. Send notes from the Task Workspace to continue.');
      if (!wf.verificationOperationId) return this.submitFixed(work, 'VERIFY', managed ? execution.verificationCommand : 'mvn -B -o -s .cache/settings.xml clean verify',
        'verificationOperationId', wf.candidateCommit, managed ? execution.timeoutSeconds : 300);
      const op = await this.client.request('GET', opRoute(wf.verificationOperationId));
      if (!terminal.has(op.state)) return;
      const git = (await this.workspace(work, true)).git;
      if (managed) {
        if (!verifiedTaskCandidate(work, op, git))
          return this.block(work, 'Independent verification did not pass: the command, candidate commit, fresh-environment evidence, or report count does not satisfy the frozen task policy. Check the logs and the diff.');
      } else {
        const j = op.evidence?.junit;
        if (op.state !== 'SUCCEEDED' || op.evidence?.sourceCommit !== wf.candidateCommit || op.evidence?.sourceDirty || j?.tests !== 2 || j.failures || j.errors || j.skipped || j.invalidReports?.length ||
            git.headCommit !== wf.candidateCommit || git.status || git.testsChanged.length || git.changedFiles.length !== 1 || git.changedFiles[0] !== work.sourceRecord.sourcePath)
          return this.block(work, 'Independent verification did not pass, or the candidate commit or test integrity changed. Check the logs and the diff.');
      }
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
