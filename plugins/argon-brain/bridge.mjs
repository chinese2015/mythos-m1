import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { M2Client } from './client.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const route = id => '/api/brain/work-items/' + id;
const opRoute = id => '/api/brain/operations/' + id;

export class BrainBridge {
  constructor(config, { sessions, workspaces, emit = () => {} } = {}) {
    if (!config.owners || !Object.keys(config.owners).length) throw new Error('Configured owners are required');
    this.config = config; this.sessions = sessions; this.workspaces = workspaces; this.emit = emit;
    this.clients = new Map(); this.bindings = new Map(); this.closed = false; this.polling = null; this.lastRestore = 0;
    this.deliveries = new Set();
    for (const [owner, profile] of Object.entries(config.owners)) {
      if (!/^sb-[a-z0-9-]+$/.test(profile.sandboxId) || !isAbsolute(profile.workspacePath) ||
          profile.preset !== 'argon-' + owner) throw new Error('Invalid operator sandbox/preset binding');
      this.clients.set(owner, new M2Client({ ...config, owner }));
    }
  }

  alive() { if (this.closed) throw new Error('argon-brain plugin is disposed'); }
  client(owner) { this.alive(); const client = this.clients.get(owner); if (!client) throw new Error('Owner unavailable'); return client; }
  sessionId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new Error('A trusted DSH Session id is required');
    return value;
  }
  key(action, owner, sessionId, callId) {
    if (typeof callId !== 'string' || !callId || callId.length > 200) throw new Error('A stable DSH callId is required');
    return 'dsh-' + hash([action, owner, sessionId, callId]);
  }
  async deliver(topic, payload) {
    if (this.closed) return false;
    let cancel;
    const disposed = new Promise(resolve => { cancel = () => resolve(false); });
    this.deliveries.add(cancel);
    try {
      const delivered = Promise.resolve().then(() => {
        if (this.closed) return false;
        return Promise.resolve(this.emit(topic, payload)).then(() => !this.closed);
      }).catch(() => false);
      return await Promise.race([delivered, disposed]);
    } finally { this.deliveries.delete(cancel); }
  }
  error(owner, error, sessionId) {
    return this.deliver('argon-brain/error', { ownerId: owner, ...(sessionId ? { sessionId } : {}),
      code: error.code ?? 'ADAPTER_ERROR', status: error.status ?? 0 });
  }

  validateWork(owner, sessionId, work) {
    const legacy = work.sessionId === sessionId && work.sandboxId === this.config.owners[owner]?.sandboxId &&
      work.source?.type === 'DIRECT' && work.source?.id === 'DSH:' + sessionId && work.source?.revision === 1;
    const task = work.source?.type === 'ARGON' && work.sessionIds?.includes(sessionId) && /^sb-[a-z0-9-]+$/.test(work.sandboxId);
    const manual = work.source?.type === 'MANUAL' && typeof work.taskSpec?.specDigest === 'string' &&
      work.sessionIds?.includes(sessionId) && /^sb-[a-z0-9-]+$/.test(work.sandboxId);
    if (work.ownerId !== owner || (!legacy && !task && !manual) || !/^work-[0-9a-f]{32}$/.test(work.workItemId))
      throw new Error('Persisted Session binding is unavailable or mismatched');
  }

  async watch(owner, sessionId, work, signal) {
    this.alive(); this.validateWork(owner, sessionId, work);
    const key = owner + ':' + sessionId;
    let binding = this.bindings.get(key);
    if (!binding) {
      binding = { owner, sessionId, workItemId: work.workItemId, cursor: null };
      this.bindings.set(key, binding);
    }
    if (binding.cursor === null) await this.publishSnapshot(binding, signal);
    this.alive();
    return binding;
  }

  async publishSnapshot(binding, signal) {
    const snapshot = await this.client(binding.owner).request('GET', route(binding.workItemId), { signal });
    this.alive(); this.validateWork(binding.owner, binding.sessionId, snapshot.workItem);
    if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0) throw new Error('Invalid snapshot cursor');
    if (await this.deliver('argon-brain/snapshot', { ownerId: binding.owner, sessionId: binding.sessionId,
      workItemId: binding.workItemId, snapshot })) binding.cursor = snapshot.cursor;
  }

  async binding(owner, sessionId, create = false, signal) {
    this.sessionId(sessionId);
    const client = this.client(owner); const key = owner + ':' + sessionId;
    if (this.bindings.has(key)) return this.bindings.get(key);
    const records = await client.request('GET', '/api/brain/work-items', { signal });
    this.alive();
    const matches = records.workItems.filter(w => w.sessionId === sessionId || w.sessionIds?.includes(sessionId) || w.source?.id === 'DSH:' + sessionId);
    if (matches.length > 1) throw new Error('Ambiguous Session binding');
    let work = matches[0];
    if (!work && create) {
      work = await client.request('POST', '/api/brain/work-items', { signal,
        key: this.key('bind', owner, sessionId, 'binding-v1'),
        body: { source: { type: 'DIRECT', id: 'DSH:' + sessionId, revision: 1 },
          sandboxId: this.config.owners[owner].sandboxId, sessionId },
      });
    }
    return work ? this.watch(owner, sessionId, work, signal) : null;
  }

  async snapshot(owner, sessionId, signal) {
    const binding = await this.binding(owner, sessionId, false, signal);
    if (!binding) return { bound: false, sessionId, sandboxId: this.config.owners[owner].sandboxId };
    const snapshot = await this.client(owner).request('GET', route(binding.workItemId), { signal });
    this.alive(); this.validateWork(owner, sessionId, snapshot.workItem);
    return { bound: true, ...snapshot };
  }

  async versioned(owner, sessionId, action, call, body, target) {
    const key = this.key(action, owner, sessionId, call.callId);
    const client = this.client(owner);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await client.request('GET', target.read, { signal: call.signal });
      this.alive();
      try {
        return await client.request('POST', target.write, { signal: call.signal, key,
          body: { ...body, expectedVersion: target.version(current) } });
      } catch (error) { if (!error.stale || attempt) throw error; }
    }
  }

  async run(owner, sessionId, args, call) {
    this.key('run', owner, sessionId, call.callId);
    if (Object.keys(args).some(k => !['command', 'kind', 'timeoutSeconds', 'sourceCommit'].includes(k))) throw new Error('Unexpected execution parameter');
    const binding = await this.binding(owner, sessionId, true, call.signal);
    const snapshot = await this.client(owner).request('GET', route(binding.workItemId), { signal: call.signal });
    this.validateWork(owner, sessionId, snapshot.workItem);
    const approval = snapshot.workItem.workflow?.approval;
    if (snapshot.workItem.source.type === 'ARGON' && (!approval ||
        !snapshot.sessions?.some(s => s.sessionId === sessionId && s.role === 'CODE')))
      throw new Error('Task execution requires the approved CODE Session');
    if (snapshot.workItem.source.type === 'MANUAL' && (approval?.specDigest !== snapshot.workItem.taskSpec?.specDigest ||
        !snapshot.sessions?.some(s => s.sessionId === sessionId && s.role === 'CODE')))
      throw new Error('Task execution requires the approved CODE Session bound to the frozen specDigest');
    return this.versioned(owner, sessionId, 'run', call, { ...args, kind: args.kind ?? 'COMMAND', timeoutSeconds: args.timeoutSeconds ?? 300 },
      { read: route(binding.workItemId), write: route(binding.workItemId) + '/operations', version: value => value.workItem.version });
  }

  async status(owner, sessionId, operationId, signal) {
    if (!/^exec-[0-9a-f]{32}$/.test(operationId)) throw new Error('Invalid operationId');
    const binding = await this.binding(owner, sessionId, false, signal);
    if (!binding) throw new Error('Session has no bound Work Item');
    const operation = await this.client(owner).request('GET', opRoute(operationId), { signal });
    if (operation.workItemId !== binding.workItemId || operation.ownerId !== owner) throw new Error('Operation is unavailable to this Session');
    return operation;
  }

  async follow(owner, sessionId, operationId, after = 0, signal) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid log cursor');
    const operation = await this.status(owner, sessionId, operationId, signal);
    const page = await this.client(owner).request('GET', opRoute(operationId) + '/logs?after=' + after + '&limit=20', { signal });
    return { operationId, state: operation.state, exitCode: operation.exitCode, ...page };
  }

  async cancel(owner, sessionId, operationId, call) {
    await this.status(owner, sessionId, operationId, call.signal);
    return this.versioned(owner, sessionId, 'cancel:' + operationId, call, {},
      { read: opRoute(operationId), write: opRoute(operationId) + '/cancel', version: value => value.version });
  }

  async pause(owner, sessionId, paused, call) {
    const binding = await this.binding(owner, sessionId, false, call.signal);
    if (!binding) throw new Error('Session has no bound Work Item');
    return this.versioned(owner, sessionId, paused ? 'pause' : 'resume', call, {},
      { read: route(binding.workItemId), write: route(binding.workItemId) + (paused ? '/pause' : '/resume'), version: value => value.workItem.version });
  }

  async restore() {
    for (const owner of this.clients.keys()) {
      try {
        const { workItems } = await this.client(owner).request('GET', '/api/brain/work-items');
        for (const work of workItems) {
          if (work.sessionId && work.source?.id === 'DSH:' + work.sessionId) await this.watch(owner, work.sessionId, work);
          if (['ARGON', 'MANUAL'].includes(work.source?.type) && work.sandboxId) for (const sessionId of work.sessionIds ?? []) await this.watch(owner, sessionId, work);
        }
      } catch (error) { await this.error(owner, error); }
    }
    this.lastRestore = Date.now();
  }

  tick() {
    if (this.closed) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = (async () => {
      if (Date.now() - this.lastRestore > 5000) await this.restore();
      for (const binding of this.bindings.values()) {
        if (this.closed) break;
        try {
          if (binding.cursor === null) {
            await this.publishSnapshot(binding);
            if (binding.cursor === null) continue;
          }
          const page = await this.client(binding.owner).request('GET', route(binding.workItemId) + '/events?after=' + binding.cursor + '&limit=100');
          for (const event of page.events) {
            if (event.sequence <= binding.cursor) continue;
            if (event.workItemId !== binding.workItemId || event.sequence !== binding.cursor + 1) {
              await this.publishSnapshot(binding);
              break;
            }
            if (!await this.deliver('argon-brain/event', { ownerId: binding.owner, sessionId: binding.sessionId, workItemId: binding.workItemId, event })) break;
            binding.cursor = event.sequence;
          }
        } catch (error) { await this.error(binding.owner, error, binding.sessionId); }
      }
    })().finally(() => { this.polling = null; });
    return this.polling;
  }

  async prepareSession(owner, requestId) {
    this.client(owner); this.key('prepare', owner, 'operator', requestId);
    if (!this.sessions || !this.workspaces) throw new Error('DSH Session services are unavailable');
    const digest = hash(['session', owner, requestId]);
    const sessionId = 'session-' + [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join('-');
    const profile = this.config.owners[owner];
    const workspace = await this.workspaces.create(profile.workspacePath, 'Argon ' + owner);
    this.alive();
    const session = await this.sessions.create({ sessionId, workspaceId: workspace.id, agentPreset: profile.preset });
    this.alive();
    const binding = await this.binding(owner, session.sessionId, true);
    return { sessionId: session.sessionId, workItemId: binding.workItemId, sandboxId: profile.sandboxId };
  }

  async promptSession(owner, sessionId, prompt, requestId, signal) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32768) throw new Error('Invalid prompt');
    this.key('prompt', owner, sessionId, requestId);
    const binding = await this.binding(owner, sessionId, false, signal);
    if (!binding) throw new Error('Session has no bound Work Item');
    this.alive();
    return this.sessions.prompt({ sessionId, requestId, mode: 'queue',
      content: [{ type: 'text', text: prompt }], clientTimeZone: 'Asia/Shanghai' }, signal ?? new AbortController().signal);
  }

  async dispose() {
    this.closed = true;
    for (const cancel of this.deliveries) cancel();
    await Promise.allSettled([...this.clients.values()].map(client => client.dispose()));
    if (this.polling) await this.polling;
    this.bindings.clear();
  }
}
