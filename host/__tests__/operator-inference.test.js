/** Normal-host inference contract: real public SDK services, no AgentSession.
 * CI supplies the selected public SDK; baseline positives reach the existing
 * request router and fail HTTP 404 until the owner-composed route is implemented.
 * REQ-OPERATOR-007 selection; 003 owner authority; 047/048 protected effects.
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequestHandler } from '../dist/request-router.js';

const SDK_ROOT = process.env.OPERATOR_INFERENCE_TEST_SDK_ROOT
  ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';
const AI_ENTRY = process.env.OPERATOR_INFERENCE_TEST_AI_ENTRY
  ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-ai/dist/index.js';
const TOKEN = 'synthetic-container-inference-token';
const PRIVATE = 'synthetic-private-provider-marker';
const previousToken = process.env.CONTAINER_AUTH_TOKEN;
before(() => { process.env.CONTAINER_AUTH_TOKEN = TOKEN; });
after(() => {
  if (previousToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
  else process.env.CONTAINER_AUTH_TOKEN = previousToken;
});
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const transcript = () => ({ messages: [
  { role: 'system', content: 'Preserve complete records.', timestamp: 1,
    toolsAdded: [{ name: 'inspect', description: 'Read release metadata',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] },
  { role: 'user', content: 'Inspect the release.', timestamp: 2 },
  { role: 'assistant', provider: 'fixture-provider', model: 'saved-model', api: 'fixture-inference-v1',
    timestamp: 3, stopReason: 'toolUse', usage: zeroUsage,
    content: [{ type: 'thinking', thinking: 'prior thought', thinkingSignature: 'prior-signature' },
      { type: 'toolCall', id: 'call-original', name: 'inspect', arguments: { path: 'release.json' } }] },
  { role: 'toolResult', toolCallId: 'call-original', toolName: 'inspect',
    content: [{ type: 'text', text: 'Release 1.2.3 is ready.' }], isError: false, timestamp: 4 },
] });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(origin, pathname, value, authorization = TOKEN) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': bytes.length,
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    } }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = null; }
        resolve({ status: response.statusCode, headers: response.headers, raw, body });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Inference fixture HTTP deadline exceeded')));
    req.on('error', reject);
    req.end(bytes);
  });
}
function router(trusted, logs) {
  return createRequestHandler({
    sessionManager: { size: 0, list: () => [] }, wsEventLog: [],
    activityTracker: { recordHeartbeat() {}, recordInput() {}, getActivityInfo: () => ({}) },
    log: (...args) => logs.push(args.map(value => typeof value === 'string' ? value : String(value)).join(' ')),
    serverStartTime: Date.now(),
    readiness: () => ({ prewarmReady: true, initFlagObserved: true, terminalServiceReady: true,
      editorReady: false, editorReadyTimedOut: false }),
    silverbullet: { host: '127.0.0.1', port: 1 }, openvscode: { host: '127.0.0.1', port: 1 },
    ...(trusted ? { operatorInference: trusted } : {}),
  });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-inference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'work');
  const agentDir = path.join(root, 'agent');
  const extensions = path.join(agentDir, 'extensions');
  await mkdir(cwd, { recursive: true }); await mkdir(extensions, { recursive: true });
  const owner = options.owner ?? 'owner-one';
  const f = { cwd, agentDir, logs: [], sends: [], refreshes: [], live: true,
    status: 200, answer: `${owner} configured response`, toolCall: false, hold: null };
  f.providerOrigin = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    if (req.url === '/oauth') {
      f.refreshes.push(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access: `synthetic-refreshed-${owner}`, refresh: `synthetic-rotated-${owner}`,
        expires: Date.now() + 3600000 }));
      return;
    }
    f.sends.push({ path: req.url, headers: req.headers, body });
    f.onSend?.();
    if (f.hold) await f.hold;
    if (options.builtin) {
      res.setHeader('content-type', 'text/event-stream');
      const chunk = (delta, finish_reason) => ({ id: 'chat-fixture', object: 'chat.completion.chunk',
        created: 1, model: 'gpt-5', choices: [{ index: 0, delta, finish_reason }] });
      res.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: f.answer }, null))}\n\n`
        + `data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.statusCode = f.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(f.status === 200 ? { text: f.answer, toolCall: f.toolCall }
      : { error: `PI_LOGIN_REQUIRED rejected ${PRIVATE} ${agentDir}` }));
  });
  const provider = options.builtin ? 'openai' : 'fixture-provider';
  const savedProvider = options.virtual ? 'fixture-router' : provider;
  const savedModel = options.builtin ? 'gpt-5' : options.virtual ? 'automatic' : 'saved-model';
  f.settings = { defaultProvider: savedProvider, defaultModel: savedModel,
    defaultThinkingLevel: 'medium', modelThinkingLevels: { [`${savedProvider}/${savedModel}`]: 'low' },
    packages: [], defaultProjectTrust: 'always' };
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(f.settings));
  const auth = options.auth === 'oauth'
    ? { type: 'oauth', access: `synthetic-expired-${owner}`, refresh: `synthetic-refresh-${owner}`, expires: 1 }
    : { type: 'api_key', key: `synthetic-key-${owner}`, env: { FIXTURE_SCOPE: owner } };
  await writeFile(path.join(agentDir, 'auth.json'), JSON.stringify(
    options.auth === 'missing' || options.auth === 'command' ? {} : { [provider]: auth }));
  if (options.builtin) {
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
      openai: { baseUrl: `${f.providerOrigin}/v1`, api: 'openai-completions',
        models: [{ id: 'gpt-5', name: 'Saved OpenAI endpoint', reasoning: true, input: ['text'],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }] },
    } }));
  } else {
    await copyFile(new URL('./fixtures/operator-inference-provider.mjs', import.meta.url), path.join(extensions, 'provider.mjs'));
    await writeFile(path.join(extensions, 'operator-inference-config.json'), JSON.stringify({
      provider, endpoint: f.providerOrigin, aiEntry: pathToFileURL(AI_ENTRY).href,
      kind: options.legacy ? 'legacy' : 'native', virtual: options.virtual,
      command: `!printf '%s' 'synthetic-command-${owner}'`, privateMarker: PRIVATE,
      initializationFailure: options.initializationFailure,
    }));
  }
  f.binding = { ownerKey: owner, sessionId: `session-${owner}`, sessionGeneration: 4,
    activityId: `activity-${owner}`, generation: 1 };
  f.trusted = { cwd, agentDir, sdkRoot: SDK_ROOT, selection: undefined,
    deadline: Date.now() + 30000, ownerKey: owner, sessionId: f.binding.sessionId, sessionGeneration: 4,
    maxRequestBytes: 64 * 1024, maxResponseBytes: 64 * 1024,
    current: async binding => f.live && Object.entries(f.binding).every(([key, value]) => binding[key] === value),
  };
  f.origin = await listen(t, router(f.trusted, f.logs));
  return f;
}
const profileRequest = f => ({ schemaVersion: 1, activityId: f.binding.activityId,
  generation: f.binding.generation, sessionGeneration: f.binding.sessionGeneration });
async function admit(f) {
  const response = await post(f.origin, '/operator-inference/profile', profileRequest(f));
  assert.equal(response.status, 200, `Saved SDK profile discovery: ${response.raw}`);
  assert.match(response.body.profileDigest, /^[a-f0-9]{64}$/);
  f.trusted.selection = { source: 'pi-native', ...response.body };
  return response;
}
function modelRequest(f, changes = {}) {
  const context = changes.context ?? transcript();
  const options = changes.options ?? { reasoning: 'low', maxTokens: 91 };
  return { ...profileRequest(f), operationId: 'inference-one',
    requestDigest: digest({ context, options }), profileDigest: f.trusted.selection.profileDigest,
    context, options, ...changes };
}
const call = (f, body = modelRequest(f)) => post(f.origin, '/operator-inference', body);
function successful(response) {
  assert.equal(response.status, 200, response.raw);
  assert.deepEqual(Object.keys(response.body).sort(), ['events', 'result']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.body.events[0].type, 'start');
  assert.equal(response.body.events.at(-1).type, 'done');
  assert.deepEqual(response.body.events.at(-1).message, response.body.result);
  return response.body.result;
}
function refused(response) {
  assert.ok(response.status >= 400 && response.status < 600 && response.status !== 404,
    `A closed refusal, not a missing route or successful response: ${response.status} ${response.raw}`);
  assert.equal(response.body?.result, undefined);
}
function privateResponse(f, response) {
  const exposed = `${response.raw}\n${JSON.stringify(f.logs)}`;
  for (const forbidden of [PRIVATE, f.agentDir, f.cwd, `synthetic-key-${f.binding.ownerKey}`,
    `synthetic-refresh-${f.binding.ownerKey}`, `synthetic-refreshed-${f.binding.ownerKey}`,
    `synthetic-command-${f.binding.ownerKey}`]) assert.equal(exposed.includes(forbidden), false, forbidden);
}

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
});

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
