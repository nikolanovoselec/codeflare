import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPackageJSON, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import register, { TRANSCRIPT_TRIM_DUE, trimActiveSessionTranscript, parseTranscript, createTranscriptTrimRequest, commitTranscriptTrimCandidate } from '../../preseed/agents/pi/extensions/active-session-transcript-trimming.ts';

const jsonl = entries => entries.map(e => JSON.stringify(e) + '\n').join('');
function fixture(t, entries = oversized()) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-trim-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const fd = fs.openSync(file, 'w', 0o640);
  try { for (const entry of entries) fs.writeFileSync(fd, JSON.stringify(entry) + '\n'); }
  finally { fs.closeSync(fd); }
  const expected = { sessionId: 'fixture', file };
  let branch = branchOf(entries, entries.at(-1)?.id);
  const ctx = { sessionManager: {
    getSessionId: () => expected.sessionId, getSessionFile: () => expected.file,
    getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch,
    getHeader: () => entries[0],
  } };
  return { root, file, entries, expected, ctx, setBranch: id => { branch = branchOf(entries, id); } };
}
function branchOf(entries, leaf) {
  const byId = new Map(entries.slice(1).map(e => [e.id, e]));
  const branch = [];
  for (let e = byId.get(leaf); e; e = byId.get(e.parentId)) branch.push(e);
  return branch.reverse();
}
function oversized({ floor = false, child = false, raw = false, historicalBytes = 8_000_000, protectedBytes } = {}) {
  const entries = [{ type: 'session', version: 3, id: 'fixture', timestamp: '2026-11-03T00:00:00Z', cwd: '/fixture', ...(child ? { parentSession: '/not-read.jsonl' } : {}) }];
  let sequence = 0, parentId = null;
  const add = payload => {
    const e = { id: `e${++sequence}`, parentId, timestamp: '2026-11-03T00:00:00Z', ...payload };
    entries.push(e); parentId = e.id; return e;
  };
  const state = { tasks: [{ id: 1, subject: 'Deleted task', status: 'deleted', blockedBy: [2], metadata: { original: true }, description: 'd'.repeat(3000) }], nextId: 77 };
  add({ type: 'custom', customType: 'rpiv-todo-state', data: state });
  add({ type: 'message', message: { role: 'toolResult', toolName: 'todo', toolCallId: 'todo-1', content: [{ type: 'text', text: 'visible Todo result' }], details: { action: 'list', ...state } } });
  add({ type: 'custom', customType: 'rpiv-todo-state', data: { ...state, nextId: 78 } });
  const fork = parentId;
  add({ type: 'custom', customType: 'rpiv-todo-state', data: { tasks: [...state.tasks, { id: 2, subject: 'Branch task', status: 'pending' }], nextId: 79 } });
  const oldLeaf = add({ type: 'message', message: { role: 'user', content: 'side branch' } }).id;
  parentId = fork;
  add({ type: 'custom', customType: 'rpiv-todo-state', data: { ...state, nextId: 80 } });
  for (const customType of ['goal-state', 'plan-mode-state', 'subagents:record', 'unknown', 'background-extraction-launch']) {
    add({ type: 'custom', customType, data: { frozen: true, requestId: customType, content: 'untouched' } });
  }
  if (!floor) for (let i = 0; i < 4; i++) {
    if (raw) {
      add({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: `read-${i}`, name: 'read', arguments: { path: '/synthetic' } }], stopReason: 'toolUse' } });
      add({ type: 'message', message: { role: 'toolResult', toolCallId: `read-${i}`, toolName: 'read', isError: false, content: [{ type: 'text', text: 'r'.repeat(historicalBytes) }] } });
    } else add({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'h'.repeat(historicalBytes), thinkingSignature: 'old-signature' }, { type: 'text', text: `visible-${i}` }, { type: 'toolCall', id: `call-${i}`, name: 'opaque', arguments: { preserve: i } }], stopReason: 'stop', usage: { input: 50, output: 10, cost: { total: 2 } } } });
  }
  const firstKept = add({ type: 'message', message: { role: 'user', content: 'protected'.repeat(1) + 'p'.repeat(protectedBytes ?? (floor ? 51_000_000 : 19_000_000)) } });
  add({ type: 'compaction', firstKeptEntryId: firstKept.id, summary: 'summary', tokensBefore: 1000 });
  add({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'current reasoning', thinkingSignature: 'current-signature' }, { type: 'text', text: 'current response' }] } });
  // Side branch is deliberately earlier in file order, but remains a full restoration checkpoint.
  assert.ok(oldLeaf);
  return entries;
}
function lifecycle(f) {
  const handlers = new Map(), listeners = new Map(), launches = [];
  const pi = { sendMessage(message) { if (message.customType === "background-extraction-launch") launches.push(message.details.items[0]); }, on(name, handler) { const all = handlers.get(name) ?? []; all.push(handler); handlers.set(name, all); },
    events: { on(name, handler) { listeners.set(name, handler); }, emit(name, data) { listeners.get(name)?.(data); } } };
  register(pi);
  const emit = (name, data = {}, ctx = f.ctx) => { for (const handler of handlers.get(name) ?? []) handler(data, ctx); };
  const due = data => pi.events.emit(TRANSCRIPT_TRIM_DUE, data ?? { ...f.expected });
  const end = () => {
    emit('agent_settled');
    const item = launches.pop();
    if (!item) return;
    const req = JSON.parse(fs.readFileSync(item.request.prompt.match(/^VARS_FILE=(.+)$/m)[1]));
    const rows = JSON.parse('[' + fs.readFileSync(f.file, 'utf8').trimEnd().split('\n').join(',') + ']');
    const cut = rows.findIndex(e => e.id === rows.find(e => e.type === 'compaction')?.firstKeptEntryId);
    for (const row of rows.slice(1, cut)) if (row.message?.role === 'assistant') row.message.content = row.message.content.map(b => b.type === 'thinking' ? { type: 'thinking', thinking: 'Historical reasoning summarized.' } : b);
    const candidate = jsonl(rows);
    if (!candidate) return;
    fs.writeFileSync(req.candidateFile, candidate);
    fs.appendFileSync(f.file, jsonl([
      { type: 'custom_message', id: `launch-${item.requestId}`, parentId: f.entries.at(-1).id, customType: 'background-extraction-launch', details: { items: [item] } },
      { type: 'message', id: `call-${item.requestId}`, parentId: `launch-${item.requestId}`, message: { role: 'assistant', content: [{ type: 'toolCall', id: item.requestId, name: 'subagent', arguments: item.request }] } },
      { type: 'custom_message', id: `done-${item.requestId}`, parentId: `call-${item.requestId}`, customType: 'subagent-notification', content: `<tool-use-id>${item.requestId}</tool-use-id><status>Done</status>` },
    ]));
    emit('agent_settled');
  };
  return { pi, emit, due, end };
}
const reopen = f => parseTranscript(fs.readFileSync(f.file, 'utf8'), 'fixture');
const replay = branch => {
  let state, legacy;
  for (const e of branch) {
    if (e.type === 'custom' && e.customType === 'rpiv-todo-state') state = e.data;
    if (e.message?.role === 'toolResult' && e.message.toolName === 'todo' && e.message.details) legacy = e.message.details;
  }
  const d = state ?? legacy;
  return d ? { tasks: d.tasks, nextId: d.nextId } : { tasks: [], nextId: 1 };
};

// The existing cadence module uses extensionless TS imports. As in pi-lockstep's fixture,
// use Node's public type stripper, not an installed SDK/compiler or a live Pi process.
const extensionDir = new URL('../../preseed/agents/pi/extensions/', import.meta.url);
const fixtureModules = new Map();
function fixtureModule(name) {
  if (fixtureModules.has(name)) return fixtureModules.get(name);
  let source = stripTypeScriptTypes(fs.readFileSync(new URL(name + '.ts', extensionDir), 'utf8'));
  source = source.replace(/from "\.\/([a-z-]+)"/g, (_match, dependency) => `from "${fixtureModule(dependency)}"`);
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  fixtureModules.set(name, url);
  return url;
}

test('REQ-MEM-028 AC1: existing cadence schedules trimming without changing capture behavior', async t => {
  const { registerMemoryVault } = await import(fixtureModule('memory-vault'));
  const f = fixture(t, [{ type: 'session', id: 'fixture' }]);
  const paths = { vaultRoot: join(f.root, 'Vault'), cacheDir: join(f.root, 'cache'), memoryCounterDir: join(f.root, 'counters'),
    memoryPromptFile: join(f.root, 'memory.md'), vaultPromptFile: join(f.root, 'vault.md'),
    vaultManifestFile: join(f.root, 'Vault/graphify-out/manifest.json'), vaultInitializationFile: join(f.root, 'Vault/graphify-out/initialized'), vaultMarkerFile: join(f.root, 'marker') };
  fs.writeFileSync(paths.memoryPromptFile, '# capture'); fs.writeFileSync(paths.vaultPromptFile, '# vault');
  const handlers = new Map(), signals = [], sent = [];
  const pi = { on(name, handler) { handlers.set(name, handler); }, events: { emit(name, data) { signals.push({ name, data }); } },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, sendMessage(...args) { sent.push(args); } };
  registerMemoryVault(pi, { paths, now: () => Date.parse('2026-11-03T00:00:00Z'), randomUUID: () => '00000000-0000-4000-8000-000000000001' });
  handlers.get('session_start')({}, f.ctx);
  const appendPrompt = n => fs.appendFileSync(f.file, jsonl([{ type: 'message', id: `u${n}`, parentId: null, message: { role: 'user', content: `prompt ${n}` } }]));
  for (let n = 1; n <= 20; n++) { appendPrompt(n); handlers.get('before_agent_start')({ prompt: `prompt ${n}` }, f.ctx); }
  assert.deepEqual(signals, [{ name: TRANSCRIPT_TRIM_DUE, data: f.expected }]);
  appendPrompt(21); handlers.get('before_agent_start')({ prompt: 'prompt 21' }, f.ctx);
  const frozen = fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vars'), 'utf8');
  const filesBefore = fs.readdirSync(paths.memoryCounterDir).sort();
  const frozenCache = fs.readdirSync(paths.cacheDir).map(name => [name, fs.readFileSync(join(paths.cacheDir, name), 'utf8')]);
  for (let n = 22; n <= 40; n++) { appendPrompt(n); handlers.get('before_agent_start')({ prompt: `prompt ${n}` }, f.ctx); }
  assert.equal(signals.length, 2);
  assert.deepEqual(signals[1], signals[0]);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vars'), 'utf8'), frozen);
  assert.deepEqual(fs.readdirSync(paths.memoryCounterDir).sort(), filesBefore);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vault-count'), 'utf8'), '40');
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.count'), 'utf8'), '1');
  assert.deepEqual(fs.readdirSync(paths.cacheDir).map(name => [name, fs.readFileSync(join(paths.cacheDir, name), 'utf8')]), frozenCache);
  assert.equal(sent.length, 0); // Scheduling never launches extraction or a model turn.
});

test('REQ-MEM-028 AC2: lifecycle cancellation protects foreign and child transcripts', t => {
  const f = fixture(t);
  const l = lifecycle(f); l.emit('session_start');
  const original = fs.readFileSync(f.file);
  for (const event of ['session_before_switch', 'session_before_fork', 'session_shutdown', 'session_start']) {
    l.emit('session_start'); l.due(); l.emit(event); l.end(); assert.deepEqual(fs.readFileSync(f.file), original);
  }
  l.emit('session_start'); l.due({ ...f.expected, sessionId: 'foreign' }); l.end();
  assert.deepEqual(fs.readFileSync(f.file), original);
  l.due(); const otherCtx = { sessionManager: { ...f.ctx.sessionManager, getSessionFile: () => join(f.root, 'foreign.jsonl') } };
  l.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] }, otherCtx);
  assert.deepEqual(fs.readFileSync(f.file), original);
  for (const stopReason of ['aborted', 'error']) { l.due(); l.emit('agent_end', { messages: [{ role: 'assistant', stopReason }] }); }
  assert.deepEqual(fs.readFileSync(f.file), original);
  const child = fixture(t, oversized({ child: true }));
  const childBytes = fs.readFileSync(child.file); assert.equal(trimActiveSessionTranscript(child.ctx, child.expected).status, 'refused');
  assert.deepEqual(fs.readFileSync(child.file), childBytes);
});

test('REQ-MEM-028 AC3: size policy preserves small files and protected-state floors', t => {
  const small = fixture(t, [{ type: 'session', id: 'fixture' }]);
  const smallBytes = fs.readFileSync(small.file);
  assert.equal(trimActiveSessionTranscript(small.ctx, small.expected).status, 'unchanged');
  assert.deepEqual(fs.readFileSync(small.file), smallBytes);
  for (const exactBoundary of [false, true]) {
    const entries = oversized({ historicalBytes: exactBoundary ? 7_500_000 : 7_000_000 });
    if (exactBoundary) {
      const bytes = entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
      entries.find(e => e.message?.role === 'assistant').message.content[0].thinking += 'h'.repeat(50_000_000 - bytes);
    }
    const belowTrigger = fixture(t, entries), bytes = fs.readFileSync(belowTrigger.file);
    if (exactBoundary) assert.equal(bytes.length, 50_000_000);
    else assert.ok(bytes.length > 40_000_000 && bytes.length < 50_000_000);
    assert.deepEqual(trimActiveSessionTranscript(belowTrigger.ctx, belowTrigger.expected), { status: 'unchanged', before: bytes.length, after: bytes.length });
    assert.deepEqual(fs.readFileSync(belowTrigger.file), bytes);
    assert.deepEqual(fs.readdirSync(belowTrigger.root), ['session.jsonl']);
  }
  const floor = fixture(t, oversized({ floor: true })), floorBytes = fs.readFileSync(floor.file);
  assert.equal(trimActiveSessionTranscript(floor.ctx, floor.expected).reason, 'protected-state-floor');
  assert.deepEqual(fs.readFileSync(floor.file), floorBytes);
  for (const raw of [false, true]) {
    const f = fixture(t, oversized({ raw }));
    const result = trimActiveSessionTranscript(f.ctx, f.expected);
    assert.equal(result.status, 'trimmed');
    assert.ok(result.before > 50_000_000); assert.ok(result.after < 20_000_000 && result.after > 18_000_000);
    assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  }
  const protectedFloor = fixture(t, oversized({ historicalBytes: 6_000_000, protectedBytes: 30_000_000 }));
  const floorResult = trimActiveSessionTranscript(protectedFloor.ctx, protectedFloor.expected);
  assert.equal(floorResult.status, 'trimmed');
  assert.ok(floorResult.before > 50_000_000 && floorResult.after > 30_000_000 && floorResult.after < 31_000_000);
  const restored = reopen(protectedFloor);
  assert.equal(restored.find(e => e.message?.role === 'user' && typeof e.message.content === 'string' && e.message.content.startsWith('protected')).message.content,
    protectedFloor.entries.find(e => e.message?.role === 'user' && typeof e.message.content === 'string' && e.message.content.startsWith('protected')).message.content);
  assert.deepEqual(fs.readdirSync(protectedFloor.root), ['session.jsonl']);
});

test('REQ-MEM-028 AC4: retained conversation and branch state reopen unchanged', t => {
  const unicode = 'Literal replacement \ufffd; 日本語; 🧭; combining e\u0301; interior BOM \ufeff';
  const entries = oversized();
  entries.find(e => e.message?.role === 'assistant').message.content.find(b => b.type === 'text').text = unicode;
  entries.at(-1).message.content.push({ type: 'text', text: unicode });
  entries.find(e => e.customType === 'unknown').data.content = unicode;
  const f = fixture(t, entries), before = f.entries;
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'trimmed');
  const after = reopen(f);
  assert.equal(after.find(e => e.message?.role === 'assistant').message.content.find(b => b.type === 'text').text, unicode);
  assert.equal(after.at(-1).message.content.at(-1).text, unicode);
  assert.equal(after.find(e => e.customType === 'unknown').data.content, unicode);
  assert.deepEqual(after.map(e => [e.id, e.parentId, e.timestamp]), before.map(e => [e.id, e.parentId, e.timestamp]));
  assert.deepEqual(after[0], before[0]);
  const cut = before.findIndex(e => e.id === before.find(e => e.type === 'compaction').firstKeptEntryId);
  for (let i = 1; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (i >= cut && a.type === 'message') assert.deepEqual(b.message.content, a.message.content);
    if (a.type === 'custom' && a.customType !== 'rpiv-todo-state') assert.deepEqual(b, a);
    if (a.message?.role === 'assistant') {
      assert.deepEqual(b.message.content.filter(x => x.type !== 'thinking'), a.message.content.filter(x => x.type !== 'thinking'));
      assert.deepEqual(b.message.usage, a.message.usage);
      const thinking = b.message.content.find(x => x.type === 'thinking');
      if (thinking && i < cut && thinking.thinking !== a.message.content[0].thinking) assert.equal(thinking.thinkingSignature, undefined);
    }
    if (a.message?.role === 'toolResult') assert.deepEqual(b.message.content, a.message.content);
    const children = before.filter(e => e.parentId === a.id);
    if (children.length !== 1 || a.type === 'compaction' || i === cut) assert.deepEqual(replay(branchOf(after, a.id)), replay(branchOf(before, a.id)));
  }
  assert.ok(after.some(e => e.customType === 'codeflare.transcript-trimmed'));
  assert.equal(after.find(e => e.message?.toolName === 'todo').message.details, undefined);
  const withoutCompaction = oversized();
  const removed = withoutCompaction.find(e => e.type === 'compaction');
  withoutCompaction.find(e => e.parentId === removed.id).parentId = removed.parentId;
  const noBoundary = fixture(t, withoutCompaction.filter(e => e !== removed));
  const original = fs.readFileSync(noBoundary.file);
  assert.equal(trimActiveSessionTranscript(noBoundary.ctx, noBoundary.expected).status, 'unchanged');
  assert.deepEqual(fs.readFileSync(noBoundary.file), original);
});

test('REQ-MEM-028 AC4: uncompacted branches retain reasoning and raw tool payloads', t => {
  const entries = oversized();
  function insertHistory(afterId, label) {
    const stamp = '2026-11-03T00:00:00Z';
    const rows = [];
    let parentId = afterId;
    const add = (suffix, message) => {
      const row = { type: 'message', id: `${label}-${suffix}`, parentId, timestamp: stamp, message };
      rows.push(row); parentId = row.id;
    };
    add('thinking', { role: 'assistant', stopReason: 'stop', content: [
      { type: 'thinking', thinking: `${label} reasoning ` + 'r'.repeat(1_000_000), thinkingSignature: `${label}-signature` },
      { type: 'text', text: `${label} answer` },
    ] });
    for (const name of ['read', 'bash']) {
      add(`${name}-call`, { role: 'assistant', stopReason: 'toolUse', content: [
        { type: 'toolCall', id: `${label}-${name}`, name, arguments: { fixture: label } },
      ] });
      add(`${name}-result`, { role: 'toolResult', toolCallId: `${label}-${name}`, toolName: name,
        isError: false, content: [{ type: 'text', text: `${label} ${name} ` + 'o'.repeat(1_000_000) }] });
    }
    for (const row of entries) if (row.parentId === afterId) row.parentId = parentId;
    entries.splice(entries.findIndex(e => e.id === afterId) + 1, 0, ...rows);
    return rows;
  }
  const shared = insertHistory(entries[1].id, 'shared');
  const side = entries.find(e => e.message?.content === 'side branch');
  const sibling = insertHistory(side.id, 'sibling');
  const activeThinking = entries.find(e => e.message?.role === 'assistant'
    && e.message.content.some(b => b.type === 'thinking') && !e.id.startsWith('shared-') && !e.id.startsWith('sibling-'));
  const f = fixture(t, entries);
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'trimmed');
  const after = reopen(f);
  const digest = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
  for (const expected of [...shared, ...sibling]) {
    assert.equal(digest(after.find(e => e.id === expected.id)), digest(expected), `preserved payload ${expected.id}`);
  }
  for (const leaf of [f.ctx.sessionManager.getLeafId(), sibling.at(-1).id]) {
    assert.deepEqual(replay(branchOf(after, leaf)), replay(branchOf(entries, leaf)));
  }
  assert.notEqual(after.find(e => e.id === activeThinking.id).message.content[0].thinking,
    activeThinking.message.content[0].thinking, 'active-only summarized payload remains eligible');
  assert.ok(fs.statSync(f.file).size < 50_000_000);
});

test('REQ-MEM-028 AC4: deeply repeated forks preserve uncompacted branch payloads', t => {
  const entries = oversized();
  const compaction = entries.find(e => e.type === 'compaction');
  const keptAt = entries.findIndex(e => e.id === compaction.firstKeptEntryId);
  let parentId = entries[keptAt].parentId;
  const forks = [], samples = [];
  for (let n = 0; n < 20_000; n++) {
    const spine = { type: 'message', id: `spine-${n}`, parentId, message: { role: 'user', content: `continuing ${n}` } };
    const sibling = { type: 'message', id: `sibling-${n}`, parentId: spine.id, message: { role: 'user', content: `branch ${n}` } };
    forks.push(spine, sibling); parentId = spine.id;
    if ([0, 10_000, 19_999].includes(n)) samples.push(sibling.id);
  }
  entries[keptAt].parentId = parentId;
  entries.splice(keptAt, 0, ...forks);
  const f = fixture(t, entries), before = fs.readFileSync(f.file);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const started = performance.now();
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'unchanged');
  t.diagnostic(`repeated-fork retention: ${Math.round(performance.now() - started)}ms`);
  const after = fs.readFileSync(f.file);
  assert.equal(digest(after), digest(before));
  const reopened = reopen(f);
  for (const leaf of samples) assert.deepEqual(replay(branchOf(reopened, leaf)), replay(branchOf(entries, leaf)));
});

test('REQ-MEM-028 AC5: ordinary appends survive replacement without reload', t => {
  const f = fixture(t);
  const appended = [];
  function append(type, index) {
    const e = { type, id: `append-${index}`, parentId: f.entries.at(-1).id, timestamp: '2026-11-03T01:00:00Z',
      ...(type === 'message' ? { message: { role: index % 2 ? 'toolResult' : 'user', toolCallId: `tool-${index}`, content: [{ type: 'text', text: `append ${index}` }] } }
        : { customType: 'subagent-notification', content: 'terminal notification', display: true }) };
    fs.appendFileSync(f.file, jsonl([e])); f.entries.push(e); f.setBranch(e.id); appended.push(e);
  }
  append('message', 0); append('message', 1); append('custom_message', 2);
  const cache = JSON.stringify(f.ctx.sessionManager.getBranch());
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'trimmed');
  assert.equal(JSON.stringify(f.ctx.sessionManager.getBranch()), cache);
  append('message', 3); append('custom_message', 4);
  const disk = reopen(f);
  for (const e of appended) assert.deepEqual(disk.filter(x => x.id === e.id), [e]);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-029 AC1: invalid inputs and failed replacement leave originals intact', t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  for (const mutate of [
    s => s.slice(0, -1), s => s + '{partial\n', s => s.replace('"id":"e2"', '"id":"e1"'),
    s => s.replace('"parentId":"e1"', '"parentId":"missing"'), s => s.replace('"id":"fixture"', '"id":"foreign"'),
    ...[2, 4, '3', null].map(version => s => s.replace('"version":3', `"version":${JSON.stringify(version)}`)),
    s => s.replace('"version":3,', ''),
  ]) {
    const malformed = mutate(original.toString()); fs.writeFileSync(f.file, malformed);
    assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'refused');
    assert.equal(fs.readFileSync(f.file, 'utf8'), malformed);
    assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  }
  const invalidBytes = Buffer.from(original);
  invalidBytes[original.indexOf(Buffer.from('visible-0'))] = 0xff;
  fs.writeFileSync(f.file, invalidBytes);
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'refused');
  assert.deepEqual(fs.readFileSync(f.file), invalidBytes);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  fs.writeFileSync(f.file, original);
  for (const operation of ['writeFileSync', 'renameSync', 'fsyncSync', 'fchownSync']) {
    const io = { ...fs, [operation]() { throw new Error('fixture filesystem failure'); } };
    assert.equal(trimActiveSessionTranscript(f.ctx, f.expected, io).status, 'refused');
    assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  }
  const target = join(f.root, 'target'); fs.renameSync(f.file, target); fs.symlinkSync(target, f.file);
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'refused');
  assert.deepEqual(fs.readFileSync(target), original); fs.unlinkSync(f.file); fs.renameSync(target, f.file);
  const alias = join(f.root, 'alias'); fs.symlinkSync(f.root, alias);
  const aliasExpected = { ...f.expected, file: join(alias, 'session.jsonl') };
  const aliasCtx = { sessionManager: { ...f.ctx.sessionManager, getSessionFile: () => aliasExpected.file } };
  assert.equal(trimActiveSessionTranscript(aliasCtx, aliasExpected).status, 'refused'); fs.unlinkSync(alias);
  let loadedPath = f.file;
  const changedContext = { sessionManager: { ...f.ctx.sessionManager, getSessionFile: () => loadedPath } };
  const changedIo = { ...fs, fsyncSync(fd) { fs.fsyncSync(fd); loadedPath = join(f.root, 'foreign.jsonl'); } };
  assert.equal(trimActiveSessionTranscript(changedContext, f.expected, changedIo).status, 'refused');
  assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  const replacementIo = { ...fs, writeFileSync(fd, content, encoding) {
    fs.writeFileSync(fd, content, encoding);
    const external = join(f.root, 'external.tmp'); fs.writeFileSync(external, original); fs.renameSync(external, f.file);
  } };
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected, replacementIo).status, 'refused');
  assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  const hardlink = join(f.root, 'hardlink'); fs.linkSync(f.file, hardlink);
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'refused'); fs.unlinkSync(hardlink);
  const foreignOwnerIo = { ...fs, lstatSync(file) { const stat = fs.lstatSync(file); if (file === f.file) stat.uid += 1; return stat; } };
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected, foreignOwnerIo).status, 'refused');
  assert.deepEqual(fs.readFileSync(f.file), original);
  const priorMode = fs.statSync(f.file).mode & 0o777;
  assert.equal(trimActiveSessionTranscript(f.ctx, f.expected).status, 'trimmed'); assert.equal(fs.statSync(f.file).mode & 0o777, priorMode);
  const directory = fixture(t, []); fs.unlinkSync(directory.file); fs.mkdirSync(directory.file);
  assert.equal(trimActiveSessionTranscript(directory.ctx, directory.expected).status, 'refused');
});

test('REQ-MEM-029 AC2: directory sync failure retains the committed replacement', t => {
  const f = fixture(t);
  const io = { ...fs, fsyncSync(fd) {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture directory sync failure');
    return fs.fsyncSync(fd);
  } };
  const result = trimActiveSessionTranscript(f.ctx, f.expected, io);
  assert.equal(result.status, 'trimmed');
  assert.equal(result.reason, 'directory-sync-failed');
  const disk = reopen(f);
  assert.deepEqual(disk.at(-1), f.entries.at(-1));
  assert.ok(fs.statSync(f.file).size > 18_000_000 && fs.statSync(f.file).size < 20_000_000);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

test('REQ-MEM-029 AC3: registration defers filesystem work and creates no retained backup', t => {
  const f = fixture(t), original = fs.readFileSync(f.file);
  const l = lifecycle(f);
  l.due(); assert.deepEqual(fs.readFileSync(f.file), original);
  l.emit('session_start'); l.due(); assert.deepEqual(fs.readFileSync(f.file), original);
  l.end(); assert.ok(fs.statSync(f.file).size < 50_000_000);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
  const after = fs.readFileSync(f.file); l.end(); assert.deepEqual(fs.readFileSync(f.file), after);
});

test('REQ-MEM-028 AC6: a later rewrite is handled at a later cadence', t => {
  const f = fixture(t), original = fs.readFileSync(f.file), l = lifecycle(f);
  l.emit('session_start'); l.due(); l.end(); assert.ok(fs.statSync(f.file).size < 50_000_000);
  fs.writeFileSync(f.file, original); l.end(); assert.deepEqual(fs.readFileSync(f.file), original);
  l.due(); l.end(); assert.ok(fs.statSync(f.file).size < 50_000_000);
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});

// GitHub host CI already provisions the pinned preseed SDK (host-pi-inference). Never
// resolve a global SDK or install one here. The local safe wrapper also sets CI=1,
// so require the managed GitHub marker; local checks exercise synthetic appends only.
test('REQ-MEM-028 AC5: provisioned public SDK appends and disk reopen survive same-path trimming', { skip: process.env.GITHUB_ACTIONS !== 'true' }, async t => {
  const manifestPath = findPackageJSON('@earendil-works/pi-coding-agent', new URL('../../preseed/agents/pi/package.json', import.meta.url));
  assert.ok(manifestPath, 'CI must provision the existing pinned preseed SDK');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.exports?.['.']?.import;
  assert.ok(typeof entry === 'string' && entry.startsWith('./'), 'public SDK import contract');
  const { SessionManager } = await import(new URL(entry, pathToFileURL(manifestPath)));
  const f = fixture(t);
  const manager = SessionManager.open(f.file, f.root, f.root);
  const ctx = { sessionManager: manager };
  const appended = [];
  const append = suffix => {
    const user = manager.appendMessage({ role: 'user', content: `sdk user ${suffix}`, timestamp: Date.now() });
    const assistant = manager.appendMessage({ role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'fixture',
      content: [{ type: 'toolCall', id: `sdk-call-${suffix}`, name: 'read', arguments: { path: '/synthetic-only' } }],
      stopReason: 'toolUse', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const result = manager.appendMessage({ role: 'toolResult', toolCallId: `sdk-call-${suffix}`, toolName: 'read',
      content: [{ type: 'text', text: `sdk result ${suffix}` }], isError: false, timestamp: Date.now() });
    const notification = manager.appendCustomMessageEntry('subagent-notification', `sdk terminal ${suffix}`, true);
    // The on-disk JSON contract omits undefined optional fields from public entries.
    for (const id of [user, assistant, result, notification]) appended.push(JSON.parse(JSON.stringify(manager.getEntry(id))));
  };
  append('before');
  const cacheBefore = JSON.stringify(manager.getBranch());
  const request = createTranscriptTrimRequest(ctx);
  assert.ok(request);
  const rows = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const candidate = rows.map(e => e.message?.role === 'assistant' ? { ...e, message: { ...e.message,
    content: e.message.content.map(block => block.type === 'thinking' && block.thinking.length > 1_000_000
      ? { type: 'thinking', thinking: 'Historical analysis condensed; visible conclusions retained.' } : block),
  } } : e);
  fs.writeFileSync(request.candidateFile, jsonl(candidate));
  assert.equal(commitTranscriptTrimCandidate(ctx, request).status, 'trimmed');
  assert.ok(fs.statSync(f.file).size <= 20_000_000);
  assert.equal(JSON.stringify(manager.getBranch()), cacheBefore);
  append('after');
  assert.equal(manager.getSessionFile(), f.file);
  const disk = reopen(f);
  for (const e of appended) assert.deepEqual(disk.filter(row => row.id === e.id), [e]);
  // A separate disk reader is not a live-session switch/reload.
  const reopened = SessionManager.open(f.file, f.root, f.root);
  for (const e of appended) assert.deepEqual(reopened.getEntry(e.id), e);
  assert.deepEqual(replay(reopened.getBranch()), replay(manager.getBranch()));
  assert.deepEqual(fs.readdirSync(f.root), ['session.jsonl']);
});
