#!/usr/bin/env node
// W1 characterization of the provisioned SDK, not a substitute for host task/run acceptance.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
const directory = await mkdtemp(path.join(tmpdir(), 'operator-pi-sdk-'));
const cwd = path.join(directory, 'work');
const agentDir = path.join(directory, 'agent');
const sessionDir = path.join(directory, 'sessions');
let session;
try {
  for (const folder of [cwd, agentDir, sessionDir, path.join(cwd, '.pi/extensions'), path.join(agentDir, 'extensions')]) {
    await mkdir(folder, { recursive: true });
  }
  for (const folder of [path.join(cwd, '.pi/extensions'), path.join(agentDir, 'extensions')]) {
    await writeFile(path.join(folder, 'candidate.ts'), 'throw new Error("Unapproved extension executed");');
  }
  await writeFile(path.join(cwd, 'AGENTS.md'), 'UNAPPROVED_CONTEXT_MARKER');
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5');
  assert.ok(model, 'Pinned SDK must supply the explicitly selected fixture model');
  const runtime = createExtensionRuntime();
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Approved operator SDK fixture context',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const options = {
    cwd, agentDir, model, modelRuntime, resourceLoader, tools: [], thinkingLevel: 'off',
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  };
  const manager = SessionManager.create(cwd, sessionDir);
  ({ session } = await createAgentSession({ ...options, sessionManager: manager }));
  assert.deepEqual(session.getActiveToolNames(), []);
  assert.match(session.agent.state.systemPrompt, /Approved operator SDK fixture context/);
  assert.ok(!session.agent.state.systemPrompt.includes('UNAPPROVED_CONTEXT_MARKER'));
  const id = session.sessionId;
  const file = session.sessionFile;
  assert.ok(file && path.dirname(file) === sessionDir);
  // Synthetic history exercises real SDK persistence without submitting inference.
  manager.appendMessage({ role: 'user', content: 'Owned history marker', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'Recorded fixture response' }],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  });
  session.dispose();
  session = undefined;
  assert.match(await readFile(file, 'utf8'), /Owned history marker/);
  ({ session } = await createAgentSession({ ...options, sessionManager: SessionManager.open(file, sessionDir) }));
  assert.equal(session.sessionId, id);
  assert.equal(session.sessionFile, file);
  assert.ok(JSON.stringify(session.messages).includes('Owned history marker'));
  assert.ok(JSON.stringify(session.messages).includes('Recorded fixture response'));
  assert.deepEqual(session.getActiveToolNames(), []);
  console.log('Operator SDK seam verified: explicit resources, no candidate extensions, exact persisted session identity/history. No inference/task-settlement claim.');
} finally {
  session?.dispose();
  await rm(directory, { recursive: true, force: true });
}
