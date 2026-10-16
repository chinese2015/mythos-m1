(() => {
  'use strict';
  const API = '/argon/api';
  const view = document.getElementById('view');
  const notice = document.getElementById('notice');
  const crumbs = document.getElementById('breadcrumbs');
  const navCount = document.getElementById('nav-count');
  const phases = ['CLAIMED','PREPARING','BASELINE','PLANNING','AWAITING_PLAN_APPROVAL','CODING','VERIFYING','AWAITING_REVIEW'];
  const phaseLabels = ['已接收','准备工作区','复现基线','生成方案','方案待审批','执行修改','独立验证','等待审核'];
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
  function route() { const h = location.hash || '#/tasks'; const match = h.match(/^#\/work\/([^/?#]+)/); return match ? {name:'work',id:decodeURIComponent(match[1])} : {name:'tasks'}; }
  function setCrumbs(workItem) {
    if (!workItem) { crumbs.textContent = '任务中心'; return; }
    crumbs.replaceChildren();
    const a = el('a',{href:'/argon/#/tasks'},'任务中心');
    const sep = el('span',{class:'sep'},'/'); const title = el('strong',{},`${workItem.source?.id || workItem.sourceRecord?.id || '任务'} · 工作详情`);
    crumbs.append(a,sep,title);
  }
  async function request(path, {method='GET',body, mutation=false} = {}) {
    const headers = {'Accept':'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (mutation) { headers['X-Argon-Action'] = '1'; headers['Idempotency-Key'] = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
    let response;
    try { response = await fetch(`${API}${path}`, {method,headers,credentials:'same-origin',body:body === undefined ? undefined : JSON.stringify(body)}); }
    catch (_) { throw new Error('无法连接 Argon 工作流服务。请检查连接后重试。'); }
    if (response.status === 401) throw new Error('登录状态已失效。请先在 DSH 主界面重新登录，再返回任务工作台。');
    let data = {};
    try { data = await response.json(); } catch (_) { /* malformed response is reported below */ }
    if (!response.ok) {
      const detail = data.error || data.message || data.detail;
      if (response.status === 409) throw new Error(`${detail || '任务状态已被其他操作更新。'} 请刷新页面后确认最新状态，再决定下一步。`);
      throw new Error(detail ? String(detail) : `请求失败（HTTP ${response.status}）。请刷新后重试。`);
    }
    return data;
  }
  function taskStatus(task) {
    if (task.workItemId) return {label:task.workStage || task.status || '处理中', cls:'running'};
    return task.enabled ? {label:'可开始',cls:'enabled'} : {label:'预览',cls:''};
  }
  function riskClass(risk) { const v=String(risk||'').toLowerCase(); return /high|高|critical|严重/.test(v)?'high':(/low|低/.test(v)?'low':'medium'); }
  function riskName(risk) { const v=String(risk||''); return ({HIGH:'高风险',MEDIUM:'中风险',LOW:'低风险',high:'高风险',medium:'中风险',low:'低风险'})[v] || v || '未标记风险'; }
  function shortRepo(url) { if (!url) return '—'; try { const u=new URL(url); return (u.pathname.split('/').filter(Boolean).slice(-2).join('/') || u.host); } catch (_) { return url; } }
  function renderTasks(data) {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    taskCache = tasks; navCount.textContent = String(tasks.filter(t=>t.enabled).length);
    setCrumbs(null);
    const active = tasks.filter(t=>t.workItemId).length;
    view.innerHTML = `<div class="page-heading"><div><div class="eyebrow">TASK INTAKE</div><h1>任务中心</h1><p>从已登记的问题开始。Argon 会准备工作区、复现基线并提交方案供你审批。</p></div><div class="heading-meta"><strong>${tasks.length}</strong>条来源任务</div></div>
      <div class="summary-grid"><div class="summary-card"><span>来源任务</span><strong>${tasks.length}</strong><i class="summary-icon">▦</i></div><div class="summary-card"><span>可启动工作流</span><strong>${tasks.filter(t=>t.enabled).length}</strong><i class="summary-icon">↗</i></div><div class="summary-card"><span>进行中的任务</span><strong>${active}</strong><i class="summary-icon">◷</i></div></div>
      <div class="section-heading"><h2>已映射的问题</h2><small>来源：Mock Findings · 刷新自动同步状态</small></div><div class="task-list" id="task-list"></div>`;
    const list = document.getElementById('task-list');
    if (!tasks.length) { list.innerHTML='<div class="empty-state">当前没有可展示的问题。来源数据恢复后会自动出现。</div>'; return; }
    tasks.forEach(task => {
      const state=taskStatus(task), enabled=!!task.enabled;
      const card=el('article',{class:`task-card ${enabled?'':'preview'}`});
      const content=el('div');
      const row=el('div',{class:'task-title-row'});
      row.append(el('span',{class:'finding-id',text:task.id}),el('span',{class:'task-title',text:task.title||'未命名问题'}),el('span',{class:`risk ${riskClass(task.risk)}`,text:riskName(task.risk)}));
      const desc=el('p',{class:'task-description',text:task.description||'来源问题将通过独立工作区处理，原始问题状态不会被自动关闭。'});
      const meta=el('div',{class:'task-meta'});
      meta.append(el('span',{},`仓库：`),el('b',{text:shortRepo(task.repositoryUrl)}),el('span',{class:'dotsep',text:'•'}),el('span',{},'基线：'),el('b',{class:'mono',text:(task.baseCommit||'—').slice(0,10)}),el('span',{class:'dotsep',text:'•'}),el('span',{},'来源：'),el('b',{text:`${task.ownerId||'—'} · ${task.revision||'—'}`}));
      content.append(row,desc,meta);
      const side=el('div',{class:'task-side'}); side.append(el('span',{class:`status-pill ${state.cls}`,text:state.label}));
      if (enabled && task.workItemId) { const b=el('button',{class:'secondary-button',type:'button',text:'打开工作详情'}); b.addEventListener('click',()=>location.hash=`#/work/${encodeURIComponent(task.workItemId)}`); side.append(b); }
      else if (enabled) { const b=el('button',{class:'primary-button',type:'button',text:'开始处理'}); b.addEventListener('click',()=>startTask(task,b)); side.append(b); }
      else side.append(el('span',{class:'preview-tag',text:'此演示暂不可启动'}));
      card.append(content,side); list.append(card);
    });
  }
  async function loadTasks(force=false) {
    if (loading&&!force) return; loading=true;
    const epoch=routeEpoch, seq=++requestEpoch;
    if (!taskCache.length) view.innerHTML='<div class="loading"><span class="spinner"></span>正在读取来源任务…</div>';
    try { hideNotice(); const data=await request('/tasks'); if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='tasks')return; renderTasks(data); }
    catch(e) { if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='tasks')return; showNotice(e.message,'error'); if (!taskCache.length) view.innerHTML='<div class="empty-state">任务来源暂不可用。<br><br>请检查服务状态，或刷新重试。</div>'; }
    finally { if(seq===requestEpoch)loading=false; }
  }
  async function startTask(task, button) {
    button.disabled=true; button.textContent='正在启动…';
    try { hideNotice(); const data=await request(`/tasks/${encodeURIComponent(task.id)}/start`,{method:'POST',body:{expectedRevision:task.revision},mutation:true});
      if (!data.workItemId) throw new Error('服务未返回工作项编号，请刷新任务列表确认启动状态。');
      location.hash=`#/work/${encodeURIComponent(data.workItemId)}`;
    } catch(e) { showNotice(e.message,'error'); button.disabled=false; button.textContent='开始处理'; }
  }
  const itemOf = d => d.workItem || d;
  function phaseOf(d) { return d.workflow?.phase || itemOf(d)?.workflow?.phase || itemOf(d)?.stage || 'CLAIMED'; }
  function phaseIndex(phase) { const idx=phases.indexOf(phase); return idx<0?0:idx; }
  function normalizeOperation(raw, evidenceRecords = []) {
    const state=String(raw.status||raw.state||'UNKNOWN').toUpperCase();
    const evidence=raw.evidence||evidenceRecords.find(e=>e.operationId===(raw.operationId||raw.id))||{};
    return {...raw,id:raw.id||raw.operationId,operationId:raw.operationId||raw.id,status:state,junit:raw.junit||evidence.junit,evidence,version:raw.version??raw.expectedVersion};
  }
  function statusText(op) { const v=String(op.status||op.state||'UNKNOWN').toUpperCase(); return ({SUCCEEDED:'已完成',COMPLETED:'已完成',FAILED:'失败',RUNNING:'运行中',QUEUED:'排队中',PENDING:'等待中',CANCELLED:'已取消',CANCELED:'已取消',UNKNOWN:'状态未知'})[v]||v; }
  function opLabel(op) { const kind=op.kind||op.type||op.operationType||'操作'; return ({UNIT_TEST:'单元测试',VERIFY:'独立验证',TEST:'测试',AGENT:'Agent 执行',COMMAND:'命令执行'})[kind]||kind; }
  function safeText(value) { return String(value==null?'':value); }
  function makePhaseStrip(phase) {
    const active=phaseIndex(phase); const strip=el('div',{class:'phase-strip'});
    phases.forEach((p,i)=>{ const n=el('div',{class:`phase ${i<active?'done':i===active?'current':''}`}); n.append(el('div',{class:'phase-marker'}),el('span',{text:phaseLabels[i]})); strip.append(n); });
    return strip;
  }
  function renderOperations(rawOps, evidenceRecords = [], openLogs = new Map()) {
    const ops=(rawOps||[]).map(op=>normalizeOperation(op,evidenceRecords));
    const wrap=el('div');
    if (!ops?.length) { wrap.append(el('div',{class:'subtle',text:'工作流尚未提交操作。'})); return wrap; }
    ops.forEach(op=>{
      const row=el('div',{class:'operation','data-operation-id':op.operationId}); const top=el('div',{class:'operation-top'}); top.append(el('span',{class:'operation-name',text:opLabel(op)}),el('span',{class:`operation-status ${['SUCCEEDED','COMPLETED'].includes(op.status)?'succeeded':op.status==='FAILED'?'failed':''}`,text:statusText(op)})); row.append(top);
      const details=el('div',{class:'operation-details'}); details.append(el('span',{text:`ID ${op.id||op.operationId||'—'}`})); if(op.exitCode!==undefined&&op.exitCode!==null) details.append(el('span',{text:`退出码 ${op.exitCode}`})); if(op.startedAt) details.append(el('span',{text:`开始 ${new Date(op.startedAt).toLocaleString('zh-CN')}`}));
      if (op.junit) { const j=op.junit; details.append(el('span',{text:`JUnit：${j.tests??j.testCount??'?'} 项 · ${j.failures??'?'} 失败 · ${j.errors??'?'} 错误`})); }
      row.append(details);
      const opId=op.operationId;
      if(opId) { const tools=el('div',{class:'operation-details'}); const logButton=el('button',{class:'text-button',type:'button',text:'查看运行日志'}); const log=el('div',{class:'log-box','data-log-operation':opId}); log.hidden=!openLogs.has(opId);if(!log.hidden)log.textContent=openLogs.get(opId); logButton.addEventListener('click',async()=>{ log.hidden=false; log.textContent='正在读取日志…'; try{const res=await request(`/operations/${encodeURIComponent(opId)}/logs?after=0`);const lines=res.lines||res.logs||res.entries||[];log.textContent=Array.isArray(lines)?lines.map(x=>typeof x==='string'?x:(x.text||x.message||JSON.stringify(x))).join('\n'):String(lines);}catch(e){log.textContent=e.message;} }); tools.append(logButton); if(['RUNNING','QUEUED','PENDING'].includes(op.status)){const cancel=el('button',{class:'text-button',type:'button',text:'取消此操作'});cancel.addEventListener('click',async()=>{if(!confirm('确定取消这条操作？这不会暂停工作流。'))return;try{await request(`/operations/${encodeURIComponent(opId)}/cancel`,{method:'POST',body:{expectedVersion:op.version},mutation:true});await loadWork(true);}catch(e){showNotice(e.message,'error');}});tools.append(cancel);} row.append(tools,log); }
      wrap.append(row);
    }); return wrap;
  }
  function renderTranscript(session) {
    const entries=session?.transcript||[]; const wrap=el('div',{class:'transcript'});
    if(!entries.length){wrap.append(el('div',{class:'subtle',text:session?.running?'Session 正在运行，等待新的活动…':'暂时没有可展示的 Session 活动。'}));return wrap;}
    entries.forEach(e=>{const item=el('div',{class:'message-item'});item.append(el('div',{class:'message-role',text:e.toolName?`工具 · ${e.toolName}`:(e.type||'消息')}),el('div',{text:e.text|| (e.isError?'发生错误':'')}));wrap.append(item);});return wrap;
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
    const title=source.title||item.sourceRecord?.title||'任务工作项'; const fid=source.id||item.sourceRecord?.id||'ARGON';
    target.append(el('div',{class:'detail-head'})); setCrumbs(item);
    const head=target.firstElementChild; const left=el('div'); left.append(el('div',{class:'eyebrow',text:`WORK ITEM · ${item.id||currentWorkId}`}),el('h1',{text:title}),el('p',{text:`来源 ${fid} · ${source.ownerId||item.sourceRecord?.ownerId||'—'} · 版本 ${item.version??'—'}`}));
    const actions=el('div',{class:'detail-actions'});
    if(phase==='BLOCKED') {const resume=el('button',{class:'secondary-button',text:'尝试继续工作流'});resume.addEventListener('click',()=>mutateWorkflow('resume',item));actions.append(resume);}
    else if(!item.paused && phase!=='AWAITING_REVIEW') {const pause=el('button',{class:'secondary-button',text:'暂停工作流'});pause.addEventListener('click',()=>mutateWorkflow('pause',item));actions.append(pause);}
    if(item.paused || phase==='PAUSED'){const resume=el('button',{class:'secondary-button',text:'恢复工作流'});resume.addEventListener('click',()=>mutateWorkflow('resume',item));actions.append(resume);}
    const refresh=el('button',{class:'secondary-button',text:'立即刷新'});refresh.addEventListener('click',()=>loadWork(true));actions.append(refresh);
    head.append(left,actions); target.append(makePhaseStrip(phase));
    const warning=el('div',{class:'warning-box',text:phase==='BLOCKED'?`工作流已阻塞：${workflow.reason||'需要人工处理'}。你可以查看失败操作的日志，或尝试继续工作流。`:workflow.reason||''});warning.hidden=!workflow.reason&&phase!=='BLOCKED';target.append(warning);
    const grid=el('div',{class:'detail-grid'}), col1=el('div',{class:'column'}), col2=el('div',{class:'column'});
    const sourcePanel=el('section',{class:'panel'}); sourcePanel.append(panelHead('来源与基线','不可变来源快照'));
    const sb=el('div',{class:'panel-body'}), info=el('div',{class:'info-grid'});
    const addInfo=(label,value,mono=false)=>{const x=el('div',{class:'info-item'});x.append(el('label',{text:label}),el('div',{class:mono?'mono':'',text:value||'—'}));info.append(x);};
    addInfo('来源问题',fid);addInfo('风险等级',riskName(source.risk||item.sourceRecord?.risk));addInfo('仓库',source.repositoryUrl||item.sourceRecord?.repositoryUrl);addInfo('基线提交',source.baseCommit||item.sourceRecord?.baseCommit,true);addInfo('源文件',source.sourcePath||item.sourceRecord?.sourcePath,true);addInfo('来源修订',source.revision||item.sourceRecord?.revision,true);
    sb.append(info); sourcePanel.append(sb); col1.append(sourcePanel);
    const baseline=el('section',{class:'panel'});baseline.append(panelHead('基线复现','真实测试运行结果'));const bb=el('div',{class:'panel-body'});
    const operations=(d.operations||[]).map(op=>normalizeOperation(op,d.evidence||[]));
    const baselineId=workflow.baselineOperationId||workflow.baselineOperation?.operationId||item.workflow?.baselineOperationId;
    const baseOp=operations.find(o=>o.operationId===baselineId);
    const reproduced=workflow.baselineReproduced===true||item.workflow?.baselineReproduced===true;
    const baselineLabel=reproduced?'已复现预期失败':baseOp?statusText(baseOp):(phaseIndex(phase)>=2?'正在准备或运行基线测试':'等待基线测试');
    const junit=baseOp?.junit;
    const btext=el('div',{class:'baseline-box'});btext.append(el('strong',{text:baselineLabel}),el('span',{text:baseOp?`${baseOp.summary||`操作 ${baseOp.operationId} · ${statusText(baseOp)}${baseOp.exitCode!=null?` · 退出码 ${baseOp.exitCode}`:''}`}${junit?` · JUnit ${junit.tests??junit.testCount??'?'} 项，${junit.failures??'?'} 失败，${junit.errors??'?'} 错误`:''}`:'固定基线测试会在独立工作区运行；仅按真实测试结果推进。'}));bb.append(btext);baseline.append(bb);col1.append(baseline);
    const plan=el('section',{class:'panel'});plan.append(panelHead('实施方案',workflow.plan?'模型提交的方案':'等待只读分析完成'));const pb=el('div',{class:'panel-body'});
    if(workflow.plan){pb.append(el('div',{class:'plan-text',text:workflow.plan}));}else{pb.append(el('div',{class:'plan-placeholder',text:'只读分析完成后，方案会显示在这里。批准前工作流不会进入代码修改阶段。'}));}
    const approval=workflow.approval||{};const bar=el('div',{class:'approval-bar'});
    if(approval.approvedAt||approval.actor){bar.append(el('span',{class:'approved-label',text:`已由 ${approval.actor||'演示操作员'} 批准${approval.approvedAt?` · ${new Date(approval.approvedAt).toLocaleString('zh-CN')}`:''}`}));}
    else if(phase==='AWAITING_PLAN_APPROVAL'&&workflow.planHash){bar.append(el('span',{text:'确认方案后，工作流才会开始修改代码。'}));const approve=el('button',{class:'primary-button',text:'批准方案并开始执行'});approve.addEventListener('click',async()=>{if(!confirm('批准当前方案并允许工作流进入代码修改阶段？'))return;approve.disabled=true;try{await request(`/work-items/${encodeURIComponent(currentWorkId)}/approve-plan`,{method:'POST',body:{expectedVersion:item.version,planHash:workflow.planHash},mutation:true});await loadWork(true);}catch(e){showNotice(e.message,'error');approve.disabled=false;}});bar.append(approve);}
    else {bar.append(el('span',{text:phaseIndex(phase)<4?'方案审批会在只读分析完成后开放。':'方案审批状态由工作流记录。'}));}
    pb.append(bar);plan.append(pb);col1.append(plan);
    const activity=el('section',{class:'panel'});activity.append(panelHead('操作记录','状态、退出码与 JUnit'));const ab=el('div',{class:'panel-body'});ab.append(renderOperations(d.operations||[],d.evidence||[],openLogs));activity.append(ab);col1.append(activity);
    const sessionPanel=el('section',{class:'panel'});sessionPanel.append(panelHead('DSH 工作会话',session?`${session.role||'Session'} · ${session.running?'运行中':'已暂停'}`:'会话尚未建立'));const ss=el('div',{class:'panel-body'});
    if(session){const caption=el('div',{class:'session-caption'});caption.append(el('span',{text:`Session ${session.sessionId} · ${session.activity||''}`}));const sessionUrl=session.url||`/?argonSession=${encodeURIComponent(session.sessionId)}&argonEmbedded=1`;caption.append(el('a',{class:'session-link',href:sessionUrl,target:'_blank',rel:'noopener noreferrer',text:'在 DSH 中打开 ↗'}));ss.append(caption);
      if(session.url){const frame=el('iframe',{class:'session-frame',src:session.url,title:'DSH 工作会话','data-session-id':String(session.sessionId)});ss.append(frame);} else {ss.append(renderTranscript(session));}
      const form=el('form',{class:'message-form'});const input=el('input',{type:'text',name:'text',placeholder:'向当前工作会话发送补充说明…',autocomplete:'off','aria-label':'补充说明'});input.value=draft;const send=el('button',{class:'secondary-button',type:'submit',text:'发送'});form.append(input,send);form.addEventListener('submit',async ev=>{ev.preventDefault();const activeForm=ev.currentTarget;const activeInput=activeForm.elements.namedItem('text');const activeSend=activeForm.querySelector('button[type="submit"]');const text=activeInput.value.trim();if(!text)return;activeSend.disabled=true;try{await request(`/work-items/${encodeURIComponent(currentWorkId)}/message`,{method:'POST',body:{text},mutation:true});activeInput.value='';await loadWork(true);}catch(e){showNotice(e.message,'error');}finally{if(activeForm.isConnected)activeForm.querySelector('button[type="submit"]').disabled=false;}});ss.append(form);
    }else{ss.append(el('div',{class:'plan-placeholder',text:'工作流会在对应阶段创建独立的 DSH Session。'}));}
    sessionPanel.append(ss);col2.append(sessionPanel);
    const gitPanel=el('section',{class:'panel'});gitPanel.append(panelHead('代码变更','与来源基线比较'));const gb=el('div',{class:'panel-body'});
    if(git){const meta=el('div',{class:'operation-details'});meta.append(el('span',{text:`分支 ${git.branch||'—'}`}),el('span',{class:'mono',text:`HEAD ${git.headCommit||'—'}`}));gb.append(meta);if(git.changedFiles?.length)gb.append(el('div',{class:'operation-details',text:`变更文件：${git.changedFiles.join('、')}`}));if(git.diff){const pre=el('pre',{class:'diff-box'});pre.textContent=git.diff;gb.append(pre);}else gb.append(el('div',{class:'diff-empty',text:'当前没有代码差异。'}));if(git.diffTruncated)gb.append(el('div',{class:'subtle',text:'差异内容已截断。'}));}
    else gb.append(el('div',{class:'diff-empty',text:'工作区准备完成后，代码差异会显示在这里。'}));gitPanel.append(gb);col2.append(gitPanel);
    const evidence=el('section',{class:'panel'});evidence.append(panelHead('验证证据','基线与独立验证'));const eb=el('div',{class:'panel-body'});const evList=d.evidence||[];if(evList.length){evList.forEach(e=>{const line=el('div',{class:'operation'});line.append(el('div',{class:'operation-top'},''));const top=line.firstElementChild;top.append(el('span',{class:'operation-name',text:e.label||e.kind||e.type||'验证证据'}),el('span',{class:`operation-status ${String(e.status||e.result||'').toUpperCase()==='PASSED'?'succeeded':''}`,text:e.status||e.result||''}));const meta=el('div',{class:'operation-details'});if(e.operationId)meta.append(el('span',{text:`操作 ${e.operationId}`}));if(e.sourceCommit)meta.append(el('span',{class:'mono',text:`来源提交 ${e.sourceCommit}${e.sourceDirty?'（含未提交变更）':''}`}));const j=e.junit;if(j)meta.append(el('span',{text:`JUnit：${j.tests??j.testCount??'?'} 项 · ${j.failures??'?'} 失败 · ${j.errors??'?'} 错误`}));line.append(meta);eb.append(line);});}else eb.append(el('div',{class:'diff-empty',text:'真实验证证据会在对应操作完成后显示。'}));evidence.append(eb);col2.append(evidence);
    grid.append(col1,col2);target.append(grid);patchChildren(view,target);window.scrollTo(0,scrollY);if(restoreInputFocus){const next=view.querySelector('.message-form input');next?.focus({preventScroll:true});next?.setSelectionRange(draft.length,draft.length);}
  }
  function panelHead(title,sub){const h=el('div',{class:'panel-head'});h.append(el('h2',{text:title}),el('small',{text:sub||''}));return h;}
  async function mutateWorkflow(action,item){const endpoint=action==='pause'?'pause':'resume';try{await request(`/work-items/${encodeURIComponent(currentWorkId)}/${endpoint}`,{method:'POST',body:{expectedVersion:item.version},mutation:true});await loadWork(true);}catch(e){showNotice(e.message,'error');}}
  async function loadWork(force=false) {
    if (loading&&!force) return; loading=true;
    const id=route().id, epoch=routeEpoch, seq=++requestEpoch, changed=currentWorkId!==id;currentWorkId=id;
    if(!workSnapshot||changed){view.innerHTML='<div class="loading"><span class="spinner"></span>正在读取工作流…</div>';}
    try{const data=await request(`/work-items/${encodeURIComponent(id)}`);if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='work'||route().id!==id)return;workSnapshot=data;hideNotice();renderWork(data);}
    catch(e){if(epoch!==routeEpoch||seq!==requestEpoch||route().name!=='work'||route().id!==id)return;showNotice(e.message,'error');if(!workSnapshot)view.innerHTML='<div class="empty-state">无法读取此工作项。请刷新列表确认任务编号和登录状态。</div>';}
    finally{if(seq===requestEpoch)loading=false;}
  }
  function renderWork(data){workSnapshot=data;const item=itemOf(data);if(!item){showNotice('服务返回的数据中没有工作项。','error');return;}buildDetail(data);}
  function routeChanged(){routeEpoch++;requestEpoch++;loading=false;if(timer){clearInterval(timer);timer=null;}workSnapshot=null;taskCache=[];hideNotice();const r=route();if(r.name==='work'){loadWork(true);timer=setInterval(()=>{if(!document.hidden)loadWork();},1800);}else loadTasks(true);}
  document.getElementById('refresh-button').addEventListener('click',()=>{const r=route();r.name==='work'?loadWork(true):loadTasks(true);});
  window.addEventListener('hashchange',routeChanged);
  routeChanged();
})();
