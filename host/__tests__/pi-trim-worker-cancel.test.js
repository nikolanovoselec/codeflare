import test from 'node:test';
import assert from 'node:assert/strict';
import {runTrimWorker} from '../../preseed/agents/pi/extensions/transcript-trim/engine.mjs';
test('REQ-MEM-030 AC2: owner cancellation settles the CPU child before returning cancellation',async()=>{
 const owner=new AbortController();const pending=runTrimWorker({action:'prepare'},owner.signal);owner.abort();
 let timer;try{await assert.rejects(Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('worker did not terminate')),2000);})]),/maintenance-canceled/);}finally{clearTimeout(timer);}
});
