import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {registerActiveSessionTranscriptTrimming}=await importPiExtension('active-session-transcript-trimming');
const {buildPublicTranscriptTrimRequest,extractionTranscriptFacts,extractionDue}=await importPiExtension('memory-vault-helpers');
const jsonl=rows=>rows.map(row=>JSON.stringify(row)+'\n').join('');
const fingerprint=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Synthetic current users and obsolete images exercise real budget refusals.
function fixture(t,userBytes=0){
 const root=fs.mkdtempSync(join(tmpdir(),'trim-refusal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=join(root,'session.jsonl'),rows=[{type:'session',version:3,id:'refusal-fixture'}];fs.writeFileSync(file,jsonl(rows));
 const append=row=>{const entry={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp:new Date().toISOString(),...row};rows.push(entry);fs.appendFileSync(file,jsonl([entry]));return entry;};
 append({type:'message',message:{role:'assistant',content:[{type:'image',mimeType:'image/png',data:'x'.repeat(userBytes?26_000_000:50_100_000)}]}});
 const user=append({type:'message',message:{role:'user',content:'u'.repeat(userBytes)}});
 append({type:'compaction',firstKeptEntryId:user.id,summary:'Current authoritative summary'});
 const tools=new Map(),outcomes=[];
 const controller=registerActiveSessionTranscriptTrimming({registerTool(tool){tools.set(tool.name,tool);},sendMessage(message){outcomes.push(message);}});
 t.after(()=>controller.cancel());
 const ctx={sessionManager:{getSessionId:()=> 'refusal-fixture',getSessionFile:()=>file,getLeafId:()=>rows.at(-1).id,getBranch:()=>rows.slice(1)}};
 const deliver=item=>{append({type:'custom_message',customType:'background-extraction-launch',details:{items:[item]}});return item;};
 controller.markDue(ctx);const first=deliver(controller.collect(ctx));
 const request=JSON.parse(fs.readFileSync(first.request.prompt.match(/^VARS_FILE=(.+)$/m)[1],'utf8'));
 const call=item=>{const id='native-'+rows.length;append({type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name:'subagent',arguments:item.request}]}});return id;};
 const done=id=>append({type:'custom_message',customType:'subagent-notification',content:`<tool-use-id>${id}</tool-use-id><status>Done</status>`});
 const collect=()=>controller.collect(ctx);
 const stage=async()=>JSON.parse((await tools.get('transcript_trim').execute('scoped-trim',{operation:'trim'},undefined,undefined,{sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:first.request.prompt}}]}})).content[0].text);
 const unchanged=action=>{const before=fingerprint(file),value=action();assert.equal(fingerprint(file),before);return value;};
 return{file,request,first,call,done,collect,stage,deliver,unchanged,outcomes};
}

test('REQ-MEM-030 AC7: insufficient retainable prose reports a below-minimum refusal without padding or staging',async t=>{
 const f=fixture(t),before=fingerprint(f.file);
 await assert.rejects(f.stage(),/retained-output-below-minimum/);assert.equal(fingerprint(f.file),before);
 assert.equal(fs.existsSync(f.request.candidateFile),false);
});

test('REQ-MEM-030 AC6: native facts at a controlled clock keep failed trim retries bounded and running delivery pending',()=>{
 const requestId='00000000-0000-4000-8000-000000000001',request=buildPublicTranscriptTrimRequest({requestId,promptFile:'/synthetic/prompt.md',varsFile:'/synthetic/request.json'});
 const entries=[];let now=Date.parse('2026-01-01T00:00:00Z');
 const next=()=>extractionDue(extractionTranscriptFacts({entries,requestId,job:'transcript-trim',now,successQualifies:()=>false}));
 for(let attempt=0;attempt<6;attempt++){
  assert.deepEqual(next(),{kind:'launch',reminder:attempt});
  entries.push({type:'custom_message',customType:'background-extraction-launch',details:{items:[{requestId,jobType:'transcript-trim',reminder:attempt,request}]}});
  assert.deepEqual(next(),{kind:'none'});
  const id='native-'+attempt;
  entries.push({type:'message',timestamp:new Date(now).toISOString(),message:{role:'assistant',content:[{type:'toolCall',id,name:'subagent',arguments:request}]}});
  now+=1000;assert.deepEqual(next(),{kind:'none'});
  entries.push({type:'custom_message',customType:'subagent-notification',content:`<tool-use-id>${id}</tool-use-id><status>Done</status>`});
 }
 assert.deepEqual(next(),{kind:'giveup'});
 entries.push({type:'custom_message',customType:'background-extraction-giveup',details:{items:[{requestId,jobType:'transcript-trim'}]}});
 assert.deepEqual(next(),{kind:'none'});
});

test('REQ-MEM-030 AC6: whole-line refusals retain the six-attempt budget without writes',async t=>{
 const f=fixture(t,26_000_000);let item=f.first;
 for(let attempt=1;attempt<=6;attempt++){
  const id=f.call(item),before=fingerprint(f.file);
  assert.equal(f.collect(),undefined,'an exact native call in flight is not duplicated');
  await assert.rejects(f.stage(),/retained-output-below-minimum/);
  assert.equal(fingerprint(f.file),before,'refused whole-record cuts never replace history');
  assert.equal(fs.existsSync(f.request.candidateFile),false);
  assert.equal(f.collect(),undefined,'a refusal does not duplicate its still-running native call');
  f.done(id);const next=f.unchanged(f.collect);
  if(attempt<6){
   assert.equal(next.reminder,attempt);assert.equal(next.requestId,f.first.requestId);assert.deepEqual(next.request,f.first.request);
   item=f.deliver(next);assert.equal(f.unchanged(f.collect),undefined,'delivered retry waits for its exact call');
  }else assert.deepEqual(next,{requestId:f.first.requestId,jobType:'transcript-trim',giveup:true});
 }
 assert.equal(fs.existsSync(f.request.directory),false);assert.equal(f.collect(),undefined);
 assert.equal(f.outcomes.some(message=>message.details?.status==='trimmed'),false);
});
