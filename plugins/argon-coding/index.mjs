import { readFile } from 'node:fs/promises';
import { TaskFiles, fault } from './files.mjs';
import { createSshReaders } from './ssh.mjs';
export const name = 'argon-coding';
export const inject = ['webServer', 'connection', 'argonWorkflow'];
const assets = new Map([
  ['/', ['./public/index.html', 'text/html']], ['/app.js', ['./public/app.js', 'text/javascript']],
  ['/styles.css', ['./public/styles.css', 'text/css']], ['/bridge.js', ['./public/bridge.js', 'text/javascript']],
  ['/monitor-view.js', ['../argon-console/public/monitor-view.js', 'text/javascript']],
  ['/monitor-state.js', ['../argon-console/public/monitor-state.js', 'text/javascript']],
  ['/monitor.css', ['../argon-console/public/styles.css', 'text/css']],
]);
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options':'nosniff' }); res.end(JSON.stringify(data)); }
export function codingHandler({ connection, workflow, files, assetReader = name => readFile(new URL(name, import.meta.url)) }) {
  return async (req, res) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20000);
    const close = () => { if (!res.writableEnded) abort.abort(); };
    req.on('aborted', close); res.on('close', close);
    try {
      const rejection = connection.requestRejection({ headers:req.headers });
      if (rejection) return json(res,rejection,{error:rejection===401?'请先在 DSH 登录':'请求来源不受信任'});
      if(req.method!=='GET') throw fault('编码工作区只提供读取接口',405);
      const url=new URL(req.url,'http://dsh.invalid');
      if(url.pathname==='/argon/coding'){res.writeHead(302,{Location:'/argon/coding/'});res.end();return;}
      if(!url.pathname.startsWith('/argon/coding/')) throw fault('页面不存在',404);
      const path=url.pathname.slice('/argon/coding'.length);
      if(assets.has(path)){
        const [asset,type]=assets.get(path), bytes=await assetReader(asset);
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'"});res.end(bytes);return;
      }
      const match=path.match(/^\/api\/work-items\/(work-[a-f0-9]{32})\/(context|files|file)$/);
      if(!match) throw fault('接口不存在',404);
      const [,id,kind]=match;
      if(kind==='context'){
        if(url.search) throw fault('无效查询参数',400);
        return json(res,200,await workflow.detail(id));
      }
      if([...url.searchParams.keys()].some(key=>key!=='path')||url.searchParams.getAll('path').length>1) throw fault('无效查询参数',400);
      const relative=url.searchParams.get('path')??'';
      if(kind==='file'&&!relative) throw fault('缺少相对文件路径',400);
      return json(res,200,await files[kind==='file'?'read':'list'](id,relative,abort.signal));
    }catch(error){
      if(res.destroyed) return;
      const status=error.status>=400&&error.status<=599?error.status:abort.signal.aborted?504:503;
      json(res,status,{error:error.status?error.message:status===504?'文件读取超时，请重试':'任务文件服务暂不可用'});
    }finally{clearTimeout(timeout);req.off('aborted',close);res.off('close',close);}
  };
}
export function apply(ctx) {
  const workflow=ctx.argonWorkflow.controller;
  const readers=createSshReaders({root:workflow.config.root,helperHash:workflow.config.helperHash});
  const files=new TaskFiles({workflow,openFs:readers.open});
  ctx.effect(()=>()=>readers.dispose());
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/argon/coding',handler:codingHandler({connection:ctx.connection,workflow,files})}));
}
