import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, ThinkingSelectorComponent } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { authorizedRoutes, enterpriseStartup, nativeHandle } from '../../../../host/__fixtures__/enterprise-pi-startup.mjs';

// Client choices are not backend supportedLevels: provider-default routes retain
// empty backend capabilities, and the Worker remains authoritative over overrides.
const providerDefaultThinkingChoices = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

async function providerDefaultSession(t) {
  const fixture = enterpriseStartup({ reasoning: '' });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const sessionManager = SessionManager.inMemory(fixture.home);
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
  assert.equal(session.model.id, 'bedrock_opus');
  return { session, sessionManager };
}

describe('REQ-ENTERPRISE-058: generated routing consumed by the pinned Pi runtime without inference', () => {
  it('REQ-ENTERPRISE-058: provider-default Dynamic routes expose and preserve all seven Pi thinking choices', async (t) => {
    const { session, sessionManager } = await providerDefaultSession(t);
    assert.deepEqual(session.getAvailableThinkingLevels(), providerDefaultThinkingChoices);
    for (const level of providerDefaultThinkingChoices) {
      session.setThinkingLevel(level);
      assert.equal(session.thinkingLevel, level, `${level} must not be clamped to off`);
      assert.equal(sessionManager.buildSessionContext().thinkingLevel, level, `${level} survives transcript reconstruction`);
      assert.equal(session.model.id, 'bedrock_opus');
    }
  });

  it('REQ-ENTERPRISE-058: the real provider-default thinking selector renders and selects all seven choices', async (t) => {
    const { session } = await providerDefaultSession(t);
    initTheme('dark', false);
    session.setThinkingLevel('off');
    const selected = [];
    // Same session-derived inputs as InteractiveMode.showThinkingSelector; no
    // fabricated model capabilities, private selector state, or terminal process.
    const selector = new ThinkingSelectorComponent(
      session.thinkingLevel, session.getAvailableThinkingLevels(),
      (level) => {
        session.setThinkingLevel(level);
        selected.push(session.thinkingLevel);
      },
      () => assert.fail('thinking selection must not cancel'),
    );
    const renderedChoices = selector.render(100)
      .map((line) => stripVTControlCharacters(line).match(/^\s*(?:→\s*)?(?:✓\s*)?(off|minimal|low|medium|high|xhigh|max)\s/)?.[1])
      .filter(Boolean);
    assert.deepEqual(renderedChoices, providerDefaultThinkingChoices);
    for (const level of providerDefaultThinkingChoices) {
      selector.handleInput('\r');
      assert.equal(session.thinkingLevel, level);
      selector.handleInput('\u001b[B');
    }
    assert.deepEqual(selected, providerDefaultThinkingChoices);
  });

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
    for (const [id, reasoning] of [
      ...providerDefaultThinkingChoices.map((level) => ['bedrock_opus', level]), [nativeHandle, 'max'],
    ]) {
      const model = runtime.getModel('codeflare-gateway', id);
      assert.ok(model, `generated model ${id} is available`);
      let sent;
      // The real serializer runs; the hook stops before any network/provider call.
      const result = await streamSimple(model, { messages: [{ role: 'user', content: 'Offline serialization', timestamp: 1 }] }, {
        apiKey: 'fixture-only', reasoning,
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
