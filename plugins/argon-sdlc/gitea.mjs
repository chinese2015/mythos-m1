import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
export class GiteaError extends Error {
  constructor(message, status = 503, code = 'GITEA_UNAVAILABLE') { super(message); this.status = status; this.code = code; }
}
const collision = () => new GiteaError('Gitea PR 身份或提交不匹配，交付冲突，未创建新 PR', 409, 'IDENTITY_CONFLICT');
export class GiteaClient {
  #auth; #loading; #closed = false; #controllers = new Set();
  #authorized = new Set();
  constructor({ baseUrl = 'http://127.0.0.1:3000', credentialFile, botLogin = 'argon-agent', timeoutMs = 10000 }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Gitea must use a credential-free loopback HTTP origin');
    if (typeof credentialFile !== 'string' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid Gitea configuration');
    this.baseUrl = url.origin; this.credentialFile = credentialFile; this.botLogin = botLogin; this.timeoutMs = timeoutMs;
  }
  // Only ever feed names derived from a trusted frozen snapshot (TaskSpec delivery identity).
  authorize(fullNames) {
    if (!Array.isArray(fullNames) || fullNames.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name) || name.endsWith('.git'))) {
      throw new GiteaError('授权仓库名必须是 owner/repository 形式', 400, 'REPOSITORY_DENIED');
    }
    for (const name of fullNames) this.#authorized.add(name);
  }
  repository(repo) { if (!/^demo\/demo-(nova-catalog-api|orion-notes-api|pixel-reports-batch)$/.test(repo) && !this.#authorized.has(repo)) throw new GiteaError('仓库不在允许列表', 400, 'REPOSITORY_DENIED'); return '/repos/' + repo; }
  async credentials() {
    if (this.#auth) return this.#auth;
    this.#loading ??= (async () => {
      try {
        const file = await open(this.credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat(); if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536) throw new Error();
          const value = JSON.parse(await file.readFile('utf8'));
          if (value.username !== this.botLogin || typeof value.password !== 'string' || value.password.length < 16) throw new Error();
          this.#auth = 'Basic ' + Buffer.from(value.username + ':' + value.password).toString('base64'); return this.#auth;
        } finally { await file.close(); }
      } catch { throw new GiteaError('Gitea 自动化凭据不可用', 503, 'CREDENTIALS_UNAVAILABLE'); }
    })(); return this.#loading;
  }
  async request(method, path, body) {
    if (this.#closed) throw new GiteaError('Gitea client disposed');
    if (!path.startsWith('/repos/demo/') || /[\r\n#]/.test(path) || path.includes('..')) throw new GiteaError('Invalid Gitea route', 400);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs); this.#controllers.add(controller);
    try {
      const authorization = await this.credentials();
      const response = await fetch(this.baseUrl + '/api/v1' + path, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { await response.body?.cancel(); throw new GiteaError(`Gitea request failed (${response.status})`, response.status); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) { controller.abort(); throw new GiteaError('Gitea response exceeded limit'); } chunks.push(chunk); }
      try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new GiteaError('Gitea returned invalid JSON'); }
    } catch (error) { if (error instanceof GiteaError) throw error; throw new GiteaError('Gitea 请求未确认；下一轮先对账，不直接重放写入'); }
    finally { clearTimeout(timer); this.#controllers.delete(controller); }
  }
  async pages(path) {
    const rows = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.request('GET', path + (path.includes('?') ? '&' : '?') + `limit=100&page=${page}`);
      if (!Array.isArray(result)) throw new GiteaError('Gitea pagination response invalid');
      rows.push(...result); if (result.length === 0) return rows;
    }
    throw new GiteaError('Gitea 对账结果超过范围，未创建新的 PR', 503, 'INCOMPLETE_RECONCILIATION');
  }
  async listPulls(repo) { return this.pages(this.repository(repo) + '/pulls?state=all&sort=oldest'); }
  validatePull(repo, d, pr, marker = true) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.html_url !== `${this.baseUrl}/${repo}/pulls/${pr.number}` ||
        pr.head?.ref !== d.headBranch || pr.head?.sha !== d.candidateCommit || pr.head?.repo?.full_name !== repo || pr.base?.ref !== d.baseBranch || pr.base?.repo?.full_name !== repo ||
        (marker && (!pr.body?.includes(`<!-- argon-delivery:${d.id} -->`) || pr.user?.login !== this.botLogin))) throw collision();
    return pr;
  }
  async findPull(repo, delivery) {
    const rows = (await this.listPulls(repo)).filter(pr => pr.head?.ref === delivery.headBranch || pr.body?.includes(`<!-- argon-delivery:${delivery.id} -->`));
    if (rows.length > 1) throw collision();
    return rows.length ? this.validatePull(repo, delivery, rows[0]) : null;
  }
  async ensurePull(repo, delivery, title, body) {
    const existing = await this.findPull(repo, delivery); if (existing) return existing;
    return this.validatePull(repo, delivery, await this.request('POST', this.repository(repo) + '/pulls', {
      head: delivery.headBranch, base: delivery.baseBranch, title, body: `<!-- argon-delivery:${delivery.id} -->\n\n${body}`, allow_maintainer_edit: false,
    }));
  }
  async tree(repo, commit) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw collision();
    const value = await this.request('GET', this.repository(repo) + '/git/commits/' + commit), tree = value.commit?.tree?.sha;
    if (value.sha !== commit || !/^[a-f0-9]{40}$/.test(tree)) throw new GiteaError('Gitea commit tree unavailable'); return tree;
  }
  async statuses(repo, commit) {
    const rows = [];
    for (let page = 1; page <= 20; page++) {
      const value = await this.request('GET', this.repository(repo) + '/commits/' + commit + `/status?limit=100&page=${page}`);
      const pageRows = value.statuses === null ? [] : value.statuses;
      if (value.sha !== commit || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(pageRows)) throw new GiteaError('Gitea CI 状态不完整，未推进关闭');
      rows.push(...pageRows);
      if (rows.length >= value.total_count) return rows;
      if (!pageRows.length) throw new GiteaError('Gitea CI 分页未对账完成，未推进关闭');
    }
    throw new GiteaError('Gitea CI 状态超过对账范围，未推进关闭');
  }
  async facts(repo, delivery) {
    const pr = this.validatePull(repo, delivery, await this.request('GET', this.repository(repo) + '/pulls/' + delivery.pullNumber), false);
    const [reviews, statuses, candidateTree, mergedTree] = await Promise.all([
      this.pages(this.repository(repo) + '/pulls/' + pr.number + '/reviews'),
      this.statuses(repo, delivery.candidateCommit),
      this.tree(repo, delivery.candidateCommit), pr.merged ? this.tree(repo, pr.merge_commit_sha) : Promise.resolve(null),
    ]);
    return { pull: pr, reviews, statuses, candidateTree, mergedTree };
  }
  async dispose() { this.#closed = true; for (const c of this.#controllers) c.abort(); this.#auth = undefined; }
}
