import {mkdir,writeFile,symlink,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=resolve(root,'artifacts/coding-preview'),profile=resolve(runtime,'home/profiles/web'),port=process.env.MYTHOS_CODING_PREVIEW_PORT||'3093';
await mkdir(profile,{recursive:true});
await writeFile(resolve(profile,'package.json'),JSON.stringify({name:'coding-preview',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
try{await symlink(resolve(root,'node_modules'),resolve(profile,'node_modules'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}
try{await symlink(resolve(root,'plugins/mythos-coding/client.js'),resolve(root,'tests/fixtures/coding-preview/client.js'),'file');}catch(e){if(e.code!=='EEXIST')throw e;}
await writeFile(resolve(profile,'cordis.patch.yml'),JSON.stringify([{id:'hmr',disabled:true},{id:'session-title-llm',disabled:true},{id:'terminal-controller',disabled:true},{id:'ui-sidebar-terminal',disabled:true},{insert:[{id:'coding-preview',name:resolve(root,'tests/fixtures/coding-preview/index.mjs')}]}]));
const child=spawn(process.execPath,[resolve(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--port',port,'--no-open'],{cwd:runtime,env:{...process.env,DSH_HOME:resolve(runtime,'home')},stdio:['ignore','pipe','pipe']});
let buffer='';child.stdout.on('data',data=>{buffer+=data;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(line.includes('dsh web:')){const url=line.match(/https?:\/\/[^\s\u001b]+/)?.[0];if(url)void writeFile(resolve(runtime,'login-url.txt'),url.replace('127.0.0.1','localhost'),{mode:0o600});console.log(`Isolated integration preview ready on localhost:${port}; private login link in artifacts/coding-preview/login-url.txt`);}else console.log(line);}});
child.stderr.on('data',data=>process.stderr.write(data));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
