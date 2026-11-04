import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
const extensionDir=new URL('../../preseed/agents/pi/extensions/',import.meta.url),fixtureModules=new Map();
function fixtureModule(name){if(fixtureModules.has(name))return fixtureModules.get(name);let text=stripTypeScriptTypes(fs.readFileSync(new URL(name+'.ts',extensionDir),'utf8'));text=text.replace(/from "\.\/([a-z-]+)(?:\.ts)?"/g,(_m,key)=>`from "${fixtureModule(key)}"`);const url='data:text/javascript;base64,'+Buffer.from(text).toString('base64');fixtureModules.set(name,url);return url;}
const {registerMemoryVault}=await import(fixtureModule('memory-vault'));
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const { createTranscriptTrimRequest, commitTranscriptTrimCandidate, validateTranscriptTrimCandidate }=await importPiExtension('active-session-transcript-trimming');
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
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
  const candidate = () => rows.map((r, i) => i === 1 ? { ...r, message: { ...r.message, content: [{ type: 'text', text: 'Historical answer summarized.' }] } } : r);
  const stage = req => { const source = fs.readFileSync(file).subarray(0, req.sourceBytes).toString().trimEnd().split('\n').map(JSON.parse); source[1].message.content = [{ type: 'text', text: 'Historical answer summarized.' }]; fs.writeFileSync(req.candidateFile, jsonl(source)); };
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
test('REQ-MEM-030 AC6: branch refusal classifies missing current ancestry without changing disk', t => {
  const f = fixture(t); f.rows.at(-1).parentId = 'opaque';
  fs.writeFileSync(f.file, jsonl(f.rows.filter(e => e.id !== 'state')));
  const before = fs.readFileSync(f.file);
  assert.throws(() => createTranscriptTrimRequest(f.ctx), error => {
    assert.ok(error.message.startsWith('foreign-branch:'));
    const detail = JSON.parse(error.message.slice('foreign-branch:'.length));
    assert.equal(detail.leaf, 'orphan'); assert.equal(detail.branchLast, 'orphan');
    assert.equal(detail.leafOnDisk, true); assert.equal(detail.branchLastOnDisk, true);
    assert.equal(detail.missingCount, 1); assert.deepEqual(detail.missingSample, ['state']);
    assert.equal(detail.edgeMismatch, null);
    return true;
  });
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC1: visible scoped launch is idempotent and cancelled with the parent session', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled');
  const item = l.launch(); assert.equal(item.request.subagent_type, 'transcript-trim');
  for (const key of ['model', 'thinking', 'max_turns']) assert.equal(item.request[key], undefined);
  l.emit('agent_settled'); assert.equal(l.sent.length, 1);
  const varsFile = item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]; assert.ok(fs.existsSync(varsFile));
  l.emit('session_before_switch'); assert.equal(fs.existsSync(varsFile), false);
  assert.ok(fs.statSync(f.file).size > 50_000_000);
  f.rows.splice(1); fs.writeFileSync(f.file, jsonl(f.rows));
  l.emit('session_start'); l.due(); l.emit('agent_settled');
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').flatMap(m => m.details.items).filter(i => i.jobType === 'transcript-trim').length, 1);
  assert.ok(fs.statSync(f.file).size < 50_000_000);
});
test('REQ-MEM-030 AC1: shared owner cancels staged work on fork shutdown restart and aborted boundaries', t => {
  for (const event of ['session_before_fork', 'session_shutdown', 'session_start', 'turn_end', 'agent_settled']) {
    const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
    const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
    const before = fs.readFileSync(f.file);
    l.emit(event, event === 'turn_end' ? { outcome: 'aborted' } : { aborted: true });
    assert.equal(fs.existsSync(req.directory), false, event);
    l.emit('agent_settled'); assert.equal(l.launch(), item, event);
    assert.ok(fs.readFileSync(f.file).subarray(0, before.length).equals(before), event);
    assert.ok(fs.statSync(f.file).size > 50_000_000);
  }
});
test('REQ-MEM-030 AC2: staged candidate requires exact native completion before parent admission', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  l.emit('agent_settled'); assert.ok(fs.statSync(f.file).size > 50_000_000);
  l.call(item); l.done({ requestId: 'foreign' }); l.emit('agent_settled'); assert.ok(fs.statSync(f.file).size > 50_000_000);
  l.done(item); l.emit('agent_settled'); assert.ok(fs.statSync(f.file).size <= 20_000_000);
  assert.ok(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'));
});
test('REQ-MEM-030 AC3: preexisting orphan survives; new damage, accounting, users and current state are rejected', t => {
  const f = fixture(t);
  f.rows.push({ type: 'compaction', id: 'active-compaction', parentId: 'orphan', firstKeptEntryId: 'orphan', summary: 'Current active summary', tokensBefore: 100 },
    { type: 'message', id: 'active-tail', parentId: 'active-compaction', message: { role: 'assistant', content: [{ type: 'text', text: 'Current response' }] } });
  fs.writeFileSync(f.file, jsonl(f.rows));
  const req = createTranscriptTrimRequest(f.ctx);
  for (const mutate of [r => r[7].parentId = 'new-gap', r => r[1].id = 'user', r => r[1].parentId = 'state',
    r => r[1].message.usage.input++, r => r[3].message.content = 'changed', r => r[8].summary = 'changed',
    r => r[5].data.nextId++, r => r[6].data.secretMeaning = false]) {
    const rows = structuredClone(f.candidate()); mutate(rows); fs.writeFileSync(req.candidateFile, jsonl(rows));
    assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'refused'); assert.ok(fs.statSync(f.file).size > 50_000_000);
  }
  f.stage(req); assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'trimmed');
  const rows = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(rows.find(r => r.id === 'orphan').parentId, 'preexisting-missing');
});
test('REQ-MEM-030 AC4: append tail merges verbatim and divergent history is not overwritten', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  const tail = jsonl([{ type: 'message', id: 'tail', parentId: 'orphan', message: { role: 'user', content: 'Concurrent user' } }]); fs.appendFileSync(f.file, tail);
  assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'trimmed'); assert.ok(fs.readFileSync(f.file, 'utf8').endsWith(tail));
  fs.writeFileSync(f.file, jsonl(f.rows)); const newer = createTranscriptTrimRequest(f.ctx); f.stage(newer);
  f.rows[3].message.content = 'Edited historical user'; fs.writeFileSync(f.file, jsonl(f.rows));
  assert.match(commitTranscriptTrimCandidate(f.ctx, newer).reason, /source-prefix-changed/);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('Edited historical user'), true);
});
test('REQ-MEM-030 AC6: native failures reuse scoped requests through common extraction reminders', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  l.call(item); l.done(item, 'Failed'); l.emit('agent_settled'); const retry = l.launch();
  assert.equal(retry.requestId, item.requestId); assert.deepEqual(retry.request, item.request);
  assert.equal(retry.reminder, 1); assert.equal(item.reminder, 0);
  l.emit('agent_settled'); assert.equal(l.launch(), retry);
  l.call(retry); l.done(retry, 'Stopped'); l.emit('agent_settled');
  const reqPath = item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1];
  assert.equal(fs.existsSync(reqPath), false);
  l.emit('agent_settled'); assert.equal(l.launch(), retry);
  assert.ok(fs.statSync(f.file).size > 50_000_000);
});
test('REQ-MEM-030 AC6: oversized completed candidates are refused without live replacement or fresh request spam', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  fs.writeFileSync(req.candidateFile, fs.readFileSync(f.file).subarray(0, req.sourceBytes));
  l.call(item); l.done(item); const before = fs.readFileSync(f.file); l.emit('agent_settled');
  assert.ok(l.sent.some(message => message.customType === 'transcript-trim-outcome' && message.details.status === 'refused' && /candidate-exceeds-target/.test(message.details.reason)));
  assert.ok(fs.readFileSync(f.file).subarray(0, before.length).equals(before));
  assert.ok(fs.statSync(f.file).size > 50_000_000); assert.equal(fs.existsSync(req.directory), false);
  l.emit('agent_settled'); assert.equal(l.launch(), item);
});
test('REQ-MEM-030 AC7: verified total target, precommit IO safety, durability distinction and no backup cleanup', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  const originalSize = fs.statSync(f.file).size;
  const failed = commitTranscriptTrimCandidate(f.ctx, req, { ...fs, renameSync() { throw new Error('synthetic rename failure'); } });
  assert.equal(failed.status, 'refused'); assert.equal(fs.statSync(f.file).size, originalSize);
  const result = commitTranscriptTrimCandidate(f.ctx, req, { ...fs, fsyncSync(fd) { if (fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory sync failure'); fs.fsyncSync(fd); } });
  assert.equal(result.status, 'trimmed'); assert.equal(result.reason, 'directory-sync-failed'); assert.ok(result.after <= 20_000_000);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC2: one scoped local trim stages without live-write authority and rejects aliases', async t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  const tool = l.tools.get('transcript_trim'); assert.ok(tool);
  const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
  const execute = context => tool.execute('tool-call', { operation: 'trim' }, undefined, undefined, context);
  await assert.rejects(execute(f.ctx), /missing-maintenance-launch-scope/);
  const before = fs.readFileSync(f.file);
  const result = JSON.parse((await execute(child)).content[0].text);
  assert.equal(result.committed, false); assert.equal(result.withinTarget, true);
  assert.ok(fs.readFileSync(f.file).equals(before)); assert.ok(fs.statSync(req.candidateFile).size < 20_000_000);
  const candidate = fs.readFileSync(req.candidateFile, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const sourceRows = before.subarray(0, req.sourceBytes).toString().trimEnd().split('\n').map(JSON.parse);
  for (const row of sourceRows.filter(row => row.id !== 'old')) assert.deepEqual(candidate.find(e => e.id === row.id), row);
  assert.deepEqual(candidate.find(e => e.id === 'old').message.usage, f.rows[1].message.usage);
  fs.unlinkSync(req.candidateFile); fs.symlinkSync(f.file, req.candidateFile);
  await assert.rejects(execute(child)); assert.ok(fs.readFileSync(f.file).equals(before));
  fs.unlinkSync(req.candidateFile); fs.linkSync(f.file, req.candidateFile);
  await assert.rejects(execute(child), /foreign-candidate/); assert.ok(fs.readFileSync(f.file).equals(before));
});
test('REQ-MEM-030 AC3: latest Goal and Plan state, active branch and unknown content remain protected', t => {
  const f = fixture(t);
  f.rows.splice(2, 0,
    { type: 'custom', id: 'goal-old', parentId: 'old', customType: 'goal-state', data: { description: 'superseded', tokensUsed: 77 } },
    { type: 'custom', id: 'goal', parentId: 'goal-old', customType: 'goal-state', data: { description: 'current', tokensUsed: 88 } },
    { type: 'custom', id: 'plan', parentId: 'goal', customType: 'plan-mode-state', data: { mode: 'implement', plan: 'current plan' } });
  f.rows.find(r => r.id === 'old-state').parentId = 'plan';
  fs.writeFileSync(f.file, jsonl(f.rows)); const req = createTranscriptTrimRequest(f.ctx);
  for (const id of ['goal', 'plan']) {
    const rows = structuredClone(f.candidate()); rows.find(r => r.id === id).data = {};
    fs.writeFileSync(req.candidateFile, jsonl(rows)); assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'refused');
  }
  const active = { sessionManager: { ...f.ctx.sessionManager, getLeafId: () => 'old', getBranch: () => [f.rows[1]] } };
  const activeRequest = createTranscriptTrimRequest(active); fs.writeFileSync(activeRequest.candidateFile, jsonl(f.candidate()));
  assert.match(commitTranscriptTrimCandidate(active, activeRequest).reason, /protected-entry/);
});
test('REQ-MEM-030 AC5: completed stale work automatically re-arms from the rewritten prefix', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  l.call(item); l.done(item); f.rows[3].message.content = 'New historical user'; fs.writeFileSync(f.file, jsonl(f.rows));
  l.emit('agent_settled'); const retry = l.launch(); assert.notEqual(retry.requestId, item.requestId);
  const next = JSON.parse(fs.readFileSync(retry.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); assert.match(next.feedback, /source-prefix-changed/);
  assert.notEqual(next.sourceSha256, req.sourceSha256); assert.equal(fs.existsSync(req.varsFile), false);
  assert.ok(fs.readFileSync(f.file, 'utf8').includes('New historical user'));
});
test('REQ-MEM-030 AC7: total includes the unmodified append tail and rejects candidate and staging aliases', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  fs.appendFileSync(f.file, jsonl([{ type: 'message', id: 'huge-tail', parentId: 'orphan', message: { role: 'user', content: 't'.repeat(20_000_000) } }]));
  const original = fs.statSync(f.file).size; const over = commitTranscriptTrimCandidate(f.ctx, req);
  assert.match(over.reason, /total-exceeds-target/); assert.equal(fs.statSync(f.file).size, original);
  fs.unlinkSync(req.candidateFile); fs.symlinkSync(f.file, req.candidateFile);
  assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'refused'); assert.equal(fs.statSync(f.file).size, original);
});

test('REQ-MEM-030 AC7: branched historical state and known argument payloads reach the total budget with an active orphan tail', async t => {
  const f = fixture(t); f.rows.splice(1);
  let parentId = null;
  const add = payload => { const row = { id: `budget-${f.rows.length}`, parentId, ...payload }; f.rows.push(row); parentId = row.id; return row; };
  for (let i = 0; i < 14; i++) {
    const state = add({ type: 'custom', customType: 'rpiv-todo-state', data: { tasks: [{ id: i, subject: `Superseded completed phase ${i}`, description: 'd'.repeat(1_000_000), status: 'completed' }], nextId: i + 1 } });
    const fork = parentId;
    add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Inactive branch completion ' + 'b'.repeat(300_000) }], usage: { input: 4, output: 3 } } });
    parentId = fork;
    add({ type: 'message', message: { role: 'toolResult', toolName: 'todo', toolCallId: `todo-${i}`, content: [{ type: 'text', text: `Phase ${i} completed` }], details: { ...state.data, action: 'list' } } });
  }
  const historical = add({ type: 'message', message: { role: 'assistant', usage: { input: 20, output: 30, cost: { total: 1 } }, content: [
    { type: 'text', text: 'Completed migration analysis ' + 'a'.repeat(8_000_000) },
    { type: 'toolCall', id: 'historical-write', name: 'write', arguments: { path: '/historical/report.md', content: 'Old generated report ' + 'w'.repeat(6_000_000), unknownExtension: 'preserve' }, extra: 'wire-stable' },
    { type: 'unknown-block', opaque: 'preserve' },
  ] } });
  const condensedMessage = { ...historical.message, content: [
    { type: 'text', text: 'Migration completed; decisions and outcome captured by the retained user brief.' },
    { ...historical.message.content[1], arguments: { ...historical.message.content[1].arguments, content: 'Historical report recorded migration completion.' } },
    historical.message.content[2],
  ] };
  add({ type: 'message', message: { role: 'system', content: [{ type: 'text', text: 'Retired system guidance ' + 's'.repeat(4_000_000) }] } });
  const oldUser = add({ type: 'message', message: { role: 'user', content: 'Migration accepted. Keep current active work and all usage/accounting.' } });
  add({ type: 'compaction', firstKeptEntryId: oldUser.id, summary: 'Earlier migration history ' + 'c'.repeat(4_000_000), tokensBefore: 999 });
  parentId = 'preexisting-missing-budget-parent';
  const activeStart = f.rows.length;
  add({ type: 'message', message: { role: 'user', content: 'Continue current work, preserving this orphan component.' } });
  add({ type: 'custom', customType: 'goal-state', data: { description: 'Current goal', tokensUsed: 700 } });
  add({ type: 'custom', customType: 'rpiv-todo-state', data: { tasks: [{ id: 70, subject: 'Current task', status: 'in_progress' }], nextId: 71 } });
  add({ type: 'custom', customType: 'plan-mode-state', data: { mode: 'implement', plan: 'Current plan' } });
  add({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'current-write', name: 'write', arguments: { path: '/current', content: 'Current generated content ' + 'k'.repeat(7_100_000) } }], usage: { input: 55, output: 66 } } });
  fs.writeFileSync(f.file, jsonl(f.rows)); assert.ok(fs.statSync(f.file).size > 50_000_000);
  const activeRows = structuredClone(f.rows.slice(activeStart));
  const l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
  const tool = l.tools.get('transcript_trim');
  const request = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  const source = fs.readFileSync(f.file).subarray(0, request.sourceBytes).toString();
  const validateMessage = (id, message) => {
    const candidate = JSON.parse('[' + source.trimEnd().split('\n').join(',') + ']');
    candidate.find(row => row.id === id).message = message;
    validateTranscriptTrimCandidate(source, jsonl(candidate), 'fixture', request.branchIds);
  };
  for (const change of [
    block => { block.id = 'fabricated-call'; }, block => { block.name = 'bash'; },
    block => { block.arguments.unknownExtension = 'changed'; }, block => { block.extra = 'changed'; },
  ]) {
    const message = structuredClone(condensedMessage); change(message.content[1]);
    assert.throws(() => validateMessage(historical.id, message), /opaque|envelope/);
  }
  const current = activeRows.at(-1); const currentMessage = structuredClone(current.message);
  currentMessage.content[0].arguments.content = 'Not authorized';
  assert.throws(() => validateMessage(current.id, currentMessage), /protected/);
  const result = JSON.parse((await tool.execute('trim', { operation: 'trim' }, undefined, undefined, child)).content[0].text);
  assert.equal(result.withinTarget, true); assert.equal(result.committed, false);
  l.append({ type: 'message', message: { role: 'user', content: 'Concurrent tail ' + 't'.repeat(500_000) } });
  l.call(item); l.done(item);
  const tail = fs.readFileSync(f.file).subarray(JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])).sourceBytes).toString();
  l.emit('agent_settled');
  const persisted = fs.readFileSync(f.file, 'utf8'); assert.ok(Buffer.byteLength(persisted) <= 20_000_000);
  assert.ok(persisted.includes(tail));
  const rows = persisted.trimEnd().split('\n').map(JSON.parse);
  for (const row of activeRows) assert.deepEqual(rows.find(e => e.id === row.id), row);
  assert.deepEqual(rows.find(e => e.id === oldUser.id), oldUser);
  assert.equal(rows.find(e => e.id === activeRows[0].id).parentId, 'preexisting-missing-budget-parent');
  assert.deepEqual(rows.find(e => e.id === historical.id).message.usage, historical.message.usage);
  assert.deepEqual(rows.find(e => e.id === f.rows.find(row => row.customType === 'rpiv-todo-state').id).data.tasks, []);
  const historicalContent = rows.find(e => e.id === historical.id).message.content;
  assert.equal(historicalContent.some(block => block.type === 'text'), false);
  assert.deepEqual(historicalContent.find(block => block.type === 'unknown-block'), historical.message.content[2]);
  const retainedCall = historicalContent.find(block => block.type === 'toolCall');
  assert.equal(retainedCall.id, 'historical-write'); assert.equal(retainedCall.name, 'write');
  assert.equal(retainedCall.arguments.path, '/historical/report.md');
  assert.ok(retainedCall.arguments.content.length < historical.message.content[1].arguments.content.length);
  assert.equal(retainedCall.arguments.unknownExtension, 'preserve'); assert.equal(retainedCall.extra, 'wire-stable');
  assert.ok(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'));
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC7: transient postcommit readback failure resumes verification without a second write', t => {
  const f = fixture(t);
  let renamed = false, failReadback = true;
  const io = { ...fs,
    renameSync(from, to) { assert.equal(renamed, false, 'uncertain committed output must never be replayed'); fs.renameSync(from, to); renamed = true; },
    readFileSync(path, ...args) { if (path === f.file && renamed && failReadback) { failReadback = false; throw new Error('transient readback failure'); } return fs.readFileSync(path, ...args); },
  };
  const req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  const first = commitTranscriptTrimCandidate(f.ctx, req, io);
  assert.equal(first.status, 'verification-pending'); assert.match(first.reason, /readback/);
  assert.equal(renamed, true); const committed = fs.readFileSync(f.file);
  assert.ok(committed.length <= 20_000_000); assert.ok(fs.existsSync(req.directory));
  const result = commitTranscriptTrimCandidate(f.ctx, req, io);
  assert.equal(result.status, 'trimmed');
  assert.ok(fs.readFileSync(f.file).equals(committed));
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC6: delivered unlaunched and altered running work remain pending without fresh requests', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled');
  const first = l.launch(); const boundary = { message: { role: 'assistant', stopReason: 'stop', content: [] } };
  l.append({ type: 'message', message: boundary.message }); l.emit('turn_end', boundary);
  assert.equal(l.launch(), first);
  l.append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: first.requestId, name: 'subagent', arguments: { ...first.request, description: 'Altered request' } }] } });
  l.emit('turn_end', boundary); l.emit('agent_settled'); assert.equal(l.launch(), first);
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').length, 1);
  assert.ok(fs.existsSync(first.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  assert.ok(fs.statSync(f.file).size > 50_000_000);
});

test('REQ-MEM-030 AC3: recognized block metadata survives and malformed replacement blocks are rejected', () => {
  const rows = [{ type: 'session', version: 3, id: 'blocks' },
    { type: 'message', id: 'old', parentId: null, message: { role: 'assistant', content: [
      { type: 'text', text: 'Ordinary historical prose.' },
      { type: 'text', text: 'Provider prose.', extensionState: { opaque: true } },
      { type: 'thinking', thinking: 'Historical reasoning.', thinkingSignature: 'signature', extensionState: { opaque: true } },
      { type: 'image', data: 'AQ==', mimeType: 'image/png', extensionState: { opaque: true } },
      { type: 'thinking', thinking: 'Ordinary reasoning.', thinkingSignature: 'obsolete' },
    ] } },
    { type: 'message', id: 'active', parentId: 'existing-gap', message: { role: 'user', content: 'Current user' } }];
  const valid = structuredClone(rows); valid[1].message.content[0].text = 'Condensed prose.';
  valid[1].message.content[4] = { type: 'thinking', thinking: 'Condensed reasoning.' };
  assert.doesNotThrow(() => validateTranscriptTrimCandidate(jsonl(rows), jsonl(valid), 'blocks', ['active']));
  for (const index of [1, 2, 3]) {
    const damaged = structuredClone(valid); delete damaged[1].message.content[index].extensionState;
    assert.throws(() => validateTranscriptTrimCandidate(jsonl(rows), jsonl(damaged), 'blocks', ['active']), /opaque/);
  }
  for (const block of [{ type: 'text', text: 42 }, { type: 'thinking' }, { type: 'image', data: 42, mimeType: 'image/png' }]) {
    const malformed = structuredClone(valid); malformed[1].message.content.push(block);
    assert.throws(() => validateTranscriptTrimCandidate(jsonl(rows), jsonl(malformed), 'blocks', ['active']), /opaque/);
  }
});

test('REQ-MEM-030 AC7: completion waits for owned cleanup and retries without replacing committed data', t => {
  for (const fault of ['unlink', 'rmdir']) {
    const f = fixture(t); let renamed = false, failCleanup = true;
    const io = { ...fs,
      renameSync(from, to) { if (renamed) throw new Error('replacement replay forbidden'); fs.renameSync(from, to); renamed = true; },
      unlinkSync(path) { if (failCleanup && fault === 'unlink' && String(path).endsWith('candidate.jsonl')) throw new Error('temporary unlink failure'); fs.unlinkSync(path); },
      rmdirSync(path) { if (failCleanup && fault === 'rmdir') throw new Error('temporary directory removal failure'); fs.rmdirSync(path); },
    };
    const req = createTranscriptTrimRequest(f.ctx); f.stage(req);
    const first = commitTranscriptTrimCandidate(f.ctx, req, io);
    assert.equal(first.status, 'verification-pending'); assert.match(first.reason, /cleanup/);
    const committed = fs.readFileSync(f.file); assert.ok(committed.length <= 20_000_000);
    assert.ok(fs.existsSync(req.directory));
    failCleanup = false;
    assert.equal(commitTranscriptTrimCandidate(f.ctx, req, io).status, 'trimmed');
    assert.equal(fs.existsSync(req.directory), false);
    assert.ok(fs.readFileSync(f.file).equals(committed));
    assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  }
});

test('REQ-MEM-030 AC1: due maintenance advances at a normal turn boundary despite queued work without settlement', t => {
  const f = fixture(t), l = lifecycle(f, true); l.due();
  for (const stopReason of ['toolUse', 'length', 'aborted', 'error']) l.emit('turn_end', { message: { role: 'assistant', stopReason, content: [] } });
  l.emit('turn_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', id: 'unfinished', name: 'read', arguments: {} }] } });
  assert.equal(l.launch(), undefined);
  const boundary = { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Ordinary turn completed; more user or Goal work is queued.' }] } };
  l.emit('turn_end', boundary); const item = l.launch(); assert.ok(item);
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  // Native follow-up delivery can remain queued across further boundaries. It must not duplicate.
  l.emit('turn_end', boundary); l.emit('agent_settled');
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').length, 1);
  l.append({ type: 'custom_message', customType: 'background-extraction-launch', details: { items: [item] } });
  l.call(item); l.done(item);
  l.emit('turn_end', boundary);
  assert.ok(fs.statSync(f.file).size <= 20_000_000);
  assert.ok(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'));
  l.emit('turn_end', boundary); l.emit('agent_settled');
  assert.equal(l.sent.filter(m => m.customType === 'background-extraction-launch').length, 1);
});

test('REQ-MEM-015 AC7: six failed trim calls emit one shared terminal notice without replacement request spam', t => {
  const f=fixture(t),l=lifecycle(f);l.due();l.emit('agent_settled');const initial=l.launch();
  for(let attempt=0;attempt<6;attempt++){const item=l.launch();assert.equal(item.requestId,initial.requestId);assert.equal(item.reminder,attempt);l.call(item);l.done(item,'Failed');l.emit('agent_settled');}
  const notices=l.sent.filter(m=>m.customType==='background-extraction-giveup');assert.equal(notices.length,1);assert.ok(notices[0].details.items.some(i=>i.jobType==='transcript-trim'&&i.requestId===initial.requestId));assert.match(notices[0].content,/next legitimate extraction cadence/);
  const launches=l.sent.filter(m=>m.customType==='background-extraction-launch').length;l.emit('agent_settled');assert.equal(l.sent.filter(m=>m.customType==='background-extraction-giveup').length,1);assert.equal(l.sent.filter(m=>m.customType==='background-extraction-launch').length,launches);assert.ok(fs.statSync(f.file).size>50_000_000);
});
