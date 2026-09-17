/** REQ-OPERATOR-021: parent-only host service configuration and durable metadata. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createOperatorPiService, FileOperatorPiStore } from '../dist/operator-pi-service.js';

const metadata = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', conversationId: 'pi-1',
  sessionFile: '/owned/sessions/pi-1.jsonl', tasks: {} };

test('REQ-OPERATOR-021: file store atomically persists bounded private conversation metadata', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-pi-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state', 'conversation.json');
  const store = new FileOperatorPiStore(file);
  assert.equal(await store.load(), null);
  await store.save(metadata);
  assert.deepEqual(await store.load(), metadata);
  assert.equal((await stat(file)).mode & 0o077, 0);
  assert.equal((await readFile(file, 'utf8')).includes('activity-1'), true);
  await writeFile(file, 'x'.repeat(257 * 1024));
  await assert.rejects(store.load(), /metadata.*large/i);
});

test('REQ-OPERATOR-021: trusted config binds identity/root/profile and produces a ready service', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-pi-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdkSession = { sessionId: 'pi-1', sessionFile: path.join(root, 'sessions/pi-1.jsonl'), isStreaming: false,
    agent: { state: { tools: [{ name: 'read', execute: async () => ({ content: [], details: undefined }) }] } },
    prompt: async () => {}, followUp: async () => {}, steer: async () => {}, abort: async () => {},
    subscribe: () => () => {}, dispose() {} };
  const sdk = {
    ModelRuntime: { create: async () => ({ getModel: () => ({ provider: 'anthropic', id: 'approved' }) }) },
    SettingsManager: { inMemory: value => value },
    SessionManager: { create: () => ({}), open: () => ({}) },
    createExtensionRuntime: () => ({}), createAgentSession: async () => ({ session: sdkSession }),
  };
  const serializedConfig = JSON.stringify({ schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', root,
    profile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'off',
      systemPrompt: 'Approved operator context', tools: ['read'] } });
  const piAi = { validateToolArguments: (_tool, toolCall) => toolCall.arguments };
  const service = createOperatorPiService({ serializedConfig, allowedRoot: root,
    importSdk: async () => sdk, importPiAi: async () => piAi });
  assert.ok(service);
  const response = await service.handle({ method: 'POST', pathname: '/internal/operator/pi/ensure',
    body: new TextEncoder().encode('{}') });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { conversationId: 'pi-1', ready: true });
  assert.equal((await readFile(path.join(root, '.codeflare/operator-pi.json'), 'utf8')).includes('pi-1'), true);
});

test('REQ-OPERATOR-021: absent config preserves ordinary host and malformed or escaping config fails closed', () => {
  assert.equal(createOperatorPiService({ allowedRoot: '/owned' }), undefined);
  assert.throws(() => createOperatorPiService({ serializedConfig: '{', allowedRoot: '/owned' }), /configuration/i);
  assert.throws(() => createOperatorPiService({ serializedConfig: JSON.stringify({ schemaVersion: 1, activityId: 'a',
    sessionId: 's', root: '/other', profile: {} }), allowedRoot: '/owned' }), /configuration/i);
});
