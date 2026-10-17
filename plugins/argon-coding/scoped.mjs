import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fault } from './files.mjs';
const program = readFile(new URL('./scoped-read.py',import.meta.url),'utf8');
export function bindScopedRead(subprocess,root,python='/usr/bin/python3') {
  let active=0;
  return async (kind,path,signal) => {
    signal?.throwIfAborted();
    if(active>=4)throw fault('文件读取繁忙，请稍后重试',503);
    active++;
    try {
    const source=await program;
    const handle=subprocess.spawn({argv:[python,'-I','-S','-B','-c',source,root,kind,path],cwd:'/',graceMs:1000,signal,stdio:{stdin:'ignore',stdout:{maxBytes:4*1024*1024},stderr:{maxBytes:4096}}});
    const outcome=await handle.done,output=handle.collected.stdout.readFrom(0);
    signal?.throwIfAborted();
    if(outcome.exitCode!==0||output.lossy)throw fault('安全文件读取不可用',503);
    let data;try{data=JSON.parse(output.text);}catch{throw fault('文件读取返回无效数据',503);}
    if(data.error)throw fault(data.error,[400,403,404,409,413,415].includes(data.status)?data.status:503);
    if(!data.value||data.value.path!==path)throw fault('文件读取绑定不匹配',503);
    if(kind==='read')data.value.contentHash='sha256:'+createHash('sha256').update(data.value.text).digest('hex');
    return data.value;
    } finally {active--;}
  };
}
