import {acceptMessage,referenceText} from './bridge.js';
import {renderMonitor} from './monitor-view.js';
const $=id=>document.getElementById(id),frame=$('native'),source=$('source');
let works=[],workId,generation=0,detail,file,path='',binding,ready=false,mode='code',polling=false,fileRequest=0,contextRequest=0,handshakeTimer;
const pending=new Set();
function notice(text){$('notice').textContent=text||'';$('notice').hidden=!text;}
function el(tag,attrs={}){const node=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key==='text')node.textContent=value;else if(key==='class')node.className=value;else node.setAttribute(key,value);}return node;}
async function requestAt(base,route,options={}){
  const response=await fetch(base+route,{method:options.method??'GET',cache:'no-store',headers:options.mutation?{'Content-Type':'application/json','X-Mythos-Action':'1','Idempotency-Key':crypto.randomUUID()}:undefined,body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'任务读取失败');return data;
}
const coding=route=>requestAt('/mythos/coding/api/work-items/'+workId,route);
function saveView(){if(workId&&path)sessionStorage.setItem('mythos.coding.view.'+workId,JSON.stringify({path,scroll:source.scrollTop,start:source.selectionStart,end:source.selectionEnd,mode}));}
function renderMode(){const diff=mode==='diff';$('code').hidden=diff;$('diff').hidden=!diff;$('code-tab').classList.toggle('active',!diff);$('diff-tab').classList.toggle('active',diff);$('quote').disabled=diff||!ready||!file;}
async function openFile(next,line=1,restore){
  const epoch=generation,id=workId,ticket=++fileRequest;notice('');
  try{
    const response=await requestAt('/mythos/coding/api/work-items/'+id,'/file?'+new URLSearchParams({path:next}));if(epoch!==generation||ticket!==fileRequest)return;
    file=response;path=next;source.value=response.text;$('filename').textContent=next;
    $('gutter').textContent=Array.from({length:response.lines},(_,i)=>i+1).join('\n');
    $('file-info').textContent=response.lines+' 行 · '+response.contentHash.slice(0,23)+' · 读取时快照';
    const start=response.text.split('\n').slice(0,line-1).join('\n').length+(line>1?1:0);
    source.setSelectionRange(restore?.start??start,restore?.end??start);source.scrollTop=restore?.scroll??Math.max(0,(line-3)*21.6);
    mode=restore?.mode??'code';renderMode();saveView();
  }catch(error){if(epoch===generation&&ticket===fileRequest)notice(error.message);}
}
async function listDirectory(relative='',depth=0,host=$('tree')){
  const epoch=generation,id=workId;
  try{
    const data=await requestAt('/mythos/coding/api/work-items/'+id,'/files?'+new URLSearchParams({path:relative}));if(epoch!==generation)return;
    for(const entry of [...data.entries].sort((a,b)=>(a.type==='directory'?0:1)-(b.type==='directory'?0:1)||a.name.localeCompare(b.name))){
      const next=relative?relative+'/'+entry.name:entry.name,row=el('button',{class:'file-row',text:(entry.type==='directory'?'▸ ':'◇ ')+entry.name,title:next});row.style.paddingLeft=(9+depth*13)+'px';host.append(row);
      if(entry.type==='directory'){
        const children=el('div');children.hidden=true;host.append(children);let loaded=false;
        const expand=async()=>{children.hidden=!children.hidden;row.textContent=(children.hidden?'▸ ':'▾ ')+entry.name;if(!children.hidden&&!loaded){loaded=true;await listDirectory(next,depth+1,children);}};
        row.onclick=expand;
        if((path||detail?.source?.sourcePath||'').startsWith(next+'/'))await expand();
      }else if(entry.type==='file')row.onclick=()=>openFile(next);else row.disabled=true;
    }
    if(data.truncated)host.append(el('small',{text:'目录超过 2000 项，当前列表已截断'}));
  }catch(error){if(epoch===generation)host.append(el('small',{text:error.message}));}
}
function renderRuns(snapshot){
  const id=workId,epoch=generation;
  const operations=(snapshot.operations||[]).map(op=>({...op,status:op.status??op.state,junit:op.junit??op.evidence?.junit}));
  const panel=renderMonitor({workItemId:id,workItem:snapshot.workItem,workflow:snapshot.workflow??snapshot.workItem.workflow,operations,session:snapshot.session,monitorHost:$('monitor'),el,
    panelHead:(title,subtitle)=>{const node=el('div',{class:'panel-head'});node.append(el('h2',{text:title}),el('small',{text:subtitle}));return node;},
    phaseText:value=>value,opLabel:op=>({UNIT_TEST:'单元测试',VERIFY:'独立验证',COMMAND:'命令'})[op.kind]||op.kind||'执行',notice,
    request:async(route,options)=>{if(epoch!==generation)throw new Error('任务已切换');const result=await requestAt('/mythos/api',route,options);if(epoch!==generation)throw new Error('任务已切换');return result;}});
  const scroll=$('monitor').scrollTop;$('monitor').replaceChildren(panel);$('monitor').scrollTop=scroll;
}
function bindNative(snapshot){
  const sid=snapshot.session?.sessionId;
  if(binding?.sessionId===sid&&binding.workItemId===workId)return;
  binding=null;ready=false;pending.clear();$('quote').disabled=true;
  clearTimeout(handshakeTimer);frame.style.visibility='hidden';
  if(!sid){frame.removeAttribute('src');$('bridge-status').textContent='当前阶段尚未创建会话';$('session').textContent='';return;}
  binding={workItemId:workId,sessionId:sid,bindingId:crypto.randomUUID()};
  const currentBinding=binding.bindingId;
  frame.src='/?'+new URLSearchParams({mythosCodingWork:workId,mythosCodingBinding:binding.bindingId});
  $('native-link').href='/?'+new URLSearchParams({mythosCodingWork:workId});$('session').textContent=sid;$('bridge-status').textContent='正在连接原生会话';
  handshakeTimer=setTimeout(()=>{if(binding?.bindingId===currentBinding&&!ready){$('bridge-status').textContent='原生会话连接超时';notice('原生会话暂不可用，可打开完整 DSH 查看或重新进入工作区');}},20000);
}
async function refreshContext(){
  if(polling)return;polling=true;const epoch=generation,id=workId,ticket=++contextRequest;
  try{
    const snapshot=await requestAt('/mythos/coding/api/work-items/'+id,'/context');if(epoch!==generation||ticket!==contextRequest)return;
    if(detail&&snapshot.workItem.version<detail.workItem.version)return;
    detail=snapshot;const item=snapshot.workItem,wf=snapshot.workflow??item.workflow,git=snapshot.git;
    $('task-context').textContent=(snapshot.source?.id||item.source?.id||id)+' · '+(snapshot.source?.title||'')+' · '+wf.phase;
    $('status').textContent=(git?.branch||'工作区准备中')+' · HEAD '+(git?.headCommit?.slice(0,12)||'—')+' · '+(snapshot.session?.activity||'暂无 Agent 活动');
    $('diff').textContent=git?`基线 ${git.baseCommit}\nHEAD ${git.headCommit}${git.status?' · 有未提交修改':''}\n文件 ${(git.changedFiles||[]).join(', ')||'无变更'}\n\n${git.diff||'当前无 Git 差异'}${git.diffTruncated?'\n\n差异已截断':''}`:'工作区尚未准备，暂时没有 Diff';
    bindNative(snapshot);renderRuns(snapshot);
  }catch(error){if(epoch===generation&&ticket===contextRequest)notice(error.message);}finally{if(epoch===generation&&ticket===contextRequest)polling=false;}
}
async function selectWork(id){
  if(!/^work-[a-f0-9]{32}$/.test(id??'')){notice('请从任务详情进入编码工作区');return;}
  saveView();workId=id;generation++;fileRequest++;contextRequest++;detail=null;file=null;path='';binding=null;ready=false;polling=false;pending.clear();source.value='';$('tree').replaceChildren();$('quote').disabled=true;
  clearTimeout(handshakeTimer);frame.style.visibility='hidden';frame.removeAttribute('src');$('native-link').removeAttribute('href');
  $('session').textContent='';$('bridge-status').textContent='正在读取任务';$('task-context').textContent='正在读取当前任务…';$('status').textContent='正在读取当前任务';
  $('diff').textContent='';$('monitor').replaceChildren();$('filename').textContent='选择文件';$('file-info').textContent='等待任务上下文';notice('');
  $('tasks').value=id;$('overview').href='/mythos/#/work/'+id;location.hash='/work/'+id;
  let restore;try{restore=JSON.parse(sessionStorage.getItem('mythos.coding.view.'+id)||'null');}catch{}
  await refreshContext();if(workId!==id||!detail)return;
  path=restore?.path??detail?.source?.sourcePath??'';
  await Promise.all([listDirectory(),path?openFile(path,1,restore):Promise.resolve()]);
}
window.addEventListener('message',event=>{
  if(!binding||!acceptMessage(event.data,{origin:event.origin,source:event.source,expectedOrigin:location.origin,expectedSource:frame.contentWindow,binding}))return;
  const data=event.data;
  if(data.type==='native.ready'){clearTimeout(handshakeTimer);ready=true;frame.style.visibility='visible';$('bridge-status').textContent='已连接';renderMode();}
  if(data.type==='native.error'){notice(data.error);if(!ready)$('bridge-status').textContent='会话暂不可用';}
  if(data.type==='context.ack'&&pending.delete(data.replyTo))notice(data.inserted?'已加入原生草稿，尚未发送':'草稿已变化，本次引用未插入');
  if(data.type==='file.open')openFile(data.path,data.line);
});
$('quote').onclick=()=>{
  if(!file||!ready||!binding)return;
  const start=source.selectionStart,end=source.selectionEnd,startLine=source.value.slice(0,start).split('\n').length,endLine=source.value.slice(0,Math.max(start,end-1)).split('\n').length;
  try{const text=referenceText({path,startLine,endLine,version:file.contentHash,text:end>start?source.value.slice(start,end):source.value.split('\n')[startLine-1]||''}),requestId=crypto.randomUUID();pending.add(requestId);frame.contentWindow.postMessage({protocol:1,...binding,type:'context.insert',requestId,text},location.origin);}catch(error){notice(error.message);}
};
$('tasks').onchange=()=>selectWork($('tasks').value);$('reload-file').onclick=()=>path&&openFile(path);
$('retry-task').onclick=()=>workId&&selectWork(workId);
for(const tab of ['code','diff'])$(tab+'-tab').onclick=()=>{mode=tab;renderMode();saveView();};
window.addEventListener('beforeunload',saveView);source.addEventListener('select',saveView);source.addEventListener('scroll',()=>{$('gutter').scrollTop=source.scrollTop;});
window.addEventListener('hashchange',()=>{const id=location.hash.match(/^#\/work\/(work-[a-f0-9]{32})$/)?.[1];if(id&&id!==workId)void selectWork(id);});
const dimensions={tree:220,agent:440,logs:240};
try{const saved=JSON.parse(localStorage.getItem('mythos.coding.layout.v1')||'{}');for(const key of Object.keys(dimensions))if(Number.isFinite(saved[key]))dimensions[key]=Math.min(650,Math.max(90,saved[key]));}catch{}
function layout(){for(const[key,value]of Object.entries(dimensions))document.documentElement.style.setProperty('--'+key,value+'px');localStorage.setItem('mythos.coding.layout.v1',JSON.stringify(dimensions));}
for(const[id,key,axis,sign,min,max]of [['tree-divider','tree','clientX',1,150,350],['agent-divider','agent','clientX',-1,330,650],['log-divider','logs','clientY',-1,90,350]]){
  const node=$(id);node.onpointerdown=event=>{const start=event[axis],value=dimensions[key];node.setPointerCapture(event.pointerId);node.onpointermove=next=>{dimensions[key]=Math.min(max,Math.max(min,value+(next[axis]-start)*sign));layout();};node.onpointerup=()=>{node.onpointermove=null;};};
  node.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();dimensions[key]=Math.min(max,Math.max(min,dimensions[key]+(['ArrowRight','ArrowDown'].includes(event.key)?10:-10)*sign));layout();};
}
$('reset').onclick=()=>{Object.assign(dimensions,{tree:220,agent:440,logs:240});layout();};layout();
try{
  works=(await requestAt('/mythos/api','/work-items')).workItems;
  for(const work of works){const option=el('option',{value:work.workItemId,text:(work.source?.id||work.workItemId)+' · '+(work.workflow?.phase||work.stage)});$('tasks').append(option);}
  await selectWork(location.hash.match(/^#\/work\/(work-[a-f0-9]{32})$/)?.[1]||works[0]?.workItemId);
}catch(error){notice(error.message);}
setInterval(()=>{if(workId&&!document.hidden)void refreshContext();},2500);
