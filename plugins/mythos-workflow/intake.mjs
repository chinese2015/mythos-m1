// Thin wrapper over the M2 repository registry and manual task admission routes.
// Callers must pass an owner-scoped M2Client; idempotency keys follow the M2 contract.
export class TaskIntake {
  constructor(client) {
    if (!client || typeof client.request !== 'function') throw new Error('An owner-scoped M2 client is required');
    this.client = client;
  }
  repositories() { return this.client.request('GET', '/api/brain/repositories'); }
  register(config, key) { return this.client.request('POST', '/api/brain/repositories', { key, body: config }); }
  revise(repositoryId, body, key) {
    if (!/^repo-[a-f0-9]{32}$/.test(repositoryId)) throw Object.assign(new Error('Invalid repositoryId'), { status: 400 });
    return this.client.request('POST', '/api/brain/repositories/' + repositoryId + '/revisions', { key, body });
  }
  check(repositoryId) {
    if (!/^repo-[a-f0-9]{32}$/.test(repositoryId)) throw Object.assign(new Error('Invalid repositoryId'), { status: 400 });
    return this.client.request('POST', '/api/brain/repositories/' + repositoryId + '/check', { body: {} });
  }
  create(input, key) { return this.client.request('POST', '/api/brain/tasks/manual', { key, body: input }); }
}
