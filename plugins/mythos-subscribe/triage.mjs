import { createHash } from 'node:crypto';
export function findingBinding(row) {
  return createHash('sha256').update(JSON.stringify([row.id, row.ownerId, row.repositoryUrl, row.baseCommit, row.sourcePath])).digest('hex');
}
export function triageFinding(row, mapping) {
  const reasons = [];
  if (!mapping) reasons.push('来源不在已映射资产内');
  else {
    const [repo, commit, path] = mapping;
    if (row.repositoryUrl !== `http://127.0.0.1:3000/demo/${repo}.git`) reasons.push('仓库地址与登记不一致');
    if (row.baseCommit !== commit) reasons.push('仓库基线已变化');
    if (row.sourcePath !== path) reasons.push('源文件路径与登记不一致');
  }
  if (!['HIGH', 'CRITICAL'].includes(row.risk)) reasons.push('风险等级不符合自动接管条件');
  if (row.status !== 'Not Started' || row.closed === 'Closed' || row.workItemId) reasons.push('来源已关闭或已有处理记录');
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(row.ownerId ?? '')) reasons.push('缺少有效的 Owner');
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) reasons.push('来源修订无效');
  return { result: reasons.length ? 'NEEDS_REVIEW' : 'CONFIRMED', reasons, binding: findingBinding(row) };
}
