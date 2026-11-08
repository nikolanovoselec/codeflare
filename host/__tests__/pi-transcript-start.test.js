import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {importPiExtension} from './fixtures/pi-extension-module.mjs';
const {registerMemoryVault}=await importPiExtension('memory-vault');
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

// The explicit standalone start operation was intentionally retired. A small
// parent transcript now reaches the shared cadence without scheduling trim work.
test('REQ-MEM-030 AC1: shared cadence skips small transcripts while memory delivery remains available', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'trim-small-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl'), rows = [{ type: 'session', version: 3, id: 'parent' }];
  fs.writeFileSync(file, jsonl(rows));
  const ctx = { sessionManager: { getSessionId: () => 'parent', getSessionFile: () => file,
    getHeader: () => rows[0], getLeafId: () => rows.at(-1).id, getBranch: () => rows.slice(1) } };
  const paths = { vaultRoot: join(root, 'Vault'), cacheDir: join(root, 'cache'), memoryCounterDir: join(root, 'counters'),
    memoryPromptFile: join(root, 'memory.md'), vaultPromptFile: join(root, 'vault.md'),
    vaultManifestFile: join(root, 'Vault/graphify-out/manifest.json'), vaultInitializationFile: join(root, 'Vault/graphify-out/initialized'), vaultMarkerFile: join(root, 'marker') };
  fs.writeFileSync(paths.memoryPromptFile, 'Memory capture'); fs.writeFileSync(paths.vaultPromptFile, 'Vault capture');
  const handlers = new Map(), tools = new Map(), messages = [];
  registerMemoryVault({ on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools: () => [{ name: 'subagent' }], getActiveTools: () => [], setActiveTools() {}, sendMessage(message) { messages.push(message); } },
  { paths, now: () => Date.now(), randomUUID: () => '00000000-0000-4000-8000-000000000001' });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  emit('session_start');
  for (let n = 1; n <= 21; n++) {
    const row = { type: 'message', id: `user-${n}`, parentId: n === 1 ? null : rows.at(-1).id, message: { role: 'user', content: `User ${n}` } };
    rows.push(row); fs.appendFileSync(file, jsonl([row])); emit('before_agent_start', { prompt: row.message.content });
  }
  const before = fs.readFileSync(file);
  emit('turn_end', { message: { role: 'assistant', stopReason: 'stop', content: [] } }); emit('agent_settled');
  const launches = messages.filter(message => message.customType === 'background-extraction-launch');
  assert.equal(launches.length, 1); assert.deepEqual(launches[0].details.items.map(item => item.jobType), ['memory-capture']);
  assert.ok(fs.readFileSync(file).equals(before)); assert.equal(fs.readdirSync(root).some(name => name.startsWith('.transcript-trim-')), false);
  const foreign = { sessionManager: { ...ctx.sessionManager, getSessionId: () => 'foreign' } };
  const child = { sessionManager: { getHeader: () => ({ parentSession: file }), getBranch: () => [] } };
  for (const context of [ctx, foreign, child]) {
    await assert.rejects(tools.get('transcript_trim').execute('trim', { operation: 'trim' }, undefined, undefined, context), /missing-maintenance-launch-scope/);
  }
  assert.ok(fs.readFileSync(file).equals(before));
});
