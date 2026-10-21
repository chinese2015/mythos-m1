import { M2Client } from '../mythos-brain/client.mjs';
import { FindingSource, mappings } from '../mythos-workflow/source.mjs';
import { triageFinding, findingBinding } from './triage.mjs';
const route = id => '/api/brain/source-intakes/' + id;
const conflict = message => Object.assign(new Error(message), { status: 409 });
export class SubscribeController {
  constructor(config, { client, mock, report = () => {} } = {}) {
    this.client = client ?? new M2Client({ ...config, owner: config.owner ?? 'alice' });
    this.mock = mock ?? new FindingSource(config.sourceUrl); this.report = report; this.closed = false;
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
  async dispose() { this.closed = true; await this.client.dispose(); }
}
