import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runTrimWorker} from '../../preseed/agents/pi/extensions/transcript-trim/engine.mjs';
const fixture=fileURLToPath(new URL('./fixtures/trim-memory-worker.mjs',import.meta.url));
const launch=(_file,args,options)=>fork(fixture,args,options);

test('REQ-MEM-032 AC1/2: kernel bounds worker memory to one GiB before work, without limiting its parent',async()=>{
 const result=await runTrimWorker({action:'inspect-limit',ownerPid:process.pid},undefined,launch);
 assert.equal(result.kernelLimitBytes,1_073_741_824);
 assert.equal(result.workerMemoryLimitBytes,1_073_741_824);
 assert.equal(result.swapBytes,0);
 assert.equal(result.parentInside,false);
 assert.ok(result.workerPeakMemoryBytes>0&&result.workerPeakMemoryBytes<1_073_741_824);
});

test('REQ-MEM-032 AC2: direct unbounded worker startup refuses before transcript work',async()=>{
 const env={...process.env};delete env.CODEFLARE_TRIM_MEMORY_GROUP;
 const child=fork(fileURLToPath(new URL('../../preseed/agents/pi/extensions/transcript-trim/engine.mjs',import.meta.url)),['--trim-worker'],{env,stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
 const outcome=await new Promise((resolve,reject)=>{let message;child.on('message',value=>{message=value;});child.on('error',reject);child.on('exit',code=>resolve({code,message}));});
 assert.equal(outcome.code,1);
 assert.equal(outcome.message.ok,false);
 assert.equal(outcome.message.error,'worker-memory-limit-unavailable');
});

test('REQ-MEM-032 AC3: kernel memory exhaustion kills only bounded workers and leaves the owner usable',{skip:process.env.GITHUB_ACTIONS!=='true'},async()=>{
 await assert.rejects(runTrimWorker({action:'exceed',ownerPid:process.pid},undefined,launch),/worker-oom-killed:1073741824/);
 const recovered=await runTrimWorker({action:'inspect-limit',ownerPid:process.pid},undefined,launch);
 assert.equal(recovered.kernelLimitBytes,1_073_741_824);
 assert.equal(recovered.parentInside,false);
});
