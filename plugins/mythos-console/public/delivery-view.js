const labels = { PUSH_PENDING: '推送已验证提交', CREATE_PR_PENDING: '创建或对账 PR', PR_OPEN: 'PR 已创建，等待审核', SYNC_SOURCE_PENDING: '合并已确认，回写来源', COMPLETED: '交付完成', CLOSED_UNMERGED: 'PR 已关闭，尚未合并' };
export function renderDelivery({ work, workflow, el, panelHead, request, reload, notice }) {
  const panel = el('section', { class: 'panel', 'data-panel': 'delivery' });
  panel.append(panelHead('PR 交付与审核', 'Gitea 事实 · 独立验证 · 来源回写'));
  const body = el('div', { class: 'panel-body' }), d = workflow.delivery;
  const status = el('div', { class: 'baseline-box' });
  status.append(el('strong', { text: d ? labels[d.step] || d.step : '验证通过后，可发布候选提交供审核' }),
    el('span', { text: '由人工在 Gitea 审核、合并；合并事实和门禁满足后才关闭来源任务。' })); body.append(status);
  const meta = el('div', { class: 'operation-details' });
  if (workflow.candidateCommit) meta.append(el('span', { class: 'mono', text: '候选 ' + workflow.candidateCommit }));
  if (d?.headBranch) meta.append(el('span', { text: '交付分支 ' + d.headBranch }));
  body.append(meta);
  const actions = el('div', { class: 'operation-details' });
  const canPublish = workflow.phase === 'AWAITING_REVIEW' && !work.paused && (!d || d.candidateCommit !== workflow.candidateCommit);
  if (canPublish) {
    const button = el('button', { class: 'primary-button', text: '发布 PR' });
    button.addEventListener('click', async () => {
      if (!confirm(`将已验证提交 ${workflow.candidateCommit.slice(0, 12)} 推送到 Gitea 并创建 PR？`)) return;
      button.disabled = true;
      try { await request(`/work-items/${work.workItemId}/publish-pr`, { method: 'POST', body: { expectedVersion: work.version }, mutation: true }); await reload(); }
      catch (error) { notice(error.message, 'error'); if (button.isConnected) button.disabled = false; }
    }); actions.append(button);
  }
  if (d) {
    const refresh = el('button', { class: 'secondary-button', text: d.lastError ? '重试交付 / 对账' : '刷新 PR 状态' });
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { await request(`/work-items/${work.workItemId}/refresh-pr`, { method: 'POST', body: { expectedVersion: work.version }, mutation: true }); await reload(); }
      catch (error) { notice(error.message, 'error'); if (refresh.isConnected) refresh.disabled = false; }
    }); actions.append(refresh);
    if (d.pullUrl) actions.append(el('a', { class: 'session-link', href: d.pullUrl, target: '_blank', rel: 'noopener noreferrer', text: `打开 Gitea PR #${d.pullNumber} ↗` }));
  }
  body.append(actions);
  if (d?.lastError) body.append(el('div', { class: 'warning-box', text: `${d.lastError}${d.nextAttemptAt ? ' · 下次对账 ' + new Date(d.nextAttemptAt).toLocaleTimeString('zh-CN') : ''}` }));
  if (d?.observed) {
    const observed = d.observed, info = el('div', { class: 'operation-details' });
    info.append(el('span', { text: `PR ${observed.pull.merged ? '已合并' : observed.pull.state === 'closed' ? '已关闭，未合并' : '审核中'}` }),
      el('span', { text: observed.checks.contexts.length ? 'CI：收到检查记录' : 'CI：暂无检查记录' })); body.append(info);
    for (const check of observed.checks.contexts) body.append(el('div', { class: 'operation-details', text: `${check.context} · ${check.state}` }));
    body.append(el('div', { class: 'operation-details', text: observed.reviews.length ? '评审记录' : '评审：暂无记录' }));
    for (const review of observed.reviews) body.append(el('div', { class: 'operation-details', text: `${review.author} · ${review.state}${review.stale ? ' · 已过期' : ''}${review.dismissed ? ' · 已撤销' : ''}` }));
    for (const gate of observed.gate.checks) {
      const neutral = (gate.name === 'ciPolicy' && !d.policy.requiredStatusContexts.length) || (gate.name === 'reviewPolicy' && !d.policy.minApprovals);
      body.append(el('div', { class: 'operation-details', text: `${neutral ? '○' : gate.passed ? '✓' : '·'} ${gate.detail}` }));
    }
  }
  if (d?.step === 'CLOSED_UNMERGED') body.append(el('p', { class: 'subtle', text: '如需继续修订，请向下方会话发送补充说明。新候选重新验证后可再次发布。' }));
  if (d?.sourceSyncedAt) body.append(el('div', { class: 'approved-label', text: `来源已回写 · ${new Date(d.sourceSyncedAt).toLocaleString('zh-CN')}` }));
  panel.append(body); return panel;
}
