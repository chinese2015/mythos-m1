import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export class M2Error extends Error {
  constructor(message, status = 0, code = 'TRANSPORT', stale = false) {
    super(message); this.status = status; this.code = code; this.stale = stale;
  }
}

export class M2Client {
  #token;
  #tokenLoading;
  #pending = new Set();
  #controllers = new Set();
  #closed = false;

  constructor({ baseUrl = 'http://127.0.0.1:13081', owner, tokenFile, timeoutMs = 10000 }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('M2 backend must be a credential-free loopback HTTP origin');
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner) || typeof tokenFile !== 'string') {
      throw new Error('Operator owner and private tokenFile are required');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid M2 timeout');
    this.baseUrl = url.origin; this.owner = owner; this.tokenFile = tokenFile; this.timeoutMs = timeoutMs;
  }

  async #credentials() {
    if (this.#token) return this.#token;
    if (!this.#tokenLoading) this.#tokenLoading = (async () => {
      const file = await open(this.tokenFile, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536) throw new Error('Credential file must be private, regular and bounded');
        const data = JSON.parse(await file.readFile('utf8'));
        const token = data.owners?.[this.owner];
        if (typeof token !== 'string' || token.length < 16) throw new Error('Owner credential is missing');
        this.#token = token;
        return token;
      } finally { await file.close(); }
    })();
    return this.#tokenLoading;
  }

  request(method, path, { body, key, signal } = {}) {
    if (this.#closed) return Promise.reject(new M2Error('M2 client is disposed', 0, 'DISPOSED'));
    if (!path.startsWith('/api/brain/') || path.startsWith('//')) return Promise.reject(new Error('Invalid M2 route'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    this.#controllers.add(controller);
    const promise = (async () => {
      try {
        const token = await this.#credentials();
        if (controller.signal.aborted || this.#closed) throw new Error('aborted');
        const response = await fetch(this.baseUrl + path, {
          method, redirect: 'error', signal: controller.signal,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { controller.abort(); throw new M2Error('M2 response exceeded limit', response.status, 'TOO_LARGE'); }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8').split(token).join('[REDACTED]');
        let value;
        try { value = JSON.parse(raw); }
        catch { throw new M2Error('M2 returned invalid JSON', response.status, 'INVALID_RESPONSE'); }
        if (!response.ok) {
          const code = /^[A-Z_]{1,50}$/.test(value.error?.code) ? value.error.code : 'HTTP_ERROR';
          throw new M2Error(`M2 request failed (${response.status} ${code})`, response.status, code,
            value.error?.message === 'Stale expectedVersion');
        }
        return value;
      } catch (error) {
        if (error instanceof M2Error) throw error;
        if (controller.signal.aborted || this.#closed) {
          throw new M2Error('M2 request interrupted; admission may have succeeded. Inspect work status before submitting a new call.', 0, 'INTERRUPTED');
        }
        throw new M2Error('M2 request unavailable or private credentials invalid', 0, 'UNAVAILABLE');
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#controllers.delete(controller);
      }
    })();
    this.#pending.add(promise);
    promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }

  async dispose() {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    await Promise.allSettled([...this.#pending]);
    this.#token = undefined;
    this.#tokenLoading = undefined;
  }
}
