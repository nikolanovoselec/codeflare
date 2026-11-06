import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {prepareLocalTranscriptTrim,validateTranscriptTrimCandidate,registerActiveSessionTranscriptTrimming}=await importPiExtension('active-session-transcript-trimming');
const {buildPublicExtractionRequest,extractionTranscriptFacts}=await importPiExtension('memory-vault-helpers');
const jsonl=rows=>rows.map(e=>JSON.stringify(e)+'\n').join('');
function history(id='fixture',bytes=100_000){
 const rows=[{type:'session',version:3,id}];const add=row=>{const e={id:id+'-'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp:'2026-11-04T00:00:00Z',...row};rows.push(e);return e;};
 add({type:'message',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(bytes)}]}});return{rows,add};
}
test('REQ-MEM-030 AC3: frozen extraction calls survive trimming and late native completion still finalizes',()=>{
 for(const job of ['memory-capture','vault-extract']){
  const f=history(),id='00000000-0000-4000-8000-000000000001',request=buildPublicExtractionRequest({job,requestId:id,promptFile:'/fixed/prompt.md',varsFile:'/fixed/request.vars'}),item={requestId:id,jobType:job,reminder:0,request};
  f.add({type:'custom_message',customType:'background-extraction-launch',details:{items:[item]}});
  const call=f.add({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'native-frozen',name:'subagent',arguments:request}]}});
  const kept=f.add({type:'message',message:{role:'user',content:'Current user'}});f.add({type:'compaction',summary:'Current summary',firstKeptEntryId:kept.id});
  const raw=jsonl(f.rows),ids=f.rows.slice(1).map(e=>e.id),result=prepareLocalTranscriptTrim(raw,'fixture',ids,0),after=result.candidate.trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(after.find(e=>e.id===call.id),call);assert.equal(extractionTranscriptFacts({entries:after,requestId:id,job,now:Date.parse('2026-11-04T00:00:01Z'),successQualifies:()=>true}).state,'running');
  const completion=f.add({type:'custom_message',customType:'subagent-notification',content:'<tool-use-id>native-frozen</tool-use-id><status>Done</status>'});after.push(completion);
  const facts=extractionTranscriptFacts({entries:after,requestId:id,job,now:Date.now(),successQualifies:()=>true});assert.equal(facts.state,'succeeded');assert.equal(facts.pendingLaunch,false);assert.equal(facts.attemptCount,1);
  const damaged=structuredClone(after.slice(0,-1));damaged.find(e=>e.id===call.id).message.content[0].arguments.prompt='[obsolete]';assert.throws(()=>validateTranscriptTrimCandidate(raw,jsonl(damaged),'fixture',ids),/opaque/);
 }
});
test('REQ-MEM-030 AC3: system and older checkpoint opaque content survives local reduction and validation',()=>{
 const f=history(),opaque=[{type:'text',text:'Provider text',extensionState:{keep:true}},{type:'extension-payload',data:{keep:true}}];
 const system=f.add({type:'message',message:{role:'system',content:[{type:'text',text:'Ordinary obsolete prose'},...opaque],timestamp:1,unknown:'keep'}});
 const old=f.add({type:'compaction',firstKeptEntryId:system.id,summary:'Old',systemMessage:{role:'system',content:[{type:'text',text:'Older checkpoint prose'},...opaque],timestamp:2,unknown:'keep'}});
 const kept=f.add({type:'message',message:{role:'user',content:'Current user'}});f.add({type:'compaction',firstKeptEntryId:kept.id,summary:'Current'});
 const raw=jsonl(f.rows),ids=f.rows.slice(1).map(e=>e.id),result=prepareLocalTranscriptTrim(raw,'fixture',ids,0),after=result.candidate.trimEnd().split('\n').map(JSON.parse),by=new Map(after.map(e=>[e.id,e]));
 assert.deepEqual(by.get(system.id).message.content,opaque);assert.deepEqual(by.get(old.id).systemMessage.content,opaque);assert.equal(by.get(old.id).systemMessage.unknown,'keep');validateTranscriptTrimCandidate(raw,result.candidate,'fixture',ids);
 for(const checkpoint of [false,true]){const bad=structuredClone(after),row=bad.find(e=>e.id===(checkpoint?old.id:system.id));if(checkpoint)row.systemMessage.content=[];else row.message.content=[];assert.throws(()=>validateTranscriptTrimCandidate(raw,jsonl(bad),'fixture',ids));}
});
test('REQ-MEM-030 AC7: committed receipt releases switched-session scheduling without write replay',async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'trim-receipt-switch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const make=id=>{const h=history(id,50_100_000),kept=h.add({type:'message',message:{role:'user',content:'Current '+id}});h.add({type:'compaction',firstKeptEntryId:kept.id,summary:'Summary '+id});const file=join(root,id+'.jsonl');fs.writeFileSync(file,jsonl(h.rows));const add=row=>{const e=h.add(row);fs.appendFileSync(file,jsonl([e]));return e;};return{...h,file,add,ctx:{sessionManager:{getSessionId:()=>id,getSessionFile:()=>file,getLeafId:()=>h.rows.at(-1).id,getBranch:()=>h.rows.slice(1)}}};};
 const a=make('owner-a'),b=make('owner-b'),outcomes=[],tools=new Map();let replaced=false,failReadback=true,selected='owner-a';
 const io={...fs,renameSync(from,to){if(to===a.file&&replaced)throw Error('replacement replay refused');fs.renameSync(from,to);if(to===a.file){replaced=true;if(failReadback)fs.renameSync(a.file,a.file+'.unavailable');}},readFileSync(path,...args){if(path===a.file&&selected!=='owner-a')throw Error('cross-owner verification refused');if(path===a.file&&replaced&&failReadback)throw Error('readback temporarily unavailable');return fs.readFileSync(path,...args);}};
 const controller=registerActiveSessionTranscriptTrimming({registerTool(tool){tools.set(tool.name,tool);},sendMessage(message){outcomes.push(message);}},io);t.after(()=>controller.cancel());controller.markDue(a.ctx);const item=controller.collect(a.ctx),request=JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
 a.add({type:'custom_message',customType:'background-extraction-launch',details:{items:[item]}});a.add({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'native-a',name:'subagent',arguments:item.request}]}});
 const child={sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:item.request.prompt}}]}};
 const result=JSON.parse((await tools.get('transcript_trim').execute('native-a',{operation:'trim'},undefined,undefined,child)).content[0].text);
 if(fs.existsSync(a.file+'.unavailable'))fs.renameSync(a.file+'.unavailable',a.file);
 assert.equal(result.committed,true);assert.equal(result.status,'verification-pending');const inode=fs.statSync(a.file).ino,persisted=fs.readFileSync(a.file);assert.ok(fs.existsSync(request.directory));assert.equal(outcomes.some(m=>m.details?.status==='trimmed'),false);
 controller.cancel();selected='owner-b';controller.markDue(b.ctx);const next=controller.collect(b.ctx);assert.equal(next.jobType,'transcript-trim');assert.notEqual(next.requestId,item.requestId);assert.ok(fs.statSync(b.file).size>50_000_000);
 controller.cancel();selected='owner-a';failReadback=false;controller.collect(a.ctx);assert.equal(fs.statSync(a.file).ino,inode);assert.deepEqual(fs.readFileSync(a.file),persisted);assert.equal(fs.existsSync(request.directory),false);assert.equal(outcomes.filter(m=>m.details?.status==='trimmed').length,1);assert.ok(fs.statSync(a.file).size>=15_000_000&&fs.statSync(a.file).size<=25_000_000);
});
