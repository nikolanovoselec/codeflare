import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptTrimRequest, commitTranscriptTrimCandidate, validateTranscriptTrimCandidate } from '../../preseed/agents/pi/extensions/active-session-transcript-trimming.ts';
const jsonl=rows=>rows.map(e=>JSON.stringify(e)+'\n').join('');
function fixture(t,bytes=50_100_000){
 const root=fs.mkdtempSync(join(tmpdir(),'trim-cache-gap-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'session.jsonl');
 const cache=[{type:'message',id:'old',parentId:null,message:{role:'assistant',content:[{type:'text',text:'h'.repeat(bytes)}]}},
  {type:'custom',id:'cached-1',parentId:'old',customType:'opaque',data:{preserve:true}},
  {type:'custom',id:'cached-2',parentId:'cached-1',customType:'opaque',data:{preserve:true}},
  {type:'message',id:'bridge',parentId:'cached-2',message:{role:'user',content:'Historical user stays exact'}},
  {type:'message',id:'kept',parentId:'bridge',message:{role:'assistant',content:[{type:'text',text:'Current response stays exact'}]}},
  {type:'compaction',id:'compact',parentId:'kept',firstKeptEntryId:'kept',summary:'Current authoritative summary'},
  {type:'custom',id:'state',parentId:'compact',customType:'rpiv-todo-state',data:{tasks:[],nextId:42}},
  {type:'message',id:'leaf',parentId:'state',message:{role:'user',content:'Current task stays exact'}}];
 const rows=[{type:'session',version:3,id:'fixture'},...cache.filter(e=>!e.id.startsWith('cached-'))];fs.writeFileSync(file,jsonl(rows));
 const ctx={sessionManager:{getSessionId:()=> 'fixture',getSessionFile:()=>file,getLeafId:()=>cache.at(-1).id,getBranch:()=>cache}};
 return{root,file,rows,cache,ctx};
}
test('REQ-MEM-030 AC3: explained historical cache gaps permit guarded reduction without ancestry repair or loss of SDK continuity',t=>{
 const f=fixture(t),ids=f.cache.map(e=>e.id),req=createTranscriptTrimRequest(f.ctx);
 assert.deepEqual(req.branchIds,ids);
 const candidate=structuredClone(f.rows);candidate[1].message.content=[{type:'text',text:'Historical answer summarized.'}];fs.writeFileSync(req.candidateFile,jsonl(candidate));
 const removed=f.cache.splice(1,1)[0];assert.match(commitTranscriptTrimCandidate(f.ctx,req).reason,/branch-changed/);assert.ok(fs.statSync(f.file).size>50_000_000);f.cache.splice(1,0,removed);
 assert.equal(commitTranscriptTrimCandidate(f.ctx,req).status,'trimmed');assert.ok(fs.statSync(f.file).size<=20_000_000);
 const persisted=fs.readFileSync(f.file,'utf8').trimEnd().split('\n').map(JSON.parse);
 assert.deepEqual(persisted.map(e=>[e.id,e.parentId]),f.rows.map(e=>[e.id,e.parentId]));assert.deepEqual(persisted.slice(2),f.rows.slice(2));
 assert.deepEqual(f.cache.map(e=>e.id),ids);assert.equal(persisted.some(e=>e.id.startsWith('cached-')),false);assert.deepEqual(fs.readdirSync(f.root),['session.jsonl']);
});
test('REQ-MEM-030 AC3: absent leaf and incoherent or changed persisted ancestry remain refused',t=>{
 const f=fixture(t,20_100_000),before=fs.readFileSync(f.file);
 const reject=()=>{assert.throws(()=>createTranscriptTrimRequest(f.ctx,'',true),/foreign-branch/);assert.ok(fs.readFileSync(f.file).equals(before));assert.deepEqual(fs.readdirSync(f.root),['session.jsonl']);};
 f.cache.push({type:'message',id:'unpersisted',parentId:'leaf',message:{role:'user',content:'Not persisted'}});reject();f.cache.pop();
 const old=f.cache[1].parentId;f.cache[1].parentId='foreign';reject();f.cache[1].parentId=old;
 const parent=f.cache[3].parentId;f.cache[3].parentId='foreign';reject();f.cache[3].parentId=parent;
 const kept=f.cache[5].firstKeptEntryId;f.cache[5].firstKeptEntryId='old';f.rows.find(e=>e.id==='compact').firstKeptEntryId='old';fs.writeFileSync(f.file,jsonl(f.rows));
 const changed=fs.readFileSync(f.file);assert.throws(()=>createTranscriptTrimRequest(f.ctx,'',true),/foreign-branch/);assert.ok(fs.readFileSync(f.file).equals(changed));f.cache[5].firstKeptEntryId=kept;
});
test('REQ-MEM-030 AC3: full persisted SDK context across an orphan is protected when no ancestral compaction frontier exists',t=>{
 const f=fixture(t,100);f.rows.splice(1,0,{type:'message',id:'side',parentId:null,message:{role:'assistant',content:[{type:'text',text:'Other branch'}]}});
 f.rows.find(e=>e.id==='compact').firstKeptEntryId='side';const source=jsonl(f.rows),candidate=structuredClone(f.rows);candidate.find(e=>e.id==='old').message.content=[{type:'text',text:'Wrongly condensed current context'}];
 assert.throws(()=>validateTranscriptTrimCandidate(source,jsonl(candidate),'fixture',f.cache.map(e=>e.id)),/protected-entry:old/);
});
