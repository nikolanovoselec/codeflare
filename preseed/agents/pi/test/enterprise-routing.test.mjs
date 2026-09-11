import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { authorizedRoutes, enterpriseStartup, nativeHandle } from '../../../../host/__fixtures__/enterprise-pi-startup.mjs';

describe('REQ-ENTERPRISE-058: generated routing consumed by the pinned Pi runtime without inference', () => {
  for (const previousModel of [undefined, 'development', nativeHandle]) {
    it(`loads the authoritative catalog for ${previousModel ?? 'a fresh conversation'}`, async (t) => {
      const fixture = enterpriseStartup({ reasoning: '' });
      t.after(fixture.cleanup);
      assert.equal(fixture.result.status, 0, fixture.result.stderr);
      const modelRuntime = await ModelRuntime.create({
        modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
        modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
      });
      assert.deepEqual(modelRuntime.getModels('codeflare-gateway').map(({ id }) => id).sort(), [...authorizedRoutes].sort());
      const sessionManager = SessionManager.inMemory(fixture.home);
      if (previousModel) {
        sessionManager.appendModelChange('codeflare-gateway', previousModel);
        sessionManager.appendMessage({ role: 'user', content: 'Retained conversation', timestamp: 1 });
      }
      const settingsManager = SettingsManager.create(fixture.home, fixture.agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: fixture.home, agentDir: fixture.agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: fixture.home, agentDir: fixture.agentDir, modelRuntime,
        sessionManager, settingsManager, resourceLoader, tools: [],
      });
      t.after(() => session.dispose());
      assert.equal(session.model.provider, 'codeflare-gateway');
      assert.equal(session.model.id, previousModel === nativeHandle ? nativeHandle : 'bedrock_opus');
    });
  }

  it('serializes generated provider-default and native models before the network boundary', async (t) => {
    const fixture = enterpriseStartup({ reasoning: '' });
    t.after(fixture.cleanup);
    const runtime = await ModelRuntime.create({
      modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
      modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
    });
    for (const id of authorizedRoutes) {
      const model = runtime.getModel('codeflare-gateway', id);
      assert.ok(model, `generated model ${id} is available`);
      let sent;
      // The real serializer runs; the hook stops before any network/provider call.
      const result = await streamSimple(model, { messages: [{ role: 'user', content: 'Offline serialization', timestamp: 1 }] }, {
        apiKey: 'fixture-only', reasoning: 'max',
        onPayload(payload) { sent = payload; throw new Error('offline serialization boundary'); },
      }).result();
      assert.ok(sent);
      assert.equal(result.stopReason, 'error');
      assert.equal(sent.model, id);
      if (id === 'bedrock_opus') assert.equal(Object.hasOwn(sent, 'reasoning_effort'), false);
      else assert.equal(sent.reasoning_effort, 'max');
    }
  });
});
