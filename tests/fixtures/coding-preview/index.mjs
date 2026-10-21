// Isolated browser integration fixture. Reuses production handlers/views; no M2 writes or model.
import { Context } from '@deepseek-ai/cordis';
import LocalFs from '@deepseek-ai/dsh-fs-local';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { codingHandler } from '../../../plugins/mythos-coding/index.mjs';
import { TaskFiles } from '../../../plugins/mythos-coding/files.mjs';
import { bindScopedRead } from '../../../plugins/mythos-coding/scoped.mjs';
export const inject=['webServer','connection','sessionController','workspaceRegistry'];
const root=fileURLToPath(new URL('../../../artifacts/coding-preview/',import.meta.url));
export async function apply(ctx){
  ctx.on('agent/created',({agent})=>{for(const method of ['followup','steer'])agent[method]=()=>{throw new Error('独立只读预览不调用模型');};});
  const entries=[];
  for(const index of [1,2]){
    const cwd=root+'sample-'+index,id='work-'+String(index).repeat(32),sid='session-02000000-0000-4000-8000-00000000000'+index;
    await mkdir(cwd+'/src',{recursive:true});
    const git=(...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
    let base;try{base=git('rev-parse','refs/tags/baseline');}catch{
      git('init','--quiet');git('config','user.name','Mythos Local Preview');git('config','user.email','preview@localhost');
      await writeFile(cwd+'/src/Sample.java',`// LOCAL INTEGRATION FIXTURE ${index}\nclass Sample { String query = "concatenated"; }\n`);
      git('add','src/Sample.java');git('commit','-qm','local fixture baseline');git('tag','baseline');base=git('rev-parse','HEAD');
      await writeFile(cwd+'/src/Sample.java',`// LOCAL INTEGRATION FIXTURE ${index}\nclass Sample { String query = "parameterized"; }\n`);
      git('add','src/Sample.java');git('commit','-qm','local fixture candidate');
    }
    await writeFile(cwd+'/README.md','# 本地隔离预览\n非真实任务，无构建/测试证据。\n');
    const native=new Context();await native.plugin(LocalFs,{cwd});await native.plugin(LocalSubprocess);ctx.effect(()=>()=>native.fiber.dispose());
    const ws=await ctx.workspaceRegistry.create(cwd,'本地预览 '+index);await ctx.sessionController.create({sessionId:sid,workspaceId:ws.id,agentPreset:'minimal'});
    const workItem={workItemId:id,ownerId:'preview',sandboxId:'sb-preview-'+index,version:1,source:{type:'MYTHOS',id:'PREVIEW-0'+index},sessionIds:[sid],workflow:{phase:'AWAITING_REVIEW',codeSessionId:sid},sourceRecord:{id:'PREVIEW-0'+index,title:'本地隔离预览（非真实任务）',sourcePath:'src/Sample.java',baseCommit:base}};
    entries.push({workItem,cwd,fs:native.fs,readBound:bindScopedRead(native.subprocess,cwd,'python3'),git:{baseCommit:base,headCommit:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:'',diff:git('diff','--no-color',base),changedFiles:['src/Sample.java'],diffTruncated:false}});
  }
  const find=id=>{const entry=entries.find(x=>x.workItem.workItemId===id);if(!entry)throw Object.assign(new Error('task not found'),{status:404});return entry;};
  const workflow={snapshot:async id=>({workItem:find(id).workItem}),workspace:async work=>{const entry=find(work.workItemId);return {workspacePath:entry.cwd,git:entry.git};},detail:async id=>{const entry=find(id);return {workItem:entry.workItem,workflow:entry.workItem.workflow,source:entry.workItem.sourceRecord,git:entry.git,operations:[],evidence:[],session:{sessionId:entry.workItem.workflow.codeSessionId,activity:'本地预览 · 未调用模型'}};}};
  const files=new TaskFiles({workflow,openFs:async work=>find(work.workItemId)});
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/mythos/coding',handler:codingHandler({connection:ctx.connection,workflow,files})}));
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/mythos/api',handler:async(req,res)=>{
    const rejection=ctx.connection.requestRejection({headers:req.headers});if(rejection){res.writeHead(rejection);res.end();return;}
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    const path=new URL(req.url,'http://preview.invalid').pathname;
    const value=path==='/mythos/api/work-items'?{workItems:entries.map(x=>x.workItem)}:/\/events$/.test(path)?{events:[],nextCursor:0}:null;
    res.writeHead(value?200:404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));
  }}));
}
