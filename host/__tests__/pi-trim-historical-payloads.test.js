import test from 'node:test';
import assert from 'node:assert/strict';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {prepareLocalTranscriptTrim,validateTranscriptTrimCandidate}=await importPiExtension('active-session-transcript-trimming');
const jsonl=rows=>rows.map(row=>JSON.stringify(row)+'\n').join('');
function fixture(){
 const rows=[{type:'session',version:3,id:'historical-payloads'}];
 const add=row=>{const value={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp:'2026-11-05T00:00:00Z',...row};rows.push(value);return value;};
 const prose=add({type:'message',message:{role:'assistant',content:[{type:'text',text:'x'.repeat(30_000_000)}],usage:{input:7,output:11}}});
 const edit=add({type:'message',message:{role:'toolResult',toolName:'edit',toolCallId:'old-edit',content:[],details:{diff:'d'.repeat(2_000_000),patch:'p'.repeat(2_000_000),firstChangedLine:4,opaque:{keep:true}}}});
 const state={goal:'Historical goal',decisions:[],constraints:[],modifiedFiles:[],readFiles:[],openLoops:['l'.repeat(500_000)],topics:['t'.repeat(500_000)],criticalContext:['c'.repeat(500_000)],nextActions:['n'.repeat(500_000)],factOverrides:[],scope:{schemaVersion:2,projectId:'p',sessionId:'historical-payloads',branchAncestryIds:['keep-id']},unknown:{keep:true}};
 const old=add({type:'compaction',firstKeptEntryId:prose.id,summary:'Old summary',details:{version:'10.6.2',compactionState:state,openLoops:['o'.repeat(500_000)],provenance:{initialScore:1,deterministicPatched:[{kind:'missing-constraint',text:'g'.repeat(500_000)}],llmPatched:false,finalScore:100,remainingGaps:[],opaque:{keep:true}},native:{keep:true}}});
 const agent=add({type:'custom',customType:'subagents:record',data:{id:'old-agent',type:'Explore',description:'Historical work',status:'completed',result:'r'.repeat(2_000_000),startedAt:1,completedAt:2,outputFile:'/retained/agent.jsonl',toolUses:3,opaque:{keep:true}}});
 const opaque=add({type:'custom',customType:'unknown-native-state',data:{payload:'z'.repeat(18_000_000)}});
 const user=add({type:'message',message:{role:'user',content:'Preserve this user message exactly'}});
 const todo=add({type:'custom',customType:'rpiv-todo-state',data:{tasks:[{id:1,subject:'Current task',status:'in_progress'}],nextId:2}});
 const current=add({type:'compaction',firstKeptEntryId:user.id,summary:'Current summary',details:{version:'10.6.2',compactionState:state,provenance:{initialScore:1,deterministicPatched:[],llmPatched:false,finalScore:100,remainingGaps:[]}}});
 // Keep the current checkpoint small while retaining the same owner schema.
 current.details.compactionState={...state,openLoops:[],topics:[],criticalContext:[],nextActions:[]};
 return{rows,prose,edit,old,agent,opaque,user,todo,current};
}
test('REQ-MEM-028 AC3: oldest known metadata payloads reach twenty MB instead of the upper ceiling',()=>{
 const f=fixture(),raw=jsonl(f.rows),ids=f.rows.slice(1).map(row=>row.id);
 const result=prepareLocalTranscriptTrim(raw,'historical-payloads',ids,25_000_000);
 assert.equal(result.withinTarget,true);assert.ok(Math.abs(result.remainingBytes-20_000_000)<1000,`twenty MB target: ${result.remainingBytes}`);
 assert.equal(Buffer.byteLength(result.candidate),result.remainingBytes);
 const after=result.candidate.trimEnd().split('\n').map(JSON.parse),by=new Map(after.map(row=>[row.id,row]));
 for(const row of [f.opaque,f.user,f.todo,f.current])assert.deepEqual(by.get(row.id),row);
 assert.deepEqual(after.map(row=>[row.id,row.parentId,row.timestamp,row.type]),f.rows.map(row=>[row.id,row.parentId,row.timestamp,row.type]));
 assert.deepEqual(by.get(f.prose.id).message.usage,f.prose.message.usage);
 assert.deepEqual(by.get(f.edit.id).message.details,{...f.edit.message.details,diff:'',patch:''});
 assert.deepEqual(by.get(f.old.id).details.compactionState.scope,f.old.details.compactionState.scope);
 assert.deepEqual(by.get(f.old.id).details.native,f.old.details.native);
 assert.deepEqual(by.get(f.old.id).details.provenance,{...f.old.details.provenance,deterministicPatched:[]});
 assert.deepEqual(by.get(f.agent.id).data,{...f.agent.data,result:''});
 validateTranscriptTrimCandidate(raw,result.candidate,'historical-payloads',ids);
 for(const mutate of [rows=>rows.find(row=>row.id===f.edit.id).message.details.opaque={},rows=>rows.find(row=>row.id===f.old.id).details.provenance.finalScore=0,rows=>rows.find(row=>row.id===f.agent.id).data.outputFile='/changed',rows=>rows.find(row=>row.id===f.current.id).details.compactionState.goal='changed']){
  const bad=structuredClone(after);mutate(bad);assert.throws(()=>validateTranscriptTrimCandidate(raw,jsonl(bad),'historical-payloads',ids));
 }
});
test('REQ-MEM-028 AC4: unknown payload owners and current content are not reduced to force the target',()=>{
 const f=fixture();f.edit.message.toolName='custom-editor';f.old.details.version=7;f.agent.customType='unknown-agent-state';
 const raw=jsonl(f.rows),result=prepareLocalTranscriptTrim(raw,'historical-payloads',f.rows.slice(1).map(row=>row.id),0),by=new Map(result.candidate.trimEnd().split('\n').map(JSON.parse).map(row=>[row.id,row]));
 assert.deepEqual(by.get(f.edit.id).message.details,f.edit.message.details);assert.deepEqual(by.get(f.old.id).details,f.old.details);assert.deepEqual(by.get(f.agent.id),f.agent);
 assert.equal(result.withinTarget,false);assert.deepEqual(by.get(f.user.id),f.user);assert.deepEqual(by.get(f.current.id),f.current);
});
