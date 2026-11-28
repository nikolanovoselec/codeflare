import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const jsonl=rows=>rows.map(r=>JSON.stringify(r)+'\n').join('');

test('REQ-MEM-015 AC3: frozen capture dispatch and correlated finalization progress without settlement or duplicate queued launches',async t=>{
  const {registerMemoryVault}=await importPiExtension('memory-vault');
  const root=fs.mkdtempSync(join(tmpdir(),'capture-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=join(root,'session.jsonl'),rows=[{type:'session',version:3,id:'fixture'}];fs.writeFileSync(file,jsonl(rows));
  const paths={vaultRoot:join(root,'Vault'),cacheDir:join(root,'cache'),memoryCounterDir:join(root,'counters'),memoryPromptFile:join(root,'memory.md'),vaultPromptFile:join(root,'vault.md'),vaultManifestFile:join(root,'Vault/graphify-out/manifest.json'),vaultInitializationFile:join(root,'Vault/graphify-out/initialized'),vaultMarkerFile:join(root,'marker')};
  fs.writeFileSync(paths.memoryPromptFile,'Capture frozen scope');fs.writeFileSync(paths.vaultPromptFile,'Extract scope');
  const handlers=new Map(),sent=[];const ctx={sessionManager:{getSessionId:()=> 'fixture',getSessionFile:()=>file,getHeader:()=>rows[0]}};
  const append=row=>{const e={id:'e'+rows.length,parentId:rows.length===1?null:rows.at(-1).id,timestamp:'2026-11-04T00:00:00Z',...row};rows.push(e);fs.appendFileSync(file,jsonl([e]));};
  const deliveries=[];
  const pi={on(name,fn){handlers.set(name,fn);},events:{emit(){}},getActiveTools:()=>[],getAllTools:()=>[],setActiveTools(){},sendMessage(message,options){sent.push(message);deliveries.push(options);}};
  registerMemoryVault(pi,{paths,now:()=>Date.parse('2026-11-04T00:00:00Z'),randomUUID:()=> '00000000-0000-4000-8000-000000000001'});
  const emit=(name,event={})=>handlers.get(name)?.(event,ctx);emit('session_start');
  append({type:'message',message:{role:'user',content:'prompt 1'}});emit('before_agent_start',{prompt:'prompt 1'});
  for(let n=2;n<=21;n++)append({type:'message',message:{role:'user',content:'prompt '+n}});
  // These queued user prompts cross the boundary without another agent start.
  const stop={message:{role:'assistant',stopReason:'stop',content:[]}};
  emit('turn_end',{message:{...stop.message,stopReason:'toolUse'}});assert.equal(sent.length,0);
  assert.equal(fs.existsSync(join(paths.memoryCounterDir,'fixture.vars')),false);
  emit('turn_end',stop);
  const pointer=JSON.parse(fs.readFileSync(join(paths.memoryCounterDir,'fixture.vars'),'utf8'));
  const vars=join(paths.cacheDir,`memory-capture.fixture.${pointer.requestId}.vars`),frozen=fs.readFileSync(vars);
  const request=JSON.parse(frozen);assert.equal(request.promptCount,21);
  const launch=sent.find(m=>m.customType==='background-extraction-launch');assert.ok(launch);
  assert.equal(launch.display,false,'routine extraction launch is hidden in display-aware clients');
  assert.deepEqual(deliveries[sent.indexOf(launch)],{deliverAs:'followUp',triggerTurn:true});
  const payload=launch.content.match(/<extraction-items-json>\n(.+)\n<\/extraction-items-json>/s);
  assert.ok(payload);
  assert.deepEqual(JSON.parse(payload[1]),launch.details.items);
  assert.ok(launch.details.items.some(item => item.jobType === 'memory-capture'));
  emit('turn_end',stop);emit('agent_settled');
  assert.deepEqual(sent.filter(m=>m.customType==='background-extraction-launch'),[launch]);
  assert.ok(fs.readFileSync(vars).equals(frozen));assert.equal(fs.readFileSync(join(paths.memoryCounterDir,'fixture.count'),'utf8'),'1');
  append({type:'custom_message',...launch});
  const item=launch.details.items.find(i=>i.jobType==='memory-capture');assert.ok(item);
  append({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'native-capture',name:'subagent',arguments:item.request}]}});
  append({type:'custom_message',customType:'subagent-notification',content:'<tool-use-id>native-capture</tool-use-id><status>Done</status>'});
  fs.writeFileSync(join(paths.vaultRoot,'Raw/Sessions',request.captureFilename),'# Captured session\nFrozen decisions retained.\n');
  fs.writeFileSync(join(paths.vaultRoot,'graphify-out',`.graphify_chunk_${request.requestId}.json`),JSON.stringify({nodes:[{id:'n',label:'Frozen decision',file_type:'concept',source_file:null,source_location:null,source_url:null,captured_at:null,author:null,contributor:null}],edges:[],hyperedges:[],input_tokens:1,output_tokens:1}));
  emit('turn_end',stop);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir,'fixture.count'),'utf8'),'21');
  const note=fs.readFileSync(join(paths.vaultRoot,'Raw/Sessions',request.captureFilename),'utf8');assert.match(note,/captured_prompt_count: 21/);
  assert.equal(fs.existsSync(vars),false);assert.equal(fs.existsSync(join(paths.memoryCounterDir,'fixture.vars')),false);
  emit('turn_end',stop);emit('agent_settled');
  assert.equal(fs.readFileSync(join(paths.vaultRoot,'Raw/Sessions',request.captureFilename),'utf8'),note);
  assert.deepEqual(sent.filter(m=>m.customType==='background-extraction-launch'),[launch]);
});

for (const [label, timezone, expected] of [
  ['process TZ without a user preference', 'Asia/Kathmandu', '2026-07-01T17-45-00+0545'],
  ['UTC without either timezone setting', undefined, '2026-07-01T12-00-00+0000'],
]) {
  test(`REQ-MEM-001 AC4: Pi capture uses ${label}`, async t => {
    const { registerMemoryVault } = await importPiExtension('memory-vault');
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-07-01T12:00:00Z') });
    const previous = { USER_TIMEZONE: process.env.USER_TIMEZONE, TZ: process.env.TZ };
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    delete process.env.USER_TIMEZONE;
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;

    const root = fs.mkdtempSync(join(tmpdir(), 'pi-capture-timezone-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = {
      vaultRoot: join(root, 'Vault'), cacheDir: join(root, 'cache'),
      memoryCounterDir: join(root, 'counters'),
      memoryPromptFile: join(root, 'memory.md'), vaultPromptFile: join(root, 'vault.md'),
      vaultManifestFile: join(root, 'Vault/graphify-out/manifest.json'),
      vaultInitializationFile: join(root, 'Vault/graphify-out/initialized'),
      vaultMarkerFile: join(root, 'marker'),
    };
    fs.writeFileSync(paths.memoryPromptFile, 'Capture the frozen request');
    fs.writeFileSync(paths.vaultPromptFile, 'Extract changed files');
    // No graph exists, so session_start cannot publish to the global graph.
    fs.mkdirSync(join(paths.vaultRoot, 'graphify-out'), { recursive: true });
    fs.writeFileSync(paths.vaultInitializationFile, '1\n');
    const rows = [{ type: 'session', version: 3, id: 'timezone-fixture' }];
    const file = join(root, 'session.jsonl');
    fs.writeFileSync(file, jsonl(rows));
    const handlers = new Map();
    const pi = {
      on(name, handler) { handlers.set(name, handler); }, events: { emit() {} },
      getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, sendMessage() {},
    };
    const ctx = { sessionManager: {
      getSessionId: () => 'timezone-fixture', getSessionFile: () => file, getHeader: () => rows[0],
    } };
    registerMemoryVault(pi, { paths, randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    t.after(() => handlers.get('session_shutdown')?.({}, ctx));
    await handlers.get('session_start')({}, ctx);
    fs.writeFileSync(join(paths.memoryCounterDir, 'timezone-fixture.count'), '0');
    for (let ordinal = 1; ordinal <= 20; ordinal++) {
      rows.push({ type: 'message', id: `prompt-${ordinal}`, message: { role: 'user', content: `Real prompt ${ordinal}` } });
    }
    fs.writeFileSync(file, jsonl(rows));
    await handlers.get('before_agent_start')({ prompt: 'Real prompt 20' }, ctx);
    const pointer = JSON.parse(fs.readFileSync(join(paths.memoryCounterDir, 'timezone-fixture.vars'), 'utf8'));
    const request = JSON.parse(fs.readFileSync(
      join(paths.cacheDir, `memory-capture.timezone-fixture.${pointer.requestId}.vars`), 'utf8'));
    assert.equal(request.captureTimestamp, expected);
    assert.equal(request.captureFilename, `${expected}--fixture.md`);
    assert.equal(request.promptCount, 20);
    assert.match(request.transcript, /Real prompt 20/);
  });
}
