import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const ownerModule=await importPiExtension('active-session-transcript-trimming');
const childModule=await importPiExtension('active-session-transcript-trimming','independent-child');
const jsonl=rows=>rows.map(row=>JSON.stringify(row)+'\n').join('');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t,{readbackFailure=false,publicationFailure=false}={}){
 const root=fs.mkdtempSync(join(tmpdir(),'trim-agent-activation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=join(root,'parent.jsonl'),rows=[{type:'session',version:3,id:'activation-parent'}];fs.writeFileSync(file,jsonl(rows));
 const append=row=>{const entry={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,...row};rows.push(entry);fs.appendFileSync(file,jsonl([entry]));return entry;};
 for(let n=0;n<17;n++)append({type:'message',message:{role:'assistant',usage:{input:2,output:3},content:[{type:'text',text:'old'.repeat(1_000_000)}]}});
 const user=append({type:'message',message:{role:'user',content:'Keep this entire current user message'}});
 append({type:'compaction',firstKeptEntryId:user.id,summary:'Current context'});
 let selected=true,replaced=false,failRead=readbackFailure;
 const io={...fs,renameSync(from,to){if(to===file&&replaced)throw Error('replacement replay refused');fs.renameSync(from,to);if(to===file){replaced=true;if(readbackFailure)fs.renameSync(file,file+'.unavailable');}},readFileSync(path,...args){if(path===file&&replaced&&failRead){failRead=false;throw Error('transient readback');}return fs.readFileSync(path,...args);}};
 const context={sessionManager:{getSessionId:()=>selected?'activation-parent':'other-session',getSessionFile:()=>selected?file:join(root,'other.jsonl'),getLeafId:()=>rows.at(-1).id,getBranch:()=>rows.slice(1)}};
 const outcomes=[],owner=ownerModule.registerActiveSessionTranscriptTrimming({registerTool(){},sendMessage:message=>{if(publicationFailure)throw Error('synthetic UI delivery failure');outcomes.push(message);}},io);t.after(()=>owner.cancel());owner.markDue(context);const item=owner.collect(context);
 const request=JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
 const tools=new Map();const child=childModule.registerActiveSessionTranscriptTrimming({registerTool:tool=>tools.set(tool.name,tool),sendMessage(){} });t.after(()=>child.cancel());
 const childContext={sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:item.request.prompt}}]}};
 const trim=signal=>tools.get('transcript_trim').execute('child-trim',{operation:'trim'},signal,undefined,childContext);
 return{file,rows,append,user,owner,context,item,request,outcomes,trim,restoreReadback(){fs.renameSync(file+'.unavailable',file);},switchOwner(){selected=false;}};
}
test('REQ-MEM-030 AC2: scoped agent activates and verifies before return without Done or parent turn completion',async t=>{
 const f=fixture(t),tail=f.append({type:'message',message:{role:'assistant',content:[{type:'text',text:'Live appended tail'}]}}),before=hash(f.file);
 const result=JSON.parse((await f.trim()).content[0].text);
 assert.equal(result.committed,true);assert.equal(result.status,'trimmed');assert.ok(result.after>=15_000_000&&result.after<=25_000_000);assert.notEqual(hash(f.file),before);
 const persisted=fs.readFileSync(f.file,'utf8').trimEnd().split('\n').map(JSON.parse);assert.deepEqual(persisted.find(row=>row.id===tail.id),tail);assert.deepEqual(persisted.find(row=>row.id===f.user.id),f.user);
 assert.equal(fs.existsSync(f.request.directory),false);
 const appended=f.append({type:'message',message:{role:'assistant',content:[{type:'text',text:'Appends after activation remain valid'}]}});
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8').trimEnd().split('\n').at(-1)),appended);
 const verified=hash(f.file);f.owner.collect(f.context);assert.equal(hash(f.file),verified);
});
for(const reason of ['cancel','switch','abort','changed prefix'])test(`REQ-MEM-030 AC2: ${reason} refuses agent activation without source replacement`,async t=>{
 const f=fixture(t);let signal;
 if(reason==='cancel')f.owner.cancel();
 if(reason==='switch')f.switchOwner();
 if(reason==='abort'){const controller=new AbortController();controller.abort();signal=controller.signal;}
 if(reason==='changed prefix'){const bytes=fs.readFileSync(f.file);const index=bytes.indexOf(Buffer.from('oldold'));bytes[index]='n'.charCodeAt(0);fs.writeFileSync(f.file,bytes);}
 const before=hash(f.file);
 try{const result=JSON.parse((await f.trim(signal)).content[0].text);assert.equal(result.committed,false);assert.notEqual(result.status,'trimmed');}catch(error){assert.match(String(error),/canceled|cancelled|changed|activation|scope|ENOENT/);}
 assert.equal(hash(f.file),before);
});
test('REQ-MEM-030 AC2: staged candidate and native Done alone never activate',t=>{
 const f=fixture(t),raw=fs.readFileSync(f.file,'utf8'),candidate=ownerModule.prepareLocalTranscriptTrim(raw,'activation-parent',f.request.branchIds,25_000_000);fs.writeFileSync(f.request.candidateFile,candidate.candidate);
 f.append({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'native-staged',name:'subagent',arguments:f.item.request}]}});
 f.append({type:'custom_message',customType:'subagent-notification',content:'<tool-use-id>native-staged</tool-use-id><status>Done</status>'});
 const before=hash(f.file);f.owner.collect(f.context);assert.equal(hash(f.file),before);assert.ok(fs.statSync(f.file).size>50_000_000);
});
test('REQ-MEM-030 AC7: failed UI delivery cannot undo or obscure verified agent activation',async t=>{
 const f=fixture(t,{publicationFailure:true}),before=hash(f.file);const result=JSON.parse((await f.trim()).content[0].text);
 assert.equal(result.committed,true);assert.equal(result.status,'trimmed');assert.notEqual(hash(f.file),before);assert.equal(fs.existsSync(f.request.directory),false);
});
test('REQ-MEM-030 AC7: activation readback recovery and duplicate Done never replay replacement',async t=>{
 const f=fixture(t,{readbackFailure:true});const result=JSON.parse((await f.trim()).content[0].text);assert.equal(result.committed,true);assert.equal(result.status,'verification-pending');f.restoreReadback();f.owner.collect(f.context);
 f.append({type:'custom_message',customType:'subagent-notification',content:'<tool-use-id>duplicate</tool-use-id><status>Done</status>'});const verified=hash(f.file);
 f.owner.collect(f.context);f.owner.collect(f.context);assert.equal(hash(f.file),verified);assert.equal(fs.existsSync(f.request.directory),false);
});
