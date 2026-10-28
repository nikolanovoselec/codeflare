/** Shared real-public-SDK HTTP fixture. No SDK replacement or prompt loop. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequestHandler } from '../../dist/request-router.js';
import { createOperatorInferenceOwnerResolver } from '../../dist/operator-inference-owner.js';

const SDK_ROOT = process.env.OPERATOR_INFERENCE_TEST_SDK_ROOT
  ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';
const AI_ENTRY = process.env.OPERATOR_INFERENCE_TEST_AI_ENTRY
  ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-ai/dist/index.js';
const TOKEN = 'synthetic-container-inference-token';
const PRIVATE = 'synthetic-private-provider-marker';
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
function post(origin, pathname, value, authorization = TOKEN, lookupHeaders = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': bytes.length,
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}), ...lookupHeaders,
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
    status: 200, answer: `${owner} configured response`, toolCall: false, hold: null, responseHeaders: {} };
  const lifecycleChannel = options.lifecycle ? `operator-inference:${root}` : undefined;
  if (lifecycleChannel) {
    const events = channel(lifecycleChannel);
    let settled;
    f.providerSettled = new Promise(resolve => { settled = resolve; });
    f.providerFinished = false;
    const observe = event => {
      if (event.type === 'context') f.sdkContext = event.context;
      if (event.type === 'settled') { f.providerFinished = true; settled(); }
    };
    events.subscribe(observe);
    t.after(() => events.unsubscribe(observe));
  }
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
    for (const [name, value] of Object.entries(f.responseHeaders)) res.setHeader(name, value);
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
  const provider = options.builtin ? 'openai' : options.providerId ?? 'fixture-provider';
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
    await copyFile(new URL('./operator-inference-provider.mjs', import.meta.url), path.join(extensions, 'provider.js'));
    await writeFile(path.join(extensions, 'operator-inference-config.json'), JSON.stringify({
      provider, endpoint: f.providerOrigin, aiEntry: pathToFileURL(AI_ENTRY).href,
      kind: options.legacy ? 'legacy' : 'native', virtual: options.virtual,
      command: `!printf '%s' 'synthetic-command-${owner}'`, privateMarker: PRIVATE,
      initializationFailure: options.initializationFailure, lifecycleChannel, ignoreAbort: options.ignoreAbort,
      fragmentSize: options.fragmentSize, failedResult: options.failedResult,
    }));
  }
  f.binding = { ownerKey: owner, sessionId: `session-${owner}`, sessionGeneration: 4,
    activityId: `activity-${owner}`, generation: 1 };
  f.trusted = { cwd, agentDir, sdkRoot: SDK_ROOT, selection: undefined,
    deadline: Date.now() + 30000, ownerKey: owner, sessionId: f.binding.sessionId, sessionGeneration: 4,
    maxRequestBytes: 64 * 1024, maxResponseBytes: 64 * 1024,
    current: async binding => f.live && Object.entries(f.binding).every(([key, value]) => binding[key] === value),
  };
  if (options.loggingEnabled !== undefined) Object.assign(f.trusted, { loggingEnabled: options.loggingEnabled });
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
  // Protected raw platform logs may contain private payloads; the Owner HTTP
  // projection and bounded metadata must still exclude them. Credentials are
  // forbidden in every application log channel, including protected raw logs.
  const boundedLogs = f.logs.filter(line => {
    try { return JSON.parse(line).module !== 'operator-execution'; }
    catch { return true; }
  });
  const bounded = `${response.raw}\n${JSON.stringify(boundedLogs)}`;
  for (const forbidden of [PRIVATE, f.agentDir, f.cwd]) assert.equal(bounded.includes(forbidden), false, forbidden);
  const all = `${response.raw}\n${JSON.stringify(f.logs)}`;
  for (const credential of [`synthetic-key-${f.binding.ownerKey}`, `synthetic-refresh-${f.binding.ownerKey}`,
    `synthetic-refreshed-${f.binding.ownerKey}`, `synthetic-command-${f.binding.ownerKey}`]) {
    assert.equal(all.includes(credential), false, credential);
  }
}

async function productionFixture(t, options = {}) {
  const f = await fixture(t, options);
  f.parentContext = {
    ownerKey: f.binding.ownerKey, sessionId: f.binding.sessionId,
    sessionGeneration: f.binding.sessionGeneration, deadline: f.trusted.deadline,
    maxRequestBytes: f.trusted.maxRequestBytes, maxResponseBytes: f.trusted.maxResponseBytes,
  };
  if (options.loggingEnabled !== undefined) f.parentContext.loggingEnabled = options.loggingEnabled;
  f.parentStatus = 200;
  f.parentRequests = [];
  const parentOrigin = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw || '{}');
    f.parentRequests.push(input);
    const valid = req.method === 'POST' && req.url === '/v1/dispatcher/owner-context'
      && JSON.stringify(input) === JSON.stringify({ activityId: f.binding.activityId, generation: f.binding.generation });
    res.writeHead(valid ? f.parentStatus : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(f.parentContext));
  });
  const resolver = createOperatorInferenceOwnerResolver({ cwd: f.cwd, agentDir: f.agentDir, sdkRoot: SDK_ROOT,
    fetch: async (input, init) => {
      if (String(input) !== 'https://operator.internal/v1/dispatcher/owner-context') {
        return new Response(null, { status: 403 });
      }
      return fetch(`${parentOrigin}/v1/dispatcher/owner-context`, init);
    },
  });
  f.origin = await listen(t, router(resolver, f.logs));
  f.admit = async () => {
    const profile = await admit(f);
    f.parentContext.selection = { ...profile.body };
    return profile;
  };
  return f;
}

async function observeSdkStartup(f) {
  // An externally observable SDK resource-discovery effect, not a private-call
  // spy: even starting discovery would send an HTTP message to the provider.
  await writeFile(path.join(f.agentDir, 'extensions', 'startup-probe.js'),
    `export default async function () { await fetch(${JSON.stringify(`${f.providerOrigin}/sdk-started`)}, `
      + `{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sdkStarted":true}' }); }`);
}


export { SDK_ROOT, AI_ENTRY, TOKEN, PRIVATE, transcript, digest, listen, post, router, fixture, profileRequest, admit, modelRequest, call, successful, refused, privateResponse, productionFixture, observeSdkStartup };
