/** Normal-host inference contract: real public SDK services and nonpersistent context.
 * CI supplies the selected public SDK; the real router executes configured
 * providers without a second prompt loop, SDK replacement or persistent history.
 * REQ-OPERATOR-007 selection; 003 owner authority; 047/048 protected effects.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownerInference } from '../dist/operator-inference.js';

import { SDK_ROOT, AI_ENTRY, TOKEN, PRIVATE, transcript, digest, listen, post, router,
  fixture, profileRequest, admit, modelRequest, call, successful, refused, privateResponse,
  productionFixture, observeSdkStartup } from './fixtures/operator-inference-harness.mjs';
const previousToken = process.env.CONTAINER_AUTH_TOKEN;
before(() => { process.env.CONTAINER_AUTH_TOKEN = TOKEN; });
after(() => {
  if (previousToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
  else process.env.CONTAINER_AUTH_TOKEN = previousToken;
});

test('REQ-OPERATOR-007: AC4/5 profile discovers saved asynchronous custom selection using public SDK services without model spend', async t => {
  const f = await fixture(t);
  const response = await admit(f);
  // Public SDK oracle, not a mocked runtime or a new AgentSession/history.
  const { createAgentSessionServices } = await import(pathToFileURL(path.join(SDK_ROOT, 'dist/index.js')).href);
  const services = await createAgentSessionServices({ cwd: f.cwd, agentDir: f.agentDir });
  const provider = services.settingsManager.getDefaultProvider();
  const modelId = services.settingsManager.getDefaultModel();
  const model = services.modelRuntime.getModel(provider, modelId);
  assert.deepEqual(response.body, { provider, model: modelId, api: model.api,
    reasoningLevel: services.settingsManager.getModelThinkingLevel(provider, modelId),
    profileDigest: response.body.profileDigest });
  assert.deepEqual(f.sends, []);
  assert.equal(response.headers['cache-control'], 'no-store');
  privateResponse(f, response);
});

test('REQ-OPERATOR-007: AC2/3 discovered native provider receives exact transcript metadata reasoning and SDK stream results', async t => {
  const f = await fixture(t); await admit(f); f.toolCall = true;
  const input = modelRequest(f);
  const response = await call(f, input);
  const result = successful(response);
  assert.equal(result.provider, 'fixture-provider');
  assert.equal(result.model, 'saved-model');
  assert.equal(result.api, 'fixture-inference-v1');
  assert.equal(result.stopReason, 'toolUse');
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: 'provider-owned reasoning', thinkingSignature: 'fixture-thinking-signature' },
    { type: 'text', text: f.answer },
    { type: 'toolCall', id: 'call-new', name: 'inspect', arguments: { path: 'release.json' } },
  ]);
  assert.equal(result.usage.totalTokens, 19);
  assert.deepEqual(f.sends.map(send => send.body.context), [input.context]);
  const sent = f.sends[0];
  assert.deepEqual(sent.body.options, { reasoning: 'low', maxTokens: 91 });
  assert.equal(sent.body.model.contextWindow, 48000);
  assert.equal(sent.body.model.cost.output, 7);
  assert.equal(sent.body.scopedEnv, f.binding.ownerKey);
  assert.equal(sent.headers.authorization, `Bearer synthetic-key-${f.binding.ownerKey}`);
  assert.ok(response.body.events.some(event => event.type === 'toolcall_end' && event.toolCall.id === 'call-new'));
  privateResponse(f, response);
});

test('REQ-OPERATOR-007: AC4/5 virtual logical profile remains pinned while public SDK routes each request to its physical model', async t => {
  const f = await fixture(t, { virtual: true });
  const admitted = await admit(f);
  assert.equal(admitted.body.provider, 'fixture-router');
  assert.equal(admitted.body.model, 'automatic');
  const first = successful(await call(f));
  const context = { messages: [{ role: 'user', content: 'Use second physical model.', timestamp: 1 }] };
  const second = successful(await call(f, modelRequest(f, { operationId: 'inference-two', context })));
  assert.deepEqual([first.model, second.model], ['saved-model', 'second-model']);
  assert.deepEqual(f.sends.map(send => send.body.options.reasoning), ['low', 'low']);
  const afterRouting = await post(f.origin, '/operator-inference/profile', profileRequest(f));
  assert.equal(afterRouting.status, 200);
  assert.deepEqual(afterRouting.body, admitted.body);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.agentDir, 'settings.json'), 'utf8')), f.settings);
  assert.deepEqual((await readdir(f.agentDir, { recursive: true })).filter(file => file.endsWith('.jsonl')), [],
    'Headless SDK context must not persist a conversation');
});

for (const outcome of ['success', 'provider-failure', 'caller-abort', 'deadline']) {
  test(`REQ-OPERATOR-047/048: genuine SDK context retires after ${outcome} without late delivery`, { timeout: 15000 }, async t => {
    const cancelled = outcome === 'caller-abort' || outcome === 'deadline';
    const f = await fixture(t, { virtual: true, lifecycle: true, ignoreAbort: cancelled });
    await admit(f);
    if (outcome === 'provider-failure') f.status = 503;
    if (outcome === 'deadline') f.trusted.deadline = Date.now() + 5000;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    f.hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    f.onSend = entered;
    const caller = new AbortController();
    // Public Host entrypoint and genuine caller signal; provider I/O remains real HTTP.
    const pending = ownerInference(f.trusted, false, Buffer.from(JSON.stringify(modelRequest(f))), caller.signal);
    await Promise.race([started, pending.then(response => {
      assert.fail(`Expected a live provider request, received ${response.status}: ${response.body}`);
    })]);
    assert.ok(f.sdkContext, 'Virtual routing must supply a genuine SDK context');
    assert.equal(f.sdkContext.cwd, f.cwd);
    assert.equal(f.providerFinished, false);
    if (outcome === 'caller-abort') caller.abort();
    if (!cancelled) release();
    const response = await pending;
    assert.equal(response.status, outcome === 'success' ? 200 : outcome === 'provider-failure' ? 502 : 403, response.body);
    const body = JSON.parse(response.body);
    if (outcome === 'success') {
      assert.equal(body.events.at(-1).type, 'done');
      assert.equal(body.result.content.find(part => part.type === 'text').text, f.answer);
    } else {
      assert.equal(body.events, undefined);
      assert.equal(body.result, undefined);
    }
    assert.throws(() => f.sdkContext.cwd, 'Retired SDK context must no longer be usable');
    if (cancelled) {
      assert.equal(f.providerFinished, false, 'Disposal must not wait for an abort-ignoring provider');
      release();
    }
    await f.providerSettled;
    assert.throws(() => f.sdkContext.cwd, 'Late provider completion must not restore SDK context');
    assert.equal(f.sends.length, 1, 'No replacement paid request after retirement');
  });
}

for (const auth of ['command', 'oauth']) {
  test(`REQ-OPERATOR-007: AC4 SDK-owned ${auth} credentials execute without interactive session or public credential exposure`, async t => {
    const f = await fixture(t, { legacy: auth === 'command', auth }); await admit(f);
    const response = await call(f);
    const result = successful(response);
    assert.equal(result.content.find(part => part.type === 'text').text, f.answer);
    assert.equal(f.sends[0].headers.authorization,
      `Bearer synthetic-${auth === 'command' ? 'command' : 'refreshed'}-${f.binding.ownerKey}`);
    if (auth === 'oauth') {
      assert.ok(f.refreshes.some(value => value.refresh === `synthetic-refresh-${f.binding.ownerKey}`));
      const credentials = JSON.parse(await readFile(path.join(f.agentDir, 'auth.json'), 'utf8'));
      assert.equal(credentials['fixture-provider'].access, `synthetic-refreshed-${f.binding.ownerKey}`);
    }
    privateResponse(f, response);
  });
}

test('REQ-OPERATOR-007: AC2/4 saved OpenAI uses the public SDK protocol with configured endpoint and its own API key', async t => {
  const f = await fixture(t, { builtin: true }); await admit(f);
  const response = await call(f, modelRequest(f, { context: { messages: [
    { role: 'user', content: 'Summarize release.', timestamp: 1 },
  ] } }));
  const result = successful(response);
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-5');
  assert.equal(result.api, 'openai-completions');
  assert.equal(result.content.find(part => part.type === 'text').text, f.answer);
  assert.deepEqual(f.sends.map(send => send.path), ['/v1/chat/completions']);
  assert.equal(f.sends[0].headers.authorization, `Bearer synthetic-key-${f.binding.ownerKey}`);
  assert.equal(f.sends[0].body.model, 'gpt-5');
  privateResponse(f, response);
});

test('REQ-OPERATOR-003: AC1/2 concurrent and cold owner compositions cannot exchange equal-ID models credentials or replies', async t => {
  const a = await fixture(t, { owner: 'alice' });
  const b = await fixture(t, { owner: 'bob' });
  await Promise.all([admit(a), admit(b)]);
  const responses = await Promise.all([call(a), call(b)]);
  assert.deepEqual(responses.map(response => successful(response).content.find(part => part.type === 'text').text),
    [a.answer, b.answer]);
  for (const f of [a, b]) {
    assert.equal(f.sends[0].headers.authorization, `Bearer synthetic-key-${f.binding.ownerKey}`);
    f.origin = await listen(t, router({ ...f.trusted }, f.logs));
    const cold = successful(await call(f, modelRequest(f, { operationId: 'cold-call' })));
    assert.equal(cold.content.find(part => part.type === 'text').text, f.answer);
    assert.equal(f.sends.at(-1).headers.authorization, `Bearer synthetic-key-${f.binding.ownerKey}`);
  }
});

test('REQ-OPERATOR-047: AC2/3 outer container authentication denies model and profile before any provider work', async t => {
  const f = await fixture(t); await admit(f);
  for (const endpoint of ['/operator-inference', '/operator-inference/profile']) {
    for (const auth of [null, 'wrong-container-token']) {
      const response = await post(f.origin, endpoint, endpoint.endsWith('/profile') ? profileRequest(f) : modelRequest(f), auth);
      assert.equal(response.status, 401);
      privateResponse(f, response);
    }
  }
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.refreshes, []);
});

test('REQ-OPERATOR-003: AC2 caller paths principal selection credentials and SDK options cannot override trusted composition', async t => {
  const f = await fixture(t); await admit(f);
  const overrides = [
    { cwd: '/foreign', agentDir: '/foreign', sdkRoot: '/foreign' },
    { ownerKey: 'foreign', sessionId: 'foreign' },
    { selection: { provider: 'openai-codex', model: 'foreign' } },
    { auth: { apiKey: PRIVATE }, env: { FIXTURE_SCOPE: 'foreign' } },
    { options: { reasoning: 'low', maxTokens: 91, apiKey: PRIVATE, baseUrl: 'https://foreign.invalid' } },
  ];
  for (const override of overrides) {
    const input = modelRequest(f, override);
    input.requestDigest = digest({ context: input.context, options: input.options });
    const response = await call(f, input);
    assert.equal(response.status, 400, response.raw);
    privateResponse(f, response);
  }
  const profile = await post(f.origin, '/operator-inference/profile', { ...profileRequest(f), agentDir: '/foreign' });
  assert.equal(profile.status, 400);
  assert.deepEqual(f.sends, []);
});

test('REQ-OPERATOR-047: AC2/3 wrong generation stale session and unavailable current authority deny both owner endpoints', async t => {
  const f = await fixture(t); await admit(f);
  for (const mismatch of [{ generation: 2 }, { sessionGeneration: 5 }, { activityId: 'foreign-activity' }]) {
    refused(await call(f, modelRequest(f, mismatch)));
    refused(await post(f.origin, '/operator-inference/profile', { ...profileRequest(f), ...mismatch }));
  }
  f.live = false;
  refused(await call(f));
  refused(await post(f.origin, '/operator-inference/profile', profileRequest(f)));
  f.live = true; f.trusted.deadline = Date.now() - 1;
  refused(await call(f));
  refused(await post(f.origin, '/operator-inference/profile', profileRequest(f)));
  assert.deepEqual(f.sends, []);
});

test('REQ-OPERATOR-007: AC2 unsupported Off and changed request or profile digests refuse before a model send', async t => {
  const f = await fixture(t); await admit(f);
  for (const changes of [
    { options: { reasoning: 'off', maxTokens: 91 } },
    { requestDigest: 'f'.repeat(64) }, { profileDigest: 'f'.repeat(64) },
  ]) refused(await call(f, modelRequest(f, changes)));
  assert.deepEqual(f.sends, []);
});

test('REQ-OPERATOR-007: AC4/5 saved profile drift or an unavailable admitted model never substitutes another model', async t => {
  const f = await fixture(t); await admit(f);
  const original = { ...f.trusted.selection };
  f.trusted.selection = { ...original, model: 'not-in-configured-catalog' };
  refused(await call(f));
  f.trusted.selection = original;
  await writeFile(path.join(f.agentDir, 'settings.json'), JSON.stringify({ ...f.settings, defaultModel: 'second-model' }));
  refused(await call(f));
  assert.deepEqual(f.sends, []);
});

test('REQ-OPERATOR-007: AC4 SDK initialization errors refuse without native managed or built-in fallback', async t => {
  const f = await fixture(t, { initializationFailure: true });
  const profile = await post(f.origin, '/operator-inference/profile', profileRequest(f));
  refused(profile);
  f.trusted.selection = { source: 'pi-native', provider: 'fixture-provider', model: 'saved-model',
    api: 'fixture-inference-v1', reasoningLevel: 'low', profileDigest: 'a'.repeat(64) };
  const response = await call(f);
  refused(response);
  assert.deepEqual(f.sends, []);
  privateResponse(f, profile); privateResponse(f, response);
});

test('REQ-OPERATOR-047: AC2/5 revocation while the configured provider is executing cannot deliver late model events or result', async t => {
  const f = await fixture(t); await admit(f);
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let release; f.hold = new Promise(resolve => { release = resolve; });
  t.after(() => release()); f.onSend = entered;
  const pending = call(f);
  await Promise.race([started, pending.then(response => {
    assert.fail(`Expected provider execution before revocation, received ${response.status}: ${response.raw}`);
  })]);
  f.live = false; release();
  const response = await pending;
  refused(response);
  assert.equal(response.raw.includes(f.answer), false);
  assert.equal(response.body?.events, undefined);
  assert.equal(f.sends.length, 1, 'No replacement paid request after lost authority');
});

for (const status of [401, 429, 503]) {
  test(`REQ-OPERATOR-047: AC7 provider HTTP ${status} is private and cannot manufacture login authority retry or fallback`, async t => {
    const f = await fixture(t); await admit(f); f.status = status;
    const response = await call(f);
    refused(response);
    // Arbitrary provider text saying PI_LOGIN_REQUIRED is not structured SDK auth proof.
    assert.equal(response.body?.authFailure, undefined);
    assert.equal(f.sends.length, 1, 'The Host may not silently spend on a replacement call');
    privateResponse(f, response);
    assert.equal(response.raw.includes('PI_LOGIN_REQUIRED rejected'), false);
  });
}

test('REQ-OPERATOR-047: AC7 missing configured SDK credentials returns safe login recovery without provider spend', async t => {
  const f = await fixture(t, { auth: 'missing' });
  // A nonsecret profile is discoverable independently of request-time login.
  await admit(f);
  const response = await call(f);
  refused(response);
  assert.notEqual(response.status, 403);
  assert.deepEqual(response.body.authFailure, { code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider: 'fixture-provider' });
  assert.deepEqual(f.sends, []);
  privateResponse(f, response);
});

test('REQ-OPERATOR-047: AC5 request and complete response byte bounds deny oversize without partial model delivery', async t => {
  const f = await fixture(t); await admit(f);
  const context = { messages: [{ role: 'user', content: 'x'.repeat(65000), timestamp: 1 }] };
  f.trusted.maxRequestBytes = 1024;
  const request = await call(f, modelRequest(f, { context }));
  assert.equal(request.status, 413);
  assert.deepEqual(f.sends, []);
  f.trusted.maxRequestBytes = 64 * 1024;
  f.trusted.maxResponseBytes = 1024; f.answer = 'response-too-large-'.repeat(2000);
  const response = await call(f);
  refused(response);
  assert.equal(response.body?.events, undefined);
  assert.equal(response.raw.includes('response-too-large-'), false);
  assert.equal(f.sends.length, 1);
});

test('REQ-OPERATOR-048: AC7 ordinary Host without owner composition exposes neither inference nor profile', async t => {
  const logs = [];
  const origin = await listen(t, router(undefined, logs));
  for (const endpoint of ['/operator-inference', '/operator-inference/profile']) {
    assert.equal((await post(origin, endpoint, {})).status, 404);
  }
});

/** Real router + real public SDK + external HTTP parent, with only DNS/egress
 * replaced. Successful HTTP/model delivery also verifies the fixed parent URL:
 * no other URL is reachable through the injected public-network transport.
 */
test('REQ-OPERATOR-003/007/048: production ordinary-Host factory serves saved profile and complete configured model result', async t => {
  const f = await productionFixture(t);
  const profile = await f.admit();
  assert.equal(profile.body.provider, 'fixture-provider');
  assert.equal(profile.body.model, 'saved-model');
  const result = successful(await call(f));
  assert.equal(result.content.find(part => part.type === 'text').text, f.answer);
  assert.equal(f.sends[0].headers.authorization, `Bearer synthetic-key-${f.binding.ownerKey}`);
  assert.deepEqual(f.sends[0].body.context, transcript());
});

test('REQ-OPERATOR-047: production authentication precedes parent context resolution and SDK discovery', async t => {
  const f = await productionFixture(t);
  await observeSdkStartup(f);
  for (const endpoint of ['/operator-inference', '/operator-inference/profile']) {
    const response = await post(f.origin, endpoint, profileRequest(f), null);
    assert.equal(response.status, 401);
  }
  assert.deepEqual(f.parentRequests, []);
  assert.deepEqual(f.sends, []);
});

for (const invalid of ['denied', 'missing', 'malformed', 'expired', 'invalid-limit', 'invalid-selection']) {
  test(`REQ-OPERATOR-003/047: production ${invalid} parent context refuses before SDK discovery or model spend`, async t => {
    const f = await productionFixture(t);
    await observeSdkStartup(f);
    if (invalid === 'denied') f.parentStatus = 403;
    if (invalid === 'missing') f.parentContext = null;
    if (invalid === 'malformed') f.parentContext = { ownerKey: 'unbound' };
    if (invalid === 'expired') f.parentContext.deadline = Date.now() - 1;
    if (invalid === 'invalid-limit') f.parentContext.maxResponseBytes = 0;
    if (invalid === 'invalid-selection') f.parentContext.selection = { provider: 'foreign' };
    for (const endpoint of ['/operator-inference', '/operator-inference/profile']) {
      const response = await post(f.origin, endpoint, profileRequest(f));
      assert.equal(response.status, 403, response.raw);
      assert.equal(response.body?.result, undefined);
      privateResponse(f, response);
    }
    assert.deepEqual(f.sends, []);
  });
}

test('REQ-OPERATOR-007: production parent reasoning override controls saved profile and model delivery', async t => {
  const f = await productionFixture(t);
  f.parentContext.reasoningOverride = 'medium';
  const profile = await f.admit();
  assert.equal(profile.body.reasoningLevel, 'medium');
  const response = await call(f, modelRequest(f, { options: { reasoning: 'medium', maxTokens: 91 } }));
  assert.equal(successful(response).content.find(part => part.type === 'text').text, f.answer);
  assert.equal(f.sends[0].body.options.reasoning, 'medium');
});

test('REQ-OPERATOR-003/007: production caller cannot select paths owner SDK configuration model or parent destination', async t => {
  const f = await productionFixture(t);
  await f.admit();
  const foreign = await fixture(t, { owner: 'foreign' });
  const changes = [
    { cwd: foreign.cwd, agentDir: foreign.agentDir, sdkRoot: '/foreign' },
    { ownerKey: foreign.binding.ownerKey, sessionId: foreign.binding.sessionId },
    { selection: { provider: 'fixture-provider', model: 'second-model' }, reasoningOverride: 'high' },
    { url: `${foreign.providerOrigin}/infer`, config: { defaultModel: 'second-model' } },
  ];
  for (const override of changes) {
    const response = await call(f, modelRequest(f, override));
    assert.equal(response.status, 400, response.raw);
    privateResponse(f, response);
  }
  const result = successful(await call(f));
  assert.equal(result.model, 'saved-model');
  assert.equal(result.content.find(part => part.type === 'text').text, f.answer);
  assert.equal(f.sends[0].headers.authorization, `Bearer synthetic-key-${f.binding.ownerKey}`);
  assert.deepEqual(foreign.sends, []);
});

for (const change of ['owner', 'session', 'session-generation', 'activity-generation', 'deadline', 'selection', 'reasoning', 'limits', 'revoked']) {
  test(`REQ-OPERATOR-047/048: production late ${change} parent drift cannot deliver model events or result`, async t => {
    const f = await productionFixture(t);
    await f.admit();
    let entered; const started = new Promise(resolve => { entered = resolve; });
    let release; f.hold = new Promise(resolve => { release = resolve; });
    t.after(() => release()); f.onSend = entered;
    const pending = call(f);
    await Promise.race([started, pending.then(response => {
      assert.fail(`Expected configured provider execution, received ${response.status}: ${response.raw}`);
    })]);
    if (change === 'owner') f.parentContext.ownerKey = 'changed-owner';
    if (change === 'session') f.parentContext.sessionId = 'changed-session';
    if (change === 'session-generation') f.parentContext.sessionGeneration++;
    if (change === 'activity-generation') f.binding.generation++;
    if (change === 'deadline') f.parentContext.deadline += 1000;
    if (change === 'selection') f.parentContext.selection.model = 'second-model';
    if (change === 'reasoning') f.parentContext.reasoningOverride = 'high';
    if (change === 'limits') f.parentContext.maxResponseBytes++;
    if (change === 'revoked') f.parentStatus = 403;
    release();
    const response = await pending;
    assert.equal(response.status, 403, response.raw);
    assert.equal(response.body?.events, undefined);
    assert.equal(response.body?.result, undefined);
    assert.equal(response.raw.includes(f.answer), false);
  });
}

test('REQ-OPERATOR-047: production bounds unresolved metadata body before parent and applies narrower admitted request/response limits', async t => {
  const f = await productionFixture(t);
  const overTransport = await post(f.origin, '/operator-inference/profile', Buffer.alloc(64 * 1024 + 1, 32));
  assert.equal(overTransport.status, 413);
  assert.deepEqual(f.parentRequests, []);
  assert.deepEqual(f.sends, []);
  await f.admit();
  f.parentContext.maxRequestBytes = 128;
  assert.equal((await call(f)).status, 413);
  assert.deepEqual(f.sends, []);
  f.parentContext.maxRequestBytes = 64 * 1024;
  f.parentContext.maxResponseBytes = 1024;
  f.answer = 'bounded-response-'.repeat(2000);
  const response = await call(f);
  assert.equal(response.status, 413, response.raw);
  assert.equal(response.body?.events, undefined);
  assert.equal(response.body?.result, undefined);
});

test('REQ-OPERATOR-047: production incomplete metadata body expires without resolving parent or discovering SDK', { timeout: 20000 }, async t => {
  const f = await productionFixture(t);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${f.origin}/operator-inference/profile`, { method: 'POST', headers: {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': 100,
    } }, res => {
      res.resume();
      res.on('end', () => { resolve(res.statusCode); req.destroy(); });
    });
    t.after(() => req.destroy());
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Metadata read was not bounded')));
    req.write('{'); // Deliberately leave the body unfinished.
  });
  assert.equal(response, 503);
  assert.deepEqual(f.parentRequests, []);
  assert.deepEqual(f.sends, []);
});


test('REQ-OPERATOR-047: production lookup metadata preserves admitted large context allowance and cannot substitute body generation', async t => {
  const f = await productionFixture(t);
  await f.admit();
  f.parentContext.maxRequestBytes = 256 * 1024;
  const headers = { 'x-codeflare-operator-activity': f.binding.activityId,
    'x-codeflare-operator-generation': String(f.binding.generation) };
  const context = { ...transcript(), systemPrompt: 'admitted-large-context '.repeat(4000) };
  const response = await post(f.origin, '/operator-inference', modelRequest(f, { context }), TOKEN, headers);
  assert.equal(successful(response).content.find(part => part.type === 'text').text, f.answer);
  const { normalizeContext } = await import(pathToFileURL(AI_ENTRY).href);
  assert.deepEqual(f.sends[0].body.context, normalizeContext(context));
  const foreign = await post(f.origin, '/operator-inference', modelRequest(f, { generation: f.binding.generation + 1 }), TOKEN, headers);
  assert.equal(foreign.status, 403, foreign.raw);
  assert.equal(foreign.body?.events, undefined);
  assert.equal(foreign.body?.result, undefined);
});


test('REQ-OPERATOR-007: public SDK custom provider identity is preserved without a catalogue or family mapping', async t => {
  const f = await productionFixture(t, { providerId: 'Owner.Custom/router' });
  const profile = await f.admit();
  assert.equal(profile.body.provider, 'Owner.Custom/router');
  const result = successful(await call(f));
  assert.equal(result.provider, 'Owner.Custom/router');
  assert.equal(result.content.find(part => part.type === 'text').text, f.answer);
});


test('REQ-OPERATOR-007: managed source selects its configured SDK route without personal-provider grants or saved-native substitution', async t => {
  const f = await productionFixture(t, { providerId: 'codeflare-gateway' });
  f.parentContext.managed = { provider: 'codeflare-gateway', model: 'second-model', reasoningLevel: 'low' };
  const profile = await f.admit();
  assert.equal(profile.body.provider, 'codeflare-gateway'); assert.equal(profile.body.model, 'second-model');
  const result = successful(await call(f));
  assert.equal(result.model, 'second-model');
  const saved = JSON.parse(await readFile(path.join(f.agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.defaultModel, 'saved-model');
});

test('REQ-OPERATOR-007: managed provider-default remains null and is not forced to Off', async t => {
  const f = await productionFixture(t, { providerId: 'codeflare-gateway' });
  f.parentContext.managed = { provider: 'codeflare-gateway', model: 'saved-model', reasoningLevel: null };
  const profile = await f.admit();
  assert.equal(profile.body.reasoningLevel, null);
  assert.equal(successful(await call(f, modelRequest(f, { options: { maxTokens: 91 } }))).model, 'saved-model');
});
