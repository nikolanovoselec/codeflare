/** REQ-OPERATOR-021: real-SDK composition contract without model/network calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvisionedOperatorPiFactory } from '../dist/operator-pi-sdk.js';

function fixture(options = {}) {
  const calls = { runtime: [], create: [], managers: [], stream: [], tool: [], disposed: 0 };
  const sdkSession = (kind, toolNames) => ({
    sessionId: 'pi-1', sessionFile: '/owned/sessions/pi-1.jsonl', isStreaming: false,
    agent: { state: { tools: toolNames.map(name => ({ name, execute: async (toolCallId, args, signal) => {
      calls.tool.push({ toolCallId, name, args, signal });
      return { content: [{ type: 'text', text: 'done' }], details: undefined };
    } })) } },
    prompt: async () => {}, followUp: async () => {}, steer: async () => {}, abort: async () => {},
    subscribe: () => () => {}, dispose: () => { calls.disposed += 1; },
  });
  const manager = kind => ({ kind });
  const runtime = {
    getModel: (provider, model) => provider === 'anthropic' && model === 'approved-model' ? { provider, id: model } : undefined,
    streamSimple: (model, context, options) => { calls.stream.push([model, context, options]); return 'stream'; },
  };
  const sdk = {
    ModelRuntime: { create: async options => { calls.runtime.push(options); return runtime; } },
    SettingsManager: { inMemory: options => ({ options }) },
    SessionManager: {
      create: (cwd, dir) => { calls.managers.push(['create', cwd, dir]); return manager('create'); },
      open: (file, dir) => { calls.managers.push(['open', file, dir]); return manager('open'); },
    },
    createExtensionRuntime: () => ({ approved: true }),
    createAgentSession: async options => {
      calls.create.push(options);
      return { session: sdkSession(options.sessionManager.kind, options.tools) };
    },
  };
  const approvedExtension = { path: '/trusted/extension.js' };
  const factory = createProvisionedOperatorPiFactory({
    cwd: '/owned/work', agentDir: '/owned/agent', sessionDir: '/owned/sessions',
    profile: { provider: 'anthropic', model: 'approved-model', thinkingLevel: 'medium',
      systemPrompt: 'Approved operator context', tools: ['read'], extensions: [approvedExtension],
      skills: [{ name: 'approved-skill' }], prompts: [], themes: [], agentsFiles: [] },
    importSdk: async () => sdk,
  });
  return { factory, calls, approvedExtension, importSdk: async () => sdk };
}

test('REQ-OPERATOR-021: creates with explicit offline model, settings and approved resources only', async () => {
  const f = fixture();
  const session = await f.factory.create();
  assert.equal(session.sessionId, 'pi-1');
  assert.deepEqual(f.calls.runtime, [{ authPath: '/owned/agent/auth.json', modelsPath: '/owned/agent/models.json', allowModelNetwork: false }]);
  assert.deepEqual(f.calls.managers, [['create', '/owned/work', '/owned/sessions']]);
  const options = f.calls.create[0];
  assert.deepEqual(options.tools, ['read']);
  assert.equal(options.thinkingLevel, 'medium');
  assert.equal(options.resourceLoader.getSystemPrompt(), 'Approved operator context');
  assert.deepEqual(options.resourceLoader.getExtensions().extensions, [f.approvedExtension]);
  assert.deepEqual(options.resourceLoader.getSkills().skills, [{ name: 'approved-skill' }]);
  assert.deepEqual(options.resourceLoader.getAgentsFiles().agentsFiles, []);
  assert.equal(options.sessionManager.kind, 'create');
});

test('REQ-OPERATOR-021: executes an approved active Pi tool directly and rejects unavailable tools', async () => {
  const f = fixture();
  const session = await f.factory.create();
  const signal = new AbortController().signal;
  await session.executeTool({ toolCallId: 'task-1', name: 'read', arguments: { path: '/owned/work/file.txt' }, signal });
  assert.deepEqual(f.calls.tool, [{ toolCallId: 'task-1', name: 'read',
    args: { path: '/owned/work/file.txt' }, signal }]);
  await assert.rejects(session.executeTool({ toolCallId: 'task-2', name: 'write', arguments: {}, signal }),
    /approved Pi tool.*unavailable/i);
});

test('REQ-OPERATOR-021: reopens only a canonical file inside the owned session directory', async () => {
  const f = fixture();
  await f.factory.open('/owned/sessions/pi-1.jsonl');
  assert.deepEqual(f.calls.managers, [['open', '/owned/sessions/pi-1.jsonl', '/owned/sessions']]);
  assert.equal(f.calls.create[0].sessionManager.kind, 'open');
  await assert.rejects(f.factory.open('/other/session.jsonl'), /owned session file/i);
  await assert.rejects(f.factory.open('/owned/sessions/../escape.jsonl'), /owned session file/i);
  assert.equal(f.calls.create.length, 1);
});

test('REQ-OPERATOR-021: fails closed for an unavailable approved model', async () => {
  const f = fixture();
  f.calls.runtime.length = 0;
  const bad = createProvisionedOperatorPiFactory({
    cwd: '/owned/work', agentDir: '/owned/agent', sessionDir: '/owned/sessions',
    profile: { provider: 'anthropic', model: 'missing', thinkingLevel: 'off', systemPrompt: 'x', tools: [] },
    importSdk: f.importSdk,
  });
  await assert.rejects(bad.create(), /approved model.*unavailable/i);
});
