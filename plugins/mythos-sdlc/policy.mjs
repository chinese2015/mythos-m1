import { createHash } from 'node:crypto';
import { isManagedWork, verifiedTaskCandidate } from '../mythos-workflow/task-spec.mjs';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const legacyRepos = /^\/demo\/demo-(nova-catalog-api|orion-notes-api|pixel-reports-batch)\.git$/;
export function deliveryIdentity(work) {
  const candidateCommit = work.workflow.candidateCommit, verificationOperationId = work.workflow.verificationOperationId;
  if (!/^work-[a-f0-9]{32}$/.test(work.workItemId) || !sha(candidateCommit) || !/^exec-[a-f0-9]{32}$/.test(verificationOperationId)) throw new Error('Invalid task delivery identity');
  if (isManagedWork(work)) {
    const spec = work.taskSpec, repo = spec.repository;
    if (!/^TASK-[0-9a-f]{12}$/.test(work.source.id) || spec.ownerId !== work.ownerId) throw new Error('Invalid task delivery identity');
    if (repo.origin !== 'http://127.0.0.1:13000' || repo.provider !== 'gitea' || repo.cloneUrl !== repo.origin + '/' + repo.fullName + '.git' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo.fullName)) throw new Error('Delivery repository is not in the allowed list');
    if (work.workflow.approval?.specDigest !== spec.specDigest) throw new Error('Approval digest does not match the frozen task policy');
    return { id: createHash('sha256').update(work.workItemId + ':' + candidateCommit + ':' + verificationOperationId).digest('hex'),
      repository: repo.fullName, repositoryUrl: repo.cloneUrl, candidateCommit, verificationOperationId,
      headBranch: `mythos/${work.source.id.toLowerCase()}-${work.workItemId.slice(5, 13)}-${candidateCommit.slice(0, 12)}`, baseBranch: repo.baseBranch };
  }
  if (!/^FND-\d{5}$/.test(work.source.id)) throw new Error('Invalid task delivery identity');
  const url = new URL(work.sourceRecord.repositoryUrl);
  if (url.origin !== 'http://127.0.0.1:13000' || !legacyRepos.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('Delivery repository is not in the allowed list');
  return { id: createHash('sha256').update(work.workItemId + ':' + candidateCommit + ':' + verificationOperationId).digest('hex'),
    repository: url.pathname.slice(1, -4), repositoryUrl: work.sourceRecord.repositoryUrl, candidateCommit, verificationOperationId,
    headBranch: `mythos/${work.source.id.toLowerCase()}-${work.workItemId.slice(5, 13)}-${candidateCommit.slice(0, 12)}`, baseBranch: 'main' };
}
export function verifiedCandidate(work, operation, git) {
  if (isManagedWork(work)) return verifiedTaskCandidate(work, operation, git);
  const wf = work.workflow, evidence = operation?.evidence, j = evidence?.junit, runtime = operation?.runtime;
  return !!(wf.approval && sha(wf.candidateCommit) && operation?.operationId === wf.verificationOperationId && operation.kind === 'VERIFY' && operation.state === 'SUCCEEDED' &&
    operation.sourceCommit === wf.candidateCommit && evidence?.sourceCommit === wf.candidateCommit && evidence.sourceDirty === false &&
    runtime?.freshTargetAbsent === true && runtime.sandboxId !== work.sandboxId && /^sb-[a-z0-9-]+$/.test(runtime.sandboxId) &&
    j?.tests === 2 && j.failures === 0 && j.errors === 0 && j.skipped === 0 && !j.invalidReports?.length &&
    git?.headCommit === wf.candidateCommit && !git.status && git.changedFiles?.length === 1 && git.changedFiles[0] === work.sourceRecord.sourcePath && git.testsChanged?.length === 0);
}
export function pullBody(work, delivery, operation) {
  const source = work.sourceRecord;
  const lines = [`Fix source: ${source.id} · ${source.title}`, '', `Baseline: ${source.baseCommit}`, `Candidate: ${delivery.candidateCommit}`, `Validation: ${delivery.verificationOperationId}`];
  if (isManagedWork(work)) {
    const spec = work.taskSpec, policy = spec.execution.evidence, j = operation?.evidence?.junit;
    lines.push(`Baseline command: ${spec.execution.baselineCommand} (${spec.execution.baselineMode}, timeout ${spec.execution.timeoutSeconds}s)`);
    lines.push(`Validation command: ${spec.execution.verificationCommand} (rerun in a fresh container)`);
    if (policy.format === 'command') lines.push(`Validation result: command mode, exit code ${operation?.evidence?.exitCode ?? 'unknown'}, no JUnit report.`);
    else if (j) lines.push(`Validation result: JUnit ${j.tests} tests / ${j.failures} failures / ${j.errors} errors / ${j.skipped} skipped (at least ${policy.minTests}).`);
    const change = spec.changePolicy;
    lines.push(`Change scope: ${change.allowedPaths.join(', ')} (at most ${change.maxFiles} files${change.allowTestChanges ? ', including approved test changes' : ', no test changes'}).`);
  } else {
    lines.push('Ran mvn clean verify in a fresh isolated container: JUnit 2 tests / 0 failures / 0 errors. Only ' + source.sourcePath + ' was modified; tests and build configuration unchanged.');
  }
  lines.push('', 'Please review and merge in Gitea. This service does not merge automatically. CI and independent-review count gates follow the demo policy; unconfigured items are not treated as passed.');
  return lines.join('\n');
}
export function pullIdentity(delivery, pull) {
  return pull?.head?.ref === delivery.headBranch && pull.head.sha === delivery.candidateCommit && pull.head.repo?.full_name === delivery.repository &&
    pull.base?.ref === delivery.baseBranch && pull.base.repo?.full_name === delivery.repository;
}
export function closureGate(delivery, facts, botLogin) {
  const pr = facts.pull, checks = [], add = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });
  add('verifiedHead', pullIdentity(delivery, pr), 'PR must point to the verified original candidate commit');
  add('humanMerge', pr?.merged === true && sha(pr.merge_commit_sha) && !!pr.merged_by?.login && (!delivery.policy.requireHumanMerge || pr.merged_by.login !== botLogin), 'Awaiting human merge in Gitea');
  add('mergedTree', sha(delivery.candidateTree) && facts.candidateTree === delivery.candidateTree && facts.mergedTree === delivery.candidateTree, 'Merged tree must match the verified code tree');
  const latestReviews = new Map();
  for (const review of [...facts.reviews ?? []].sort((a, b) => a.id - b.id)) if (review.user?.login) latestReviews.set(review.user.login, review);
  const approvals = [...latestReviews.values()].filter(r => r.state === 'APPROVED' && !r.dismissed && !r.stale && r.commit_id === delivery.candidateCommit && r.user.login !== botLogin && r.user.login !== pr?.user?.login).length;
  add('reviewPolicy', approvals >= delivery.policy.minApprovals, delivery.policy.minApprovals ? `Valid independent approvals ${approvals}/${delivery.policy.minApprovals}` : 'Demo policy does not configure an independent review count gate');
  const statuses = new Map(); for (const status of [...facts.statuses ?? []].sort((a,b) => a.id - b.id)) statuses.set(status.context, status.status);
  add('ciPolicy', delivery.policy.requiredStatusContexts.every(context => statuses.get(context) === 'success'), delivery.policy.requiredStatusContexts.length ? 'Check the configured CI contexts' : 'Demo policy does not configure a CI gate; CI pass is not claimed');
  return { allowed: checks.every(c => c.passed), checks };
}
export function factsView(delivery, facts, botLogin) {
  const p = facts.pull;
  return { pull: { number: p.number, url: p.html_url, state: p.state, merged: p.merged, mergedBy: p.merged_by?.login ?? null, mergeCommit: p.merge_commit_sha ?? null,
    headCommit: p.head?.sha, branch: p.head?.ref, baseBranch: p.base?.ref, mergeable: p.mergeable, title: p.title, updatedAt: p.updated_at },
    reviews: (facts.reviews ?? []).map(r => ({ id: r.id, author: r.user?.login, state: r.state, commit: r.commit_id, stale: !!r.stale, dismissed: !!r.dismissed })),
    checks: { state: facts.statuses?.length ? 'RECORDED' : 'NOT_RUN', contexts: (facts.statuses ?? []).map(s => ({ id: s.id, context: s.context, state: s.status })) },
    gate: closureGate(delivery, facts, botLogin) };
}
