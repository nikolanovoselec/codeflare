import * as fs from 'node:fs';
import {join} from 'node:path';
process.once('message',job=>{
  const group=process.env.CODEFLARE_TRIM_MEMORY_GROUP;
  const limit=Number(fs.readFileSync(join(group,'memory.max'),'utf8'));
  const swap=Number(fs.readFileSync(join(group,'memory.swap.max'),'utf8'));
  const members=fs.readFileSync(join(group,'cgroup.procs'),'utf8').trim().split('\n').map(Number);
  if(limit!==1_073_741_824||swap!==0||!members.includes(process.pid)||members.includes(job.ownerPid))throw Error('unsafe-test-memory-boundary');
  if(job.action==='exceed'){
    // CI-only caller verifies the actual kernel boundary before stressing it.
    const retained=[];for(;;)retained.push(Buffer.alloc(8*1024*1024,1));
  }
  process.send({ok:true,value:{kernelLimitBytes:limit,swapBytes:swap,parentInside:members.includes(job.ownerPid)}},()=>process.disconnect());
});
