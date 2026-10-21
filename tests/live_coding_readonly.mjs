// Run on the operator host from an isolated staging directory, never as an Agent tool.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { TaskFiles } from '../plugins/mythos-coding/files.mjs';
import { createSshReaders } from '../plugins/mythos-coding/ssh.mjs';
const root=process.env.MYTHOS_TASK_ROOT||'/home/hx/mythos-m1';
const {TaskWorkflow}=await import(pathToFileURL(root+'/plugins/mythos-workflow/controller.mjs'));
const id=process.argv[2]||'work-e0c22f1188d6495781d2c33659937fa5';
const records=JSON.parse(await readFile(root+'/state/sandboxes.json','utf8'));
const workflow=new TaskWorkflow({owner:'alice',tokenFile:'/home/hx/.mythos-brain/tokens.json'}, {sessions:{},workspaces:{},presets:{},source:{}});
const readers=createSshReaders({root,helperHash:records.alice.helper_hash});
const files=new TaskFiles({workflow,openFs:readers.open});
const digest=value=>createHash('sha256').update(value).digest('hex');
try{
  const before=await workflow.snapshot(id),location=await workflow.workspace(before.workItem,true);
  const file=await files.read(id,before.workItem.sourceRecord.sourcePath);
  const listing=await files.list(id,'');
  assert.ok(file.text.length);assert.ok(listing.entries.some(x=>x.name==='src'));
  await assert.rejects(()=>files.read(id,'../outside'),{status:400});
  const after=await workflow.workspace((await workflow.snapshot(id)).workItem,true);
  const fingerprint=git=>({head:git.headCommit,status:git.status,diff:digest(git.diff),changed:git.changedFiles});
  assert.deepEqual(fingerprint(location.git),fingerprint(after.git));
  const report={checkedAt:new Date().toISOString(),workItemId:id,sandboxId:before.workItem.sandboxId,sourcePath:file.path,bytes:Buffer.byteLength(file.text),lines:file.lines,contentHash:file.contentHash,containsPreparedStatement:file.text.includes('PreparedStatement'),rootEntries:listing.entries.map(e=>e.name),gitUnchanged:true,git:fingerprint(after.git),modelInvoked:false};
  await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
  await writeFile(new URL('../artifacts/coding-readonly-remote.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await readers.dispose();await workflow.dispose();}
