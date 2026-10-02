import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createAgentSession, DefaultPackageManager, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, ThinkingSelectorComponent } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { isPersonalPiDestination } from '../../../../src/lib/personal-pi-destinations.ts';
import { authorizedRoutes, enterpriseStartup, nativeHandle } from '../../../../host/__fixtures__/enterprise-pi-startup.mjs';

// Client choices are not backend supportedLevels: provider-default routes retain
// empty backend capabilities, and the Worker remains authoritative over overrides.
const providerDefaultThinkingChoices = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

async function providerDefaultSession(t, options = {}) {
  const fixture = enterpriseStartup({ reasoning: '', ...options });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(fixture.home);
  if (options.todo) {
    const { fileURLToPath } = await import('node:url');
    const settingsPath = join(fixture.agentDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.packages = [fileURLToPath(new URL('../node_modules/@juicesharp/rpiv-todo/', import.meta.url))];
    writeFileSync(settingsPath, JSON.stringify(settings));
  }
  const settingsManager = SettingsManager.create(fixture.home, fixture.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: fixture.home, agentDir: fixture.agentDir, settingsManager,
    noExtensions: !options.todo, noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.home, agentDir: fixture.agentDir, modelRuntime,
    sessionManager, settingsManager, resourceLoader, tools: options.todo ? ['todo'] : [],
  });
  t.after(() => session.dispose());
  assert.equal(session.model.provider, 'codeflare-gateway');
  assert.equal(session.model.id, 'bedrock_opus');
  if (options.todo) await session.bindExtensions({});
  return { session, sessionManager, modelRuntime };
}

describe('REQ-ENTERPRISE-058: generated routing consumed by the pinned Pi runtime without inference', () => {
  it('REQ-OPERATOR-053: Pi loads only the selector, not the separately auto-discovered local Review extension', async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'pi-review-inventory-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const agentDir = join(home, '.pi/agent');
    const projectDir = join(home, 'workspace');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    mkdirSync(join(projectDir, '.pi'), { recursive: true });
    const local = join(agentDir, 'extensions/review-enforcement.ts');
    const remote = join(agentDir, 'extensions/operator-review-remote.ts');
    const selector = join(agentDir, 'extensions/operator-review-selector.ts');
    const source = new URL('../extensions/', import.meta.url);
    for (const name of ['review-enforcement.ts', 'operator-review-remote.ts',
      'operator-review-selector.ts', 'active-repo-memory.ts', 'review-helpers.ts',
      'review-scope.ts', 'review-completion-state.ts', 'graphify-helpers.ts',
      'capability-helpers.ts', 'guard-helpers.ts']) {
      copyFileSync(new URL(name, source), join(agentDir, 'extensions', name));
    }
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [`-${local}`, `-${remote}`] }));
    // Candidate-owned project settings cannot force either implementation back on.
    writeFileSync(join(projectDir, '.pi/settings.json'), JSON.stringify({ extensions: [`+${local}`, `+${remote}`] }));
    const settingsManager = SettingsManager.create(projectDir, agentDir);
    const packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    assert.deepEqual(resolved.extensions.filter(item => item.enabled
      && [local, remote, selector].includes(item.path)).map(item => item.path), [selector]);
    const runtime = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true });
    await runtime.reload();
    const loaded = runtime.getExtensions();
    assert.equal(loaded.errors.some(error => error.path === selector), false, JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.extensions.filter(extension =>
      [local, remote, selector].includes(extension.resolvedPath)).map(extension => extension.resolvedPath), [selector]);
  });
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

  for (const id of ['bedrock_opus', nativeHandle]) {
    for (const levels of [['medium'], ['off'], ['high', 'max']]) {
      it(`REQ-ENTERPRISE-058: ${id === nativeHandle ? 'Native' : 'Dynamic'} mapped ${levels.join('/')} offers only supported Pi choices`, async (t) => {
        const { session, sessionManager, modelRuntime } = await providerDefaultSession(t, {
          levels: { bedrock_opus: [], [nativeHandle]: [], [id]: levels },
        });
        await session.setModel(modelRuntime.getModel('codeflare-gateway', id));
        assert.deepEqual(session.getAvailableThinkingLevels(), levels);
        initTheme('dark', false);
        session.setThinkingLevel(levels[0]);
        const selector = new ThinkingSelectorComponent(
          session.thinkingLevel, session.getAvailableThinkingLevels(),
          (level) => session.setThinkingLevel(level),
          () => assert.fail('thinking selection must not cancel'),
        );
        const renderedChoices = selector.render(100)
          .map((line) => stripVTControlCharacters(line).match(/^\s*(?:→\s*)?(?:✓\s*)?(off|minimal|low|medium|high|xhigh|max)\s/)?.[1])
          .filter(Boolean);
        assert.deepEqual(renderedChoices, levels);
        for (const level of levels) {
          selector.handleInput('\r');
          assert.equal(session.thinkingLevel, level);
          assert.equal(sessionManager.buildSessionContext().thinkingLevel, level);
          assert.equal(session.model.id, id);
          selector.handleInput('\u001b[B');
        }
      });
    }
  }

  it('REQ-ENTERPRISE-058: Native provider-default offers seven choices without serializing an override', async (t) => {
    const { session, sessionManager, modelRuntime } = await providerDefaultSession(t, {
      levels: { bedrock_opus: [], [nativeHandle]: [] },
    });
    await session.setModel(modelRuntime.getModel('codeflare-gateway', nativeHandle));
    assert.deepEqual(session.getAvailableThinkingLevels(), providerDefaultThinkingChoices);
    for (const level of providerDefaultThinkingChoices) {
      session.setThinkingLevel(level);
      assert.equal(session.thinkingLevel, level);
      assert.equal(sessionManager.buildSessionContext().thinkingLevel, level);
      let sent;
      const result = await streamSimple(session.model, {
        messages: [{ role: 'user', content: 'Offline native provider-default serialization', timestamp: 1 }],
      }, {
        apiKey: 'fixture-only', reasoning: level,
        onPayload(payload) { sent = payload; throw new Error('offline serialization boundary'); },
      }).result();
      assert.ok(sent);
      assert.equal(result.stopReason, 'error');
      assert.equal(sent.model, nativeHandle);
      assert.equal(Object.hasOwn(sent, 'reasoning_effort'), false);
    }
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


it('REQ-ENTERPRISE-088 AC4: pinned Pi retains native authenticated providers alongside sanctioned models', async t => {
  const fixture = enterpriseStartup({ personalProviders: true, auth: { anthropic: { type: 'api_key', key: 'synthetic-personal-key' } } });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const runtime = await ModelRuntime.create({ modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false });
  const available = await runtime.getAvailable();
  assert.ok(available.some(model => model.provider === 'anthropic'));
  assert.deepEqual(available.filter(model => model.provider === 'codeflare-gateway').map(model => model.id).sort(), [...authorizedRoutes].sort());
  assert.ok(runtime.getProvider('anthropic').auth.apiKey);
  assert.ok(runtime.getProvider('openai-codex').auth.oauth);
  // Security allowlist contract: bundled native HTTPS model destinations must
  // reach the policy boundary after SDK/catalog upgrades too.
  for (const model of runtime.getModels()) {
    if (['codeflare-gateway', 'unrelated-provider'].includes(model.provider) || !model.baseUrl?.startsWith('https://')) continue;
    const endpoint = new URL(model.baseUrl.replace(/\{[^}]+\}/g, 'fixture'));
    assert.ok(isPersonalPiDestination(endpoint), `native ${model.provider} destination is gated: ${endpoint.hostname}`);
  }
});

it('REQ-ENTERPRISE-088 AC6: pinned native OAuth login and refresh destinations reach the policy boundary', async t => {
  const fixture = enterpriseStartup({ personalProviders: true });
  t.after(fixture.cleanup);
  const runtime = await ModelRuntime.create({ modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const id of ['kimi-coding', 'meta', 'xai']) {
    const oauth = runtime.getProvider(id)?.auth.oauth;
    assert.ok(oauth, `pinned native ${id} supports OAuth`);
    for (const action of ['login', 'refresh']) {
      const requests = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        // The genuine SDK starts device authorization, then reaches its token
        // endpoint. Synthetic rejection stops before credentials are issued.
        if (requests.length === 1 && action === 'login') return Response.json({ device_code: 'synthetic-device',
          user_code: 'synthetic-code', verification_uri: 'https://example.test/verify',
          verification_uri_complete: 'https://example.test/verify?code=synthetic', interval: 0.001, expires_in: 600 });
        return new Response('offline boundary', { status: 401 });
      };
      const signal = AbortSignal.timeout(10000);
      await assert.rejects(action === 'login' ? oauth.login({ signal, notify() {} })
        : oauth.refresh({ type: 'oauth', refresh: 'synthetic-refresh', access: 'synthetic-access', expires: 0 }, signal));
      assert.ok(requests.length >= (action === 'login' ? 2 : 1));
      for (const request of requests) assert.ok(isPersonalPiDestination(new URL(request.url)),
        `pinned ${id} ${action} traffic must reach authorization: ${new URL(request.url).hostname}`);
    }
  }
});

it('REQ-AGENT-081 AC1: actual pinned todo tasks survive independent child sessions and foreground replay', async t => {
  const { patchRpivHostPeers } = await import('../../../../scripts/patch-rpiv-host-peers.mjs');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
  const manifests = ['rpiv-advisor', 'rpiv-ask-user-question', 'rpiv-todo']
    .map(name => join(modules, '@juicesharp', name, 'package.json'));
  const originals = await Promise.all(manifests.map(async path => [path, await readFile(path)]));
  t.after(async () => { for (const [path, bytes] of originals) await writeFile(path, bytes); });
  await patchRpivHostPeers(modules);
  const foreground = await providerDefaultSession(t, { todo: true });
  const run = async ({ session, sessionManager }, params) => {
    // Execute the SDK-wrapped public tool: its context is the actual session,
    // not a fabricated session ID or a replacement task store.
    const tool = session.agent.state.tools.find(item => item.name === 'todo');
    assert.ok(tool, 'the pinned extension delivers todo to the session');
    const id = `todo-${sessionManager.getBranch().length}`;
    const result = await tool.execute(id, params);
    sessionManager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'todo',
      content: result.content, details: result.details, isError: false, timestamp: Date.now() });
    return result.details.tasks;
  };
  const retained = await run(foreground, { action: 'create', subject: 'Retain foreground work' });
  assert.equal(retained[0].subject, 'Retain foreground work');
  const child = await providerDefaultSession(t, { todo: true });
  assert.deepEqual(await run(child, { action: 'list' }), []);
  assert.equal((await run(child, { action: 'create', subject: 'Independent child work' }))[0].subject,
    'Independent child work');
  assert.deepEqual(await run(foreground, { action: 'list' }), retained);
  child.session.dispose();
  assert.deepEqual(await run(foreground, { action: 'list' }), retained);
  const replay = await providerDefaultSession(t, { todo: true, sessionManager: foreground.sessionManager });
  assert.deepEqual(await run(replay, { action: 'list' }), retained);
});

it('REQ-AGENT-210 AC6: image-prepared RPIV packages load actual pinned tools without warnings', async t => {
  const { patchRpivHostPeers } = await import('../../../../scripts/patch-rpiv-host-peers.mjs');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
  const packages = ['rpiv-advisor', 'rpiv-ask-user-question', 'rpiv-todo'].map(name => join(modules, '@juicesharp', name));
  const originals = await Promise.all(packages.map(async path => [join(path, 'package.json'), await readFile(join(path, 'package.json'))]));
  t.after(async () => { for (const [path, bytes] of originals) await writeFile(path, bytes); });
  await patchRpivHostPeers(modules);
  const home = mkdtempSync(join(tmpdir(), 'pi-rpiv-real-startup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agentDir = join(home, '.pi/agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages }));
  const loader = new DefaultResourceLoader({ cwd: home, agentDir,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings ?? [], []);
  // Delivered tool inventory is the generated runtime contract, not a mock count.
  const tools = new Set(result.extensions.flatMap(extension => [...extension.tools.keys()]));
  for (const name of ['advisor', 'ask_user_question', 'todo']) assert.ok(tools.has(name));
});
