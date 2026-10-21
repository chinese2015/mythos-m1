import { renderDelivery } from './delivery-view.js';
import { renderMonitor } from './monitor-view.js';
import { renderIntake, sourceFacts, evidenceLine } from './intake-view.js';
(() => {
  'use strict';
  const API = '/mythos/api';
  const view = document.getElementById('view');
  const notice = document.getElementById('notice');
  const crumbs = document.getElementById('breadcrumbs');
  const navCount = document.getElementById('nav-count');
  const phases = ['CLAIMED','PREPARING','BASELINE','PLANNING','AWAITING_PLAN_APPROVAL','CODING','VERIFYING','AWAITING_REVIEW'];
  const phaseLabels = ['Claimed','Preparing workspace','Baseline','Planning','Plan awaiting approval','Coding','Independent verification','Delivery & review'];
  let timer = null, loading = false, currentWorkId = null, taskCache = [], workSnapshot = null, routeEpoch = 0, requestEpoch = 0;

  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const el = (tag, attrs = {}, content = '') => {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => { if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else node.setAttribute(k,v); });
    if (content) node.textContent = content;
    return node;
  };
  function showNotice(message, kind = 'info') { notice.textContent = message; notice.className = `notice ${kind}`; notice.hidden = false; }
  function hideNotice() { notice.hidden = true; notice.textContent = ''; }
  function route() { const h = location.hash || '#/tasks'; const match = h.match(/^#\/work\/([^/?#]+)/); if (match) return {name:'work',id:decodeURIComponent(match[1])}; return h === '#/intake' ? {name:'intake'} : {name:'tasks'}; }
  function setCrumbs(workItem) {
    if (!workItem) { crumbs.textContent = 'Task Center'; return; }
    crumbs.replaceChildren();
    const a = el('a',{href:'/mythos/#/tasks'},'Task Center');
    const sep = el('span',{class:'sep'},'/'); const title = el('strong',{},`${workItem.source?.id || workItem.sourceRecord?.id || 'Task'} · Work Detail`);
    crumbs.append(a,sep,title);
  }
  async function request(path, {method='GET',body, mutation=false, idempotencyKey} = {}) {
    const headers = {'Accept':'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (mutation) { headers['X-Mythos-Action'] = '1'; headers['Idempotency-Key'] = idempotencyKey || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`); }
    let response;
    try { response = await fetch(`${API}${path}`, {method,headers,credentials:'same-origin',body:body === undefined ? undefined : JSON.stringify(body)}); }
    catch (_) { throw new Error('Cannot reach the Mythos workflow service. Check the connection and retry.'); }
    if (response.status === 401) throw new Error('Your session has expired. Sign in again in the DSH main UI, then return to the Task Workspace.');
    let data = {};
    try { data = await response.json(); } catch (_) { /* malformed response is reported below */ }
    if (!response.ok) {
      const detail = data.error || data.message || data.detail;
      if (response.status === 409) throw new Error(`${detail || 'The task state was updated by another action.'} Refresh the page to confirm the latest state before continuing.`);
      throw new Error(detail ? String(detail) : `Request failed (HTTP ${response.status}). Refresh and retry.`);
    }
    return data;
  }
  function taskStatus(task) {
    if (task.workItemId) return {label:task.workStage || task.status || 'In progress', cls:'running'};
    const states = { AWAITING_OWNER: 'Awaiting owner approval', NEEDS_REVIEW: 'Needs manual review', REJECTED: 'Takeover rejected' };
    if (states[task.intake?.state]) return {label:states[task.intake.state],cls:'pending'};
    if (task.startable) return {label:'Approved for takeover',cls:'enabled'};
    return {label:task.intake?.state === 'APPROVED' ? 'Source changed, needs manual review' : 'Awaiting automatic triage',cls:''};
  }
  function riskClass(risk) { const v=String(risk||'').toLowerCase(); return /high|高|critical|严重/.test(v)?'high':(/low|低/.test(v)?'low':'medium'); }
  function riskName(risk) { const v=String(risk||''); return ({HIGH:'High risk',MEDIUM:'Medium risk',LOW:'Low risk',high:'High risk',medium:'Medium risk',low:'Low risk'})[v] || v || 'Risk not marked'; }
  function shortRepo(url) { if (!url) return '—'; try { const u=new URL(url); return (u.pathname.split('/').filter(Boolean).slice(-2).join('/') || u.host); } catch (_) { return url; } }
  function renderTasks(data) {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    taskCache = tasks; const pending = tasks.filter(t=>t.intake?.state === 'AWAITING_OWNER').length; navCount.textContent = String(pending); navCount.title = 'Awaiting owner approval'; navCount.classList.toggle('has-pending', pending > 0);
    setCrumbs(null);
    const active = tasks.filter(t=>t.workItemId).length;
    view.innerHTML = `<div class="page-heading"><div><div class="eyebrow">TASK INTAKE</div><h1>Task Center</h1><p>New findings are triaged automatically and an owner notification preview is generated. The workspace is prepared only after takeover is approved. Code changes still require a separate plan approval.</p></div><div class="heading-meta"><strong>${tasks.length}</strong> source findings</div></div>
      <div class="summary-grid"><div class="summary-card"><span>Source findings</span><strong>${tasks.length}</strong><i class="summary-icon">▦</i></div><div class="summary-card"><span>Awaiting owner approval</span><strong>${pending}</strong><i class="summary-icon">↗</i></div><div class="summary-card"><span>Tasks in progress</span><strong>${active}</strong><i class="summary-icon">◷</i></div></div>
      <div class="section-heading"><h2>Mapped issues</h2><small>Source: Mock Findings · refresh syncs status automatically</small></div><div class="task-list" id="task-list"></div>`;
    const list = document.getElementById('task-list');
    if (!tasks.length) { list.innerHTML='<div class="empty-state">No issues to show right now. They will appear automatically once the source data recovers.</div>'; return; }
    tasks.forEach(task => {
      const state=taskStatus(task), enabled=!!(task.startable || task.workItemId);
      const card=el('article',{class:`task-card ${enabled?'':'preview'}`});
      const content=el('div');
      const row=el('div',{class:'task-title-row'});
      row.append(el('span',{class:'finding-id',text:task.id}),el('span',{class:'task-title',text:task.title||'Untitled finding'}));
      row.append(task.manual ? el('span',{class:'manual-tag',text:'Manual task'}) : el('span',{class:`risk ${riskClass(task.risk)}`,text:riskName(task.risk)}));
      const desc=el('p',{class:'task-description',text:task.description||'The source finding will be handled in an isolated workspace; the original issue will not be closed automatically.'});
      const meta=el('div',{class:'task-meta'});
      meta.append(el('span',{},`Repo: `),el('b',{text:shortRepo(task.repositoryUrl)}),el('span',{class:'dotsep',text:'•'}),el('span',{},'Baseline: '),el('b',{class:'mono',text:(task.baseCommit||'—').slice(0,10)}),el('span',{class:'dotsep',text:'•'}),el('span',{},'Source: '),el('b',{text:`${task.ownerId||'—'} · ${task.revision||'—'}`}));
      content.append(row,desc,meta);
      content.append(el('p',{class:'task-description',text:`Owner: ${task.ownerId||'—'} · ${task.ownerTeamsId||'No team registered'}`}));
      if (task.intake?.triage?.reasons?.length) content.append(el('p',{class:'task-description',text:task.intake.triage.reasons.join('; ')}));
      if (task.intake?.lastError) content.append(el('p',{class:'task-description',text:'Notification not delivered yet, will retry automatically: ' + task.intake.lastError}));
      else if (task.intake?.notifiedAt) content.append(el('small',{class:'subtle',text:'Owner notification preview generated (local outbox)'}));
      const side=el('div',{class:'task-side'}); side.append(el('span',{class:`status-pill ${state.cls}`,text:state.label}));
      if (enabled && task.workItemId) { const b=el('button',{class:'secondary-button',type:'button',text:'Open work detail'}); b.addEventListener('click',()=>location.hash=`#/work/${encodeURIComponent(task.workItemId)}`); side.append(b); }
      else if (enabled) { const b=el('button',{class:'primary-button',type:'button',text:'Start'}); b.addEventListener('click',()=>startTask(task,b)); side.append(b); }
      else if (task.enabled && task.intake?.state === 'AWAITING_OWNER') {
        for (const [decision,label,cls] of [['APPROVE','Approve takeover','primary-button'],['REJECT','Reject','text-button']]) {
          const button=el('button',{class:cls,type:'button',text:label});
          button.addEventListener('click',async()=>{button.disabled=true;try{await request(`/tasks/${encodeURIComponent(task.id)}/decide`,{method:'POST',body:{decision,expectedRevision:task.intake.revision},mutation:true});await loadTasks(true);}catch(error){showNotice(error.message,'error');button.disabled=false;}});
          side.append(button);
        }
      } else side.append(el('span',{class:'preview-tag',text:'No fix starts before approval'}));
      card.append(content,side); list.append(card);
    });
  }
  async function loadTasks(force=false) {
    if (loading&&!force) return; loading=true;
    const epoch=routeEpoch, seq=++requestEpoch;
    if (!taskCache.length) view.innerHTML='<div class="loading"><span class="spinner"></span>Loading source tasks…</div>';
    try { hideNotice(); const data=await request('/tasks'); if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='tasks')return; renderTasks(data); }
    catch(e) { if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='tasks')return; showNotice(e.message,'error'); if (!taskCache.length) view.innerHTML='<div class="empty-state">Task source is temporarily unavailable.<br><br>Check the service status, or refresh and retry.</div>'; }
    finally { if(seq===requestEpoch)loading=false; }
  }
  async function startTask(task, button) {
    button.disabled=true; button.textContent='Starting…';
    try { hideNotice(); const data=await request(`/tasks/${encodeURIComponent(task.id)}/start`,{method:'POST',body:{expectedRevision:task.revision},mutation:true});
      if (!data.workItemId) throw new Error('The service did not return a work item id. Refresh the task list to confirm the start state.');
      location.hash=`#/work/${encodeURIComponent(data.workItemId)}`;
    } catch(e) { showNotice(e.message,'error'); button.disabled=false; button.textContent='Start'; }
  }
  const itemOf = d => d.workItem || d;
  function phaseOf(d) { return d.workflow?.phase || itemOf(d)?.workflow?.phase || itemOf(d)?.stage || 'CLAIMED'; }
  function phaseIndex(phase) { if(['PUBLISHING','PR_OPEN','CLOSING','COMPLETED'].includes(phase))return phases.length-1;const idx=phases.indexOf(phase); return idx<0?0:idx; }
  function normalizeOperation(raw, evidenceRecords = []) {
    const state=String(raw.status||raw.state||'UNKNOWN').toUpperCase();
    const evidence=raw.evidence||evidenceRecords.find(e=>e.operationId===(raw.operationId||raw.id))||{};
    return {...raw,id:raw.id||raw.operationId,operationId:raw.operationId||raw.id,status:state,junit:raw.junit||evidence.junit,evidence,version:raw.version??raw.expectedVersion};
  }
  function statusText(op) { const v=String(op.status||op.state||'UNKNOWN').toUpperCase(); return ({SUCCEEDED:'Succeeded',COMPLETED:'Completed',FAILED:'Failed',RUNNING:'Running',QUEUED:'Queued',PENDING:'Pending',CANCELLED:'Cancelled',CANCELED:'Canceled',UNKNOWN:'Unknown state'})[v]||v; }
  function opLabel(op) { const kind=op.kind||op.type||op.operationType||'operation'; return ({UNIT_TEST:'Unit tests',VERIFY:'Independent verification',TEST:'Tests',AGENT:'Agent run',COMMAND:'Command'})[kind]||kind; }
  function safeText(value) { return String(value==null?'':value); }
  function makePhaseStrip(phase) {
    const active=phaseIndex(phase); const strip=el('div',{class:'phase-strip'});
    phases.forEach((p,i)=>{ const n=el('div',{class:`phase ${i<active?'done':i===active?'current':''}`}); n.append(el('div',{class:'phase-marker'}),el('span',{text:phaseLabels[i]})); strip.append(n); });
    return strip;
  }
  function renderOperations(rawOps, evidenceRecords = [], openLogs = new Map()) {
    const ops=(rawOps||[]).map(op=>normalizeOperation(op,evidenceRecords));
    const wrap=el('div');
    if (!ops?.length) { wrap.append(el('div',{class:'subtle',text:'No operations submitted by the workflow yet.'})); return wrap; }
    ops.forEach(op=>{
      const row=el('div',{class:'operation','data-operation-id':op.operationId}); const top=el('div',{class:'operation-top'}); top.append(el('span',{class:'operation-name',text:opLabel(op)}),el('span',{class:`operation-status ${['SUCCEEDED','COMPLETED'].includes(op.status)?'succeeded':op.status==='FAILED'?'failed':''}`,text:statusText(op)})); row.append(top);
      const details=el('div',{class:'operation-details'}); details.append(el('span',{text:`ID ${op.id||op.operationId||'—'}`})); if(op.exitCode!==undefined&&op.exitCode!==null) details.append(el('span',{text:`Exit code ${op.exitCode}`})); if(op.startedAt) details.append(el('span',{text:`Started ${new Date(op.startedAt).toLocaleString('en-US')}`}));
      if (op.junit) { const j=op.junit; details.append(el('span',{text:`JUnit: ${j.tests??j.testCount??'?'} tests · ${j.failures??'?'} failures · ${j.errors??'?'} errors`})); }
      row.append(details);
      const opId=op.operationId;
      if(opId) { const tools=el('div',{class:'operation-details'}); const logButton=el('button',{class:'text-button',type:'button',text:'View run log'}); const log=el('div',{class:'log-box','data-log-operation':opId}); log.hidden=!openLogs.has(opId);if(!log.hidden)log.textContent=openLogs.get(opId); logButton.addEventListener('click',async()=>{ log.hidden=false; log.textContent='Reading log…'; try{const res=await request(`/operations/${encodeURIComponent(opId)}/logs?after=0`);const lines=res.lines||res.logs||res.entries||[];log.textContent=Array.isArray(lines)?lines.map(x=>typeof x==='string'?x:(x.text||x.message||JSON.stringify(x))).join('\n'):String(lines);}catch(e){log.textContent=e.message;} }); tools.append(logButton); if(['RUNNING','QUEUED','PENDING'].includes(op.status)){const cancel=el('button',{class:'text-button',type:'button',text:'Cancel this operation'});cancel.addEventListener('click',async()=>{if(!confirm('Cancel this operation? The workflow keeps running.'))return;try{await request(`/operations/${encodeURIComponent(opId)}/cancel`,{method:'POST',body:{expectedVersion:op.version},mutation:true});await loadWork(true);}catch(e){showNotice(e.message,'error');}});tools.append(cancel);} row.append(tools,log); }
      wrap.append(row);
    }); return wrap;
  }
  function renderTranscript(session) {
    const entries=session?.transcript||[]; const wrap=el('div',{class:'transcript'});
    if(!entries.length){wrap.append(el('div',{class:'subtle',text:session?.running?'Session is running, waiting for new activity…':'No session activity to show yet.'}));return wrap;}
    entries.forEach(e=>{const item=el('div',{class:'message-item'});item.append(el('div',{class:'message-role',text:e.toolName?`Tool · ${e.toolName}`:(e.type||'Message')}),el('div',{text:e.text|| (e.isError?'An error occurred':'')}));wrap.append(item);});return wrap;
  }
  function compatibleNode(a,b){return a.nodeType===b.nodeType&&(a.nodeType!==1||(a.tagName===b.tagName&&a.tagName!=='BUTTON'));}
  function patchTree(current,next){
    if(current.nodeType===3){if(current.data!==next.data)current.data=next.data;return current;}
    const sessionChanged=current.tagName==='IFRAME'&&current.dataset.sessionId!==next.dataset.sessionId;
    Array.from(current.attributes).forEach(attr=>{if(!next.hasAttribute(attr.name)&&!(current.tagName==='IFRAME'&&attr.name==='src'))current.removeAttribute(attr.name);});
    Array.from(next.attributes).forEach(attr=>{if(attr.name==='src'&&current.tagName==='IFRAME'&&!sessionChanged)return;if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);});
    if(current.tagName==='INPUT'){const focused=document.activeElement===current;const value=focused?current.value:next.value;if(current.value!==value)current.value=value;}
    const oldChildren=Array.from(current.childNodes), newChildren=Array.from(next.childNodes);
    newChildren.forEach((child,index)=>{const old=current.childNodes[index];if(old&&compatibleNode(old,child)){patchTree(old,child);}else if(old){current.replaceChild(child,old);}else current.appendChild(child);});
    while(current.childNodes.length>newChildren.length)current.removeChild(current.lastChild);
    return current;
  }
  function patchChildren(current,next){const fresh=Array.from(next.childNodes);fresh.forEach((node,index)=>{const prior=current.childNodes[index];if(prior&&compatibleNode(prior,node))patchTree(prior,node);else if(prior)current.replaceChild(node,prior);else current.appendChild(node);});while(current.childNodes.length>fresh.length)current.removeChild(current.lastChild);}
  function buildDetail(d) {
    const target=el('div');
    const scrollY=window.scrollY;
    const oldInput=view.querySelector('.message-form input');
    const draft=oldInput?oldInput.value:'';
    const restoreInputFocus=!!oldInput&&document.activeElement===oldInput;
    const openLogs=new Map(Array.from(view.querySelectorAll('.log-box:not([hidden])')).map(n=>[n.dataset.logOperation,n.textContent]));
    const item=itemOf(d)||{}; const source=d.source||item.source||item.sourceRecord||{}; const workflow=d.workflow||item.workflow||{}; const phase=workflow.phase||item.stage||'CLAIMED'; const session=d.session||(d.sessions||[]).slice().sort((a,b)=>(a.role==='CODE'?-1:0)-(b.role==='CODE'?-1:0))[0]||null; const git=d.git||null;
    const title=source.title||item.sourceRecord?.title||'Work item'; const fid=source.id||item.sourceRecord?.id||'MYTHOS';
    target.append(el('div',{class:'detail-head'})); setCrumbs(item);
    const head=target.firstElementChild; const left=el('div'); left.append(el('div',{class:'eyebrow',text:`WORK ITEM · ${item.id||currentWorkId}`}),el('h1',{text:title}),el('p',{text:`Source ${fid} · ${source.ownerId||item.sourceRecord?.ownerId||'—'} · Version ${item.version??'—'}`}));
    const executionStates=(d.operations||[]).map(op=>String(op.state||op.status||'UNKNOWN').toUpperCase());
    const knownFailureRecovery=item.blocked===true&&['CODING','PLANNING'].includes(phase)&&executionStates.some(state=>['FAILED','CANCELLED'].includes(state))&&executionStates.every(state=>['FAILED','CANCELLED','SUCCEEDED','QUEUED'].includes(state));
    const actions=el('div',{class:'detail-actions'});
    if(!item.paused && !item.blocked && !['AWAITING_REVIEW','BLOCKED','COMPLETED'].includes(phase)) {const pause=el('button',{class:'secondary-button',text:'Pause workflow'});pause.addEventListener('click',()=>mutateWorkflow('pause',item));actions.append(pause);}
    if(item.paused || phase==='PAUSED'){const resume=el('button',{class:'secondary-button',text:'Resume workflow'});resume.addEventListener('click',()=>mutateWorkflow('resume',item));actions.append(resume);}
    if(knownFailureRecovery&&!item.paused){const recover=el('button',{class:'secondary-button',text:'Resume after inspection'});recover.addEventListener('click',()=>{if(confirm('Review the failure logs and the committed candidate first. Resuming allows queued operations to run; it does not replay failed operations. Resume?'))return mutateWorkflow('resume',item);});actions.append(recover);}
    const refresh=el('button',{class:'secondary-button',text:'Refresh now'});refresh.addEventListener('click',()=>loadWork(true));actions.append(refresh);
    head.append(left,actions); target.append(makePhaseStrip(phase));
    const warning=el('div',{class:'warning-box',text:phase==='BLOCKED'?`Workflow blocked: ${workflow.reason||'manual intervention required'}. Check the failed operation logs; to continue the session, send additional instructions below. If workspace preparation failed or the execution state is unknown, the operator must resolve it first.`:item.blocked?(knownFailureRecovery?'Execution stopped dispatching due to a recorded failure or cancellation; queued operations have not run. Check the real logs and the committed candidate before resuming explicitly.':'The current execution is blocked and queued operations will not be dispatched. Verify unknown or in-progress executions first; there is no automatic recovery here.'):workflow.reason||''});warning.hidden=!workflow.reason&&phase!=='BLOCKED'&&!item.blocked;target.append(warning);
    const grid=el('div',{class:'detail-grid'}), col1=el('div',{class:'column'}), col2=el('div',{class:'column'});
    const sourcePanel=el('section',{class:'panel'}); sourcePanel.append(panelHead('Source & baseline','Immutable source snapshot'));
    const sb=el('div',{class:'panel-body'}), info=el('div',{class:'info-grid'});
    const addInfo=(label,value,mono=false)=>{const x=el('div',{class:'info-item'});x.append(el('label',{text:label}),el('div',{class:mono?'mono':'',text:value||'—'}));info.append(x);};
    const facts = sourceFacts(source, item.taskSpec || null);
    addInfo('Source finding',fid);addInfo('Risk level',facts.riskLabel ?? '—');addInfo('Repository',source.repositoryUrl||item.sourceRecord?.repositoryUrl);addInfo('Baseline commit',source.baseCommit||item.sourceRecord?.baseCommit,true);
    addInfo(facts.singleFile ? 'Source file' : 'Allowed scope', facts.singleFile ? (source.sourcePath||item.sourceRecord?.sourcePath) : (facts.scopeLabel ?? '—'), true);
    addInfo('Source revision',source.revision||item.sourceRecord?.revision,true);
    if (facts.evidenceLabel) addInfo('Acceptance evidence', facts.evidenceLabel);
    sb.append(info); sourcePanel.append(sb); col1.append(sourcePanel);
    col1.append(renderDelivery({ work:item,workflow,el,panelHead,request,reload:()=>loadWork(true),notice:showNotice }));
    const baseline=el('section',{class:'panel'});baseline.append(panelHead('Baseline reproduction','Real test run results'));const bb=el('div',{class:'panel-body'});
    const operations=(d.operations||[]).map(op=>normalizeOperation(op,d.evidence||[]));
    const baselineId=workflow.baselineOperationId||workflow.baselineOperation?.operationId||item.workflow?.baselineOperationId;
    const baseOp=operations.find(o=>o.operationId===baselineId);
    const reproduced=workflow.baselineReproduced===true||item.workflow?.baselineReproduced===true;
    const manualBaseline=item.source?.type==='MANUAL'&&item.taskSpec?.execution?.baselineMode;
    const baselineLabel=manualBaseline&&reproduced&&baseOp
      ? (manualBaseline==='record'?`Baseline recorded: ${baseOp.status==='SUCCEEDED'?'passed':'failed'}`:manualBaseline==='must-pass'?'Baseline passed':'Baseline failed as required')
      :reproduced?'Expected failure reproduced':baseOp?statusText(baseOp):(phaseIndex(phase)>=2?'Preparing or running baseline tests':'Waiting for baseline tests');
    const junit=baseOp?.junit;
    const evidenceFmt = item.taskSpec?.execution?.evidence?.format ?? (junit ? 'junit' : null);
    const baselineLine = evidenceLine(evidenceFmt, junit);
    const btext=el('div',{class:'baseline-box'});btext.append(el('strong',{text:baselineLabel}),el('span',{text:baseOp?`${baseOp.summary||`Operation ${baseOp.operationId} · ${statusText(baseOp)}${baseOp.exitCode!=null?` · exit code ${baseOp.exitCode}`:''}`}${baselineLine?` · ${baselineLine}`:''}`:'Pinned baseline tests run in an isolated workspace; progress is based only on real test results.'}));bb.append(btext);baseline.append(bb);col1.append(baseline);
    const plan=el('section',{class:'panel'});plan.append(panelHead('Implementation plan',workflow.plan?'Plan submitted by the model':'Waiting for read-only analysis'));const pb=el('div',{class:'panel-body'});
    if(workflow.plan){pb.append(el('div',{class:'plan-text',text:workflow.plan}));}else{pb.append(el('div',{class:'plan-placeholder',text:'The plan will appear here once read-only analysis completes. The workflow will not enter the code modification phase before approval.'}));}
    const approval=workflow.approval||{};const bar=el('div',{class:'approval-bar'});
    if(approval.approvedAt||approval.actor){bar.append(el('span',{class:'approved-label',text:`Approved by ${approval.actor||'Demo Operator'}${approval.approvedAt?` · ${new Date(approval.approvedAt).toLocaleString('en-US')}`:''}`}));}
    else if(phase==='AWAITING_PLAN_APPROVAL'&&workflow.planHash){bar.append(el('span',{text:'The workflow modifies code only after the plan is confirmed.'}));const approve=el('button',{class:'primary-button',text:'Approve plan & start execution'});approve.addEventListener('click',async()=>{if(!confirm('Approve the current plan and allow the workflow to enter the code modification phase?'))return;approve.disabled=true;try{await request(`/work-items/${encodeURIComponent(currentWorkId)}/approve-plan`,{method:'POST',body:{expectedVersion:item.version,planHash:workflow.planHash},mutation:true});await loadWork(true);}catch(e){showNotice(e.message,'error');approve.disabled=false;}});bar.append(approve);}
    else {bar.append(el('span',{text:phaseIndex(phase)<4?'Plan approval opens after read-only analysis completes.':'Plan approval status is recorded by the workflow.'}));}
    pb.append(bar);plan.append(pb);col1.append(plan);
    const activity=el('section',{class:'panel'});activity.append(panelHead('Operation log','Status, exit codes & JUnit'));const ab=el('div',{class:'panel-body'});ab.append(renderOperations(d.operations||[],d.evidence||[],openLogs));activity.append(ab);col1.append(activity);
    col1.append(renderMonitor({ workItemId: currentWorkId, workflow, operations, session, workItem: item, el, panelHead, request, notice: showNotice, phaseText: p => phaseLabels[phaseIndex(p)] ?? p, opLabel }));
    const sessionPanel=el('section',{class:'panel'});sessionPanel.append(panelHead('DSH work session',session?`${session.role||'Session'} · ${session.running?'Running':'Paused'}`:'No session yet'));const ss=el('div',{class:'panel-body'});
    if(session){const caption=el('div',{class:'session-caption'});caption.append(el('span',{text:`Session ${session.sessionId} · ${session.activity||''}`}));const sessionUrl=session.url||`/?mythosSession=${encodeURIComponent(session.sessionId)}&mythosEmbedded=1`;caption.append(el('a',{class:'session-link',href:sessionUrl,target:'_blank',rel:'noopener noreferrer',text:'Open in DSH ↗'}));const workbenchUrl=`/?mythosVibeTask=${encodeURIComponent(currentWorkId)}&mythosSession=${encodeURIComponent(session.sessionId)}&mythosEmbedded=1`;caption.append(el('a',{class:'session-link',href:workbenchUrl,target:'_blank',rel:'noopener noreferrer',text:'Read-only coding workbench ↗'}));ss.append(caption);
      if(session.url){const frame=el('iframe',{class:'session-frame',src:session.url,title:'DSH work session','data-session-id':String(session.sessionId)});ss.append(frame);} else {ss.append(renderTranscript(session));}
      const form=el('form',{class:'message-form'});const input=el('input',{type:'text',name:'text',placeholder:'Send additional instructions to the current work session…',autocomplete:'off','aria-label':'Additional instructions'});input.value=draft;const send=el('button',{class:'secondary-button',type:'submit',text:'Send'});form.append(input,send);form.addEventListener('submit',async ev=>{ev.preventDefault();const activeForm=ev.currentTarget;const activeInput=activeForm.elements.namedItem('text');const activeSend=activeForm.querySelector('button[type="submit"]');const text=activeInput.value.trim();if(!text)return;activeSend.disabled=true;try{await request(`/work-items/${encodeURIComponent(currentWorkId)}/message`,{method:'POST',body:{text},mutation:true});activeInput.value='';await loadWork(true);}catch(e){showNotice(e.message,'error');}finally{if(activeForm.isConnected)activeForm.querySelector('button[type="submit"]').disabled=false;}});if(['PUBLISHING','PR_OPEN','CLOSING','COMPLETED'].includes(phase)){ss.append(el('div',{class:'subtle',text:phase==='COMPLETED'?'Task completed; the session is kept for reference.':'The current candidate has entered delivery; the coding session is read-only. To make changes, close the unmerged PR in Gitea first.'}));}else ss.append(form);
    }else{ss.append(el('div',{class:'plan-placeholder',text:'The workflow creates an isolated DSH session at the corresponding phase.'}));}
    sessionPanel.append(ss);
    const gitPanel=el('section',{class:'panel'});gitPanel.append(panelHead('Code changes','Compared with the source baseline'));const gb=el('div',{class:'panel-body'});
    if(git){const meta=el('div',{class:'operation-details'});meta.append(el('span',{text:`Branch ${git.branch||'—'}`}),el('span',{class:'mono',text:`HEAD ${git.headCommit||'—'}`}));gb.append(meta);if(git.changedFiles?.length)gb.append(el('div',{class:'operation-details',text:`Changed files: ${git.changedFiles.join(', ')}`}));if(git.diff){const pre=el('pre',{class:'diff-box'});pre.textContent=git.diff;gb.append(pre);}else gb.append(el('div',{class:'diff-empty',text:'No code diff right now.'}));if(git.diffTruncated)gb.append(el('div',{class:'subtle',text:'Diff content truncated.'}));}
    else gb.append(el('div',{class:'diff-empty',text:'The code diff will appear here once the workspace is prepared.'}));gitPanel.append(gb);col2.append(gitPanel);
    const evidence=el('section',{class:'panel'});evidence.append(panelHead('Verification evidence','Baseline & independent verification'));const eb=el('div',{class:'panel-body'});const evList=d.evidence||[];if(evList.length){evList.forEach(e=>{const line=el('div',{class:'operation'});line.append(el('div',{class:'operation-top'},''));const top=line.firstElementChild;top.append(el('span',{class:'operation-name',text:e.label||e.kind||e.type||'Verification evidence'}),el('span',{class:`operation-status ${String(e.status||e.result||'').toUpperCase()==='PASSED'?'succeeded':''}`,text:e.status||e.result||''}));const meta=el('div',{class:'operation-details'});if(e.operationId)meta.append(el('span',{text:`Operation ${e.operationId}`}));if(e.sourceCommit)meta.append(el('span',{class:'mono',text:`Source commit ${e.sourceCommit}${e.sourceDirty?' (with uncommitted changes)':''}`}));const eLine=evidenceLine(item.taskSpec?.execution?.evidence?.format ?? (e.junit ? 'junit' : null), e.junit);if(eLine)meta.append(el('span',{text:eLine}));line.append(meta);eb.append(line);});}else eb.append(el('div',{class:'diff-empty',text:'Real verification evidence appears after the corresponding operation completes.'}));evidence.append(eb);col2.append(evidence);
    grid.append(col1,col2);col2.append(sessionPanel);target.append(grid);patchChildren(view,target);window.scrollTo(0,scrollY);if(restoreInputFocus){const next=view.querySelector('.message-form input');next?.focus({preventScroll:true});next?.setSelectionRange(draft.length,draft.length);}
  }
  function panelHead(title,sub){const h=el('div',{class:'panel-head'});h.append(el('h2',{text:title}),el('small',{text:sub||''}));return h;}
  async function mutateWorkflow(action,item){const endpoint=action==='pause'?'pause':'resume';try{await request(`/work-items/${encodeURIComponent(currentWorkId)}/${endpoint}`,{method:'POST',body:{expectedVersion:item.version},mutation:true});await loadWork(true);}catch(e){showNotice(e.message,'error');}}
  async function loadWork(force=false) {
    if (loading&&!force) return; loading=true;
    const id=route().id, epoch=routeEpoch, seq=++requestEpoch, changed=currentWorkId!==id;currentWorkId=id;
    if(!workSnapshot||changed){view.innerHTML='<div class="loading"><span class="spinner"></span>Loading workflow…</div>';}
    try{const data=await request(`/work-items/${encodeURIComponent(id)}`);if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='work'||route().id!==id)return;workSnapshot=data;hideNotice();renderWork(data);}
    catch(e){if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='work'||route().id!==id)return;showNotice(e.message,'error');if(!workSnapshot)view.innerHTML='<div class="empty-state">Cannot read this work item. Refresh the list to confirm the task id and sign-in state.</div>';}
    finally{if(seq===requestEpoch)loading=false;}
  }
  function renderWork(data){workSnapshot=data;const item=itemOf(data);if(!item){showNotice('The service response contains no work item.','error');return;}buildDetail(data);}
  function routeChanged(){routeEpoch++;requestEpoch++;loading=false;if(timer){clearInterval(timer);timer=null;}workSnapshot=null;taskCache=[];hideNotice();const r=route();document.querySelectorAll('.side-link').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='/mythos/#/'+r.name));if(r.name==='work'){loadWork(true);timer=setInterval(()=>{if(!document.hidden)loadWork();},1800);}else if(r.name==='intake'){crumbs.textContent='Repositories & New Task';intake.mount(view);intake.load(true);timer=setInterval(()=>{if(!document.hidden)intake.load();},5000);}else{loadTasks(true);timer=setInterval(()=>{if(!document.hidden)loadTasks();},5000);}}
  const intake = renderIntake({ el, panelHead, request, notice: showNotice, goWork: id => { location.hash = '#/work/' + encodeURIComponent(id); } });
  document.getElementById('refresh-button').addEventListener('click',()=>{const r=route();r.name==='work'?loadWork(true):r.name==='intake'?intake.load(true):loadTasks(true);});
  window.addEventListener('hashchange',routeChanged);
  routeChanged();
})();
