import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {fork} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runTrimWorker} from '../../preseed/agents/pi/extensions/transcript-trim/engine.mjs';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {commitTranscriptTrimCandidate}=await importPiExtension('active-session-transcript-trimming');
const within=async promise=>{
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('worker did not settle')),2000);})]);}finally{clearTimeout(timer);}
};
test('REQ-MEM-030 AC2: failed worker spawn settles promptly even when no exit event follows',async()=>{
 const launch=(file,args,options)=>fork(file,args,{...options,execPath:'/nonexistent-codeflare-trim-worker-node'});
 await assert.rejects(within(runTrimWorker({action:'prepare'},undefined,launch)),/launch|ENOENT|spawn/);
});
test('REQ-MEM-030 AC2: failed IPC send terminates the owned worker and settles without hanging',async()=>{
 const launch=(file,_args,options)=>{const child=fork(file,[],options);child.disconnect();return child;};
 await assert.rejects(within(runTrimWorker({action:'prepare'},undefined,launch)),/IPC|channel|send|worker/);
});
test('REQ-MEM-030 AC7: postcommit ordinary growth is verified separately from the accepted committed prefix, without replacement replay',async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'trim-worker-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=join(root,'session.jsonl'),directory=fs.mkdtempSync(join(root,'.transcript-trim-'));
 const rows=[{type:'session',version:3,id:'receipt'},{type:'message',id:'u',parentId:null,message:{role:'user',content:'u'.repeat(15_001_000)}}];
 const prefix=Buffer.from(rows.map(e=>JSON.stringify(e)+'\n').join(''));fs.writeFileSync(file,prefix);
 const request={sessionId:'receipt',file,directory,directoryIdentity:`${fs.statSync(directory).dev}:${fs.statSync(directory).ino}`,varsFile:join(directory,'request.json'),candidateFile:join(directory,'candidate.jsonl'),branchIds:['u'],committed:{bytes:prefix.length,sha256:createHash('sha256').update(prefix).digest('hex'),before:51_000_000}};
 const tail={type:'message',id:'a',parentId:'u',message:{role:'assistant',content:[{type:'text',text:'a'.repeat(10_001_000)}]}};fs.appendFileSync(file,JSON.stringify(tail)+'\n');
 const before=fs.statSync(file).size;assert.ok(before>25_000_000);
 const readback=await runTrimWorker({action:'readback',request});assert.equal(readback.after,prefix.length);assert.equal(readback.currentBytes,before);assert.equal(readback.appendedAfterCommitBytes,before-prefix.length);
 const ctx={sessionManager:{getSessionId:()=> 'receipt',getSessionFile:()=>file,getBranch:()=>rows.slice(1),getLeafId:()=> 'u'}};
 const recovered=commitTranscriptTrimCandidate(ctx,request);assert.equal(recovered.status,'trimmed');assert.equal(recovered.after,prefix.length);assert.equal(recovered.currentBytes,before);assert.equal(fs.statSync(file).size,before);assert.equal(fs.existsSync(directory),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8').trimEnd().split('\n').at(-1)),tail);
});

test('REQ-MEM-030 AC2: an inherited lower worker priority is preserved without changing the parent', async t => {
 const root=fs.mkdtempSync(join(tmpdir(),'trim-inherited-priority-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=join(root,'session.jsonl'),directory=fs.mkdtempSync(join(root,'.transcript-trim-'));
 const bytes=Buffer.from(JSON.stringify({type:'session',version:3,id:'priority'})+'\n'+JSON.stringify({type:'message',id:'u',parentId:null,message:{role:'user',content:'u'.repeat(15_001_000)}})+'\n');
 fs.writeFileSync(file,bytes);
 const request={sessionId:'priority',file,directory,directoryIdentity:`${fs.statSync(directory).dev}:${fs.statSync(directory).ino}`,committed:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
 const {getPriority}=await import('node:os');const parentPriority=getPriority(0);
 const preload='data:text/javascript,'+encodeURIComponent("import {setPriority} from 'node:os'; setPriority(0,19);");
 const launch=(entry,args,options)=>fork(entry,args,{...options,execArgv:['--import',preload]});
 const result=await runTrimWorker({action:'readback',request},undefined,launch);
 assert.equal(result.workerPriority,19);
 assert.equal(getPriority(0),parentPriority);
 assert.equal(result.after,bytes.length);
});
