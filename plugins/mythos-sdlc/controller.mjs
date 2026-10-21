import { GiteaClient } from './gitea.mjs';
import { deliveryIdentity, verifiedCandidate, factsView, pullBody } from './policy.mjs';
import { sessionProgress, conflict } from '../mythos-workflow/rules.mjs';
import { isManagedWork } from '../mythos-workflow/task-spec.mjs';
const route = id => '/api/brain/work-items/' + id;
const active = op => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(op.state);
const canonicalJson = value => {
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return 'null';
  return JSON.stringify(value);
};
export class SdlcController {
  constructor(config, { workflow, forge, source, report = () => {} }) {
    this.workflow = workflow; this.forge = forge ?? new GiteaClient(config); this.source = source ?? workflow.source; this.report = report;
    const minApprovals = config.minApprovals ?? 0, requiredStatusContexts = config.requiredStatusContexts ?? [];
    if (!Number.isInteger(minApprovals) || minApprovals < 0 || minApprovals > 20 || !Array.isArray(requiredStatusContexts) || requiredStatusContexts.length > 20 || requiredStatusContexts.some(s => typeof s !== 'string' || !s.trim() || s.length > 200)) throw new Error('Invalid SDLC gate configuration');
    this.policy = { requireHumanMerge: true, requireIdenticalMergedTree: true, minApprovals, requiredStatusContexts: [...new Set(requiredStatusContexts)] };
    this.closed = false; this.polling = null; this.lastPoll = new Map();
  }
  async eligible(work) {
    const snapshot = await this.workflow.snapshot(work.workItemId);
    if (snapshot.workItem.version !== work.version || work.paused || work.blocked || snapshot.operations.some(active)) throw conflict('Task changed, is paused, or has unconfirmed executions');
    const wf = work.workflow;
    const progress = sessionProgress(await this.workflow.sessions.inspect(wf.codeSessionId), wf.codeRequestId);
    const { items } = await this.workflow.sessions.list({});
    if (!progress.completed || progress.endSequence !== wf.codeEndSequence || progress.latestUserSequence > wf.codeEndSequence || progress.pendingInputs.length || items.some(s => s.sessionId === wf.codeSessionId && s.running)) throw conflict('The coding session has new activity; run Validation again before delivery');
    const operation = await this.workflow.client.request('GET', '/api/brain/operations/' + wf.verificationOperationId);
    const { git } = await this.workflow.workspace(work, true);
    if (!verifiedCandidate(work, operation, git)) throw conflict('Candidate commit is not clean, tests were modified, or Validation evidence is stale');
    return { operation, git };
  }
  publish(id, body, key) { return this.workflow.serial(async () => {
    const { workItem: work } = await this.workflow.snapshot(id), wf = work.workflow;
    if (isManagedWork(work) && wf.approval?.specDigest !== work.taskSpec.specDigest) throw conflict('Approval digest does not match the frozen task policy');
    const identity = deliveryIdentity(work);
    if (typeof this.forge.authorize === 'function') this.forge.authorize([identity.repository]);
    if (wf.delivery?.id === identity.id) {
      if (wf.delivery.step === 'CLOSED_UNMERGED') throw conflict('PR is closed. Send supplementary notes to revise the code and run Validation again before publishing a new candidate');
      return work;
    }
    if (wf.phase !== 'AWAITING_REVIEW' || work.version !== body.expectedVersion) throw conflict('Refresh and confirm the current candidate under review');
    return this.workflow.fence(wf.codeSessionId, async () => {
      await this.eligible(work);
      const policy = isManagedWork(work) ? { ...work.taskSpec.reviewPolicy, requireHumanMerge: true, requireIdenticalMergedTree: true } : this.policy;
      return this.workflow.update(work, { phase: 'PUBLISHING', reason: null, delivery: { ...identity, step: 'PUSH_PENDING', policy,
        requestedBy: work.ownerId, requestedAt: new Date().toISOString(), requestKey: key, attempts: 0, nextAttemptAt: null, lastError: null } });
    });
  }); }
  async save(work, delivery, phase = work.workflow.phase) {
    return this.workflow.update(work, { phase, delivery, reason: null });
  }
  authorizeDelivery(work) {
    if (!isManagedWork(work)) return;
    const identity = deliveryIdentity(work), delivery = work.workflow.delivery;
    if (!delivery || delivery.id !== identity.id || delivery.repository !== identity.repository || delivery.repositoryUrl !== identity.repositoryUrl ||
        delivery.candidateCommit !== identity.candidateCommit || delivery.verificationOperationId !== identity.verificationOperationId ||
        delivery.headBranch !== identity.headBranch || delivery.baseBranch !== identity.baseBranch)
      throw conflict('Delivery identity does not match the frozen task; Gitea was not accessed');
    if (typeof this.forge.authorize === 'function') this.forge.authorize([identity.repository]);
  }
  async fail(workId, deliveryId, error) {
    const { workItem: current } = await this.workflow.snapshot(workId), d = current.workflow.delivery;
    if (!d || d.id !== deliveryId || d.step === 'COMPLETED') return;
    const attempts = (d.attempts ?? 0) + 1;
    await this.save(current, { ...d, attempts, lastError: String(error.message).slice(0, 300), nextAttemptAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 9))).toISOString() });
  }
  closedCurrent(work) {
    const d = work.workflow.delivery;
    return d?.step === 'CLOSED_UNMERGED' && work.workflow.phase === 'AWAITING_REVIEW' &&
      d.candidateCommit === work.workflow.candidateCommit && d.verificationOperationId === work.workflow.verificationOperationId;
  }
  async step(work) {
    const d = work.workflow.delivery;
    const closedCurrent = this.closedCurrent(work);
    if (!d || work.paused || d.step === 'COMPLETED' || (d.step === 'CLOSED_UNMERGED' && !closedCurrent) || (!closedCurrent && !['PUBLISHING', 'PR_OPEN', 'CLOSING'].includes(work.workflow.phase))) return;
    if (d.nextAttemptAt && new Date(d.nextAttemptAt).getTime() > Date.now()) return;
    try {
      this.authorizeDelivery(work);
      if (d.step === 'PUSH_PENDING') {
        await this.eligible(work);
        const result = await this.workflow.client.request('POST', route(work.workItemId) + '/publish-branch', {
          key: this.workflow.key('publish-branch', d.id), body: { expectedVersion: work.version, deliveryId: d.id },
        });
        if (result.deliveryId !== d.id || result.remoteCommit !== d.candidateCommit || result.candidateCommit !== d.candidateCommit || result.branch !== d.headBranch || result.repositoryUrl !== d.repositoryUrl || !/^[a-f0-9]{40}$/.test(result.candidateTree)) throw conflict('Branch publish receipt does not match the candidate commit');
        const current = (await this.workflow.snapshot(work.workItemId)).workItem;
        return this.save(current, { ...d, candidateTree: result.candidateTree, pushReconciled: !!result.reconciled, step: 'CREATE_PR_PENDING', attempts: 0, lastError: null, nextAttemptAt: null });
      }
      if (d.step === 'CREATE_PR_PENDING') {
        await this.eligible(work);
        const operation = await this.workflow.client.request('GET', '/api/brain/operations/' + d.verificationOperationId);
        const body = pullBody(work, d, operation);
        const pr = await this.forge.ensurePull(d.repository, d, `${work.source.id}: ${work.sourceRecord.title}`.slice(0, 220), body);
        if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.html_url !== `${this.forge.baseUrl}/${d.repository}/pulls/${pr.number}`) throw conflict('PR returned an untrusted URL');
        return this.save(work, { ...d, pullNumber: pr.number, pullUrl: pr.html_url, step: 'PR_OPEN', attempts: 0, lastError: null, nextAttemptAt: null }, 'PR_OPEN');
      }
      if (d.step === 'PR_OPEN' || d.step === 'SYNC_SOURCE_PENDING' || closedCurrent) {
        const facts = await this.forge.facts(d.repository, d), view = factsView(d, facts, this.forge.botLogin);
        if (facts.pull.state === 'closed' && facts.pull.merged !== true) {
          if (closedCurrent && canonicalJson(view) === canonicalJson(d.observed) && !d.lastError) return;
          return this.save(work, { ...d, step: 'CLOSED_UNMERGED', observed: view, lastError: null, nextAttemptAt: null }, 'AWAITING_REVIEW');
        }
        if (d.step !== 'SYNC_SOURCE_PENDING') {
          const next = { ...d, step: 'PR_OPEN', observed: view, lastError: null, nextAttemptAt: null };
          if (view.gate.allowed) return this.save(work, { ...next, step: 'SYNC_SOURCE_PENDING', mergeCommit: facts.pull.merge_commit_sha }, 'CLOSING');
          if (closedCurrent || canonicalJson(view) !== canonicalJson(d.observed) || d.lastError) return this.save(work, next, 'PR_OPEN');
          return;
        }
        // A persisted closure intent still rechecks current external facts after restart.
        if (!view.gate.allowed || facts.pull.merge_commit_sha !== d.mergeCommit) throw conflict('External merge facts or gates changed; source task not closed');
        if (isManagedWork(work)) {
          // Manual tasks complete the Work Item only; there is no Finding source to write back.
          return this.save(work, { ...d, observed: view, step: 'COMPLETED', completedAt: new Date().toISOString(), lastError: null, nextAttemptAt: null }, 'COMPLETED');
        }
        const result = await this.source.complete(work, d);
        if (result.status !== 'Resolved' || result.verificationResult !== 'PASSED' || result.codeFixCommit !== d.candidateCommit || result.workItemId !== work.workItemId) throw conflict('Source completion receipt mismatch; work item not completed');
        return this.save(work, { ...d, observed: view, step: 'COMPLETED', sourceSyncedAt: new Date().toISOString(), sourceRevision: result.revision, lastError: null, nextAttemptAt: null }, 'COMPLETED');
      }
    } catch (error) { this.report(error, work.workItemId); await this.fail(work.workItemId, d.id, error); }
  }
  refresh(id, body) { return this.workflow.serial(async () => {
    const { workItem: work } = await this.workflow.snapshot(id);
    if (work.version !== body.expectedVersion) throw conflict('Task state changed; refresh before continuing');
    if (work.workflow.delivery?.step === 'CLOSED_UNMERGED' && !this.closedCurrent(work)) throw conflict('The previous delivery was superseded by new coding or verification; the old candidate will not be restored');
    if (work.workflow.delivery?.nextAttemptAt) {
      const next = await this.save(work, { ...work.workflow.delivery, nextAttemptAt: null }); await this.step(next);
    } else await this.step(work);
    return (await this.workflow.snapshot(id)).workItem;
  }); }
  tick() {
    if (this.closed) return Promise.resolve(); if (this.polling) return this.polling;
    this.polling = this.workflow.serial(async () => {
      for (const listed of await this.workflow.listWorks()) {
        const closedCurrent = this.closedCurrent(listed);
        if (!listed.workflow.delivery || (!closedCurrent && !['PUBLISHING', 'PR_OPEN', 'CLOSING'].includes(listed.workflow.phase))) continue;
        const last = this.lastPoll.get(listed.workItemId) ?? 0;
        if ((closedCurrent || listed.workflow.phase === 'PR_OPEN') && Date.now() - last < 10000) continue;
        this.lastPoll.set(listed.workItemId, Date.now());
        try { await this.step((await this.workflow.snapshot(listed.workItemId)).workItem); } catch (error) { this.report(error, listed.workItemId); }
      }
    }).finally(() => { this.polling = null; }); return this.polling;
  }
  async dispose() { this.closed = true; await this.forge.dispose(); if (this.polling) await this.polling; }
}
