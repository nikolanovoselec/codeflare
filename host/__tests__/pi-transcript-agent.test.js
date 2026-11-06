import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import { fixture, lifecycle, jsonl, assertTrimWindow, createTranscriptTrimRequest, commitTranscriptTrimCandidate, validateTranscriptTrimCandidate } from './fixtures/pi-transcript-agent-fixture.mjs';

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
test('REQ-MEM-030 AC6: oversized completed candidates are refused without live replacement or fresh request spam', t => {
  const f = fixture(t), l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  fs.writeFileSync(req.candidateFile, fs.readFileSync(f.file).subarray(0, req.sourceBytes));
  l.call(item); l.done(item); const before = fs.readFileSync(f.file); l.emit('agent_settled');
  const retry = l.launch();
  assert.equal(retry.requestId, item.requestId); assert.deepEqual(retry.request, item.request);
  assert.equal(retry.reminder, 1); assert.equal(item.reminder, 0);
  assert.equal(l.sent.some(message => message.customType === 'transcript-trim-outcome' && message.details.status === 'trimmed'), false);
  assert.ok(fs.readFileSync(f.file).subarray(0, before.length).equals(before));
  assert.ok(fs.statSync(f.file).size > 50_000_000); assert.equal(fs.existsSync(req.directory), true);
  l.emit('agent_settled'); assert.equal(l.launch(), retry);
});
test('REQ-MEM-030 AC7: verified total target, precommit IO safety, durability distinction and no backup cleanup', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  const originalSize = fs.statSync(f.file).size;
  const failed = commitTranscriptTrimCandidate(f.ctx, req, { ...fs, renameSync() { throw new Error('synthetic rename failure'); } });
  assert.equal(failed.status, 'refused'); assert.equal(fs.statSync(f.file).size, originalSize);
  const result = commitTranscriptTrimCandidate(f.ctx, req, { ...fs, fsyncSync(fd) { if (fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory sync failure'); fs.fsyncSync(fd); } });
  assert.equal(result.status, 'trimmed'); assert.equal(result.reason, 'directory-sync-failed'); assertTrimWindow(result.after);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-030 AC2: one scoped local trim verifies live history before return and rejects aliases', async t => {
  const f = fixture(t);f.rows[3].message.content='Retained user '+ 'u'.repeat(19_000_000);fs.writeFileSync(f.file,jsonl(f.rows));const l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  const tool = l.tools.get('transcript_trim'); assert.ok(tool);
  const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
  const execute = context => tool.execute('tool-call', { operation: 'trim' }, undefined, undefined, context);
  await assert.rejects(execute(f.ctx), /missing-maintenance-launch-scope/);
  const before = fs.readFileSync(f.file);
  // Refuse aliases before reduction/activation; the owner capability remains usable.
  fs.symlinkSync(f.file, req.candidateFile);
  await assert.rejects(execute(child)); assert.ok(fs.readFileSync(f.file).equals(before));
  fs.unlinkSync(req.candidateFile); fs.linkSync(f.file, req.candidateFile);
  await assert.rejects(execute(child)); assert.ok(fs.readFileSync(f.file).equals(before));
  fs.unlinkSync(req.candidateFile);
  const result = JSON.parse((await execute(child)).content[0].text);
  assert.equal(result.committed, true); assert.equal(result.withinTarget, true);
  assertTrimWindow(fs.statSync(f.file).size); assert.equal(fs.existsSync(req.directory), false);
  assert.ok(result.candidateBytes <= result.budgetBytes && result.budgetBytes <= req.candidateBudget, 'scoped candidate respects the tail-adjusted request budget');
  const candidate = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const sourceRows = before.toString().trimEnd().split('\n').map(JSON.parse);
  for (const row of sourceRows.filter(row => row.id !== 'old')) assert.deepEqual(candidate.find(e => e.id === row.id), row);
  assert.equal(candidate.some(e=>e.id==='old'),false,'the oldest whole record is discarded, not semantically rewritten');

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
test('REQ-MEM-030 AC5: stale scoped work refuses rewritten history without replacing it', async t => {
  const f = fixture(t);f.rows[3].message.content='Retained user '+ 'u'.repeat(19_000_000);fs.writeFileSync(f.file,jsonl(f.rows));const l = lifecycle(f); l.due(); l.emit('agent_settled'); const item = l.launch();
  const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1])); f.stage(req);
  f.rows[3].message.content = 'New historical user '+ 'u'.repeat(19_000_000); fs.writeFileSync(f.file, jsonl(f.rows));
  const before = fs.readFileSync(f.file);
  const child = { sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: item.request.prompt } }] } };
  await assert.rejects(l.tools.get('transcript_trim').execute('stale', { operation: 'trim' }, undefined, undefined, child), /source-prefix-changed/);
  assert.ok(fs.readFileSync(f.file).equals(before));
  l.call(item); l.done(item); l.emit('agent_settled');
  assert.ok(fs.readFileSync(f.file).subarray(0, before.length).equals(before));
  const refreshed=l.launch();assert.ok(refreshed);assert.notEqual(refreshed.requestId,item.requestId);
  const rebound=JSON.parse(fs.readFileSync(refreshed.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
  assert.notEqual(rebound.sourceSha256,req.sourceSha256);
  const prefix=fs.readFileSync(f.file).subarray(0,rebound.sourceBytes);
  assert.equal(rebound.sourceSha256,createHash('sha256').update(prefix).digest('hex'));
  const freshChild={sessionManager:{getBranch:()=>[{type:'message',message:{role:'user',content:refreshed.request.prompt}}]}};
  const result=JSON.parse((await l.tools.get('transcript_trim').execute('refreshed',{operation:'trim'},undefined,undefined,freshChild)).content[0].text);
  assert.equal(result.committed,true);assert.equal(result.status,'trimmed');assertTrimWindow(fs.statSync(f.file).size);
  const persisted=fs.readFileSync(f.file,'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(persisted.find(row=>row.id===f.rows[3].id),f.rows[3]);
});
test('REQ-MEM-030 AC7: total includes the unmodified append tail and rejects candidate and staging aliases', t => {
  const f = fixture(t), req = createTranscriptTrimRequest(f.ctx); f.stage(req);
  fs.appendFileSync(f.file, jsonl([{ type: 'message', id: 'huge-tail', parentId: 'orphan', message: { role: 'user', content: 't'.repeat(20_000_000) } }]));
  const original = fs.statSync(f.file).size; const over = commitTranscriptTrimCandidate(f.ctx, req);
  assert.match(over.reason, /total-exceeds-target/); assert.equal(fs.statSync(f.file).size, original);
  fs.unlinkSync(req.candidateFile); fs.symlinkSync(f.file, req.candidateFile);
  assert.equal(commitTranscriptTrimCandidate(f.ctx, req).status, 'refused'); assert.equal(fs.statSync(f.file).size, original);
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
  assertTrimWindow(committed.length); assert.ok(fs.existsSync(req.directory));
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
    const committed = fs.readFileSync(f.file); assertTrimWindow(committed.length);
    assert.ok(fs.existsSync(req.directory));
    failCleanup = false;
    assert.equal(commitTranscriptTrimCandidate(f.ctx, req, io).status, 'trimmed');
    assert.equal(fs.existsSync(req.directory), false);
    assert.ok(fs.readFileSync(f.file).equals(committed));
    assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  }
});

test('REQ-MEM-015 AC7: six failed trim calls emit one shared terminal notice without replacement request spam', t => {
  const f=fixture(t),l=lifecycle(f);l.due();l.emit('agent_settled');const initial=l.launch();
  for(let attempt=0;attempt<6;attempt++){const item=l.launch();assert.equal(item.requestId,initial.requestId);assert.equal(item.reminder,attempt);l.call(item);l.done(item,'Failed');l.emit('agent_settled');}
  const notices=l.sent.filter(m=>m.customType==='background-extraction-giveup');assert.equal(notices.length,1);assert.ok(notices[0].details.items.some(i=>i.jobType==='transcript-trim'&&i.requestId===initial.requestId));assert.match(notices[0].content,/next legitimate extraction cadence/);
  const launches=l.sent.filter(m=>m.customType==='background-extraction-launch').length;l.emit('agent_settled');assert.equal(l.sent.filter(m=>m.customType==='background-extraction-giveup').length,1);assert.equal(l.sent.filter(m=>m.customType==='background-extraction-launch').length,launches);assert.ok(fs.statSync(f.file).size>50_000_000);
});
