import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createChatAuthService } from '../dist/chat-auth.js';

// TEST-ONLY proposal for the NEW Codeflare boundary (REQ-AGENT-224 AC8–10).
// No Dashboard, AgentSession, operator factory or real SDK is instantiated.
// SDK fixture persistence is an externally observable shared-primary store,
// not an assertion about SDK internals. No tests are executed in this phase.
// OAuthFlowStatus is the public Dashboard 0.11 shape; stepId/inputSecret are
// Codeflare additions for stale-answer rejection and a first-party masked field.
const scope = { cfid: 'abcdef0123456789', ownerId: 'owner-a', generation: 7,
  primary: { sessionId: 'primary-a', generation: 7 } };
const authPath = '/home/user/.pi/agent/auth.json';
const modelsPath = '/home/user/.pi/agent/models.json';
const secret = 'fixture-secret-never-return';
const abortError = () => new DOMException('Cancelled', 'AbortError');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function eventually(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await nextTurn();
  }
  assert.fail('Auth boundary did not publish the expected observable outcome');
}
async function rejected(operation, code) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    assert.ok(!String(error.message).includes(secret), 'public failure must not contain a credential');
    return true;
  });
}

function harness(t, { login, managed = false, allowPersonalAuth = !managed, failLoad = false } = {}) {
  let current = clone(scope);
  const primaryCredentials = new Map();
  const nativeStatus = new Map();
  const providers = [
    { id: 'example', name: 'Example', auth: {
      apiKey: { name: 'API key', login() {} },
      oauth: { name: 'OAuth', loginLabel: 'Sign in', isSubscription: true, login() {} },
    }, baseUrl: `https://private.invalid/${secret}`, headers: { Authorization: secret } },
    { id: 'ambient', name: 'Ambient', auth: { apiKey: { name: 'Environment', resolve() {} } } },
  ];
  let refreshFailure;
  const runtime = {
    getProviders: () => providers,
    getProvider: id => providers.find(provider => provider.id === id),
    getProviderAuthStatus(id) {
      return nativeStatus.get(id) ?? { configured: primaryCredentials.has(id),
        ...(primaryCredentials.has(id) ? { source: 'stored' } : {}), token: secret };
    },
    async listCredentials() {
      return [...primaryCredentials].map(([providerId, credential]) => ({ providerId, type: credential.type, token: secret }));
    },
    async refresh() {
      if (refreshFailure) throw refreshFailure;
      return { errors: new Map(), aborted: false };
    },
    async login(providerId, type, interaction, options) {
      const credential = login
        ? await login({ providerId, type, interaction, options })
        : { type, access: secret, refresh: secret, expires: Date.now() + 3600000 };
      // Public SDK fixture observes cancellation before its own persistence.
      // The service may not substitute its own auth.json writes or token store.
      if (interaction.signal.aborted) throw abortError();
      primaryCredentials.set(providerId, credential);
      return credential;
    },
    async logout(providerId, options) {
      if (options?.signal?.aborted) throw abortError();
      primaryCredentials.delete(providerId);
    },
    setRuntimeApiKey() { throw new Error('Runtime-only keys do not update the shared primary store'); },
    removeRuntimeApiKey() { throw new Error('Runtime-only keys are not persisted logout'); },
  };
  const sdk = { ModelRuntime: { async create(options) {
    if (failLoad) throw new Error(`SDK unavailable ${secret}`);
    // Intentional SDK-file-authority contract: paths come from trusted primary
    // composition, not private CHAT_ROOT/HOME or browser-supplied relocators.
    assert.deepEqual(options, { authPath, modelsPath, allowModelNetwork: false });
    return runtime;
  } } };
  const service = createChatAuthService({ scope: clone(scope), currentScope: () => current,
    authPath, modelsPath, policy: { mode: managed ? 'managed' : 'personal', allowPersonalAuth },
    loadSdk: async () => sdk });
  t.after(() => service.close());
  return { service, primaryCredentials, providers, nativeStatus,
    setScope(value) { current = value; }, failRefresh(error) { refreshFailure = error; } };
}

const start = service => service.start(scope, { providerId: 'example', type: 'oauth' });
const waiting = (service, id) => eventually(() => service.flow(scope, id), value => value.pending !== undefined);
const complete = (service, id) => eventually(() => service.flow(scope, id), value => value.status === 'complete');

// AC9: native status must remain truthful after logout (ambient/configured auth
// can remain); provider metadata and credentials are explicit allowlist DTOs.
describe('REQ-AGENT-224 AC9: Codeflare provider status and shared credential authority', () => {
  it('returns only permitted provider actions and native redacted status, not SDK objects', async t => {
    const h = harness(t);
    h.nativeStatus.set('ambient', { configured: true, source: 'environment', label: secret, credentials: secret });
    assert.deepEqual(await h.service.providers(scope), { credentialScope: 'primary-agent-store',
      personalAuthAllowed: true, providers: [
        { id: 'example', name: 'Example', authTypes: ['api_key', 'oauth'] },
        { id: 'ambient', name: 'Ambient', authTypes: [] },
      ] });
    assert.deepEqual(await h.service.status(scope), { credentialScope: 'primary-agent-store', providers: [
      { providerId: 'example', configured: false },
      { providerId: 'ambient', configured: true, source: 'environment' },
    ], credentials: [] });
  });

  it('persists login in the SDK-authoritative primary store, not the Dashboard transport store', async t => {
    const h = harness(t);
    const flow = await start(h.service);
    assert.equal((await complete(h.service, flow.flowId)).status, 'complete');
    assert.equal(h.primaryCredentials.get('example').access, secret);
    assert.deepEqual(await h.service.status(scope), { credentialScope: 'primary-agent-store', providers: [
      { providerId: 'example', configured: true, source: 'stored' },
      { providerId: 'ambient', configured: false },
    ], credentials: [{ providerId: 'example', type: 'oauth' }] });
    assert.ok(!JSON.stringify(await h.service.flow(scope, flow.flowId)).includes(secret));
  });

  it('updates an API key through public SDK login, keeping answers out of flow/status', async t => {
    const h = harness(t, { login: async ({ type, interaction }) => {
      assert.equal(type, 'api_key');
      const key = await interaction.prompt({ type: 'secret', message: 'API key', placeholder: 'Paste key' });
      return { type: 'api_key', key };
    } });
    const flow = await h.service.start(scope, { providerId: 'example', type: 'api_key' });
    const step = await waiting(h.service, flow.flowId);
    assert.deepEqual(step.pending, { kind: 'text', message: 'API key', placeholder: 'Paste key' });
    assert.equal(step.inputSecret, true);
    await h.service.input(scope, flow.flowId, { stepId: step.stepId, value: secret });
    await complete(h.service, flow.flowId);
    assert.deepEqual(h.primaryCredentials.get('example'), { type: 'api_key', key: secret });
    assert.ok(!JSON.stringify([await h.service.flow(scope, flow.flowId), await h.service.status(scope)]).includes(secret));
  });

  it('logout removes the shared stored credential without falsely disconnecting native ambient auth', async t => {
    const h = harness(t);
    h.primaryCredentials.set('example', { type: 'oauth', access: secret, refresh: secret });
    h.nativeStatus.set('example', { configured: true, source: 'environment', label: secret });
    await h.service.logout(scope, { providerId: 'example' });
    assert.equal(h.primaryCredentials.has('example'), false);
    const status = await h.service.status(scope);
    assert.deepEqual(status.providers[0], { providerId: 'example', configured: true, source: 'environment' });
    assert.deepEqual(status.credentials, []);
  });

  it('sanitizes SDK load and status-refresh failures instead of returning raw causes', async t => {
    const unavailable = harness(t, { failLoad: true });
    await rejected(() => unavailable.service.status(scope), 'auth_unavailable');
    const h = harness(t);
    h.failRefresh(new Error(`upstream HTTP body ${secret}`));
    await rejected(() => h.service.status(scope), 'auth_unavailable');
  });
});

// AC8: assert owned flow projection/answer/cancellation, not provider behavior.
describe('REQ-AGENT-224 AC8: scoped public AuthInteraction adapter', () => {
  it('projects auth URL + code, text, selection and device metadata using the retained public UI contract', async t => {
    const device = deferred();
    const h = harness(t, { login: async ({ interaction }) => {
      interaction.notify({ type: 'auth_url', url: 'https://login.example/authorize?state=public-state' });
      assert.equal(await interaction.prompt({ type: 'manual_code', message: 'Paste code', placeholder: 'Code' }), 'code-1');
      assert.equal(await interaction.prompt({ type: 'text', message: 'Account name' }), 'account-1');
      assert.equal(await interaction.prompt({ type: 'select', message: 'Choose account',
        options: [{ id: 'work', label: 'Work', description: 'Work account' }] }), 'work');
      interaction.notify({ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://login.example/device',
        intervalSeconds: 5, expiresInSeconds: 300 });
      await device.promise;
      return { type: 'oauth', access: secret, refresh: secret, expires: 1 };
    } });
    const initial = await start(h.service);
    let flow = await waiting(h.service, initial.flowId);
    assert.equal(flow.provider, 'example');
    assert.equal(flow.status, 'pending');
    assert.equal(flow.authUrl, 'https://login.example/authorize?state=public-state');
    assert.deepEqual(flow.pending, { kind: 'manual_code', message: 'Paste code', placeholder: 'Code' });
    await h.service.input(scope, flow.flowId, { stepId: flow.stepId, value: 'code-1' });
    flow = await eventually(() => h.service.flow(scope, flow.flowId), f => f.pending?.message === 'Account name');
    assert.deepEqual(flow.pending, { kind: 'text', message: 'Account name' });
    await h.service.input(scope, flow.flowId, { stepId: flow.stepId, value: 'account-1' });
    flow = await eventually(() => h.service.flow(scope, flow.flowId), f => f.pending?.kind === 'select');
    assert.deepEqual(flow.pending, { kind: 'select', message: 'Choose account',
      options: [{ id: 'work', label: 'Work', description: 'Work account' }] });
    await rejected(() => h.service.input(scope, flow.flowId, { stepId: flow.stepId, value: 'foreign' }), 'invalid_auth_input');
    const answeredStepId = flow.stepId;
    await h.service.input(scope, flow.flowId, { stepId: answeredStepId, value: 'work' });
    flow = await eventually(() => h.service.flow(scope, flow.flowId), f => f.pending?.kind === 'device_code');
    assert.deepEqual(flow.pending, { kind: 'device_code', userCode: 'ABCD-EFGH',
      verificationUri: 'https://login.example/device', intervalSeconds: 5, expiresInSeconds: 300 });
    assert.equal(flow.stepId, undefined, 'automatic device-code waiting exposes no answer step');
    await rejected(() => h.service.input(scope, flow.flowId, { stepId: answeredStepId, value: 'not-an-answer' }), 'auth_not_waiting');
    device.resolve();
    const terminal = await complete(h.service, flow.flowId);
    assert.equal(terminal.pending, undefined);
    assert.equal(terminal.authUrl, undefined);
  });

  it('rejects replayed step answers even when the next prompt has identical copy', async t => {
    const h = harness(t, { login: async ({ interaction }) => {
      const first = await interaction.prompt({ type: 'manual_code', message: 'Code' });
      const second = await interaction.prompt({ type: 'manual_code', message: 'Code' });
      return { type: 'api_key', key: `${first}:${second}` };
    } });
    const flow = await start(h.service);
    const first = await waiting(h.service, flow.flowId);
    await h.service.input(scope, flow.flowId, { stepId: first.stepId, value: 'one' });
    const second = await eventually(() => h.service.flow(scope, flow.flowId), f => f.stepId && f.stepId !== first.stepId);
    await rejected(() => h.service.input(scope, flow.flowId, { stepId: first.stepId, value: 'replayed' }), 'stale_auth_step');
    await h.service.input(scope, flow.flowId, { stepId: second.stepId, value: 'two' });
    await complete(h.service, flow.flowId);
    assert.equal(h.primaryCredentials.get('example').key, 'one:two');
  });

  it('per-prompt abort invalidates the old step without cancelling the whole login', async t => {
    const promptAbort = new AbortController();
    const h = harness(t, { login: async ({ interaction }) => {
      await assert.rejects(interaction.prompt({ type: 'manual_code', message: 'Old code', signal: promptAbort.signal }));
      const answer = await interaction.prompt({ type: 'text', message: 'New step' });
      return { type: 'api_key', key: answer };
    } });
    const flow = await start(h.service);
    const old = await waiting(h.service, flow.flowId);
    promptAbort.abort();
    const fresh = await eventually(() => h.service.flow(scope, flow.flowId), f => f.pending?.message === 'New step');
    await rejected(() => h.service.input(scope, flow.flowId, { stepId: old.stepId, value: 'old' }), 'stale_auth_step');
    await h.service.input(scope, flow.flowId, { stepId: fresh.stepId, value: 'new' });
    await complete(h.service, flow.flowId);
    assert.equal(h.primaryCredentials.get('example').key, 'new');
  });

  it('cancel aborts pending input, preserves existing credentials and cannot be resurrected by late callbacks', async t => {
    const late = deferred();
    let interaction;
    const h = harness(t, { login: async context => {
      interaction = context.interaction;
      await assert.rejects(interaction.prompt({ type: 'manual_code', message: 'Code' }));
      await late.promise;
      interaction.notify({ type: 'auth_url', url: 'https://late.example/' });
      return { type: 'oauth', access: 'late-token', refresh: secret, expires: 1 };
    } });
    h.primaryCredentials.set('example', { type: 'api_key', key: 'existing' });
    const flow = await start(h.service);
    const step = await waiting(h.service, flow.flowId);
    await h.service.cancel(scope, flow.flowId);
    assert.equal(interaction.signal.aborted, true);
    late.resolve();
    await nextTurn();
    const cancelled = await h.service.flow(scope, flow.flowId);
    assert.equal(cancelled.status, 'expired');
    assert.equal(cancelled.error, 'auth_cancelled');
    assert.equal(cancelled.pending, undefined);
    assert.equal(cancelled.authUrl, undefined);
    await rejected(() => h.service.input(scope, flow.flowId, { stepId: step.stepId, value: secret }), 'auth_not_waiting');
    assert.deepEqual(h.primaryCredentials.get('example'), { type: 'api_key', key: 'existing' });
  });

  it('keeps SDK synchronization errors generic even when their public credential field contains secrets', async t => {
    const h = harness(t, { login: async () => {
      throw Object.assign(new Error(`provider response ${secret}`), { credential: { access: secret }, cause: secret });
    } });
    const flow = await start(h.service);
    const failed = await eventually(() => h.service.flow(scope, flow.flowId), f => f.status === 'error');
    assert.equal(failed.error, 'auth_failed');
    assert.equal(failed.pending, undefined);
    assert.ok(!JSON.stringify(failed).includes(secret));
  });

  it('does not forward free-form provider progress/info bodies or unsafe authentication URLs', async t => {
    const hold = deferred();
    const h = harness(t, { login: async ({ interaction }) => {
      interaction.notify({ type: 'info', message: secret, links: [{ url: `https://info.example/${secret}` }] });
      interaction.notify({ type: 'progress', message: secret });
      interaction.notify({ type: 'auth_url', url: `javascript:${secret}`, instructions: secret });
      await hold.promise;
      return { type: 'oauth', access: secret };
    } });
    const flow = await start(h.service);
    await nextTurn();
    const status = await h.service.flow(scope, flow.flowId);
    assert.equal(status.authUrl, undefined);
    assert.ok(!JSON.stringify(status).includes(secret));
    await h.service.cancel(scope, flow.flowId);
    hold.resolve();
  });
});

const wrongScopes = [
  { ...scope, cfid: 'foreign-container' },
  { ...scope, ownerId: 'foreign-owner' },
  { ...scope, generation: 6 },
  { ...scope, primary: { ...scope.primary, sessionId: 'foreign-primary' } },
  { ...scope, primary: { ...scope.primary, generation: 6 } },
];
describe('REQ-AGENT-224 AC8–10: service scope/policy and narrow input boundary', () => {
  for (const wrong of wrongScopes) {
    it(`rejects all service roads for mismatched scope ${JSON.stringify(wrong)}`, async t => {
      // Failing SDK fixture makes authorization order externally observable:
      // wrong scope must be rejected, never an SDK-unavailable failure.
      const { service } = harness(t, { failLoad: true });
      for (const operation of [
        () => service.providers(wrong), () => service.status(wrong),
        () => service.start(wrong, { providerId: 'example', type: 'oauth' }),
        () => service.flow(wrong, 'unknown'),
        () => service.input(wrong, 'unknown', { stepId: 'step', value: secret }),
        () => service.cancel(wrong, 'unknown'), () => service.logout(wrong, { providerId: 'example' }),
      ]) await rejected(operation, 'stale_auth_scope');
    });
  }

  for (const body of [null, [], {}, { providerId: 'example', type: 'legacy' },
    { providerId: '', type: 'oauth' }, { providerId: 'x'.repeat(129), type: 'oauth' },
    { providerId: 'example', type: 'oauth', authPath: '/tmp/other/auth.json' },
    { providerId: 'example', type: 'oauth', HOME: '/private/chat' },
    { providerId: 'example', type: 'oauth', sessionId: 'foreign' },
    JSON.parse('{"providerId":"example","type":"oauth","__proto__":{"admin":true}}')]) {
    it(`rejects invalid/widened start body ${JSON.stringify(body)} before SDK access`, async t => {
      const { service } = harness(t, { failLoad: true });
      await rejected(() => service.start(scope, body), 'invalid_auth_request');
    });
  }

  it('rejects unknown providers and ambient-only/unsupported login methods without creating a flow', async t => {
    const { service } = harness(t);
    await rejected(() => service.start(scope, { providerId: 'unknown', type: 'oauth' }), 'auth_provider_unavailable');
    await rejected(() => service.start(scope, { providerId: 'ambient', type: 'api_key' }), 'auth_method_unavailable');
    await rejected(() => service.logout(scope, { providerId: 'unknown' }), 'auth_provider_unavailable');
  });

  it('validates answers and logout DTOs without consuming the current step', async t => {
    const h = harness(t, { login: async ({ interaction }) => ({ type: 'api_key',
      key: await interaction.prompt({ type: 'secret', message: 'Key' }) }) });
    const flow = await start(h.service);
    const step = await waiting(h.service, flow.flowId);
    for (const body of [null, {}, { stepId: step.stepId, value: 1 }, { stepId: step.stepId, value: '' },
      { stepId: step.stepId, value: 'x'.repeat(16385) },
      { stepId: step.stepId, value: secret, providerId: 'foreign' }]) {
      await rejected(() => h.service.input(scope, flow.flowId, body), 'invalid_auth_input');
    }
    for (const body of [null, {}, { providerId: '' }, { providerId: 'example', all: true }]) {
      await rejected(() => h.service.logout(scope, body), 'invalid_auth_request');
    }
    await h.service.input(scope, flow.flowId, { stepId: step.stepId, value: secret });
    await complete(h.service, flow.flowId);
    assert.equal(h.primaryCredentials.get('example').key, secret);
  });

  for (const replacement of [null, ...wrongScopes]) {
    it(`invalidates live flows when trusted binding changes to ${JSON.stringify(replacement)}`, async t => {
      let interaction;
      const h = harness(t, { login: async context => {
        interaction = context.interaction;
        const value = await interaction.prompt({ type: 'manual_code', message: 'Code' });
        return { type: 'api_key', key: value };
      } });
      const flow = await start(h.service);
      const step = await waiting(h.service, flow.flowId);
      h.setScope(replacement);
      await rejected(() => h.service.input(scope, flow.flowId, { stepId: step.stepId, value: secret }), 'stale_auth_scope');
      assert.equal(interaction.signal.aborted, true);
      h.setScope(clone(scope));
      // Returning to an old binding must not resurrect its aborted flow.
      await rejected(() => h.service.flow(scope, flow.flowId), 'stale_auth_scope');
      assert.equal(h.primaryCredentials.size, 0);
    });
  }

  it('close aborts active login and permanently refuses subsequent access', async t => {
    let interaction;
    const h = harness(t, { login: async context => {
      interaction = context.interaction;
      return { type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Key' }) };
    } });
    const flow = await start(h.service);
    await waiting(h.service, flow.flowId);
    h.service.close();
    assert.equal(interaction.signal.aborted, true);
    await rejected(() => h.service.flow(scope, flow.flowId), 'auth_closed');
    await rejected(() => start(h.service), 'auth_closed');
    assert.equal(h.primaryCredentials.size, 0);
  });

  for (const transition of ['stale', 'close']) {
    it(`rejects late callbacks after ${transition} without requiring another browser request`, async t => {
      const late = deferred();
      let interaction;
      const h = harness(t, { login: async context => {
        interaction = context.interaction;
        await late.promise;
        interaction.notify({ type: 'auth_url', url: 'https://late.example/' });
        return { type: 'oauth', access: secret };
      } });
      const flow = await start(h.service);
      await nextTurn();
      if (transition === 'close') h.service.close();
      else h.setScope({ ...scope, generation: 8 });
      late.resolve();
      await nextTurn();
      assert.equal(interaction.signal.aborted, true);
      assert.equal(h.primaryCredentials.size, 0);
      if (transition === 'stale') h.setScope(clone(scope));
      await rejected(() => h.service.flow(scope, flow.flowId),
        transition === 'close' ? 'auth_closed' : 'stale_auth_scope');
    });
  }

  it('logout cancels a live same-provider flow so late completion cannot sign the user back in', async t => {
    const late = deferred();
    let interaction;
    const h = harness(t, { login: async context => {
      interaction = context.interaction;
      await late.promise;
      return { type: 'oauth', access: secret };
    } });
    const flow = await start(h.service);
    await nextTurn();
    await h.service.logout(scope, { providerId: 'example' });
    assert.equal(interaction.signal.aborted, true);
    late.resolve();
    await nextTurn();
    assert.equal((await h.service.flow(scope, flow.flowId)).status, 'expired');
    assert.equal(h.primaryCredentials.has('example'), false);
  });

  it('does not allow competing live sign-ins for the same global provider credential', async t => {
    const h = harness(t, { login: async ({ interaction }) => ({ type: 'api_key',
      key: await interaction.prompt({ type: 'secret', message: 'Key' }) }) });
    const flow = await start(h.service);
    await waiting(h.service, flow.flowId);
    await rejected(() => start(h.service), 'auth_flow_conflict');
    await h.service.cancel(scope, flow.flowId);
    const replacement = await start(h.service);
    assert.notEqual(replacement.flowId, flow.flowId);
  });

  it('unknown flow IDs have no answer/cancel/status authority', async t => {
    const { service } = harness(t);
    for (const operation of [() => service.flow(scope, 'unknown'), () => service.cancel(scope, 'unknown'),
      () => service.input(scope, 'unknown', { stepId: 'step', value: secret })]) {
      await rejected(operation, 'auth_flow_not_found');
    }
  });

  it('managed Enterprise keeps native configured status but forbids personal mutation by default', async t => {
    const h = harness(t, { managed: true });
    h.nativeStatus.set('example', { configured: true, source: 'environment', label: secret });
    assert.deepEqual(await h.service.providers(scope), { credentialScope: 'primary-agent-store',
      personalAuthAllowed: false, providers: [
        { id: 'example', name: 'Example', authTypes: [] }, { id: 'ambient', name: 'Ambient', authTypes: [] },
      ] });
    assert.deepEqual((await h.service.status(scope)).providers[0],
      { providerId: 'example', configured: true, source: 'environment' });
    await rejected(() => start(h.service), 'personal_auth_forbidden');
    await rejected(() => h.service.logout(scope, { providerId: 'example' }), 'personal_auth_forbidden');
    assert.equal(h.primaryCredentials.size, 0);
  });

  it('only an explicit trusted policy can permit personal auth in managed mode', async t => {
    const h = harness(t, { managed: true, allowPersonalAuth: true });
    const flow = await start(h.service);
    await complete(h.service, flow.flowId);
    assert.equal(h.primaryCredentials.has('example'), true);
  });
});
