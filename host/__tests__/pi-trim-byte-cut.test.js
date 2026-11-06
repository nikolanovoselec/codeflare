import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {registerActiveSessionTranscriptTrimming}=await importPiExtension('active-session-transcript-trimming');
const header=Buffer.from('{"type":"session","version":3,"id":"byte-cut"}\n');
function expectedHash(file,start,end){const h=createHash('sha256'),fd=fs.openSync(file,'r'),b=Buffer.alloc(65536);h.update(header);try{for(let p=start;p<end;){const n=fs.readSync(fd,b,0,Math.min(b.length,end-p),p);h.update(b.subarray(0,n));p+=n;}}finally{fs.closeSync(fd);}return h.digest('hex');}
function fixture(t,megabytes=60){
 const root=fs.mkdtempSync(join(tmpdir(),'trim-byte-cut-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'session.jsonl');
 // Opaque lines deliberately need no JSON decoding. Copy their bytes, not values.
 const line=Buffer.from('opaque UTF-8 é '+ 'x'.repeat(1007)+'\n');assert.equal(line.length,1024);
 const fd=fs.openSync(file,'w');fs.writeSync(fd,header);const block=Buffer.concat(Array(1024).fill(line));
 for(let i=0;i<megabytes;i++)fs.writeSync(fd,block);fs.closeSync(fd);
 let selected=true;const tools=new Map(),ctx={sessionManager:{getSessionId:()=> selected?'byte-cut':'switched',getSessionFile:()=>file,getHeader:()=>({id:'byte-cut'}),getLeafId:()=> 'leaf',getBranch:()=>[{id:'leaf',parentId:null,type:'message',message:{role:'user',content:'current'}}]}};
 const owner=registerActiveSessionTranscriptTrimming({registerTool:x=>tools.set(x.name,x),sendMessage(){}});t.after(()=>owner.cancel());owner.markDue(ctx);let item=owner.collect(ctx);assert.ok(item?.request);
 const child={sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:item.request.prompt}}]}};
 const call=async operation=>JSON.parse((await tools.get('transcript_trim').execute('call',{operation},undefined,undefined,child)).content[0].text);
 return{file,owner,ctx,call,switchOwner(){selected=false;},rearm(){owner.cancel();owner.markDue(ctx);item=owner.collect(ctx);assert.ok(item?.request);}};
}
for(const size of [60,80,120])test(`REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window`,async t=>{
 const f=fixture(t,size),before=fs.statSync(f.file).size,body=before-header.length;
 const cut=header.length+(Math.floor((before-20_000_000)/1024)+1)*1024;
 const expected=expectedHash(f.file,cut,before);
 const result=await f.call('trim');assert.equal(result.status,'trimmed');assert.equal(result.committed,true);assert.equal(result.cutPercent,100*(cut-header.length)/body);assert.equal(result.workerMemoryLimitBytes,1_073_741_824);assert.ok(result.workerPeakMemoryBytes>0&&result.workerPeakMemoryBytes<1_073_741_824);
 assert.ok(result.after>=15_000_000&&result.after<=25_000_000);assert.equal(result.after,header.length+before-cut);assert.ok(result.after<=20_000_000&&result.after>20_000_000-1024,'one aligned cut aims at twenty MB, not the ceiling');
 assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),expected);
 assert.deepEqual(fs.readdirSync(join(f.file,'..')),['session.jsonl']);
});
test('REQ-MEM-029 AC1/4: a line-aligned cut below fifteen MB refuses without replacing the source',async t=>{
 const f=fixture(t,60);fs.writeFileSync(f.file,Buffer.concat([header,Buffer.alloc(51_000_000,120),Buffer.from('\nlast\n')]));
 f.rearm();
 const before=createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
 await assert.rejects(f.call('trim'),/retained-output-below-minimum/);
 assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),before);
});
test('REQ-MEM-030 AC4/7: activation includes appended tail and recalculates one cutoff before committing',async t=>{
 const f=fixture(t,60);const prepared=await f.call('prepare');assert.ok(prepared.cutPercent>0);
 const tail=Buffer.from('new tail '+ 'z'.repeat(999990)+'\n');for(let i=0;i<5;i++)fs.appendFileSync(f.file,tail);
 const result=await f.call('activate');assert.equal(result.status,'trimmed');assert.ok(result.cutPercent>prepared.cutPercent);assert.ok(result.after>=15_000_000&&result.after<=25_000_000);
 const fd=fs.openSync(f.file,'r'),last=Buffer.alloc(tail.length);fs.readSync(fd,last,0,last.length,result.after-last.length);fs.closeSync(fd);assert.deepEqual(last,tail);
});

test('REQ-MEM-029 AC1: a changed authorized prefix is not overwritten',async t=>{
 const f=fixture(t);await f.call('prepare');const fd=fs.openSync(f.file,'r+');fs.writeSync(fd,Buffer.from('Y'),0,1,header.length+30);fs.closeSync(fd);
 const before=createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
 const result=await f.call('activate');assert.equal(result.status,'refused');assert.match(result.reason,/source-prefix-changed/);assert.equal(result.committed,false);
 assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),before);
});
test('REQ-MEM-028 AC2: switching the loaded owner revokes activation without touching its file',async t=>{
 const f=fixture(t);await f.call('prepare');const before=createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');f.switchOwner();
 await assert.rejects(f.call('activate'),/missing-or-stale-activation-scope/);
 assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),before);
});

test('REQ-MEM-029 AC4: an append tail above the ceiling refuses without replacing the source',async t=>{
 const f=fixture(t);await f.call('prepare');fs.appendFileSync(f.file,Buffer.concat([Buffer.alloc(26_000_000,122),Buffer.from('\n')]));
 const before=createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');const result=await f.call('activate');
 assert.equal(result.status,'refused');assert.equal(result.committed,false);assert.match(result.reason,/retained-output-above-maximum/);
 assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),before);
});

for(const [name,diskHeader,reason]of [
 ['foreign session',JSON.stringify({type:'session',version:3,id:'another-session'})+'\n','foreign-or-child-session'],
 ['child session',JSON.stringify({type:'session',version:3,id:'byte-cut',parentSession:'/another/session.jsonl'})+'\n','foreign-or-child-session'],
 ['unsupported version',JSON.stringify({type:'session',version:2,id:'byte-cut'})+'\n','unsupported-session-version'],
 ['oversized header','x'.repeat(65536)+'\n','session-header-too-large-or-incomplete'],
 ['malformed header','not-json\n','invalid-session-header'],
])test(`REQ-MEM-028 AC2: automatic admission refuses ${name} without changing its file`,t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'trim-header-fence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'session.jsonl'),fd=fs.openSync(file,'w');fs.writeSync(fd,diskHeader);fs.ftruncateSync(fd,51_000_000);fs.closeSync(fd);
 const before=createHash('sha256').update(fs.readFileSync(file)).digest('hex'),inode=fs.statSync(file).ino,outcomes=[];
 const ctx={sessionManager:{getSessionId:()=> 'byte-cut',getSessionFile:()=>file,getHeader:()=>({id:'byte-cut'}),getLeafId:()=> 'cached-leaf',getBranch:()=>[{id:'cached-leaf'}]}};
 const owner=registerActiveSessionTranscriptTrimming({registerTool(){},sendMessage(m){outcomes.push(m);}});t.after(()=>owner.cancel());owner.markDue(ctx);
 assert.equal(owner.collect(ctx),undefined);assert.equal(outcomes.at(-1).details.status,'refused');assert.equal(outcomes.at(-1).details.reason,reason);
 assert.equal(fs.statSync(file).ino,inode);assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),before);assert.deepEqual(fs.readdirSync(root),['session.jsonl']);
});
