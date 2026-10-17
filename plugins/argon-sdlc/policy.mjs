import { createHash } from 'node:crypto';
import { isManagedWork, verifiedTaskCandidate } from '../argon-workflow/task-spec.mjs';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const legacyRepos = /^\/demo\/demo-(nova-catalog-api|orion-notes-api|pixel-reports-batch)\.git$/;
export function deliveryIdentity(work) {
  const candidateCommit = work.workflow.candidateCommit, verificationOperationId = work.workflow.verificationOperationId;
  if (!/^work-[a-f0-9]{32}$/.test(work.workItemId) || !sha(candidateCommit) || !/^exec-[a-f0-9]{32}$/.test(verificationOperationId)) throw new Error('任务交付标识无效');
  if (isManagedWork(work)) {
    const spec = work.taskSpec, repo = spec.repository;
    if (!/^TASK-[0-9a-f]{12}$/.test(work.source.id) || spec.ownerId !== work.ownerId) throw new Error('任务交付标识无效');
    if (repo.origin !== 'http://127.0.0.1:3000' || repo.provider !== 'gitea' || repo.cloneUrl !== repo.origin + '/' + repo.fullName + '.git' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo.fullName)) throw new Error('交付仓库不在允许列表');
    if (work.workflow.approval?.specDigest !== spec.specDigest) throw new Error('审批摘要与冻结任务策略不一致');
    return { id: createHash('sha256').update(work.workItemId + ':' + candidateCommit + ':' + verificationOperationId).digest('hex'),
      repository: repo.fullName, repositoryUrl: repo.cloneUrl, candidateCommit, verificationOperationId,
      headBranch: `argon/${work.source.id.toLowerCase()}-${work.workItemId.slice(5, 13)}-${candidateCommit.slice(0, 12)}`, baseBranch: repo.baseBranch };
  }
  if (!/^FND-\d{5}$/.test(work.source.id)) throw new Error('任务交付标识无效');
  const url = new URL(work.sourceRecord.repositoryUrl);
  if (url.origin !== 'http://127.0.0.1:3000' || !legacyRepos.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('交付仓库不在允许列表');
  return { id: createHash('sha256').update(work.workItemId + ':' + candidateCommit + ':' + verificationOperationId).digest('hex'),
    repository: url.pathname.slice(1, -4), repositoryUrl: work.sourceRecord.repositoryUrl, candidateCommit, verificationOperationId,
    headBranch: `argon/${work.source.id.toLowerCase()}-${work.workItemId.slice(5, 13)}-${candidateCommit.slice(0, 12)}`, baseBranch: 'main' };
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
  const lines = [`修复来源：${source.id} · ${source.title}`, '', `基线：${source.baseCommit}`, `候选：${delivery.candidateCommit}`, `独立验证：${delivery.verificationOperationId}`];
  if (isManagedWork(work)) {
    const spec = work.taskSpec, policy = spec.execution.evidence, j = operation?.evidence?.junit;
    lines.push(`基线命令：${spec.execution.baselineCommand}（${spec.execution.baselineMode}，超时 ${spec.execution.timeoutSeconds}s）`);
    lines.push(`验证命令：${spec.execution.verificationCommand}（新容器中独立执行）`);
    if (policy.format === 'command') lines.push(`验证结果：command 模式，退出码 ${operation?.evidence?.exitCode}，无 JUnit 报告。`);
    else if (j) lines.push(`验证结果：JUnit ${j.tests} tests / ${j.failures} failures / ${j.errors} errors / ${j.skipped} skipped（至少 ${policy.minTests} 项）。`);
    const change = spec.changePolicy;
    lines.push(`变更范围：${change.allowedPaths.join('、')}（最多 ${change.maxFiles} 个文件${change.allowTestChanges ? '，含获批测试变更' : '，无测试变更'}）。`);
  } else {
    lines.push('新的隔离容器中执行 mvn clean verify，JUnit 2 tests / 0 failures / 0 errors。仅修改 ' + source.sourcePath + '，测试与构建配置未变。');
  }
  lines.push('', '请人工审核后在 Gitea 合并。此服务不自动合并。CI 与独立评审数量门禁按演示策略配置，未配置项不视为已通过。');
  return lines.join('\n');
}
export function pullIdentity(delivery, pull) {
  return pull?.head?.ref === delivery.headBranch && pull.head.sha === delivery.candidateCommit && pull.head.repo?.full_name === delivery.repository &&
    pull.base?.ref === delivery.baseBranch && pull.base.repo?.full_name === delivery.repository;
}
export function closureGate(delivery, facts, botLogin) {
  const pr = facts.pull, checks = [], add = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });
  add('verifiedHead', pullIdentity(delivery, pr), 'PR 必须指向已验证的原始候选提交');
  add('humanMerge', pr?.merged === true && sha(pr.merge_commit_sha) && !!pr.merged_by?.login && (!delivery.policy.requireHumanMerge || pr.merged_by.login !== botLogin), '等待 Gitea 人工合并');
  add('mergedTree', sha(delivery.candidateTree) && facts.candidateTree === delivery.candidateTree && facts.mergedTree === delivery.candidateTree, '合并结果必须与验证过的代码树一致');
  const latestReviews = new Map();
  for (const review of [...facts.reviews ?? []].sort((a, b) => a.id - b.id)) if (review.user?.login) latestReviews.set(review.user.login, review);
  const approvals = [...latestReviews.values()].filter(r => r.state === 'APPROVED' && !r.dismissed && !r.stale && r.commit_id === delivery.candidateCommit && r.user.login !== botLogin && r.user.login !== pr?.user?.login).length;
  add('reviewPolicy', approvals >= delivery.policy.minApprovals, delivery.policy.minApprovals ? `有效独立批准 ${approvals}/${delivery.policy.minApprovals}` : '演示策略未配置独立评审数量门禁');
  const statuses = new Map(); for (const status of [...facts.statuses ?? []].sort((a,b) => a.id - b.id)) statuses.set(status.context, status.status);
  add('ciPolicy', delivery.policy.requiredStatusContexts.every(context => statuses.get(context) === 'success'), delivery.policy.requiredStatusContexts.length ? '检查配置的 CI context' : '演示策略未配置 CI 门禁，未宣称 CI 通过');
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
