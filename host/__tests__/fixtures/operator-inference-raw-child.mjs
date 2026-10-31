/** CI-only subprocess scenarios. stdout/stderr remain genuine console output;
 * IPC returns functional outcomes without intercepting console or SDK internals.
 */
import assert from 'node:assert/strict';
import { closeSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ownerInference } from '../../dist/operator-inference.js';
import { createOperatorInferenceOwnerResolver } from '../../dist/operator-inference-owner.js';
import { TOKEN, PRIVATE, fixture, productionFixture, transcript, profileRequest, admit,
  modelRequest, post, call, listen, router } from './operator-inference-harness.mjs';

process.env.CONTAINER_AUTH_TOKEN = TOKEN;
const cleanups = [];
const t = { after(fn) { cleanups.push(fn); } };
const scenario = process.argv[2];
const headers = (binding, enabled) => ({
  'x-codeflare-operator-activity': binding.activityId,
  'x-codeflare-operator-generation': String(binding.generation),
  'x-codeflare-operator-logging': enabled ? 'on' : 'off',
});
const binding = { activityId: 'raw-first-lookup', generation: 3 };
const plainProfile = { schemaVersion: 1, ...binding, sessionGeneration: 4 };
const safe = 'noncredential-private-neighbor-✓';
const headerSafe = 'noncredential-private-header-neighbor';
const huge = '完整🙂raw-private-body-'.repeat(900);
const secrets = {
  bearer: 'synthetic-bearer-sensitive-921', cookie: 'synthetic-cookie-sensitive-922',
  key: 'synthetic-api-key-sensitive-923', token: 'synthetic-token-sensitive-924',
  password: 'synthetic-password-sensitive-925', signature: 'synthetic-signature-sensitive-926',
  user: 'synthetic-url-user-927', userPassword: 'synthetic-url-password-928',
  json: 'synthetic-json-token-sensitive-929',
};

async function firstLookup(kind, enabled = true, auth = TOKEN) {
  let reads = 0;
  const child = new Error('deep original cause 完整');
  child.stack = 'Error: deep original cause 完整\n at original-provider (provider.js:777:42)\n' + huge;
  const aggregate = new AggregateError([child, { code: 'NON_ERROR_CAUSE', detail: safe }, 'literal non-Error cause'],
    'aggregate original cause', { cause: 'root non-Error cause' });
  const original = new Error('first parent lookup failed before owner context', { cause: aggregate });
  original.stack = 'Error: first parent lookup failed before owner context\n at original-fetch (lookup.js:41:9)';
  original.detail = { safe, huge, level1: { level2: { level3: { level4: safe } } },
    items: Array.from({ length: 151 }, (_, index) => ({ index, value: `${safe}-${index}` })) };
  original.detail.circular = original.detail;
  Object.defineProperty(original.detail, 'dangerousGetter', { enumerable: true,
    get() { reads++; throw new Error('Logging executed an arbitrary getter'); } });
  original.detail.toJSON = () => { reads++; throw new Error('Logging executed arbitrary toJSON'); };
  const sensitive = {
    headers: { Authorization: `Bearer ${secrets.bearer}`, Cookie: `sid=${secrets.cookie}`,
      'set-cookie': `session=${secrets.cookie}; HttpOnly`, 'x-request-note': safe },
    nested: { apiKey: secrets.key, token: secrets.token, password: secrets.password, note: safe },
    signedUrl: `https://${secrets.user}:${secrets.userPassword}@files.example.invalid/object?X-Amz-Signature=${secrets.signature}&page=2`,
    serialized: JSON.stringify({ token: secrets.json, note: safe }),
    echo: `Known literal echo ${secrets.key}; neighbor ${safe}`,
  };
  if (kind === 'credentials') original.sensitive = sensitive;
  let thrown = original;
  if (kind === 'object') thrown = { failure: 'non-Error thrown lookup value', detail: safe, cause: { original: huge } };
  if (kind === 'string') thrown = `non-Error primitive failure ${safe}`;
  if (kind === 'sanitizer') original.detail.hostile = new Proxy({}, {
    ownKeys() { throw new Error('Raw reflection unavailable'); },
  });
  const resolver = createOperatorInferenceOwnerResolver({ fetch: async () => { throw thrown; } });
  const applicationLogs = [];
  const origin = await listen(t, router(resolver, applicationLogs));
  const responses = [];
  for (const endpoint of ['/operator-inference/profile', '/operator-inference']) {
    responses.push(await post(origin, endpoint, plainProfile, auth, headers(binding, enabled)));
  }
  return { responses, binding, reads, applicationLogs, expected: {
    safe, huge, secrets: Object.values(secrets), outerMessage: original.message, outerStack: original.stack,
    childMessage: child.message, childStack: child.stack, aggregateMessage: aggregate.message,
    unchanged: original.cause === aggregate && aggregate.errors[0] === child,
  } };
}

async function run() {
  if (scenario === 'auth-missing') return firstLookup('error', true, null);
  if (scenario === 'auth-invalid') return firstLookup('error', true, 'invalid-container-bearer');
  if (scenario === 'first-lookup-on') return firstLookup('error');
  if (scenario === 'first-lookup-off') return firstLookup('error', false);
  if (scenario === 'credentials') return firstLookup('credentials');
  if (scenario === 'non-error-object') return firstLookup('object');
  if (scenario === 'non-error-string') return firstLookup('string');
  if (scenario === 'sanitizer-failure') return firstLookup('sanitizer');

  if (scenario === 'context-does-not-authorize') {
    const f = await productionFixture(t, { loggingEnabled: true });
    f.parentStatus = 403;
    const response = await post(f.origin, '/operator-inference/profile', profileRequest(f), TOKEN, headers(f.binding, true));
    return { response, binding: f.binding, sends: f.sends };
  }
  if (scenario === 'body-cannot-enable') {
    const f = await productionFixture(t, { loggingEnabled: false });
    const response = await post(f.origin, '/operator-inference/profile',
      { ...profileRequest(f), loggingEnabled: true }, TOKEN, headers(f.binding, false));
    return { response, binding: f.binding, sends: f.sends };
  }
  if (scenario === 'original-logging-drift') {
    const f = await productionFixture(t, { loggingEnabled: true });
    await f.admit();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    f.hold = new Promise(resolve => { release = resolve; });
    t.after(() => release()); f.onSend = entered;
    const pending = call(f);
    await Promise.race([started, pending.then(response => assert.fail(`Provider never entered: ${response.raw}`))]);
    f.parentContext.loggingEnabled = false;
    release();
    return { response: await pending, binding: f.binding, sends: f.sends };
  }

  if (scenario.startsWith('sdk-') || scenario.startsWith('unsupported-')) {
    const off = scenario.endsWith('-off');
    const f = await productionFixture(t, { loggingEnabled: !off,
      initializationFailure: scenario.startsWith('sdk-initialization'),
      failedResult: scenario.startsWith('sdk-failed-result') });
    if (scenario.startsWith('sdk-import')) {
      const resolver = createOperatorInferenceOwnerResolver({ cwd: f.cwd, agentDir: f.agentDir,
        sdkRoot: path.join(f.cwd, 'missing-real-sdk'),
        fetch: async () => Response.json(f.parentContext) });
      f.origin = await listen(t, router(resolver, f.logs));
    }
    if (scenario.startsWith('sdk-loader')) {
      await writeFile(path.join(f.agentDir, 'extensions', 'raw-invalid-extension.js'), 'export default function () { = ; }');
    }
    if (scenario.startsWith('unsupported-model')) {
      await writeFile(path.join(f.agentDir, 'settings.json'), JSON.stringify({ ...f.settings, defaultModel: 'missing-saved-model' }));
    }
    if (scenario.startsWith('unsupported-reasoning')) f.parentContext.reasoningOverride = 'off';
    let response;
    if (scenario.startsWith('sdk-stream-error') || scenario.startsWith('sdk-failed-result')) {
      await f.admit();
      if (scenario.startsWith('sdk-stream-error')) f.status = 503;
      response = await call(f);
    } else response = await post(f.origin, '/operator-inference/profile', profileRequest(f));
    return { response, binding: f.binding, sends: f.sends, expected: { marker: PRIVATE, agentDir: f.agentDir } };
  }

  if (scenario.startsWith('cancel-') || scenario.startsWith('deadline-')) {
    const loggingEnabled = scenario.endsWith('-on');
    const f = await fixture(t, { virtual: true, lifecycle: true, ignoreAbort: true, loggingEnabled });
    await admit(f);
    if (scenario.startsWith('deadline-')) f.trusted.deadline = Date.now() + 1000;
    let entered; const started = new Promise(resolve => { entered = resolve; });
    let release; f.hold = new Promise(resolve => { release = resolve; });
    t.after(() => release()); f.onSend = entered;
    const caller = new AbortController();
    const pending = ownerInference(f.trusted, false, Buffer.from(JSON.stringify(modelRequest(f))), caller.signal);
    await Promise.race([started, pending.then(response => assert.fail(`Provider never entered: ${response.body}`))]);
    if (scenario.startsWith('cancel-')) caller.abort();
    const response = await pending;
    let retired = false;
    try { void f.sdkContext.cwd; } catch { retired = true; }
    const unfinishedAtRefusal = !f.providerFinished;
    release(); await f.providerSettled;
    let retiredAfterLateCompletion = false;
    try { void f.sdkContext.cwd; } catch { retiredAfterLateCompletion = true; }
    return { response: { ...response, body: JSON.parse(response.body) }, binding: f.binding,
      sends: f.sends, retired, retiredAfterLateCompletion, unfinishedAtRefusal };
  }

  const enabled = !scenario.endsWith('-off');
  const f = await productionFixture(t, { loggingEnabled: enabled,
    builtin: scenario.startsWith('native-'),
    providerId: scenario.startsWith('managed-') ? 'owner-managed-route' : 'Owner.Custom/raw-route',
    fragmentSize: scenario.includes('fragmented-') ? 8 : scenario.startsWith('many-events-') ? 1 : undefined });
  // Functional policy bounds remain explicit and finite; only logging has no cap.
  f.parentContext.maxRequestBytes = 512 * 1024;
  f.parentContext.maxResponseBytes = scenario.startsWith('bounded-response-') ? 1024 : 2 * 1024 * 1024;
  if (scenario.startsWith('managed-')) f.parentContext.managed = {
    provider: 'owner-managed-route', model: 'second-model', reasoningLevel: null,
  };
  await f.admit();
  f.responseHeaders = { 'set-cookie': 'session=synthetic-provider-response-cookie-845; HttpOnly',
    'x-noncredential-debug': headerSafe };
  f.toolCall = scenario.startsWith('native-fragmented-tool-')
    ? { path: 'release.json', apiKey: 'fragmented-tool-sensitive-material-982', note: safe }
    : !scenario.startsWith('native-');
  const context = transcript();
  context.messages[1].content = huge;
  context.messages[2].content[1].arguments = { path: 'private/release.json',
    level1: { level2: { level3: { level4: safe } } },
    items: Array.from({ length: 151 }, (_, index) => ({ index, privateBody: `${safe}-${index}` })) };
  context.messages[3].content[0].text = `Private tool output ${huge}`;
  if (scenario.startsWith('native-')) context.messages = [{ role: 'user', content: huge, timestamp: 1 }];
  f.answer = scenario.startsWith('many-events-')
    ? Array.from({ length: 161 }, (_, index) => String.fromCharCode(0x20 + index)).join('')
    : scenario.includes('fragmented-')
      ? JSON.stringify({ apiKey: 'fragmented-sensitive-material-674', note: safe })
      : `Private configured response ${huge}`;
  const input = modelRequest(f, { context,
    ...(scenario.startsWith('managed-') ? { options: { maxTokens: 91 } } : {}) });
  if (scenario.startsWith('closed-log-sink-')) {
    // Real failed output descriptors, not a global console replacement.
    if (scenario.includes('-failure-')) f.status = 503;
    closeSync(1); closeSync(2);
  }
  const response = await call(f, input);
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(f.agentDir, 'settings.json'), 'utf8'));
  return { response, binding: f.binding, sends: f.sends, input, saved, expected: {
    answer: f.answer, safe, headerSafe, huge, secret: 'fragmented-sensitive-material-674',
    toolSecret: 'fragmented-tool-sensitive-material-982',
    credential: `synthetic-key-${f.binding.ownerKey}`,
    responseCookie: 'synthetic-provider-response-cookie-845',
  } };
}

let result;
let failure;
try { result = await run(); }
catch (error) { failure = { message: error.message, stack: error.stack }; }
finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (error) { failure ??= { message: error.message, stack: error.stack }; }
  }
}
if (process.send) {
  await new Promise((resolve, reject) => process.send({ result, failure }, error => error ? reject(error) : resolve()));
  process.disconnect();
}
if (failure) process.exitCode = 1;
