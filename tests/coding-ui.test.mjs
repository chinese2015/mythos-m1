import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as bridge from '../plugins/argon-coding/public/bridge.js';
import {renderMonitor} from '../plugins/argon-console/public/monitor-view.js';
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.style={setProperty:(key,value)=>{this.style[key]=value;}};this.className='';this.classList={toggle:(name,enabled)=>{this.className=enabled?name:'';}};this.value='';this.text='';this.hidden=false;this.selectionStart=0;this.selectionEnd=0;this.scrollTop=0;this.contentWindow={};}
  setAttribute(name,value){this.attrs[name]=value;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;else this[name]=value;}
  removeAttribute(name){delete this.attrs[name];delete this[name];}
  append(...values){this.children.push(...values);}
  replaceChildren(...values){this.text='';this.children=values;}
  set textContent(value){this.text=value;this.children=[];}
  get textContent(){return this.text+this.children.map(x=>x.textContent||'').join('');}
  addEventListener(){}
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
  querySelector(selector){const matches=node=>selector==='[data-panel="monitor"]'?node.attrs['data-panel']==='monitor':selector==='[data-stale-note]'?node.attrs['data-stale-note']:selector.startsWith('.')&&node.className.split(' ').includes(selector.slice(1));for(const node of this.children){if(matches(node))return node;const child=node.querySelector?.(selector);if(child)return child;}return null;}
}
const a='work-'+'1'.repeat(32),b='work-'+'2'.repeat(32);
async function app(){
  const html=await readFile(new URL('../plugins/argon-coding/public/index.html',import.meta.url),'utf8');
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const events=new Map(),store=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};
  let failB;
  const body={workItem:{workItemId:a,version:1,sessionIds:['session-a'],workflow:{phase:'CODING'}},source:{id:'TASK_A',sourcePath:'src/A.java',title:'Task A'},workflow:{phase:'CODING'},session:{sessionId:'session-a',activity:'TASK_A_AGENT'},git:{headCommit:'a'.repeat(40),baseCommit:'b'.repeat(40),diff:'TASK_A_DIFF',changedFiles:['src/A.java']},operations:[]};
  const response=(data,ok=true)=>({ok,json:async()=>data});
  const fetch=async url=>{
    if(url==='/argon/api/work-items')return response({workItems:[body.workItem,{workItemId:b,source:{id:'TASK_B'},workflow:{phase:'CODING'}}]});
    if(url.includes(b)&&url.endsWith('/context'))return new Promise(resolve=>{failB=()=>resolve(response({error:'TASK_B_UNAVAILABLE'},false));});
    if(url.endsWith('/context'))return response(body);
    if(url.includes('/files?'))return response({entries:[]});
    if(url.includes('/file?'))return response({text:'TASK_A_SOURCE',lines:1,contentHash:'sha256:abc'});
    if(url.includes('/events?'))return response({events:[],nextCursor:0});
    throw new Error('Unexpected URL '+url);
  };
  const document={getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),documentElement:new Element(),hidden:false,querySelector:selector=>nodes.get('monitor').querySelector(selector)};
  const location={hash:'#/work/'+a,origin:'http://test.local'};
  const window={addEventListener:(type,handler)=>events.set(type,handler)};
  const code=(await readFile(new URL('../plugins/argon-coding/public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  await vm.runInNewContext('(async()=>{'+code+'})()',{...bridge,renderMonitor,document,window,location,fetch,crypto:webcrypto,localStorage:store(),sessionStorage:store(),URLSearchParams,URL,setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{},queueMicrotask,console});
  const bindingId=new URL(nodes.get('native').src,'http://test.local').searchParams.get('argonCodingBinding');
  events.get('message')({origin:location.origin,source:nodes.get('native').contentWindow,data:{protocol:1,workItemId:a,sessionId:'session-a',bindingId,type:'native.ready',requestId:'ready-a'}});
  return {nodes,switchB:()=>{nodes.get('tasks').value=b;return nodes.get('tasks').onchange();},failB:()=>failB()};
}
test('switching tasks immediately retires the previous interactive frame and execution view',async()=>{
  const h=await app();assert.equal(h.nodes.get('native').style.visibility,'visible');
  const pending=h.switchB();
  assert.equal(h.nodes.get('native').style.visibility,'hidden');
  assert.equal(h.nodes.get('diff').textContent.includes('TASK_A_DIFF'),false);
  assert.equal(h.nodes.get('monitor').textContent.includes('TASK_A_AGENT'),false);
  assert.equal(h.nodes.get('task-context').textContent.includes('TASK_A'),false);
  h.failB();await pending;
  assert.equal(h.nodes.get('native').style.visibility,'hidden');
  assert.equal(h.nodes.get('notice').textContent,'TASK_B_UNAVAILABLE');
});
