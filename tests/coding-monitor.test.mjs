import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMonitor } from '../plugins/argon-console/public/monitor-view.js';
// Minimal DOM boundary double: exercises actual async view updates, not source strings.
class Element {
  constructor(tag,attrs={}) { this.tag=tag;this.attrs=attrs;this.children=[];this.dataset={};this.value=attrs.text||'';for(const [key,val]of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=val; }
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;this.value='';}
  get textContent(){return this.value+this.children.map(x=>x.textContent||'').join('');}
  set textContent(value){this.value=value;this.children=[];}
  querySelector(selector){const matches=node=>selector.startsWith('.')?(node.attrs.class||'').split(' ').includes(selector.slice(1)):selector==='[data-stale-note]'&&node.attrs['data-stale-note'];for(const child of this.children){if(matches(child))return child;const nested=child.querySelector?.(selector);if(nested)return nested;}return null;}
}
test('late events for task A cannot update the current task B monitor',async t=>{
  const original=globalThis.document;let current,resolveA;
  globalThis.document={querySelector:()=>current};t.after(()=>{globalThis.document=original;});
  const ctx=(workItemId,request)=>({workItemId,workflow:{phase:'CODING'},operations:[],phaseText:x=>x,el:(tag,attrs)=>new Element(tag,attrs),panelHead:()=>new Element('h2'),opLabel:()=>'',request});
  const a=ctx('work-monitor-a',()=>new Promise(resolve=>{resolveA=resolve;}));
  current=renderMonitor(a);await Promise.resolve();
  current=renderMonitor(ctx('work-monitor-b',()=>new Promise(()=>{})));await Promise.resolve();
  resolveA({events:[{sequence:1,type:'TASK_A_PRIVATE_EVENT'}],nextCursor:1});await Promise.resolve();await Promise.resolve();
  assert.equal(current.textContent.includes('TASK_A_PRIVATE_EVENT'),false);
  assert.match(current.textContent,/正在读取事件/);
});
