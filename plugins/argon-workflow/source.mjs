export const mappings = {
  'FND-00003': ['demo-orion-notes-api', '2ce309f4dd7a39a22fcce59ad4309a50e1df237e', 'src/main/java/com/example/notes/AppConfig.java'],
  'FND-00009': ['demo-nova-catalog-api', '7fd32b0535fac3f6ce105a8494e2dcbba7ce355b', 'src/main/java/com/example/catalog/CatalogSearchService.java'],
  'FND-00015': ['demo-pixel-reports-batch', '0a67ffc801aad448a0992ba84aabc5d47d63c478', 'src/main/java/com/example/reports/ReportImporter.java'],
};
export function normalizeFinding(row) {
  const mapping = mappings[row?.id];
  if (!mapping) return null;
  const [repo, commit, path] = mapping;
  const exact = row.repositoryUrl === `http://127.0.0.1:3000/demo/${repo}.git` && row.baseCommit === commit && row.sourcePath === path;
  return { id: row.id, title: String(row.name ?? row.title ?? row.id), risk: String(row.risk ?? ''),
    ownerId: String(row.ownerId ?? ''), ownerTeamsId: String(row.ownerTeamsId ?? ''), repositoryUrl: String(row.repositoryUrl ?? ''), baseCommit: String(row.baseCommit ?? ''),
    sourcePath: String(row.sourcePath ?? ''), revision: row.revision, status: String(row.status ?? ''),
    description: String(row.category ?? row.description ?? ''), enabled: exact && ['HIGH', 'CRITICAL'].includes(row.risk) && row.status === 'Not Started' && row.closed !== 'Closed' && !row.workItemId };
}
export function sourceRecord(task) {
  const { id, title, risk, ownerId, repositoryUrl, baseCommit, sourcePath, revision, description } = task;
  return { id, title, risk, ownerId, repositoryUrl, baseCommit, sourcePath, revision, description };
}
export class FindingSource {
  constructor(baseUrl = 'http://127.0.0.1:8080') {
    if (baseUrl !== 'http://127.0.0.1:8080') throw new Error('Only the configured local demo source is supported');
    this.baseUrl = baseUrl;
  }
  async request(path, method = 'GET', body) {
    const response = await fetch(this.baseUrl + path, { method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Finding source unavailable (' + response.status + ')');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Finding response too large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async list() { return (await Promise.all(Object.keys(mappings).map(id => this.get(id)))).filter(Boolean); }
  async get(id) { if (!mappings[id]) return null; return normalizeFinding(await this.request('/api/findings/' + id)); }
  async claim(work) {
    return this.request('/api/findings/' + work.source.id, 'PATCH', { status: 'In Progress', workItemId: work.workItemId, remediationJobId: work.workItemId });
  }
  async complete(work, delivery) {
    if (!mappings[work.source.id]) throw Object.assign(new Error('409 来源不在允许列表'), { status: 409 });
    const latest = await this.request('/api/findings/' + work.source.id), record = work.sourceRecord;
    const bound = latest.workItemId === work.workItemId && latest.remediationJobId === work.workItemId &&
      ['ownerId', 'repositoryUrl', 'baseCommit', 'sourcePath'].every(key => latest[key] === record[key]);
    const target = { workItemId: work.workItemId, ownerId: record.ownerId, repositoryUrl: record.repositoryUrl,
      baseCommit: record.baseCommit, sourcePath: record.sourcePath, codeFixCommit: delivery.candidateCommit, prUrl: delivery.pullUrl };
    const completed = value => value.status === 'Resolved' && value.closed === 'Closed' && value.verificationResult === 'PASSED' &&
      Object.entries(target).every(([key, expected]) => value[key] === expected) && value.remediationJobId === work.workItemId;
    if (!bound || (latest.status !== 'In Progress' && !completed(latest))) throw Object.assign(new Error('409 来源归属、状态或仓库映射已变化，未回写关闭'), { status: 409 });
    if (completed(latest)) return latest;
    const result = await this.request('/api/findings/' + work.source.id + '/ai-completion', 'POST', { expectedRevision: latest.revision, ...target });
    if (!completed(result)) throw Object.assign(new Error('409 来源原子完成回执不匹配'), { status: 409 });
    return result;
  }
}
