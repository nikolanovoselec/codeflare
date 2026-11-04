import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register, { TRANSCRIPT_TRIM_DUE, createTranscriptTrimRequest, commitTranscriptTrimCandidate, registerActiveSessionTranscriptTrimming } from '../../preseed/agents/pi/extensions/active-session-transcript-trimming.ts';
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
  return { root, file, rows, ctx, candidate, stage };
}
function lifecycle(f, io, queueLaunch = false) {
  const handlers = new Map(), listeners = new Map(), sent = [], tools = new Map();
  const pi = { registerTool(tool) { tools.set(tool.name, tool); }, on(n, fn) { handlers.set(n, fn); }, events: { on(n, fn) { listeners.set(n, fn); } },
    getAllTools: () => [{ name: 'subagent' }], getActiveTools: () => [], setActiveTools() {},
    sendMessage(message) { sent.push(message); if (queueLaunch && message.customType === 'background-extraction-launch') return; const row = { type: 'custom_message', id: `sent-${f.rows.length}`, parentId: f.rows.at(-1).id, ...message }; f.rows.push(row); fs.appendFileSync(f.file, jsonl([row])); } };
  if (io) registerActiveSessionTranscriptTrimming(pi, io); else register(pi);
  const emit = (n, e = {}) => handlers.get(n)?.(e, f.ctx);
  emit('session_start');
  const due = () => listeners.get(TRANSCRIPT_TRIM_DUE)({ sessionId: 'fixture', file: f.file });
  const launch = () => sent.filter(m => m.customType === 'background-extraction-launch').at(-1)?.details.items[0];
  const append = row => { const e = { id: `native-${f.rows.length}`, parentId: f.rows.at(-1).id, ...row }; f.rows.push(e); fs.appendFileSync(f.file, jsonl([e])); };
  const call = item => append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: item.requestId, name: 'subagent', arguments: item.request }] } });
  const done = (item, status = 'Done') => append({ type: 'custom_message', customType: 'subagent-notification', content: `<tool-use-id>${item.requestId}</tool-use-id><status>${status}</status>` });
  return { emit, due, launch, sent, call, done, append, tools };
}
test('REQ-MEM-030 AC1: visible scoped launch is idempotent and cancelled with the parent session', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled');
  const item = l.launch(); assert.equal(item.request.subagent_type, 'transcript-trim');
  for (const key of ['model', 'thinking', 'max_turns']) assert.equal(item.request[key], undefined);
  l.emit('agent_settled'); assert.equal(l.sent.length, 1);
  const varsFile = item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]; assert.ok(fs.existsSync(varsFile));
  l.emit('session_before_switch'); assert.equal(fs.existsSync(varsFile), false);
  assert.ok(fs.statSync(f.file).size > 50_000_000);
  fs.writeFileSync(f.file, jsonl([f.rows[0]])); l.emit('session_start'); l.due(); l.emit('agent_settled'); assert.equal(l.sent.length, 1);
});
test('REQ-MEM-030 AC2: semantic candidate requires exact native completion before parent admission', t => {
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
test('REQ-MEM-030 AC4: append tail merges verbatim and source rewrite rebases instead of overwriting', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  const tail = jsonl([{ type: 'message', id: 'tail', parentId: 'orphan', message: { role: 'user', content: 'Concurrent user' } }]); fs.appendFileSync(f.file, tail);
  assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'trimmed'); assert.ok(fs.readFileSync(f.file, 'utf8').endsWith(tail));
  fs.writeFileSync(f.file, jsonl(f.rows)); const newer = createTranscriptTrimRequest(f.ctx); f.stage(newer);
  f.rows[3].message.content = 'Edited historical user'; fs.writeFileSync(f.file, jsonl(f.rows));
  assert.match(commitTranscriptTrimCandidate(f.ctx, newer).reason, /source-prefix-changed/);
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('Edited historical user'), true);
});
test('REQ-MEM-030 AC5: failed or oversized candidates produce fresh scoped automatic corrective requests', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); let item = l.launch();
  let req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); fs.writeFileSync(req.candidateFile, jsonl(f.rows.slice(0, 8)));
  l.call(item); l.done(item); l.emit('agent_settled'); const retry = l.launch(); assert.notEqual(retry.requestId, item.requestId);
  req = JSON.parse(fs.readFileSync(retry.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); assert.match(req.feedback, /target|size/);
  l.call(retry); l.done(retry, 'Failed'); l.emit('agent_settled'); item = l.launch(); assert.notEqual(item.requestId, retry.requestId);
  req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); assert.match(req.feedback, /native/);
});
test('REQ-MEM-030 AC6: verified total target, precommit IO safety, durability distinction and no backup cleanup', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  const originalSize = fs.statSync(f.file).size;
  const failed = commitTranscriptTrimCandidate(f.ctx, req, { ...fs, renameSync() { throw new Error('synthetic rename failure'); } });
  assert.equal(failed.status, 'refused'); assert.equal(fs.statSync(f.file).size, originalSize);
  const result = commitTranscriptTrimCandidate(f.ctx, req, { ...fs, fsyncSync(fd) { if (fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory sync failure'); fs.fsyncSync(fd); } });
  assert.equal(result.status, 'trimmed'); assert.equal(result.reason, 'directory-sync-failed'); assert.ok(result.after <= 20_000_000);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC2: native scoped tool inspects and applies agent-selected replacements without live-write authority', async t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  const tool = l.tools.get('transcript_trim'); assert.ok(tool);
  const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
  const execute = params => tool.execute('tool-call', params, undefined, undefined, child);
  const info = JSON.parse((await execute({ operation: 'inspect' })).content[0].text);
  assert.equal(info.request.requestId, item.requestId); assert.equal(info.entries[1].eligible, true);
  const selected = JSON.parse((await execute({ operation: 'inspect', index: 3 })).content[0].text);
  assert.ok(selected.text.includes('Keep me verbatim'));
  const original = fs.statSync(f.file).size;
  await assert.rejects(execute({ operation: 'candidate', replacements: [] }), /empty|no-change/);
  assert.equal(fs.existsSync(req.candidateFile), false);
  await assert.rejects(execute({ operation: 'candidate', replacements: [{ id: 'user', patch: JSON.stringify({ message: f.rows[3].message }) }] }), /no-change/);
  assert.equal(fs.existsSync(req.candidateFile), false);
  await assert.rejects(execute({ operation: 'candidate', replacements: [{ id: 'user', patch: JSON.stringify({ message: { role: 'user', content: 'tampered' } }) }] }), /protected|opaque/);
  const patch = { message: { ...f.rows[1].message, content: [{ type: 'text', text: 'Historical conclusion.' }] } };
  const result = JSON.parse((await execute({ operation: 'candidate', replacements: [{ id: 'old', patch: JSON.stringify(patch) }] })).content[0].text);
  assert.equal(result.committed, false); assert.equal(result.withinTarget, true);
  assert.equal(fs.statSync(f.file).size, original); assert.ok(fs.statSync(req.candidateFile).size < 20_000_000);
  fs.unlinkSync(req.candidateFile); fs.symlinkSync(f.file, req.candidateFile);
  await assert.rejects(execute({ operation: 'candidate', replacements: [{ id: 'old', patch: JSON.stringify(patch) }] }));
  assert.equal(fs.statSync(f.file).size, original);
  fs.unlinkSync(req.candidateFile); fs.linkSync(f.file, req.candidateFile);
  await assert.rejects(execute({ operation: 'candidate', replacements: [{ id: 'old', patch: JSON.stringify(patch) }] }), /foreign-candidate/);
  assert.equal(fs.statSync(f.file).size, original);
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
test('REQ-MEM-030 AC4: completed stale work automatically re-arms from the rewritten prefix', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  l.call(item); l.done(item); f.rows[3].message.content = 'New historical user'; fs.writeFileSync(f.file, jsonl(f.rows));
  l.emit('agent_settled'); const retry = l.launch(); assert.notEqual(retry.requestId, item.requestId);
  const next = JSON.parse(fs.readFileSync(retry.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); assert.match(next.feedback, /source-prefix-changed/);
  assert.notEqual(next.sourceSha256, req.sourceSha256); assert.equal(fs.existsSync(req.varsFile), false);
  assert.ok(fs.readFileSync(f.file, 'utf8').includes('New historical user'));
});
test('REQ-MEM-030 AC6: total includes the unmodified append tail and rejects candidate and staging aliases', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  fs.appendFileSync(f.file, jsonl([{ type: 'message', id: 'huge-tail', parentId: 'orphan', message: { role: 'user', content: 't'.repeat(20_000_000) } }]));
  const original = fs.statSync(f.file).size; const over = commitTranscriptTrimCandidate(f.ctx, req);
  assert.match(over.reason, /total-exceeds-target/); assert.equal(fs.statSync(f.file).size, original);
  fs.unlinkSync(req.candidateFile); fs.symlinkSync(f.file, req.candidateFile);
  assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'refused'); assert.equal(fs.statSync(f.file).size, original);
});

test('REQ-MEM-030 AC6: branched historical state and known argument payloads reach the total budget with an active orphan tail', async t => {
  const f = fixture(t); f.rows.splice(1);
  const choices = [];
  let parentId = null;
  const add = payload => { const row = { id: `budget-${f.rows.length}`, parentId, ...payload }; f.rows.push(row); parentId = row.id; return row; };
  const choose = (row, patch) => choices.push({ id: row.id, patch: JSON.stringify(patch) });
  for (let i = 0; i < 14; i++) {
    const state = add({ type: 'custom', customType: 'rpiv-todo-state', data: { tasks: [{ id: i, subject: `Superseded completed phase ${i}`, description: 'd'.repeat(1_000_000), status: 'completed' }], nextId: i + 1 } });
    choose(state, { data: { tasks: [{ id: i, subject: `Completed phase ${i}; outcome captured in history summary`, status: 'completed' }], nextId: i + 1 } });
    const fork = parentId;
    const side = add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Inactive branch completion ' + 'b'.repeat(300_000) }], usage: { input: 4, output: 3 } } });
    choose(side, { message: { ...side.message, content: [{ type: 'text', text: `Inactive branch ${i} completed successfully.` }] } });
    parentId = fork;
    const result = add({ type: 'message', message: { role: 'toolResult', toolName: 'todo', toolCallId: `todo-${i}`, content: [{ type: 'text', text: `Phase ${i} completed` }], details: { ...state.data, action: 'list' } } });
    choose(result, { message: { ...result.message, details: { tasks: [], nextId: i + 1, action: 'list' } } });
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
  choose(historical, { message: condensedMessage });
  const oldSystem = add({ type: 'message', message: { role: 'system', content: [{ type: 'text', text: 'Retired system guidance ' + 's'.repeat(4_000_000) }] } });
  choose(oldSystem, { message: { ...oldSystem.message, content: [{ type: 'text', text: 'Retired guidance superseded by current contract.' }] } });
  const oldUser = add({ type: 'message', message: { role: 'user', content: 'Migration accepted. Keep current active work and all usage/accounting.' } });
  const oldCompaction = add({ type: 'compaction', firstKeptEntryId: oldUser.id, summary: 'Earlier migration history ' + 'c'.repeat(4_000_000), tokensBefore: 999 });
  choose(oldCompaction, { summary: 'Migration accepted; inactive historical details condensed.' });
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
  const execute = replacements => tool.execute('candidate', { operation: 'candidate', replacements }, undefined, undefined, child);
  for (const change of [
    block => { block.id = 'fabricated-call'; }, block => { block.name = 'bash'; },
    block => { block.arguments.unknownExtension = 'changed'; }, block => { block.extra = 'changed'; },
  ]) {
    const message = structuredClone(condensedMessage); change(message.content[1]);
    await assert.rejects(execute([{ id: historical.id, patch: JSON.stringify({ message }) }]), /opaque|envelope/);
  }
  const current = activeRows.at(-1); const currentMessage = structuredClone(current.message);
  currentMessage.content[0].arguments.content = 'Not authorized';
  await assert.rejects(execute([{ id: current.id, patch: JSON.stringify({ message: currentMessage }) }]), /protected/);
  const firstBatch = JSON.parse((await execute(choices.slice(0, 28))).content[0].text);
  assert.equal(firstBatch.withinTarget, false);
  const progress = JSON.parse((await tool.execute('inspect', { operation: 'inspect' }, undefined, undefined, child)).content[0].text);
  assert.equal(progress.candidateBytes, firstBatch.candidateBytes);
  assert.ok(progress.bytesToReduce > 0); assert.ok(progress.largestEligible.length > 0);
  const result = JSON.parse((await execute(choices.slice(28))).content[0].text);
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
  assert.equal(rows.find(e => e.id === choices[0].id).data.tasks[0].description, undefined);
  assert.equal(rows.find(e => e.id === historical.id).message.content[0].text, condensedMessage.content[0].text);
  assert.ok(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'));
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC6: transient postcommit readback failure resumes verification without a second write', t => {
  const f = fixture(t);
  let renamed = false, failReadback = true;
  const io = { ...fs,
    renameSync(from, to) { assert.equal(renamed, false, 'uncertain committed output must never be replayed'); fs.renameSync(from, to); renamed = true; },
    readFileSync(path, ...args) { if (path === f.file && renamed && failReadback) { failReadback = false; throw new Error('transient readback failure'); } return fs.readFileSync(path, ...args); },
  };
  const l = lifecycle(f, io); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  l.call(item); l.done(item); l.emit('agent_settled');
  assert.equal(renamed, true); const committed = fs.readFileSync(f.file);
  assert.ok(committed.length <= 20_000_000);
  assert.equal(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'), false);
  l.emit('agent_settled');
  assert.ok(l.sent.some(m => m.customType === 'transcript-trim-outcome' && m.details.status === 'trimmed'));
  const final = fs.readFileSync(f.file); assert.ok(final.subarray(0, committed.length).equals(committed));
  assert.equal(l.launch().requestId, item.requestId); assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC1: due maintenance advances at a normal turn boundary despite queued work without settlement', t => {
  const f = fixture(t), l = lifecycle(f, undefined, true); l.due();
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
