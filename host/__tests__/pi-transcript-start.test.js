import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import register from '../../preseed/agents/pi/extensions/active-session-transcript-trimming.ts';
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

test('REQ-MEM-030 AC1: explicit parent start schedules the existing native workflow without committing or duplicating pending work', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'trim-start-')); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const file=join(root,'session.jsonl');
  const rows=[{type:'session',version:3,id:'parent'},
    {type:'message',id:'old',parentId:null,message:{role:'assistant',content:[{type:'text',text:'h'.repeat(50_100_000)}]}},
    {type:'message',id:'active',parentId:'existing-gap',message:{role:'user',content:'Current work'}}];
  fs.writeFileSync(file,jsonl(rows));
  const ctx={sessionManager:{getSessionId:()=> 'parent',getSessionFile:()=>file,getHeader:()=>rows[0],getLeafId:()=> 'active',getBranch:()=>[rows[2]]}};
  const handlers=new Map(),tools=new Map(),messages=[];
  register({registerTool(tool){tools.set(tool.name,tool);},on(name,fn){handlers.set(name,fn);},events:{on(){}},
    getAllTools:()=>[],getActiveTools:()=>[],setActiveTools(){},sendMessage(message){messages.push(message);}});
  handlers.get('session_start')({},ctx);
  const execute=context=>tools.get('transcript_trim').execute('start',{operation:'start'},undefined,undefined,context);
  const child={sessionManager:{...ctx.sessionManager,getHeader:()=>({...rows[0],parentSession:'/parent.jsonl'})}};
  await assert.rejects(execute(child),/parent|owner|foreign/);
  const foreign={sessionManager:{...ctx.sessionManager,getSessionId:()=> 'foreign'}};
  await assert.rejects(execute(foreign),/parent|owner|foreign/);
  const started=JSON.parse((await execute(ctx)).content[0].text);
  assert.equal(started.status,'scheduled');assert.equal(started.committed,false);
  assert.ok(fs.statSync(file).size>50_000_000);
  assert.equal(messages.some(m=>m.customType==='background-extraction-launch'),false);
  const repeated=JSON.parse((await execute(ctx)).content[0].text);assert.equal(repeated.status,'already-pending');
  handlers.get('turn_end')({message:{role:'assistant',stopReason:'stop',content:[]}},ctx);
  const items=messages.filter(m=>m.customType==='background-extraction-launch').flatMap(m=>m.details.items);
  assert.equal(items.length,1);assert.equal(items[0].request.subagent_type,'transcript-trim');
  handlers.get('agent_settled')({},ctx);
  assert.deepEqual(messages.filter(m=>m.customType==='background-extraction-launch').flatMap(m=>m.details.items),items);
  assert.ok(fs.statSync(file).size>50_000_000);
});
