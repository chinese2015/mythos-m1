import { renderPlanMarkdown } from './plan-markdown.js';

// The panel owns its editor DOM so polling cannot replace drafts, focus, or listeners.
export function renderPlanPanel(context) {
  let ctx = context, mode = 'view', busy = false, base = null, draft = '', feedback = '';
  const { el } = ctx;
  const root = el('section', { class: 'panel plan-panel', 'data-plan-work-id': ctx.workId });
  const editable = () => !ctx.item.paused && !ctx.workflow.approval && ctx.workflow.phase === 'AWAITING_PLAN_APPROVAL' && !!ctx.workflow.planHash;
  const stale = () => base && (base.expectedVersion !== ctx.item.version || base.planHash !== ctx.workflow.planHash || !editable());
  const button = (text, action, primary = false) => {
    const node = el('button', { type: 'button', class: primary ? 'primary-button' : 'secondary-button', text });
    node.disabled = busy;
    node.addEventListener('click', action);
    return node;
  };
  function markdown(text, className = '') {
    const node = el('div', { class: `plan-markdown ${className}`.trim() });
    node.innerHTML = renderPlanMarkdown(text);
    return node;
  }
  async function act(action) {
    if (busy) return;
    busy = true; feedback = '';
    root.querySelectorAll('button, textarea').forEach(node => { node.disabled = true; });
    try { await action(); mode = 'view'; base = null; draft = ''; }
    catch (error) { feedback = error.message; }
    finally {
      try { if (root.isConnected) await ctx.reload(); }
      finally { busy = false; if (root.isConnected) render(); }
    }
  }
  function begin(nextMode) {
    mode = nextMode; feedback = '';
    base = { planHash: ctx.workflow.planHash, expectedVersion: ctx.item.version };
    draft = nextMode === 'edit' ? ctx.workflow.plan : '';
    render(); root.querySelector('textarea')?.focus({ preventScroll: true });
  }
  function render() {
    const wf = ctx.workflow;
    root.replaceChildren();
    const header = el('div', { class: 'panel-head' });
    const title = el('div', { class: 'plan-title' });
    title.append(el('h2', { text: 'Implementation plan' }), el('small', { text: wf.plan ? `Revision ${wf.planRevision ?? 1} · ${wf.planEdit ? 'Modified by ' + wf.planEdit.actor : 'Plan submitted by the model'}` : 'Waiting for read-only analysis' }));
    header.append(title);
    root.append(header);
    const body = el('div', { class: 'panel-body' }); root.append(body);
    const status = el('div', { class: 'plan-feedback', role: 'status' });
    status.textContent = feedback || (stale() ? 'The plan changed while you were editing. Your draft is preserved. Cancel and reopen the latest plan before saving or sending.' : '');
    status.hidden = !status.textContent;
    body.append(status);
    if (mode === 'edit') {
      const field = el('label', { class: 'plan-field', text: 'Markdown source' });
      const input = el('textarea', { class: 'plan-editor', 'aria-label': 'Implementation plan Markdown', maxlength: '64000', spellcheck: 'false' }); input.value = draft;
      const preview = markdown(draft, 'plan-preview');
      const previewWrap = el('div', { class: 'plan-preview-wrap' }); previewWrap.append(el('div', { class: 'plan-field', text: 'Preview' }), preview);
      field.append(input); body.append(field, previewWrap);
      const actions = el('div', { class: 'plan-actions plan-form-actions' });
      const save = button('Save changes', () => act(async () => {
        await ctx.request(`/work-items/${encodeURIComponent(ctx.workId)}/modify-plan`, { method: 'POST', body: { ...base, plan: draft }, mutation: true });
      }), true);
      save.disabled = busy || stale() || !draft.trim();
      input.addEventListener('input', () => { draft = input.value; preview.innerHTML = renderPlanMarkdown(draft); save.disabled = busy || stale() || !draft.trim(); });
      actions.append(save, button('Cancel', () => { mode = 'view'; base = null; feedback = ''; render(); }));
      body.append(actions, el('p', { class: 'subtle', text: 'Saving updates the plan only. Approve the latest version when you are ready to start execution.' }));
      return;
    }
    if (wf.plan) body.append(markdown(wf.plan));
    else body.append(el('div', { class: 'plan-placeholder', text: 'The plan will appear here once read-only analysis completes. The workflow will not modify code before approval.' }));
    if (mode === 'discuss') {
      const form = el('form', { class: 'plan-discussion' });
      const field = el('label', { class: 'plan-field', text: 'What should the model change?' });
      const input = el('textarea', { class: 'plan-instructions', 'aria-label': 'Requested plan changes', maxlength: '16000', placeholder: 'Describe changes or ask follow-up questions…' }); input.value = draft;
      field.append(input);
      const send = el('button', { type: 'submit', class: 'primary-button', text: 'Generate revised plan' });
      send.disabled = busy || stale() || !draft.trim();
      input.addEventListener('input', () => { draft = input.value; send.disabled = busy || stale() || !draft.trim(); });
      const actions = el('div', { class: 'plan-actions' }); actions.append(send, button('Cancel', () => { mode = 'view'; base = null; feedback = ''; render(); }));
      form.append(field, el('p', { class: 'subtle', text: 'The current saved plan and your instructions will be sent to the model. The revised plan will wait for your approval.' }), actions);
      form.addEventListener('submit', event => {
        event.preventDefault(); if (busy || stale() || !draft.trim()) return;
        act(async () => { await ctx.request(`/work-items/${encodeURIComponent(ctx.workId)}/message`, { method: 'POST', body: { ...base, text: draft.trim() }, mutation: true }); });
      });
      body.append(form); return;
    }
    const bar = el('div', { class: 'approval-bar' });
    const actions = el('div', { class: 'approval-actions' });
    if (editable()) actions.append(button('Modify', () => begin('edit')), button('Ask model', () => begin('discuss')));
    if (wf.approval?.approvedAt || wf.approval?.actor) {
      bar.append(el('span', { class: 'approved-label', text: `Approved by ${wf.approval.actor || 'Demo Operator'}${wf.approval.approvedAt ? ' · ' + new Date(wf.approval.approvedAt).toLocaleString('en-US') : ''}` }), actions);
    } else if (editable()) {
      bar.append(el('span', { text: 'Review, modify, or discuss this plan. Only approval starts code changes.' }));
      actions.append(button('Approve plan & start execution', () => {
        if (!confirm('Approve the current plan and allow the workflow to enter the code modification phase?')) return;
        act(async () => { await ctx.request(`/work-items/${encodeURIComponent(ctx.workId)}/approve-plan`, { method: 'POST', body: { expectedVersion: ctx.item.version, planHash: ctx.workflow.planHash }, mutation: true }); });
      }, true));
      bar.append(actions);
    } else bar.append(el('span', { text: ctx.item.paused ? 'Resume the workflow before modifying or approving the plan.' : wf.phase === 'PLANNING' ? 'The model is updating the plan. Review the new version when it is ready.' : 'Plan approval opens after read-only analysis completes.' }));
    body.append(bar);
  }
  root.planContext = context;
  root.updatePlan = next => {
    const changed = ctx.item.version !== next.item.version || ctx.workflow.planHash !== next.workflow.planHash || ctx.workflow.phase !== next.workflow.phase || ctx.item.paused !== next.item.paused;
    ctx = next; root.planContext = next;
    if (busy || !changed) return;
    if (mode === 'view') render();
    else {
      const status = root.querySelector('.plan-feedback');
      status.textContent = feedback || (stale() ? 'The plan changed while you were editing. Your draft is preserved. Cancel and reopen the latest plan before saving or sending.' : '');
      status.hidden = !status.textContent;
      root.querySelector('.plan-form-actions .primary-button, .plan-discussion .primary-button').disabled = stale() || !draft.trim();
    }
  };
  render(); return root;
}
