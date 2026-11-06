import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const mod=await importPiExtension('active-session-transcript-trimming');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const jsonl=rows=>rows.map(e=>JSON.stringify(e)+'\n').join('');
function notification(id,parentId,result){return {id,parentId,type:'custom_message',customType:'subagent-notification',display:true,content:`<task-notification>\n<task-id>native-task</task-id>\n<tool-use-id>native-call</tool-use-id>\n<status>Done</status>\n<summary>Subagent completed</summary>\n<result>${result}</result>\n<usage><total_tokens>23</total_tokens><tool_uses>1</tool_uses><duration_ms>5</duration_ms></usage>\n</task-notification>\nUnrecognized suffix: <opaque>keep exactly</opaque>`,details:{id:'native-task',description:'Completed work',status:'completed',toolUses:1,totalTokens:23,durationMs:5,resultPreview:result,opaque:{keep:'untouched'}}};}
function fixture(t,{readbackUnavailable=false}={}){
 const dir=fs.mkdtempSync(join(tmpdir(),'trim-adaptive-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=join(dir,'session.jsonl');
 const rows=[{type:'session',version:3,id:'adaptive'}, {id:'a',parentId:null,type:'message',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(50_100_000)}]}},notification('n','a','r'.repeat(800_000)),{id:'u',parentId:'n',type:'message',message:{role:'user',content:'u'.repeat(20_000_000)}},{id:'c',parentId:'u',type:'compaction',firstKeptEntryId:'u',summary:'Current'}];fs.writeFileSync(file,jsonl(rows));
 let selected=true;const ownerAbort=new AbortController();const ctx={signal:ownerAbort.signal,sessionManager:{getSessionId:()=>selected?'adaptive':'changed',getSessionFile:()=>file,getLeafId:()=>rows.at(-1).id,getBranch:()=>rows.slice(1)}};
 let parked=false;const recovery=join(dir,'committed.jsonl');const io={...fs,renameSync(from,to){if(parked)throw Error('replacement replay');fs.renameSync(from,to);if(readbackUnavailable&&to===file){fs.renameSync(file,recovery);parked=true;}}};
 let recovered;const recoveryDone=new Promise(resolve=>recovered=resolve);
 const tools=new Map(),owner=mod.registerActiveSessionTranscriptTrimming({registerTool:x=>tools.set(x.name,x),sendMessage(m){if(m.details?.status==='trimmed')recovered(m);}},io);t.after(()=>owner.cancel());owner.markDue(ctx);const item=owner.collect(ctx);
 const child={sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:item.request.prompt}}]}};
 const call=async(operation,extra={},signal)=>JSON.parse((await tools.get('transcript_trim').execute('call',{operation,...extra},signal,undefined,child)).content[0].text);
 const append=row=>{const e={id:'tail'+rows.length,parentId:rows.at(-1).id,timestamp:new Date().toISOString(),...row};rows.push(e);fs.appendFileSync(file,jsonl([e]));return e;};
 return {file,rows,owner,ctx,item,append,call,recoveryDone,abortOwner(){ownerAbort.abort();},restoreReadback(){fs.renameSync(recovery,file);},switchOwner(){selected=false;}};
}
test('REQ-MEM-030 AC2: abort and owner revocation during asynchronous planning never replace the source',async t=>{
 const f=fixture(t),before=hash(f.file),abort=new AbortController();const work=f.call('prepare',{},abort.signal);setTimeout(()=>{f.owner.cancel();abort.abort();},10);await assert.rejects(work,/abort|cancel|scope|ENOENT/);assert.equal(hash(f.file),before);
});
test('REQ-MEM-030 AC3: current, human-authored and unrecognized notification-like payloads remain protected',()=>{
 const rows=[{type:'session',version:3,id:'s'},{type:'message',id:'u',parentId:null,message:{role:'user',content:'human'}},notification('n','u','result'),{type:'custom_message',customType:'unknown',id:'x',parentId:'n',content:'opaque'}],source=jsonl(rows);
 for(const id of ['u','n','x']){const changed=structuredClone(rows),e=changed.find(x=>x.id===id);if(e.message)e.message.content='changed';else e.content='changed';assert.throws(()=>mod.validateTranscriptTrimCandidate(source,jsonl(changed),'s',['u','n','x']),/protected|opaque/);}
});
test('REQ-MEM-030 AC5/6: fresh native compaction coverage revokes settled scope without duplicating running work or resetting six total attempts',async t=>{
 const f=fixture(t);let item=f.item;
 const deliver=x=>f.append({type:'custom_message',customType:'background-extraction-launch',details:{items:[x]}});
 const invoke=x=>{const id='native'+f.rows.length;f.append({type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name:'subagent',arguments:x.request}]}});return id;};
 const done=id=>f.append({type:'custom_message',customType:'subagent-notification',content:`<tool-use-id>${id}</tool-use-id><status>Done</status>`});
 deliver(item);const first=invoke(item);f.append({type:'compaction',firstKeptEntryId:f.rows.at(-1).id,summary:'Later native compaction'});
 assert.equal(f.owner.collect(f.ctx),undefined,'running native work is never duplicated even after new coverage');done(first);
 item=f.owner.collect(f.ctx);assert.notEqual(item.requestId,f.item.requestId);assert.equal(item.reminder,1);await assert.rejects(f.call('prepare'),/scope|ENOENT|stale/);
 for(let attempt=1;attempt<6;attempt++){deliver(item);const id=invoke(item);assert.equal(f.owner.collect(f.ctx),undefined);done(id);const next=f.owner.collect(f.ctx);if(attempt===5){assert.equal(next.giveup,true);}else{assert.equal(next.reminder,attempt+1);item=next;}}
 assert.equal(f.owner.collect(f.ctx),undefined);
});
test('REQ-MEM-030 AC2: owner abort promptly stops asynchronous CPU work without source replacement',async t=>{
 const f=fixture(t),before=hash(f.file);const work=f.call('prepare');f.abortOwner();
 const settled=await Promise.race([work.then(()=> 'unexpected-success',e=>String(e)),new Promise(resolve=>setTimeout(()=>resolve('still-running'),750))]);
 await assert.rejects(work,/abort|cancel|scope/);assert.match(settled,/abort|cancel|scope/);assert.equal(hash(f.file),before);
});
test('REQ-MEM-030 AC7: unavailable asynchronous readback keeps a committed receipt and recovers without a second replacement',async t=>{
 const f=fixture(t,{readbackUnavailable:true});await f.call('prepare');
 const result=await f.call('activate');assert.equal(result.committed,true);assert.equal(result.status,'verification-pending');
 f.restoreReadback();const committed=hash(f.file),inode=fs.statSync(f.file).ino;f.owner.collect(f.ctx);f.owner.collect(f.ctx);
 assert.equal(await Promise.race([f.recoveryDone.then(()=> 'verified'),new Promise(resolve=>setTimeout(()=>resolve('heartbeat'),0))]),'heartbeat');
 await f.recoveryDone;assert.equal(fs.statSync(f.file).ino,inode);assert.equal(hash(f.file),committed);
 await assert.rejects(f.call('activate'),/scope|ENOENT|stale/);
});
test('REQ-MEM-030 AC3: batch execution refinement changes recognized command payloads only, never labels, opaque arguments or malformed commands',()=>{
 const call={type:'toolCall',id:'call',name:'ctx_batch_execute',arguments:{commands:[{label:'label',command:'c'.repeat(8000),opaque:'preserve'}],queries:['keep'],unknown:{keep:true}}};
 const rows=[{type:'session',version:3,id:'batch'},{type:'message',id:'a',parentId:null,message:{role:'assistant',content:[call],usage:{input:2}}},{type:'message',id:'u',parentId:'a',message:{role:'user',content:'current'}},{type:'compaction',id:'c',parentId:'u',firstKeptEntryId:'u',summary:'Current'}];
 const result=mod.prepareLocalTranscriptTrim(jsonl(rows),'batch',['a','u','c'],4096,['historical-execution-inputs']);const parsed=result.candidate.trimEnd().split('\n').map(JSON.parse),args=parsed[1].message.content[0].arguments;
 assert.ok(args.commands[0].command.length<100);assert.equal(args.commands[0].label,'label');assert.equal(args.commands[0].opaque,'preserve');assert.deepEqual(args.queries,['keep']);assert.deepEqual(args.unknown,{keep:true});
 for(const field of ['label','opaque']){const changed=structuredClone(parsed);changed[1].message.content[0].arguments.commands[0][field]='changed';assert.throws(()=>mod.validateTranscriptTrimCandidate(jsonl(rows),jsonl(changed),'batch',['a','u','c']),/opaque/);}
 const malformed=structuredClone(rows);delete malformed[1].message.content[0].arguments.commands[0].label;const malformedSource=jsonl(malformed),changed=structuredClone(malformed);changed[1].message.content[0].arguments.commands[0].command='[Obsolete historical payload trimmed]';assert.throws(()=>mod.validateTranscriptTrimCandidate(malformedSource,jsonl(changed),'batch',['a','u','c']),/opaque/);
});
