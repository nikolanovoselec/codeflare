/** REQ-OPERATOR-090 protected raw logs, not bounded Owner API data.
 * Uses real router/resolver/ownerInference and the installed public Pi SDK.
 * Child stdio is the log observation boundary; no global console replacement,
 * fake SDK, extra AgentSession/prompt, source assertions or stream teeing.
 * CI executes this suite; authoring it does not qualify RED or GREEN.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const childPath = fileURLToPath(new URL('./fixtures/operator-inference-raw-child.mjs', import.meta.url));
async function scenario(t, name) {
  const child = fork(childPath, [name], { silent: true, execArgv: [] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = ''; let message;
  // No capture limit: the contract explicitly forbids truncation/sampling.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', value => { message = value; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => signal ? reject(new Error(`Scenario ${name} ended by ${signal}`)) : resolve(exitCode));
  });
  assert.equal(code, 0, `${name}: ${message?.failure?.stack ?? stderr}`);
  assert.ok(message?.result, `${name}: child must return a functional outcome`);
  const records = [];
  const output = [stdout, stderr, ...(message.result.applicationLogs ?? [])].join('\n');
  for (const line of output.split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record.module === 'operator-execution') records.push(record);
    } catch { /* Stock SDK output is not the owned JSON logging contract. */ }
  }
  return { ...message.result, records };
}
function* values(value) {
  yield value;
  if (value && typeof value === 'object') for (const child of Object.values(value)) yield* values(child);
}
function captured(out) {
  assert.ok(out.records.length > 0, 'Enabled protected logging must capture actual raw values');
  for (const record of out.records) {
    assert.equal(typeof record.message, 'string');
    assert.notEqual(record.message, '', 'The existing logger message identifies the stage');
    assert.equal(record.data.activityId, out.binding.activityId);
    assert.equal(record.data.generation, out.binding.generation);
    assert.ok(Object.hasOwn(record.data, 'value'), 'Raw value is separate from bounded diagnostic metadata');
  }
  return out.records.map(record => record.data.value);
}
function hasExact(raw, expected, why) {
  assert.ok([...values(raw)].some(value => isDeepStrictEqual(value, expected)), why);
}
function safeRefusal(response, status) {
  assert.equal(response.status, status, response.raw ?? JSON.stringify(response.body));
  assert.deepEqual(response.body, { error: 'Configured inference unavailable' });
  if (response.headers) assert.equal(response.headers['cache-control'], 'no-store');
}
function succeeded(out) {
  const { response, expected } = out;
  assert.equal(response.status, 200, response.raw);
  assert.deepEqual(Object.keys(response.body).sort(), ['events', 'result']);
  assert.equal(response.body.events[0].type, 'start');
  assert.equal(response.body.events.at(-1).type, 'done');
  assert.deepEqual(response.body.events.at(-1).message, response.body.result);
  assert.equal(response.body.result.content.find(part => part.type === 'text').text, expected.answer);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(out.sends.length, 1, 'Raw logging must not cause a replacement paid inference request');
}

for (const auth of ['missing', 'invalid']) {
  test(`REQ-OPERATOR-003: ${auth} container authentication denies both inference routes before trusted raw capture`, { timeout: 30000 }, async t => {
    const out = await scenario(t, `auth-${auth}`);
    for (const response of out.responses) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'Unauthorized' });
    }
    assert.deepEqual(out.records, [], 'Even the reserved ON transport header cannot bypass bearer authentication');
  });
}

test('REQ-OPERATOR-090: authenticated ON transport captures the first owner lookup original error causes stacks and unbounded detail before the same 403', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'first-lookup-on');
  for (const response of out.responses) safeRefusal(response, 403);
  const raw = captured(out);
  for (const expected of [out.expected.outerMessage, out.expected.outerStack, out.expected.childMessage,
    out.expected.childStack, out.expected.aggregateMessage, 'root non-Error cause',
    'literal non-Error cause', out.expected.huge, `${out.expected.safe}-150`]) {
    hasExact(raw, expected, `Original error evidence is retained completely: ${expected.slice(0, 80)}`);
  }
  hasExact(raw, { code: 'NON_ERROR_CAUSE', detail: out.expected.safe }, 'AggregateError retains non-Error members');
  hasExact(raw, { level2: { level3: { level4: out.expected.safe } } }, 'Depth beyond two remains intact');
  assert.equal(out.expected.unchanged, true, 'Raw capture must not rewrite the thrown error graph');
  assert.equal(out.reads, 0, 'Raw serialization must not invoke arbitrary accessors or toJSON');
  assert.match(JSON.stringify(raw), /circular/i, 'Cycles are explicit, not silently omitted');
  assert.equal(JSON.stringify(out.responses).includes(out.expected.outerStack), false,
    'Protected raw logs must not expand the private Owner HTTP error projection');
});

test('REQ-OPERATOR-090: OFF trusted transport preserves the first lookup 403 without optional raw capture', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'first-lookup-off');
  for (const response of out.responses) safeRefusal(response, 403);
  assert.deepEqual(out.records, []);
  assert.equal(out.reads, 0);
  assert.equal(out.expected.unchanged, true);
});

for (const kind of ['object', 'string']) {
  test(`REQ-OPERATOR-090: first lookup retains a thrown non-Error ${kind} without changing its 403 refusal`, { timeout: 30000 }, async t => {
    const out = await scenario(t, `non-error-${kind}`);
    for (const response of out.responses) safeRefusal(response, 403);
    const raw = captured(out);
    if (kind === 'object') {
      hasExact(raw, 'non-Error thrown lookup value', 'Non-Error object failure is not replaced by a fingerprint');
      hasExact(raw, out.expected.huge, 'Non-Error causes have no logging string cap');
    } else hasExact(raw, `non-Error primitive failure ${out.expected.safe}`, 'Primitive thrown values remain available');
  });
}

test('REQ-OPERATOR-090: redacts only credentials in headers nested fields signed URLs stringified JSON and literal echoes while preserving private neighbors', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'credentials');
  for (const response of out.responses) safeRefusal(response, 403);
  const raw = captured(out);
  const text = JSON.stringify(raw);
  for (const secret of out.expected.secrets) assert.equal(text.includes(secret), false, `Credential must not reach platform logs: ${secret}`);
  hasExact(raw, out.expected.huge, 'Noncredential private payloads must not be removed');
  assert.ok([...values(raw)].some(value => value?.headers?.['x-request-note'] === out.expected.safe),
    'Header redaction preserves the neighboring noncredential header');
  assert.ok([...values(raw)].some(value => value?.nested?.note === out.expected.safe && Object.hasOwn(value.nested, 'apiKey')),
    'Nested credential redaction preserves the neighboring private note');
  assert.ok([...values(raw)].some(value => {
    if (typeof value !== 'string') return false;
    try { const parsed = JSON.parse(value); return parsed.note === out.expected.safe && Object.hasOwn(parsed, 'token'); }
    catch { return false; }
  }), 'Stringified JSON is redacted as credential data, not discarded wholesale');
  assert.ok([...values(raw)].some(value => typeof value === 'string'
    && value.includes('Known literal echo') && value.includes(out.expected.safe)),
  'Known-literal redaction keeps the noncredential surrounding text');
  assert.ok(text.includes('files.example.invalid/object'), 'Redaction must preserve the noncredential URL destination');
  assert.ok(text.includes('page=2'), 'Noncredential query parameters remain readable');
  assert.ok(text.includes('Known literal echo'), 'Known credential echoes are redacted without removing the surrounding diagnostic');
  assert.ok(text.includes('note'), 'Stringified credential JSON retains its noncredential fields');
  assert.equal(out.reads, 0);
});

test('REQ-OPERATOR-082: sanitizer reflection failure leaves the original first lookup refusal intact and marks unavailable evidence', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'sanitizer-failure');
  for (const response of out.responses) safeRefusal(response, 403);
  const raw = captured(out);
  hasExact(raw, out.expected.outerMessage, 'Inspectable original error evidence survives one uninspectable member');
  assert.match(JSON.stringify(raw), /unavailable|uninspectable|unsupported|serialization/i,
    'Uninspectable evidence must not be silently advertised as complete');
  assert.equal(out.reads, 0);
  assert.equal(out.expected.unchanged, true);
});

test('REQ-OPERATOR-047: trusted prelookup logging context grants capture only and cannot authorize refused execution', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'context-does-not-authorize');
  safeRefusal(out.response, 403);
  assert.deepEqual(out.sends, []);
});

test('REQ-OPERATOR-003: request body loggingEnabled cannot replace the original OFF owner context or become an execution option', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'body-cannot-enable');
  safeRefusal(out.response, 400);
  assert.deepEqual(out.sends, []);
  assert.deepEqual(out.records, []);
});

test('REQ-OPERATOR-090: original owner logging flag participates in exact current snapshot fencing during provider execution', { timeout: 30000 }, async t => {
  const out = await scenario(t, 'original-logging-drift');
  safeRefusal(out.response, 403);
  assert.equal(out.sends.length, 1, 'Original in-flight request is not replaced after owner-context drift');
  assert.equal(out.response.body.events, undefined);
  assert.equal(out.response.body.result, undefined);
});

for (const kind of ['import', 'initialization', 'loader']) {
  for (const enabled of [true, false]) {
    test(`REQ-OPERATOR-090: real SDK ${kind} failure logging ${enabled ? 'ON retains original diagnostics' : 'OFF is quiet'} before unchanged 503`, { timeout: 30000 }, async t => {
      const out = await scenario(t, `sdk-${kind}-${enabled ? 'on' : 'off'}`);
      safeRefusal(out.response, 503);
      assert.deepEqual(out.sends, [], 'Failed SDK setup must not substitute a provider request');
      if (!enabled) { assert.deepEqual(out.records, []); return; }
      const raw = captured(out);
      const text = JSON.stringify(raw);
      if (kind === 'import') {
        assert.match(text, /ERR_MODULE_NOT_FOUND/);
        assert.ok(text.includes('missing-real-sdk'), 'Original loader destination is protected technical evidence');
      }
      if (kind === 'initialization') assert.ok(text.includes(`Provider initialization failed ${out.expected.marker}`));
      if (kind === 'loader') {
        assert.ok(text.includes('raw-invalid-extension.js'), 'Actual resource-loader error identifies the failed extension');
        assert.match(text, /error|unexpected|syntax|transform/i);
      }
      assert.equal(out.response.raw.includes(out.expected.marker), false, 'HTTP refusal remains bounded/private-safe');
    });
  }
}

for (const kind of ['model', 'reasoning']) {
  test(`REQ-OPERATOR-007: unsupported saved ${kind} retains raw selection evidence but remains 409 without substitution`, { timeout: 30000 }, async t => {
    const out = await scenario(t, `unsupported-${kind}-on`);
    safeRefusal(out.response, 409);
    assert.deepEqual(out.sends, []);
    const raw = captured(out);
    hasExact(raw, kind === 'model' ? 'missing-saved-model' : 'off', 'Raw selection refusal explains the actual unsupported configured value');
  });
}

for (const kind of ['stream-error', 'failed-result']) {
  for (const enabled of [true, false]) {
    test(`REQ-OPERATOR-078: public SDK ${kind} logging ${enabled ? 'ON captures the original failure' : 'OFF is quiet'} while preserving 502`, { timeout: 30000 }, async t => {
      const out = await scenario(t, `sdk-${kind}-${enabled ? 'on' : 'off'}`);
      safeRefusal(out.response, 502);
      assert.equal(out.sends.length, 1, 'Observed provider failure must not trigger a replacement paid request');
      if (!enabled) { assert.deepEqual(out.records, []); return; }
      const raw = captured(out);
      if (kind === 'stream-error') {
        assert.ok([...values(raw)].some(value => value?.type === 'error' && value.error?.errorMessage
          === `Provider HTTP 503: PI_LOGIN_REQUIRED rejected ${out.expected.marker} ${out.expected.agentDir}`),
        'Raw capture retains the actual public error event, not just its refusal status');
      } else {
        assert.ok([...values(raw)].some(value => value?.stopReason === 'error'
          && value.errorMessage === `Incomplete provider result ${out.expected.marker}`),
        'Failed result without a done event remains inspectable');
        assert.ok([...values(raw)].some(value => value?.type === 'text_delta'), 'Already observed pre-failure events remain inspectable');
      }
      assert.equal(out.response.raw.includes(out.expected.marker), false);
    });
  }
}

for (const source of ['custom', 'native', 'managed']) {
  for (const enabled of [true, false]) {
    test(`REQ-OPERATOR-090: ${source} logging ${enabled ? 'ON captures full large deep request response SDK and tool data' : 'OFF preserves successful configured bytes quietly'}`, { timeout: 60000 }, async t => {
      const out = await scenario(t, `${source}-${enabled ? 'on' : 'off'}`);
      succeeded(out);
      const result = out.response.body.result;
      assert.equal(result.provider, source === 'native' ? 'openai' : source === 'managed' ? 'owner-managed-route' : 'Owner.Custom/raw-route');
      assert.equal(result.model, source === 'native' ? 'gpt-5' : source === 'managed' ? 'second-model' : 'saved-model');
      if (source === 'managed') {
        assert.equal(out.sends[0].body.options.reasoning, undefined, 'Provider-default is not forced to Off');
        assert.equal(out.saved.defaultModel, 'saved-model', 'Logging cannot rewrite personal saved selection');
      } else if (source === 'custom') assert.equal(out.sends[0].body.options.reasoning, 'low');
      if (!enabled) { assert.deepEqual(out.records, []); return; }
      const raw = captured(out);
      hasExact(raw, out.input.context, 'Complete observed transcript includes large private tool input and output, not a digest or allowlisted shape');
      hasExact(raw, result, 'Complete functional result is captured without rewriting response bytes');
      hasExact(raw, out.response.body.events.at(-1), 'Public SDK done event remains complete');
      assert.equal(JSON.stringify(raw).includes(out.expected.credential), false);
      assert.equal(JSON.stringify(raw).includes(out.expected.responseCookie), false);
      assert.ok([...values(raw)].some(value => value?.headers?.['x-noncredential-debug'] === out.expected.headerSafe),
        'Public response-header observation preserves private noncredential neighbors while redacting cookies');
      if (source !== 'native') {
        hasExact(raw, out.sends[0].body, 'Public onPayload observes the actual outgoing provider request, including configured model metadata');
        hasExact(raw, { type: 'fixture-response', text: out.expected.answer }, 'Public provider-stream response payload remains complete');
        assert.ok([...values(raw)].some(value => value?.type === 'toolcall_end' && value.toolCall?.arguments?.path === 'release.json'));
        hasExact(raw, `${out.expected.safe}-150`, 'Array entries beyond 100 are not truncated');
      }
    });
  }
}

test('REQ-OPERATOR-090: raw public SDK events beyond 100 remain complete without consuming or replacing the functional stream', { timeout: 60000 }, async t => {
  const out = await scenario(t, 'many-events-on');
  succeeded(out);
  const events = out.response.body.events.filter(event => event.type === 'text_delta');
  assert.equal(events.length, 161, 'Every provider fragment is delivered through the normal functional iterator');
  assert.equal(events.map(event => event.delta).join(''), out.expected.answer);
  const raw = captured(out);
  for (const event of events) hasExact(raw, event, `Observed event ${event.delta} must not disappear behind a logging count cap`);
});

test('REQ-OPERATOR-090: fragmented credential text is redacted using assembled functional values without changing original SDK bytes', { timeout: 60000 }, async t => {
  const out = await scenario(t, 'fragmented-on');
  succeeded(out);
  const raw = captured(out);
  const text = JSON.stringify(raw);
  assert.equal(text.includes(out.expected.secret), false);
  const start = out.expected.answer.indexOf(out.expected.secret);
  for (let offset = 0; offset < out.expected.answer.length; offset += 8) {
    if (offset >= start && offset + 8 <= start + out.expected.secret.length) {
      const fragment = out.expected.answer.slice(offset, offset + 8);
      assert.equal(text.includes(fragment), false, `Logging separate deltas must not disclose credential fragment ${fragment}`);
    }
  }
  assert.ok(text.includes(out.expected.safe), 'Redaction preserves neighboring noncredential response values');
  assert.ok(out.response.body.result.content.some(part => part.type === 'text' && part.text.includes(out.expected.secret)),
    'Raw-log sanitization cannot mutate the original functional result');
});

for (const kind of ['text', 'tool']) {
  for (const enabled of [true, false]) {
    test(`REQ-OPERATOR-090: real native ${kind} fragments logging ${enabled ? 'ON redacts reconstructible credentials' : 'OFF remains quiet'} without changing SDK bytes`, { timeout: 60000 }, async t => {
      const out = await scenario(t, `native-fragmented-${kind}-${enabled ? 'on' : 'off'}`);
      succeeded(out);
      assert.equal(out.response.body.result.content.find(part => part.type === 'text').text, out.expected.answer);
      if (kind === 'tool') assert.equal(out.response.body.result.content.find(part => part.type === 'toolCall').arguments.apiKey, out.expected.toolSecret);
      if (!enabled) { assert.deepEqual(out.records, []); return; }
      const raw = captured(out);
      const native = [...values(raw)].filter(value => value?.object === 'chat.completion.chunk' && Array.isArray(value.choices));
      assert.ok(native.length > 1, 'Actual public built-in adapter observes fragmented provider HTTP events');
      const text = native.flatMap(value => value.choices).map(choice => choice.delta?.content ?? '').join('');
      const argumentsText = native.flatMap(value => value.choices).flatMap(choice => choice.delta?.tool_calls ?? [])
        .map(call => call.function?.arguments ?? '').join('');
      assert.equal(text.includes(out.expected.secret), false, 'Joining raw native text cannot recover the credential');
      assert.ok(text.includes(out.expected.safe), 'Native noncredential response text remains complete');
      if (kind === 'tool') {
        assert.equal(argumentsText.includes(out.expected.toolSecret), false, 'Joining native tool argument fragments cannot recover the credential');
        assert.ok(argumentsText.includes(out.expected.safe), 'Native noncredential tool arguments remain complete');
      }
      assert.equal(JSON.stringify(raw).includes(out.expected.secret), false);
      assert.equal(JSON.stringify(raw).includes(out.expected.toolSecret), false);
    });
  }
}

for (const mode of ['cancel', 'deadline']) {
  for (const enabled of [true, false]) {
    test(`REQ-OPERATOR-082: ${mode} with logging ${enabled ? 'ON' : 'OFF'} preserves prompt refusal real SDK disposal and suppression of late results`, { timeout: 30000 }, async t => {
      const out = await scenario(t, `${mode}-${enabled ? 'on' : 'off'}`);
      safeRefusal(out.response, 403);
      assert.equal(out.retired, true, 'Genuine public SDK context is disposed before the late provider finishes');
      assert.equal(out.unfinishedAtRefusal, true, 'Raw capture cannot wait for abort-ignoring provider completion');
      assert.equal(out.retiredAfterLateCompletion, true);
      assert.equal(out.sends.length, 1, 'No replacement inference after cancellation/deadline');
      if (enabled) captured(out); else assert.deepEqual(out.records, []);
    });
  }
}

for (const enabled of [true, false]) {
  test(`REQ-OPERATOR-047: logging ${enabled ? 'ON retains the complete observed oversized event' : 'OFF is quiet'} without widening the functional response bound`, { timeout: 60000 }, async t => {
    const out = await scenario(t, `bounded-response-${enabled ? 'on' : 'off'}`);
    safeRefusal(out.response, 413);
    assert.equal(out.sends.length, 1, 'A response bound cannot grant a retry or replacement inference');
    if (enabled) hasExact(captured(out), out.expected.answer, 'Observed raw event is not cut to the functional response allowance');
    else assert.deepEqual(out.records, []);
  });
}

test('REQ-OPERATOR-082: failed platform output descriptors cannot replace a successful configured result', { timeout: 60000 }, async t => {
  const out = await scenario(t, 'closed-log-sink-on');
  succeeded(out);
  assert.equal(out.response.body.result.model, 'saved-model');
});

test('REQ-OPERATOR-082: failed platform output descriptors cannot replace the original provider failure refusal', { timeout: 60000 }, async t => {
  const out = await scenario(t, 'closed-log-sink-failure-on');
  safeRefusal(out.response, 502);
  assert.equal(out.sends.length, 1, 'Logging output failure cannot cause fallback after the provider failure');
});
