import { createHash } from 'node:crypto';
export function findingBinding(row) {
  return createHash('sha256').update(JSON.stringify([row.id, row.ownerId, row.repositoryUrl, row.baseCommit, row.sourcePath])).digest('hex');
}
export function triageFinding(row, mapping) {
  const reasons = [];
  if (!mapping) reasons.push('Source is not in a mapped asset');
  else {
    const [repo, commit, path] = mapping;
    if (row.repositoryUrl !== `http://127.0.0.1:13000/demo/${repo}.git`) reasons.push('Repository URL does not match registration');
    if (row.baseCommit !== commit) reasons.push('Repository baseline has changed');
    if (row.sourcePath !== path) reasons.push('Source file path does not match registration');
  }
  if (!['HIGH', 'CRITICAL'].includes(row.risk)) reasons.push('Risk level does not meet auto-takeover criteria');
  if (row.status !== 'Not Started' || row.closed === 'Closed' || row.workItemId) reasons.push('Source is closed or already handled');
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(row.ownerId ?? '')) reasons.push('Missing a valid owner');
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) reasons.push('Invalid source revision');
  return { result: reasons.length ? 'NEEDS_REVIEW' : 'CONFIRMED', reasons, binding: findingBinding(row) };
}
