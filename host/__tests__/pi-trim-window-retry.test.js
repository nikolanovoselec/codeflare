import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {registerActiveSessionTranscriptTrimming,prepareLocalTranscriptTrim,commitTranscriptTrimCandidate}=await importPiExtension('active-session-transcript-trimming');
const jsonl=rows=>rows.map(row=>JSON.stringify(row)+'\n').join('');
const fingerprint=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('REQ-MEM-028 AC3: source-prefix retention respects JSON escaped UTF8 byte budgets',()=>{
 const text='é😀"\n\\\u0000'.repeat(10000),rows=[{type:'session',version:3,id:'unicode'},
  {type:'message',id:'old',parentId:null,message:{role:'assistant',content:[{type:'text',text}]}},
  {type:'message',id:'user',parentId:'old',message:{role:'user',content:'Keep current user'}},
  {type:'compaction',id:'checkpoint',parentId:'user',firstKeptEntryId:'user',summary:'Current'}];
 const result=prepareLocalTranscriptTrim(jsonl(rows),'unicode',['old','user','checkpoint'],4096),candidate=result.candidate.trimEnd().split('\n').map(JSON.parse);
 assert.equal(Buffer.byteLength(result.candidate),result.remainingBytes);assert.ok(result.remainingBytes<=4096&&result.remainingBytes>=4088);
 const retained=candidate[1].message.content[0].text;assert.ok(text.startsWith(retained));assert.ok(!/[\uD800-\uDBFF]$/.test(retained));assert.deepEqual(candidate.slice(2),rows.slice(2));
});

// Disposable synthetic history only. All lifecycle transitions use the public
// controller, exact public subagent calls, and its registered scoped tool.
function fixture(t,userBytes=0){
 const root=fs.mkdtempSync(join(tmpdir(),'trim-window-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=join(root,'session.jsonl'),rows=[{type:'session',version:3,id:'window-fixture'}];
 fs.writeFileSync(file,jsonl(rows));
 const append=row=>{const entry={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp:new Date().toISOString(),...row};rows.push(entry);fs.appendFileSync(file,jsonl([entry]));return entry;};
 let historical;for(let n=0;n<25;n++){const e=append({type:'message',extensionEnvelope:{keep:true},message:{role:'assistant',usage:{input:27,output:41},content:[{type:'text',text:'x'.repeat(2_004_000)}]}});historical??=e;}
 const user=append({type:'message',message:{role:'user',content:userBytes?'u'.repeat(userBytes):'Preserve the entire current user message.'}});
 append({type:'compaction',firstKeptEntryId:user.id,summary:'Current authoritative summary'});
 append({type:'custom',customType:'unknown-extension-state',data:{keep:true}});
 const tools=new Map(),outcomes=[];let failReadback=false,committed=false;
 const io={...fs,renameSync(from,to){fs.renameSync(from,to);if(to===file){committed=true;if(failReadback)fs.renameSync(file,file+'.unavailable');}},readFileSync(path,...args){if(path===file&&committed&&failReadback){throw Error('synthetic transient readback');}return fs.readFileSync(path,...args);}};
 const controller=registerActiveSessionTranscriptTrimming({registerTool(tool){tools.set(tool.name,tool);},sendMessage(message){outcomes.push(message);}},io);
 t.after(()=>controller.cancel());
 const ctx={sessionManager:{getSessionId:()=> 'window-fixture',getSessionFile:()=>file,getLeafId:()=>rows.at(-1).id,getBranch:()=>rows.slice(1)}};
 const deliver=item=>{assert.equal(item.jobType,'transcript-trim');append({type:'custom_message',customType:'background-extraction-launch',details:{items:[item]}});return item;};
 controller.markDue(ctx);const first=deliver(controller.collect(ctx));
 const request=JSON.parse(fs.readFileSync(first.request.prompt.match(/^VARS_FILE=(.+)$/m)[1],'utf8'));
 const call=item=>{const id='native-'+rows.length;append({type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name:'subagent',arguments:item.request}]}});return id;};
 const done=(id,status='Done')=>append({type:'custom_message',customType:'subagent-notification',content:`<tool-use-id>${id}</tool-use-id><status>${status}</status>`});
 const collect=()=>controller.collect(ctx);
 const stage=async()=>{try{return JSON.parse((await tools.get('transcript_trim').execute('scoped-trim',{operation:'trim'},undefined,undefined,{sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:first.request.prompt}}]}})).content[0].text);}finally{if(fs.existsSync(file+'.unavailable'))fs.renameSync(file+'.unavailable',file);}};
 // Intentionally invalid sizes still preserve all protected source records.
 const stageBytes=bytes=>fs.writeFileSync(request.candidateFile,Buffer.alloc(bytes,32));
 const unchanged=action=>{const before=fingerprint(file);const value=action();assert.equal(fingerprint(file),before,'parent must not replace source for an unqualified attempt');return value;};
 return{root,file,rows,historical,user,controller,ctx,first,request,deliver,call,done,collect,stage,stageBytes,unchanged,outcomes,failNextReadback(){failReadback=true;},restoreReadback(){failReadback=false;}};
}

function assertCompletion(f){
 const bytes=fs.statSync(f.file).size;assert.ok(bytes>=15_000_000&&bytes<=25_000_000,`verified total ${bytes} is in the inclusive window`);
 const persisted=fs.readFileSync(f.file,'utf8').trimEnd().split('\n').map(JSON.parse);
 assert.deepEqual(persisted.find(row=>row.id===f.user.id),f.user);
 for(const row of persisted)assert.deepEqual(row,f.rows.find(original=>original.id===row.id));
 assert.equal(fs.existsSync(f.request.directory),false,'owned staging is removed after verified completion');
 assert.equal(f.outcomes.filter(message=>message.details?.status==='trimmed').length,1);
 return bytes;
}







for(const [label,bytes] of [['below minimum',14_999_999],['above maximum',25_000_001]]){
 test(`REQ-MEM-030 AC6: ${label} Done candidates consume the same six attempts and one terminal giveup without writes`,t=>{
  const f=fixture(t);let item=f.first;
  for(let attempt=1;attempt<=6;attempt++){
   const id=f.call(item);f.done(id);f.stageBytes(bytes-(fs.statSync(f.file).size-f.request.sourceBytes));const next=f.unchanged(f.collect);
   assert.equal(f.outcomes.some(message=>message.details?.status==='trimmed'),false);
   if(attempt<6){assert.equal(next.requestId,f.first.requestId);assert.deepEqual(next.request,f.first.request);assert.equal(next.reminder,attempt,`next public reminder represents attempt ${attempt+1}/6`);item=f.deliver(next);assert.equal(f.unchanged(f.collect),undefined,'delivered retry stays pending until its exact call');}
   else{assert.deepEqual(next,{requestId:f.first.requestId,jobType:'transcript-trim',giveup:true});}
  }
  assert.equal(fs.existsSync(f.request.directory),false);assert.equal(f.unchanged(f.collect),undefined);assert.equal(f.unchanged(f.collect),undefined,'terminal result is not replayed');
 });
}

test('REQ-MEM-030 AC6: retry two scoped trim activates immediately while its own native call is running',async t=>{
 const f=fixture(t);const old=f.call(f.first);f.done(old);f.stageBytes(14_999_999-(fs.statSync(f.file).size-f.request.sourceBytes));const retry=f.unchanged(f.collect);
 assert.equal(retry.reminder,1);assert.deepEqual(retry.request,f.first.request);f.deliver(retry);const current=f.call(retry);
 const result=await f.stage();assert.equal(result.withinTarget,true);assert.equal(result.committed,true);assertCompletion(f);
 const verified=fingerprint(f.file);assert.equal(f.collect(),undefined);assert.equal(fingerprint(f.file),verified);
 f.done(current);const before=fingerprint(f.file);assert.equal(f.collect(),undefined);assert.equal(fingerprint(f.file),before);
});

test('REQ-MEM-030 AC6: invalid in-window candidate retries without replacing live history',t=>{
 const f=fixture(t),id=f.call(f.first);f.done(id);fs.writeFileSync(f.request.candidateFile,Buffer.alloc(20_000_000,32));
 const refused=f.unchanged(()=>commitTranscriptTrimCandidate(f.ctx,f.request));assert.equal(refused.status,'refused');
 const retry=f.unchanged(f.collect);assert.equal(retry.reminder,1);assert.equal(retry.requestId,f.first.requestId);assert.deepEqual(retry.request,f.first.request);
 assert.equal(fs.existsSync(f.request.candidateFile),false);assert.equal(refused.status,'refused');assert.equal(f.outcomes.some(m=>m.details?.status==='trimmed'),false);
});

test('REQ-MEM-030 AC6: native failure advances the same reminder and native stop cancels rather than retries',t=>{
 const f=fixture(t);const first=f.call(f.first);f.done(first,'Failed');const retry=f.unchanged(f.collect);
 assert.equal(retry.reminder,1);assert.equal(retry.requestId,f.first.requestId);assert.deepEqual(retry.request,f.first.request);f.deliver(retry);
 const second=f.call(retry);f.done(second,'Stopped');assert.equal(f.unchanged(f.collect),undefined);assert.equal(fs.existsSync(f.request.directory),false);
 assert.equal(f.unchanged(f.collect),undefined);assert.equal(f.outcomes.some(message=>message.details?.status==='trimmed'),false);
});

test('REQ-MEM-030 AC7: postcommit readback resumes only receipt verification without native-agent replay',async t=>{
 const f=fixture(t);f.failNextReadback();const result=await f.stage();assert.equal(result.committed,true);
 assert.equal(f.outcomes.at(-1).details.status,'verification-pending');assert.equal(fs.existsSync(f.request.directory),true);
 const inode=fs.statSync(f.file).ino,committed=fingerprint(f.file);f.restoreReadback();assert.equal(f.collect(),undefined,'read-only receipt is not an extraction launch');
 assert.equal(fs.statSync(f.file).ino,inode,'receipt must not atomically replace the committed file again');assert.equal(fingerprint(f.file),committed);assertCompletion(f);
 assert.equal(f.collect(),undefined);assert.equal(f.outcomes.filter(message=>message.details?.status==='trimmed').length,1);
});
