import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import registerTrimmer, { TRANSCRIPT_TRIM_DUE } from '../../preseed/agents/pi/extensions/active-session-transcript-trimming.ts';

const extensionDir = new URL('../../preseed/agents/pi/extensions/', import.meta.url);
const modules = new Map();
function fixtureModule(name) {
  if (modules.has(name)) return modules.get(name);
  let source = stripTypeScriptTypes(fs.readFileSync(new URL(`${name}.ts`, extensionDir), 'utf8'));
  source = source.replace(/from "\.\/([a-z-]+)"/g, (_match, dependency) => `from "${fixtureModule(dependency)}"`);
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  modules.set(name, url);
  return url;
}
const jsonl = entries => entries.map(entry => JSON.stringify(entry) + '\n').join('');

test('REQ-MEM-028 AC1: actual trims preserve the next twenty-prompt cadence and frozen extraction inputs', async t => {
  const { registerMemoryVault } = await import(fixtureModule('memory-vault'));
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-trim-cadence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const entries = [{ type: 'session', version: 3, id: 'fixture', cwd: '/synthetic' }];
  const append = payload => {
    const entry = { id: `e${entries.length}`, parentId: entries.length === 1 ? null : entries.at(-1).id,
      timestamp: '2026-11-03T00:00:00Z', ...payload };
    entries.push(entry);
    return entry;
  };
  for (let n = 0; n < 4; n++) append({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'thinking', thinking: 'h'.repeat(8_000_000) }, { type: 'text', text: `historical answer ${n}` }] } });
  const kept = append({ type: 'custom', customType: 'synthetic-opaque-state', data: { payload: 'p'.repeat(19_000_000) } });
  append({ type: 'compaction', firstKeptEntryId: kept.id, summary: 'Historical answers summarized', tokensBefore: 1000 });
  fs.writeFileSync(file, jsonl(entries));
  assert.ok(fs.statSync(file).size > 50_000_000);
  const ctx = { sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => file,
    getHeader: () => entries[0], getLeafId: () => entries.at(-1).id, getBranch: () => entries.slice(1) } };
  const paths = { vaultRoot: join(root, 'Vault'), cacheDir: join(root, 'cache'), memoryCounterDir: join(root, 'counters'),
    memoryPromptFile: join(root, 'memory.md'), vaultPromptFile: join(root, 'vault.md'),
    vaultManifestFile: join(root, 'Vault/graphify-out/manifest.json'), vaultInitializationFile: join(root, 'Vault/graphify-out/initialized'),
    vaultMarkerFile: join(root, 'marker') };
  fs.writeFileSync(paths.memoryPromptFile, '# capture'); fs.writeFileSync(paths.vaultPromptFile, '# vault');
  const handlers = new Map(), listeners = new Map(), due = [], messages = [];
  let promptNumber = 0;
  const pi = {
    on(name, handler) { const rows = handlers.get(name) ?? []; rows.push(handler); handlers.set(name, rows); },
    events: { on(name, handler) { listeners.set(name, handler); }, emit(name, data) {
      if (name === TRANSCRIPT_TRIM_DUE) due.push({ prompt: promptNumber, data });
      listeners.get(name)?.(data);
    } },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, sendMessage(...args) { messages.push(args); },
  };
  registerTrimmer(pi);
  registerMemoryVault(pi, { paths, now: () => Date.parse('2026-11-03T00:00:00Z'), randomUUID: () => '00000000-0000-4000-8000-000000000001' });
  const emit = (name, event = {}) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
  const snapshot = directory => fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(join(directory, name), 'utf8')]);
  emit('session_start');
  let frozenCache, frozenVars;
  const reductions = [];
  for (promptNumber = 1; promptNumber <= 40; promptNumber++) {
    // Model a later public-SDK rewrite from loaded entries, without changing them:
    // the second actual trim must also preserve the already-frozen capture request.
    if (promptNumber === 40) fs.writeFileSync(file, jsonl(entries));
    const user = append({ type: 'message', message: { role: 'user', content: `prompt ${promptNumber}` } });
    fs.appendFileSync(file, jsonl([user]));
    emit('before_agent_start', { prompt: user.message.content });
    const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `answer ${promptNumber}` }] };
    fs.appendFileSync(file, jsonl([append({ type: 'message', message: answer })]));
    const before = fs.statSync(file).size;
    emit('agent_end', { messages: [answer] });
    if (promptNumber === 20 || promptNumber === 40) {
      const after = fs.statSync(file).size;
      assert.ok(before > 50_000_000); assert.ok(after < 20_000_000);
      reductions.push({ prompt: promptNumber, before, after });
    }
    if (promptNumber === 21) {
      frozenCache = snapshot(paths.cacheDir);
      frozenVars = fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vars'), 'utf8');
    }
  }
  assert.deepEqual(due, [20, 40].map(prompt => ({ prompt, data: { sessionId: 'fixture', file } })));
  assert.equal(reductions.length, 2);
  assert.ok(frozenCache.length > 0); assert.ok(frozenVars.length > 0);
  assert.deepEqual(snapshot(paths.cacheDir), frozenCache);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vars'), 'utf8'), frozenVars);
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.vault-count'), 'utf8'), '40');
  assert.equal(fs.readFileSync(join(paths.memoryCounterDir, 'fixture.count'), 'utf8'), '1');
  const persisted = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(persisted.filter(entry => entry.message?.role === 'user').map(entry => entry.message.content),
    Array.from({ length: 40 }, (_value, n) => `prompt ${n + 1}`));
  assert.equal(persisted.find(entry => entry.id === kept.id).data.payload.length, 19_000_000);
  assert.deepEqual(messages, []);
});
