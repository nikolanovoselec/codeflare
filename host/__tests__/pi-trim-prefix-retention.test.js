import test from 'node:test';
import assert from 'node:assert/strict';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {prepareLocalTranscriptTrim}=await importPiExtension('active-session-transcript-trimming');
const jsonl=rows=>rows.map(row=>JSON.stringify(row)+'\n').join('');

test('REQ-MEM-028 AC3: many historical blocks retain source prefixes within the preferred byte budget',()=>{
 const blocks=Array.from({length:10000},()=>({type:'text',text:'x'.repeat(2048)}));
 const opaque={type:'opaque-native',data:{keep:true}},rows=[{type:'session',version:3,id:'many'},
  {type:'message',id:'old',parentId:null,message:{role:'assistant',usage:{input:12},content:[opaque,...blocks]}},
  {type:'message',id:'user',parentId:'old',message:{role:'user',content:'Current user'}},
  {type:'compaction',id:'checkpoint',parentId:'user',firstKeptEntryId:'user',summary:'Current'}];
 const result=prepareLocalTranscriptTrim(jsonl(rows),'many',['old','user','checkpoint'],25_000_000),after=result.candidate.trimEnd().split('\n').map(JSON.parse),retained=after[1].message.content.filter(b=>b.type==='text');
 // The JSON wire envelope plus one original character must fit before any
 // further source prefix can be retained; unused bytes must never be padded.
 const minimumSourceBlockBytes=Buffer.byteLength(JSON.stringify({type:'text',text:blocks[0].text.slice(0,1)}))+1;
 const gap=20_000_000-result.remainingBytes;
 assert.equal(result.withinTarget,true);assert.equal(Buffer.byteLength(result.candidate),result.remainingBytes);assert.ok(gap>=0&&gap<minimumSourceBlockBytes);assert.ok(retained.length>9000&&retained.length<=blocks.length);
 retained.forEach((block,i)=>assert.ok(blocks[i].text.startsWith(block.text)));assert.deepEqual(after[1].message.usage,rows[1].message.usage);assert.deepEqual(after[1].message.content.filter(b=>b.type==='opaque-native'),[opaque]);assert.deepEqual(after.slice(2),rows.slice(2));
});

