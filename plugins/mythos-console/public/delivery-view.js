const labels = { PUSH_PENDING: 'Push verified commit', CREATE_PR_PENDING: 'Create or reconcile PR', PR_OPEN: 'PR created, awaiting review', SYNC_SOURCE_PENDING: 'Merge confirmed, write back source', COMPLETED: 'Delivery completed', CLOSED_UNMERGED: 'PR closed, not merged' };
export function renderDelivery({ work, workflow, el, panelHead, request, reload, notice }) {
  const panel = el('section', { class: 'panel', 'data-panel': 'delivery' });
  panel.append(panelHead('PR delivery & review', 'Gitea facts · Independent verification · Source write-back'));
  const body = el('div', { class: 'panel-body' }), d = workflow.delivery;
  const status = el('div', { class: 'baseline-box' });
  status.append(el('strong', { text: d ? labels[d.step] || d.step : 'Once verification passes, publish the candidate commit for review' }),
    el('span', { text: 'Humans review and merge in Gitea; the source task closes only after the merge fact and gate checks are satisfied.' })); body.append(status);
  const meta = el('div', { class: 'operation-details' });
  if (workflow.candidateCommit) meta.append(el('span', { class: 'mono', text: 'Candidate ' + workflow.candidateCommit }));
  if (d?.headBranch) meta.append(el('span', { text: 'Delivery branch ' + d.headBranch }));
  body.append(meta);
  const actions = el('div', { class: 'operation-details' });
  const canPublish = workflow.phase === 'AWAITING_REVIEW' && !work.paused && (!d || d.candidateCommit !== workflow.candidateCommit);
  if (canPublish) {
    const button = el('button', { class: 'primary-button', text: 'Publish PR' });
    button.addEventListener('click', async () => {
      if (!confirm(`Push verified commit ${workflow.candidateCommit.slice(0, 12)} to Gitea and create a PR?`)) return;
      button.disabled = true;
      try { await request(`/work-items/${work.workItemId}/publish-pr`, { method: 'POST', body: { expectedVersion: work.version }, mutation: true }); await reload(); }
      catch (error) { notice(error.message, 'error'); if (button.isConnected) button.disabled = false; }
    }); actions.append(button);
  }
  if (d) {
    const refresh = el('button', { class: 'secondary-button', text: d.lastError ? 'Retry delivery / reconcile' : 'Refresh PR status' });
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { await request(`/work-items/${work.workItemId}/refresh-pr`, { method: 'POST', body: { expectedVersion: work.version }, mutation: true }); await reload(); }
      catch (error) { notice(error.message, 'error'); if (refresh.isConnected) refresh.disabled = false; }
    }); actions.append(refresh);
    if (d.pullUrl) actions.append(el('a', { class: 'session-link', href: d.pullUrl, target: '_blank', rel: 'noopener noreferrer', text: `Open Gitea PR #${d.pullNumber} ↗` }));
  }
  body.append(actions);
  if (d?.lastError) body.append(el('div', { class: 'warning-box', text: `${d.lastError}${d.nextAttemptAt ? ' · next reconciliation ' + new Date(d.nextAttemptAt).toLocaleTimeString('en-US') : ''}` }));
  if (d?.observed) {
    const observed = d.observed, info = el('div', { class: 'operation-details' });
    info.append(el('span', { text: `PR ${observed.pull.merged ? 'merged' : observed.pull.state === 'closed' ? 'closed, not merged' : 'under review'}` }),
      el('span', { text: observed.checks.contexts.length ? 'CI: check records received' : 'CI: no check records yet' })); body.append(info);
    for (const check of observed.checks.contexts) body.append(el('div', { class: 'operation-details', text: `${check.context} · ${check.state}` }));
    body.append(el('div', { class: 'operation-details', text: observed.reviews.length ? 'Review records' : 'Reviews: none yet' }));
    for (const review of observed.reviews) body.append(el('div', { class: 'operation-details', text: `${review.author} · ${review.state}${review.stale ? ' · stale' : ''}${review.dismissed ? ' · dismissed' : ''}` }));
    for (const gate of observed.gate.checks) {
      const neutral = (gate.name === 'ciPolicy' && !d.policy.requiredStatusContexts.length) || (gate.name === 'reviewPolicy' && !d.policy.minApprovals);
      body.append(el('div', { class: 'operation-details', text: `${neutral ? '○' : gate.passed ? '✓' : '·'} ${gate.detail}` }));
    }
  }
  if (d?.step === 'CLOSED_UNMERGED') body.append(el('p', { class: 'subtle', text: 'To continue revising, send additional instructions to the session below. A new candidate can be published again after re-verification.' }));
  if (d?.sourceSyncedAt) body.append(el('div', { class: 'approved-label', text: `Source written back · ${new Date(d.sourceSyncedAt).toLocaleString('en-US')}` }));
  panel.append(body); return panel;
}
