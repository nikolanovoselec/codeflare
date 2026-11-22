import test from 'node:test';
import assert from 'node:assert/strict';
import { registerInitialToolFilter } from '../../preseed/agents/pi/extensions/capability-helpers.ts';
function fixture({active,registered=active,child=true}){
 let visible=[...active];const handlers=new Map();
 const ctx={sessionManager:{getHeader:()=>child?{id:'child',parentSession:'/synthetic-parent.jsonl'}:{id:'root'}}};
 const pi={getActiveTools:()=>[...visible],getAllTools:()=>registered.map(name=>({name})),setActiveTools:names=>{visible=names.filter(name=>registered.includes(name));},on:(name,handler)=>handlers.set(name,handler)};
 registerInitialToolFilter(pi);
 return{start:()=>handlers.get('before_agent_start')({},ctx),tools:()=>visible};
}
test('REQ-MEM-030 AC1: explicit scoped child keeps its selected transcript tool and parent channels through final exposure',()=>{
 const allowed=['transcript_trim','ask_parent','notify_parent'];const f=fixture({active:allowed});f.start();
 assert.deepEqual(f.tools(),allowed);f.start();assert.deepEqual(f.tools(),allowed);
});
test('REQ-MEM-030 AC1: child exposure never grants an unselected transcript tool or bypasses broader-tool filtering',()=>{
 const unselected=fixture({active:['ask_parent'],registered:['transcript_trim','ask_parent']});unselected.start();assert.deepEqual(unselected.tools(),['ask_parent']);
 const broader=fixture({active:['transcript_trim','bash','ask_parent']});broader.start();assert.deepEqual(broader.tools(),['bash','ask_parent']);
});
test('REQ-MEM-030 AC1: scoped child exception does not expose the trim tool in the root',()=>{
 const f=fixture({active:['transcript_trim','read','bash'],registered:['transcript_trim','read','bash','capability'],child:false});
 f.start();assert.deepEqual(f.tools(),['read','bash','capability']);
});
