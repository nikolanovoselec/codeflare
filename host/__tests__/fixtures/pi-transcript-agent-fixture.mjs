import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
const extensionDir=new URL('../../../preseed/agents/pi/extensions/',import.meta.url),fixtureModules=new Map();
function fixtureModule(name){if(fixtureModules.has(name))return fixtureModules.get(name);let text=stripTypeScriptTypes(fs.readFileSync(new URL(name+'.ts',extensionDir),'utf8'));text=text.replace(/from "\.\/([a-z-]+)(?:\.ts)?"/g,(_m,key)=>`from "${fixtureModule(key)}"`);const url='data:text/javascript;base64,'+Buffer.from(text).toString('base64');fixtureModules.set(name,url);return url;}
const {registerMemoryVault}=await import(fixtureModule('memory-vault'));
import {importPiExtension} from './pi-extension-module.mjs';
const { createTranscriptTrimRequest, commitTranscriptTrimCandidate, validateTranscriptTrimCandidate, prepareLocalTranscriptTrim }=await importPiExtension('active-session-transcript-trimming');
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
function assertTrimWindow(bytes) {
  assert.ok(bytes >= 15_000_000 && bytes <= 25_000_000, `committed bytes ${bytes} must be within the inclusive trim window`);
}
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'trim-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const rows = [
    { type: 'session', version: 3, id: 'fixture' },
    { type: 'message', id: 'old', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50_100_000) }], usage: { input: 100, output: 30 } } },
    { type: 'custom', id: 'old-state', parentId: 'old', customType: 'rpiv-todo-state', data: { tasks: [], nextId: 1 } },
    { type: 'message', id: 'user', parentId: 'old-state', message: { role: 'user', content: 'Keep me verbatim' } },
    { type: 'compaction', id: 'compact', parentId: 'user', firstKeptEntryId: 'user', summary: 'Authoritative summary', tokensBefore: 900 },
    { type: 'custom', id: 'state', parentId: 'compact', customType: 'rpiv-todo-state', data: { tasks: [], nextId: 9 } },
    { type: 'custom', id: 'opaque', parentId: 'state', customType: 'unrecognized', data: { secretMeaning: true } },
    { type: 'message', id: 'orphan', parentId: 'preexisting-missing', message: { role: 'user', content: 'Orphan active user' } },
  ];
  fs.writeFileSync(file, jsonl(rows));
  const ctx = { sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => file, getLeafId: () => rows.at(-1).id,
    getBranch: () => { const out = []; const byId = new Map(rows.map(r => [r.id, r])); for (let e = rows.at(-1); e && e.type !== 'session'; e = byId.get(e.parentId)) out.unshift(e); return out; } } };
  const candidate = () => prepareLocalTranscriptTrim(jsonl(rows), 'fixture', ctx.sessionManager.getBranch().map(row => row.id), 19_995_904).candidate.trimEnd().split('\n').map(JSON.parse);
  const stage = req => {
    const source = fs.readFileSync(file).subarray(0, req.sourceBytes).toString();
    const trimmed = prepareLocalTranscriptTrim(source, req.sessionId, req.branchIds, req.candidateBudget);
    assert.equal(trimmed.withinTarget, true);
    assertTrimWindow(trimmed.remainingBytes);
    assert.ok(trimmed.remainingBytes <= req.candidateBudget, 'staged prefix respects the request budget');
    fs.writeFileSync(req.candidateFile, trimmed.candidate);
  };
  return { root, file, rows, ctx, candidate, stage, t };
}
function lifecycle(f, queueLaunch = false) {
  const handlers = new Map(), sent = [], tools = new Map(), calls=new Map();
  const auxiliary=fs.mkdtempSync(join(tmpdir(),'trim-shared-owner-'));f.t.after(()=>fs.rmSync(auxiliary,{recursive:true,force:true}));
  const paths={vaultRoot:join(auxiliary,'Vault'),cacheDir:join(auxiliary,'cache'),memoryCounterDir:join(auxiliary,'counters'),memoryPromptFile:join(auxiliary,'memory.md'),vaultPromptFile:join(auxiliary,'vault.md'),vaultManifestFile:join(auxiliary,'Vault/graphify-out/manifest.json'),vaultInitializationFile:join(auxiliary,'Vault/graphify-out/initialized'),vaultMarkerFile:join(auxiliary,'marker')};
  fs.writeFileSync(paths.memoryPromptFile,'Capture scope');fs.writeFileSync(paths.vaultPromptFile,'Vault scope');
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, on(n, fn) { const list=handlers.get(n)||[];list.push(fn);handlers.set(n,list); },
    getAllTools: () => [{ name: 'subagent' }], getActiveTools: () => [], setActiveTools() {},
    sendMessage(message) { sent.push(message); if (queueLaunch && message.customType === 'background-extraction-launch') return; const row = { type: 'custom_message', id: `sent-${f.rows.length}`, parentId: f.rows.at(-1).id, ...message }; f.rows.push(row); fs.appendFileSync(f.file, jsonl([row])); } };
  let sequence=0;
  registerMemoryVault(pi,{paths,now:()=>Date.now(),randomUUID:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`});
  const emit = (n, e = {}) => {for(const handler of handlers.get(n)||[])handler(e,f.ctx);};
  const append = row => { const e = { id: `native-${f.rows.length}`, parentId: f.rows.at(-1).id, ...row }; f.rows.push(e); fs.appendFileSync(f.file, jsonl([e])); };
  emit('session_start');
  const due = () => {for(let n=0;n<21;n++){const prompt='Cadence user '+f.rows.length;append({type:'message',message:{role:'user',content:prompt}});emit('before_agent_start',{prompt});}};
  const launch = () => sent.filter(m => m.customType === 'background-extraction-launch').flatMap(m=>m.details.items).filter(i=>i.jobType==='transcript-trim').at(-1);
  const call = item => {const id='call-'+f.rows.length;calls.set(item.requestId,id);append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'subagent', arguments: item.request }] } });};
  const done = (item, status = 'Done') => append({ type: 'custom_message', customType: 'subagent-notification', content: `<tool-use-id>${calls.get(item.requestId)||item.requestId}</tool-use-id><status>${status}</status>` });
  return { emit, due, launch, sent, call, done, append, tools };
}

export { fixture, lifecycle, jsonl, assertTrimWindow, createTranscriptTrimRequest, commitTranscriptTrimCandidate, validateTranscriptTrimCandidate };
