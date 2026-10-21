import { M2Client } from '../mythos-brain/client.mjs';
import { FindingSource, mappings } from '../mythos-workflow/source.mjs';
import { triageFinding, findingBinding } from './triage.mjs';
const route = id => '/api/brain/source-intakes/' + id;
const conflict = message => Object.assign(new Error(message), { status: 409 });
export class SubscribeController {
  constructor(config, { client, mock, report = () => {} } = {}) {
    this.client = client ?? new M2Client({ ...config, owner: config.owner ?? 'alice' });
    this.mock = mock ?? new FindingSource(config.sourceUrl); this.report = report; this.pending = null; this.closed = false;
  }
  syncOnce() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.sync().finally(() => { this.pending = null; }); return this.pending;
  }
  async sync() {
    const [rows, { intakes }, { workItems }] = await Promise.all([
      this.mock.request('/api/findings'), this.client.request('GET', '/api/brain/source-intakes'), this.client.request('GET', '/api/brain/work-items')]);
    if (!Array.isArray(rows)) throw new Error('Finding source must return a list');
    const summary = { seen: 0, registered: 0, notified: 0, errors: 0 };
    for (const row of rows) {
      if (this.closed) break;
      const mapping = mappings[row?.id]; if (!mapping) continue;
      const previous = intakes.find(i => i.findingId === row.id);
      const work = workItems.find(w => w.source?.type === 'MYTHOS' && w.source.id === row.id);
      if (previous && ['APPROVED', 'REJECTED'].includes(previous.state)) continue;
      if (!work && !previous && (!['HIGH', 'CRITICAL'].includes(row.risk) || row.closed === 'Closed' || row.status !== 'Not Started' || row.workItemId)) continue;
      summary.seen++;
      let revision = row.revision, triage = triageFinding(row, mapping), registered = false;
      const save = extra => this.client.request('PUT', route(row.id), { body: { revision, triage, ...extra } });
      try {
        if (work) {
          await save({ state: 'APPROVED' }); summary.registered++; continue;
        }
        await save(); registered = true; summary.registered++;
        if (row.triageResult !== triage.result) {
          if (this.closed) break;
          const updated = await this.mock.request('/api/findings/' + row.id, 'PATCH', { triageResult: triage.result });
          revision = updated.revision;
          triage = triageFinding(updated, mapping);
          await save();
        }
        if (triage.result !== 'CONFIRMED' || (previous?.notifiedAt && previous.triage?.binding === triage.binding) || this.closed) continue;
        const receipt = await this.mock.request('/api/findings/' + row.id + '/notify-owner', 'POST', {
          notificationId: 'intake-' + triage.binding, expectedRevision: revision, ownerId: row.ownerId });
        if (receipt.delivered !== true || receipt.preview !== true) throw new Error('Owner notification requires a local preview receipt');
        await save({ notified: true }); summary.notified++;
      } catch (error) {
        summary.errors++; this.report(error, row.id);
        if (registered) await save({ lastError: String(error.message).slice(0, 2000) }).catch(e => this.report(e, row.id));
      }
    }
    return summary;
  }
  async decide(id, body, key) {
    if (!Object.hasOwn(mappings, id) || !['APPROVE', 'REJECT'].includes(body.decision)) throw Object.assign(new Error('Invalid source or approval decision'), { status: 400 });
    const { intakes } = await this.client.request('GET', '/api/brain/source-intakes');
    const intake = intakes.find(i => i.findingId === id);
    if (!intake) throw conflict('Source is not registered yet; wait for automatic triage');
    if (intake.state === 'AWAITING_OWNER') {
      const latest = await this.mock.request('/api/findings/' + id);
      if (latest.revision !== intake.revision || (body.decision === 'APPROVE' &&
          (triageFinding(latest, mappings[id]).result !== 'CONFIRMED' || intake.triage.binding !== findingBinding(latest)))) throw conflict('Source changed; wait for re-triage before confirming');
    }
    return this.client.request('POST', route(id) + '/decide', { key, body: {
      expectedRevision: body.expectedRevision, decision: body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' } });
  }
  async dispose() { this.closed = true; await this.client.dispose(); await this.pending; }
}
