import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
const base=new URL('../../preseed/agents/pi/extensions/',import.meta.url),modules=new Map();
function moduleUrl(name){if(modules.has(name))return modules.get(name);let text=stripTypeScriptTypes(fs.readFileSync(new URL(name+'.ts',base),'utf8'));text=text.replace(/from "\.\/([a-z-]+)(?:\.ts)?"/g,(_m,key)=>`from "${moduleUrl(key)}"`);const url='data:text/javascript;base64,'+Buffer.from(text).toString('base64');modules.set(name,url);return url;}
const {registerMemoryVault}=await import(moduleUrl('memory-vault'));
const jsonl=rows=>rows.map(e=>JSON.stringify(e)+'\n').join('');
function fixture(t,{protectedFloor=false,extra=0}={}){
 const root=fs.mkdtempSync(join(tmpdir(),'shared-trim-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'session.jsonl'),rows=[{type:'session',version:3,id:'fixture'}];fs.writeFileSync(file,jsonl(rows));
 const append=row=>{const entry={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,...row};rows.push(entry);fs.appendFileSync(file,jsonl([entry]));return entry;};
 append({type:'message',message:{role:protectedFloor?'user':'assistant',content:[{type:'text',text:'x'.repeat(50_100_000)}]}});
 for(let i=0;i<extra;i++)append({type:'custom',customType:'opaque',data:{keep:i}});
 const kept=append({type:'message',message:{role:'user',content:'Current user 1'}});append({type:'compaction',firstKeptEntryId:kept.id,summary:'Current authoritative summary'});append({type:'custom',customType:'rpiv-todo-state',data:{tasks:[{id:1,subject:'Current task',status:'in_progress'}],nextId:2}});
 const paths={vaultRoot:join(root,'Vault'),cacheDir:join(root,'cache'),memoryCounterDir:join(root,'counters'),memoryPromptFile:join(root,'memory.md'),vaultPromptFile:join(root,'vault.md'),vaultManifestFile:join(root,'Vault/graphify-out/manifest.json'),vaultInitializationFile:join(root,'Vault/graphify-out/initialized'),vaultMarkerFile:join(root,'marker')};fs.writeFileSync(paths.memoryPromptFile,'Frozen capture');fs.writeFileSync(paths.vaultPromptFile,'Vault capture');
 const handlers=new Map(),tools=new Map(),sent=[];let id=0;
 const ctx={sessionManager:{getSessionId:()=> 'fixture',getSessionFile:()=>file,getHeader:()=>rows[0],getBranch:()=>rows.slice(1),getLeafId:()=>rows.at(-1).id}};
 const pi={on(name,fn){const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);},registerTool(tool){tools.set(tool.name,tool);},getActiveTools:()=>[],getAllTools:()=>[{name:'subagent'}],setActiveTools(){},sendMessage(message){sent.push(message);}};
 registerMemoryVault(pi,{paths,now:()=>Date.parse('2026-11-04T00:00:00Z'),randomUUID:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`});
 const emit=(name,event={})=>{for(const fn of handlers.get(name)||[])fn(event,ctx);};emit('session_start');emit('before_agent_start',{prompt:'Current user 1'});
 fs.mkdirSync(join(paths.vaultRoot,'Notes'),{recursive:true});fs.writeFileSync(join(paths.vaultRoot,'Notes/new.md'),'New Vault decision');
 for(let n=2;n<=21;n++)append({type:'message',message:{role:'user',content:'Current user '+n}});
 emit('before_agent_start',{prompt:'Current user 21'});const stop={message:{role:'assistant',stopReason:'stop',content:[]}};
 const shared=()=>sent.filter(m=>m.customType==='background-extraction-launch');
 const trimItem=()=>shared().flatMap(m=>m.details.items).find(i=>i.jobType==='transcript-trim');
 const child=()=>({sessionManager:{getHeader:()=>({id:'child',parentSession:file}),getBranch:()=>[{type:'message',message:{role:'user',content:trimItem().request.prompt}}]}});
 return{root,file,rows,paths,ctx,append,emit,sent,tools,stop,shared,trimItem,child};
}
test('REQ-MEM-015 AC3: memory Vault and trim share one extraction launch and queued-boundary deduplication',t=>{
 const f=fixture(t);f.emit('turn_end',f.stop);const launches=f.shared();assert.equal(launches.length,1);assert.deepEqual(launches[0].details.items.map(i=>i.jobType).sort(),['memory-capture','transcript-trim','vault-extract']);assert.match(launches[0].content,/Extraction jobs ready/);
 f.emit('turn_end',f.stop);f.emit('agent_settled');assert.deepEqual(f.shared(),launches);assert.equal(f.sent.some(m=>['transcript-trim-start','transcript-trim-retry'].includes(m.customType)),false);
});
test('REQ-MEM-030 AC2: one scoped local trim call reaches budget and only parent completion commits',async t=>{
 const f=fixture(t);f.emit('turn_end',f.stop);const item=f.trimItem(),request=JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));const before=fs.readFileSync(f.file),ids=f.ctx.sessionManager.getBranch().map(e=>e.id);
 const result=await f.tools.get('transcript_trim').execute('trim',{operation:'trim'},undefined,undefined,f.child());const outcome=JSON.parse(result.content[0].text);assert.equal(outcome.withinTarget,true);assert.equal(outcome.committed,false);assert.ok(outcome.candidateBytes>=15_000_000&&outcome.candidateBytes<=25_000_000);assert.ok(outcome.candidateBytes<=outcome.budgetBytes&&outcome.budgetBytes<=request.candidateBudget);assert.equal(outcome.candidateBytes,20_000_000,'available ASCII prose reaches the separate preferred goal');assert.ok(fs.readFileSync(f.file).equals(before));
 const launch=f.shared()[0];f.append({type:'custom_message',...launch});f.append({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'native-trim',name:'subagent',arguments:item.request}]}});f.append({type:'custom_message',customType:'subagent-notification',content:'<tool-use-id>native-trim</tool-use-id><status>Done</status>'});f.emit('turn_end',f.stop);
 assert.ok(fs.statSync(f.file).size>=15_000_000&&fs.statSync(f.file).size<=25_000_000);const persisted=fs.readFileSync(f.file,'utf8').trimEnd().split('\n').map(JSON.parse);assert.deepEqual(persisted.slice(2,ids.length+1),f.rows.slice(2,ids.length+1));assert.deepEqual(f.ctx.sessionManager.getBranch().map(e=>e.id).slice(0,ids.length),ids);assert.equal(fs.existsSync(request.directory),false);
});
test('REQ-MEM-030 AC7: protected floor is measured without writing or publishing a candidate',async t=>{
 const f=fixture(t,{protectedFloor:true});f.emit('turn_end',f.stop);const before=fs.readFileSync(f.file),item=f.trimItem(),request=JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
 const result=await f.tools.get('transcript_trim').execute('trim',{operation:'trim'},undefined,undefined,f.child());const outcome=JSON.parse(result.content[0].text);assert.equal(outcome.withinTarget,false);assert.ok(outcome.remainingBytes>25_000_000);assert.equal(outcome.committed,false);assert.equal(fs.existsSync(request.candidateFile),false);assert.ok(fs.readFileSync(f.file).equals(before));
});
test('REQ-MEM-030 AC1: abort cancels uncommitted trim without fresh launches or counter advancement',t=>{
 const f=fixture(t);f.emit('turn_end',f.stop);const launch=f.shared()[0],count=fs.readFileSync(join(f.paths.memoryCounterDir,'fixture.count'),'utf8');f.append({type:'custom_message',...launch});f.emit('agent_settled',{aborted:true});f.emit('turn_end',f.stop);f.emit('agent_settled');assert.deepEqual(f.shared(),[launch]);assert.equal(fs.readFileSync(join(f.paths.memoryCounterDir,'fixture.count'),'utf8'),count);
});
test('REQ-MEM-030 AC2: model-facing contract omits large internal branch ownership arrays',async t=>{
 const f=fixture(t,{extra:20_001});f.emit('turn_end',f.stop);const item=f.trimItem(),path=item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1],before=fs.readFileSync(path);
 const result=await f.tools.get('transcript_trim').execute('contract',{operation:'contract'},undefined,undefined,f.child());const text=result.content[0].text,v=JSON.parse(text);assert.ok(Buffer.byteLength(text)<12_000);assert.equal(v.request.branchIds,undefined);assert.ok(v.request.branchEntryCount>20_000);assert.ok(fs.readFileSync(path).equals(before));assert.ok(JSON.parse(before).branchIds.length>20_000);
});
