import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findPackageJSON} from 'node:module';
import {pathToFileURL} from 'node:url';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {prepareLocalTranscriptTrim,validateTranscriptTrimCandidate}=await importPiExtension('active-session-transcript-trimming');
const jsonl=rows=>rows.map(e=>JSON.stringify(e)+'\n').join('');
function fixture(){
 const rows=[{type:'session',version:3,id:'fixture',timestamp:'2026-11-04T00:00:00Z',cwd:'/fixture'}];
 const add=data=>{const e={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp:'2026-11-04T00:00:00Z',...data};rows.push(e);return e;};
 const oldGoal=add({type:'custom',customType:'goal-state',data:{goal:{id:'past-goal',status:'completed',objective:'o'.repeat(2_000_000)}}});
 const oldSystem=add({type:'message',message:{role:'system',content:'Old instructions',toolsAdded:[{name:'old_tool',description:'s'.repeat(10_000_000),parameters:{type:'object',properties:{}}}],timestamp:1,opaque:{keep:true}}});
 const edit=add({type:'message',message:{role:'assistant',api:'anthropic-messages',provider:'anthropic',model:'fixture',stopReason:'toolUse',timestamp:2,usage:{input:10,output:1,cost:{total:2}},content:[{type:'toolCall',id:'edit-call',name:'edit',arguments:{path:'/historical',edits:[{oldText:'a'.repeat(20_000_000),newText:'b'.repeat(20_000_000),opaque:'keep'}]}}]}});
 const kept=add({type:'message',message:{role:'user',content:'Current user must stay exact',timestamp:3}});
 const structured={goal:'Old compaction goal',decisions:[{id:'d',summary:'d'.repeat(1_000_000),type:'explicit'}],constraints:[],modifiedFiles:[],readFiles:[],deletedFiles:[],unresolvedErrors:[],resolvedErrors:[],unknown:{keep:true}};
 const oldCheckpoint=add({type:'compaction',firstKeptEntryId:kept.id,summary:'Old summary',systemMessage:{role:'system',content:'Older checkpoint text',toolsAdded:[{name:'old',description:'Old',parameters:{type:'object',properties:{}}}],timestamp:4},details:{version:'10.6.2',compactionState:structured,native:{opaque:'provider state'},unknown:{keep:true}}});
 const staleTodo=add({type:'custom',customType:'rpiv-todo-state',data:{tasks:[{id:1,description:'t'.repeat(7_000_000)}],nextId:5,unknown:'keep'}});
 const todoResult=add({type:'message',message:{role:'toolResult',toolName:'todo',toolCallId:'todo-current',timestamp:5,isError:false,content:[{type:'text',text:'Current tool message stays exact'}],details:{tasks:[{id:1,description:'r'.repeat(7_000_000)}],nextId:5,error:'keep error',opaque:{keep:true}}}});
 const goal=add({type:'custom',customType:'goal-state',data:{goal:{id:'current-goal',status:'active',objective:'Current task'},budget:{used:1}}});
 const plan=add({type:'custom',customType:'plan-mode-state',data:{enabled:true,plan:'Current plan'}});
 const todo=add({type:'custom',customType:'rpiv-todo-state',data:{tasks:[{id:1,subject:'Current task',status:'in_progress'}],nextId:6}});
 const checkpoint=add({type:'compaction',firstKeptEntryId:kept.id,summary:'Current authoritative summary',systemMessage:{role:'system',content:'Current system checkpoint',toolsAdded:[{name:'current_tool',description:'Current',parameters:{type:'object',properties:{}}}],timestamp:6},details:{version:'10.6.2',compactionState:{...structured,decisions:[{id:'current',summary:'Current decision',type:'explicit'}]},native:{opaque:'current provider state'}}});
 const answer=add({type:'message',message:{role:'assistant',api:'anthropic-messages',provider:'anthropic',model:'fixture',timestamp:7,content:[{type:'thinking',thinking:'Current reasoning',thinkingSignature:'current-signature'},{type:'text',text:'Current response'}],stopReason:'stop',usage:{input:12,output:2,cost:{total:3}}}});
 const currentSystem=add({type:'message',message:{role:'system',content:'Current live system update',toolsRemoved:[{name:'old_tool'}],timestamp:8}});
 return{rows,oldGoal,oldSystem,edit,kept,oldCheckpoint,staleTodo,todoResult,goal,plan,todo,checkpoint,answer,currentSystem};
}
test('REQ-MEM-030 AC3: local trim reduces superseded metadata without changing current messages state or opaque fields',()=>{
 const f=fixture(),raw=jsonl(f.rows),result=prepareLocalTranscriptTrim(raw,'fixture',f.rows.slice(1).map(e=>e.id),19_995_904);assert.ok(Buffer.byteLength(raw)>50_000_000);assert.equal(result.withinTarget,true);assert.ok(result.remainingBytes<=19_995_904);validateTranscriptTrimCandidate(raw,result.candidate,'fixture',f.rows.slice(1).map(e=>e.id));
 const rows=result.candidate.trimEnd().split('\n').map(JSON.parse),by=new Map(rows.map(e=>[e.id,e]));
 for(const e of [f.kept,f.goal,f.plan,f.todo,f.checkpoint,f.answer,f.currentSystem])assert.deepEqual(by.get(e.id),e);
 assert.deepEqual(rows.map(e=>[e.id,e.parentId,e.type,e.timestamp]),f.rows.map(e=>[e.id,e.parentId,e.type,e.timestamp]));assert.deepEqual(by.get(f.edit.id).message.usage,f.edit.message.usage);assert.equal(by.get(f.edit.id).message.content[0].arguments.edits[0].opaque,'keep');
 // A zero budget exhausts available reductions, exercising metadata inside the current frontier.
 const reduced=prepareLocalTranscriptTrim(raw,'fixture',f.rows.slice(1).map(e=>e.id),0).candidate.trimEnd().split('\n').map(JSON.parse),all=new Map(reduced.map(e=>[e.id,e]));
 assert.deepEqual(all.get(f.todoResult.id).message.content,f.todoResult.message.content);assert.deepEqual(all.get(f.todoResult.id).message.details,{...f.todoResult.message.details,tasks:[]});assert.deepEqual(all.get(f.staleTodo.id).data,{...f.staleTodo.data,tasks:[]});assert.deepEqual(all.get(f.oldCheckpoint.id).details.native,f.oldCheckpoint.details.native);assert.deepEqual(all.get(f.oldCheckpoint.id).details.unknown,f.oldCheckpoint.details.unknown);assert.deepEqual(all.get(f.oldCheckpoint.id).details.compactionState.unknown,{keep:true});
 for(const mutate of [r=>r.find(e=>e.id===f.todoResult.id).message.content=[],r=>r.find(e=>e.id===f.todoResult.id).message.details.opaque={},r=>r.find(e=>e.id===f.checkpoint.id).details.native={}]){const bad=structuredClone(reduced);mutate(bad);assert.throws(()=>validateTranscriptTrimCandidate(raw,jsonl(bad),'fixture',f.rows.slice(1).map(e=>e.id)));}
});
test('REQ-MEM-030 AC3: managed SDK context and current tool schemas survive obsolete checkpoint reduction',{skip:process.env.GITHUB_ACTIONS!=='true'},async t=>{
 const manifestPath=findPackageJSON('@earendil-works/pi-coding-agent',new URL('../../preseed/agents/pi/package.json',import.meta.url));assert.ok(manifestPath);const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));const {SessionManager}=await import(new URL(manifest.exports['.'].import,pathToFileURL(manifestPath)));
 const f=fixture(),raw=jsonl(f.rows),candidate=prepareLocalTranscriptTrim(raw,'fixture',f.rows.slice(1).map(e=>e.id),0).candidate;
 const root=fs.mkdtempSync(join(tmpdir(),'trim-sdk-projection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const before=join(root,'before.jsonl'),after=join(root,'after.jsonl');fs.writeFileSync(before,raw);fs.writeFileSync(after,candidate);
 const a=SessionManager.open(before,root,root).buildSessionContext().messages,b=SessionManager.open(after,root,root).buildSessionContext().messages;
 // details.tasks is UI snapshot metadata; the model-facing message/wire fields stay exact.
 const modelMessages=messages=>messages.map(message=>{const {details,...wire}=message;return wire;});assert.deepEqual(modelMessages(b),modelMessages(a));
 assert.ok(b.some(m=>m.role==='system'&&m.toolsAdded?.some(tool=>tool.name==='current_tool')));
});
