import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceDiagnostic } from '../../lib/inference-diagnostics';
import { setLogLevel } from '../../lib/logger';

// Approved additive runtime-log contract. The bounded metadata channel is unchanged.
// Reflect.apply keeps baseline collection valid: it ignores the optional lazy third argument.
const admitted = { activityId: 'raw-activity', generation: 7, loggingEnabled: true };
const metadata = { stage: 'native-response', outcome: 'completed' };
type RawRecord = { module: string; message: string; data: { activityId: string; generation: number; value: unknown } };
function capture() {
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((value: unknown) => { lines.push(String(value)); });
  return () => lines.map(line => JSON.parse(line) as RawRecord).filter(record => record.module === 'operator-execution');
}
function emit(value: unknown, context: typeof admitted = admitted) {
  Reflect.apply(inferenceDiagnostic, undefined, [context, metadata, () => value]);
}
function valueOf(records: RawRecord[]) {
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ module: 'operator-execution', message: metadata.stage,
    data: { activityId: admitted.activityId, generation: admitted.generation } });
  return records[0].data.value;
}
afterEach(() => { vi.restoreAllMocks(); setLogLevel('silent'); });

describe('protected raw execution logging through the existing diagnostic entrypoint', () => {
  it.each(['info', 'error', 'silent'] as const)('REQ-OPERATOR-090: AC1/4/5 admitted raw capture survives global level %s with complete large Unicode and noncredential data', level => {
    const records = capture(); setLogLevel(level);
    const payload = { text: '🦊é漢字'.repeat(12_001) + 'END_OF_RAW_VALUE', email: 'actual-owner@example.test',
      prompt: 'Keep the original task', toolName: 'arbitrary_domain_tool', requestId: 'original-request' };
    emit(payload);
    expect(valueOf(records())).toEqual(payload);
  });

  it('REQ-OPERATOR-090: AC5 retains the full admitted 1 MiB user operation through a collecting output sink', () => {
    const records = capture();
    const content = 'x'.repeat(1048576);
    const operation = { operationId: 'configured-inference', path: '/v1/dispatcher/inference',
      body: { operationId: 'configured-inference', input: { messages: [{ role: 'user', content }] } },
      signal: new AbortController().signal };
    emit(operation);
    expect(valueOf(records())).toMatchObject({ operationId: operation.operationId, path: operation.path, body: operation.body });
    expect(operation.body.input.messages[0].content).toBe(content);
  });

  it('REQ-OPERATOR-090: AC4/5 retains deep objects, every array element and every object entry without inspection cutoffs', () => {
    const records = capture();
    const entries = Object.fromEntries(Array.from({ length: 151 }, (_, index) => [`field-${index}`, `value-${index}`]));
    const array = Array.from({ length: 151 }, (_, index) => ({ index, result: `tool-output-${index}` }));
    const payload = { a: { b: { c: { d: { e: { array, entries, last: 'DEEPEST_VALUE' } } } } } };
    emit(payload);
    expect(valueOf(records())).toEqual(payload);
  });

  it('REQ-OPERATOR-090: AC4/5 emits all admitted events without sampling or an event-count budget', () => {
    const records = capture();
    const events = Array.from({ length: 2051 }, (_, index) => ({ type: 'public-sdk-event', index, output: `raw-${index}` }));
    for (const event of events) emit(event);
    expect(records().map(record => record.data.value)).toEqual(events);
  });

  it('REQ-OPERATOR-090: AC4 preserves original Error messages, stacks, deep causes, AggregateError members and non-Error throws', () => {
    const records = capture();
    const origin = new Error('ORIGINAL_UNICODE_é🦊'); origin.stack = 'Error: ORIGINAL_UNICODE_é🦊\n at original (service.ts:17:9)';
    const nested = new Error('CATCHING_FAILURE', { cause: new Error('INTERMEDIATE', { cause: origin }) });
    nested.stack = 'Error: CATCHING_FAILURE\n at catching (route.ts:21:3)';
    const error = new AggregateError([nested, { reason: 'non-error member', detail: ['complete member'] }, 'literal rejection'],
      'AGGREGATE_FAILURE', { cause: new Error('AGGREGATE_CAUSE') });
    emit(error);
    expect(valueOf(records())).toMatchObject({ name: 'AggregateError', message: error.message, stack: error.stack,
      cause: { name: 'Error', message: 'AGGREGATE_CAUSE' }, errors: [
        { name: 'Error', message: nested.message, stack: nested.stack, cause: { message: 'INTERMEDIATE',
          cause: { message: origin.message, stack: origin.stack } } },
        { reason: 'non-error member', detail: ['complete member'] }, 'literal rejection',
      ] });
    expect(error.errors[0]).toBe(nested);
    expect(nested.cause).toMatchObject({ cause: origin });
  });

  it.each([null, undefined, 'plain thrown value', 73, false, { reason: 'nonError', nested: { original: true } }])(
    'REQ-OPERATOR-090: AC4 non-Error raw value %# remains explicit rather than disappearing', raw => {
      const records = capture(); emit(raw);
      const observed = valueOf(records());
      if (raw === undefined) expect(JSON.stringify(observed)).toMatch(/undefined/i);
      else expect(observed).toEqual(raw);
    });

  it('REQ-OPERATOR-090: AC4 cycles and repeated shared objects are explicit without losing noncyclic neighbors', () => {
    const records = capture();
    const shared = { marker: 'SHARED_RAW_VALUE', deep: { leaf: 'RETAINED_LEAF' } };
    const cyclic: Record<string, unknown> = { first: shared, second: shared, neighbor: 'RETAINED_NEIGHBOR' };
    cyclic.self = cyclic;
    emit(cyclic);
    const observed = valueOf(records()) as Record<string, unknown>;
    expect(observed.first).toEqual(shared);
    // A shared value may be repeated or identified as an explicit reference, never silently dropped.
    expect(JSON.stringify(observed.second)).toMatch(/SHARED_RAW_VALUE|reference|ref|circular/i);
    expect(JSON.stringify(observed.self)).toMatch(/reference|ref|circular/i);
    expect(observed.neighbor).toBe('RETAINED_NEIGHBOR');
  });

  it('REQ-OPERATOR-082: AC3/4 raw serialization never executes arbitrary getters or toJSON and marks inaccessible evidence', () => {
    const records = capture();
    let state = 'untouched';
    const raw = { neighbor: 'RETAIN_ME', nested: { leaf: 'RETAIN_NESTED' },
      get arbitrary() { state = 'getter executed'; throw new Error('must not invoke getter'); },
      toJSON() { state = 'toJSON executed'; return 'REPLACED_RAW'; } };
    emit(raw);
    const observed = valueOf(records()) as Record<string, unknown>;
    expect(state).toBe('untouched');
    expect(observed).toMatchObject({ neighbor: 'RETAIN_ME', nested: { leaf: 'RETAIN_NESTED' } });
    expect(JSON.stringify(observed.arbitrary)).toMatch(/accessor|unavailable|getter/i);
    expect(JSON.stringify(observed)).not.toContain('REPLACED_RAW');
  });

  it('REQ-OPERATOR-082: AC4 Error field accessors cannot execute during raw capture and unavailable evidence remains explicit', () => {
    const records = capture(); let state = 'untouched';
    const error = new Error('replace with hostile accessor');
    // Force lazy native stack materialization before installing hostile descriptors.
    Object.getOwnPropertyDescriptor(error, 'stack');
    for (const key of ['message', 'stack', 'cause', 'name']) Object.defineProperty(error, key, { configurable: true,
      get() { state = `executed-${key}`; throw new Error('UNSAFE_ERROR_ACCESS'); } });
    emit({ error, neighbor: 'VISIBLE_NEIGHBOR' });
    const observed = valueOf(records());
    expect(state).toBe('untouched');
    expect(JSON.stringify(observed)).toContain('VISIBLE_NEIGHBOR');
    expect(JSON.stringify(observed)).toMatch(/accessor|unavailable|getter/i);
  });

  it('REQ-OPERATOR-082: native stack formatting cannot coerce an application-owned Error message', () => {
    const records = capture(); let state = 'untouched';
    const error = new Error();
    Object.defineProperty(error, 'message', { configurable: true, value: {
      toString() { state = 'coerced'; return 'UNSAFE_MESSAGE_COERCION'; }, note: 'KEEP_MESSAGE_NEIGHBOR',
    } });
    emit({ error, neighbor: 'KEEP_ERROR_NEIGHBOR' });
    expect(state).toBe('untouched');
    const wire = JSON.stringify(valueOf(records()));
    expect(wire).toContain('KEEP_ERROR_NEIGHBOR');
    expect(wire).toContain('KEEP_MESSAGE_NEIGHBOR');
    expect(wire).not.toContain('UNSAFE_MESSAGE_COERCION');
    expect(wire).toMatch(/unavailable/i);
  });

  it.each(['own', 'inherited'] as const)('REQ-OPERATOR-082: raw capture never invokes a replaced %s stack formatter', location => {
    const records = capture(); let state = 'untouched';
    const owner = location === 'own' ? Error : Function.prototype;
    const original = Object.getOwnPropertyDescriptor(owner, 'prepareStackTrace');
    const errorFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    try {
      if (location === 'inherited') Reflect.deleteProperty(Error, 'prepareStackTrace');
      Object.defineProperty(owner, 'prepareStackTrace', { configurable: true, value: () => {
        state = 'formatter executed'; return 'UNSAFE_STACK_FORMATTER';
      } });
      emit({ error: new Error('KEEP_ORIGINAL_MESSAGE'), neighbor: 'KEEP_STACK_NEIGHBOR' });
      expect(state).toBe('untouched');
      const wire = JSON.stringify(valueOf(records()));
      expect(wire).toContain('KEEP_ORIGINAL_MESSAGE');
      expect(wire).toContain('KEEP_STACK_NEIGHBOR');
      expect(wire).not.toContain('UNSAFE_STACK_FORMATTER');
      expect(wire).toMatch(/unavailable/i);
    } finally {
      if (original) Object.defineProperty(owner, 'prepareStackTrace', original);
      else Reflect.deleteProperty(owner, 'prepareStackTrace');
      if (location === 'inherited' && errorFormatter) Object.defineProperty(Error, 'prepareStackTrace', errorFormatter);
    }
  });

  it('REQ-OPERATOR-090: AC4 circular Error causes remain explicit while retaining original messages and stacks', () => {
    const records = capture();
    const error = new Error('CYCLIC_ERROR_ORIGIN'); error.stack = 'Error: CYCLIC_ERROR_ORIGIN\n at KEEP_CYCLE_FRAME (cycle.ts:7:1)';
    error.cause = error; emit(error);
    const observed = valueOf(records()) as { message: string; stack: string; cause: unknown };
    expect(observed.message).toBe(error.message); expect(observed.stack).toBe(error.stack);
    expect(JSON.stringify(observed.cause)).toMatch(/reference|ref|circular/i);
  });

  it('REQ-OPERATOR-090: AC7 redacts nested credential fields, auth, cookies, signed URLs and stringified JSON but preserves adjacent raw data', () => {
    const records = capture();
    const secrets = ['credential-password-value', 'credential-access-token', 'credential-api-key', 'credential-cookie-value',
      'credential-url-user', 'credential-url-password', 'credential-signature', 'credential-json-secret',
      'credential-cf-access-jwt-value', 'credential-access-key-id-value'];
    const raw = { text: 'NORMAL_RAW_TEXT', nested: { password: secrets[0], access_token: secrets[1], apiKey: secrets[2], keep: 'KEEP_NESTED' },
      headers: { Authorization: `Bearer ${secrets[1]}`, Cookie: `session=${secrets[3]}`, 'Set-Cookie': `session=${secrets[3]}; HttpOnly`,
        'cf-access-jwt-assertion': secrets[8], 'content-type': 'application/json', 'x-request-id': 'KEEP_REQUEST_ID' },
      accessKeyId: secrets[9], thinkingSignature: 'KEEP_TRANSCRIPT_SIGNATURE',
      url: `https://${secrets[4]}:${secrets[5]}@service.example.test/path?X-Amz-Signature=${secrets[6]}&label=KEEP_QUERY`,
      body: JSON.stringify({ client_secret: secrets[7], description: 'KEEP_JSON_NEIGHBOR', deep: { toolOutput: 'KEEP_TOOL_OUTPUT' } }) };
    emit(raw);
    const observed = valueOf(records()) as typeof raw;
    const wire = JSON.stringify(observed);
    for (const secret of secrets) expect(wire).not.toContain(secret);
    for (const retained of ['NORMAL_RAW_TEXT', 'KEEP_NESTED', 'application/json', 'KEEP_REQUEST_ID',
      'service.example.test/path', 'label=KEEP_QUERY', 'KEEP_JSON_NEIGHBOR', 'KEEP_TOOL_OUTPUT', 'KEEP_TRANSCRIPT_SIGNATURE']) expect(wire).toContain(retained);
    expect(raw.nested.password).toBe(secrets[0]); // Redaction cannot mutate the functional input.
  });

  it('REQ-OPERATOR-090: AC7 known credential literals echoed in messages, stacks and unrelated string fields are redacted', () => {
    const records = capture();
    const credential = 'echoed-sensitive-credential-47';
    const error = new Error(`Provider refused ${credential} while processing KEEP_ERROR_CONTEXT`);
    error.stack = `Error: ${error.message}\n at KEEP_STACK_FRAME (${credential}:12:5)`;
    emit({ error, nested: { credentials: { apiKey: credential } }, echo: `prefix ${credential} KEEP_ECHO_SUFFIX` });
    const observed = valueOf(records());
    expect(JSON.stringify(observed)).not.toContain(credential);
    for (const retained of ['Provider refused', 'KEEP_ERROR_CONTEXT', 'KEEP_STACK_FRAME', 'KEEP_ECHO_SUFFIX'])
      expect(JSON.stringify(observed)).toContain(retained);
    expect(error.message).toContain(credential);
  });

  it.each(['current-prefix', 'already-advanced'] as const)('REQ-OPERATOR-090: AC7 SDK delta channels redact credentials with %s partials without changing functional values', mode => {
    const records = capture();
    const kinds = ['thinking', 'text', 'toolcall'] as const;
    const secrets = kinds.map(kind => `sdk-${kind}-sensitive-material-738`);
    const bodies = secrets.map((apiKey, index) => JSON.stringify({ apiKey, note: `KEEP_SDK_NEIGHBOR_${index}` }));
    const message = { role: 'assistant', provider: 'configured-custom-provider', model: 'saved-model', timestamp: 27,
      content: [{ type: 'thinking', thinking: bodies[0] }, { type: 'text', text: bodies[1] },
        { type: 'toolCall', id: 'actual-call', name: 'inspect', arguments: JSON.parse(bodies[2]) }] };
    const deltas = bodies.flatMap((body, contentIndex) => Array.from({ length: Math.ceil(body.length / 7) }, (_, step) => ({
      contentIndex, step, delta: body.slice(step * 7, (step + 1) * 7),
    }))).sort((a, b) => a.step - b.step);
    const events = deltas.map(({ contentIndex, step, delta }) => {
      const partial = mode === 'already-advanced' ? message : { ...message, content: message.content.map((part, index) => {
        if (index !== contentIndex || contentIndex === 2) return part;
        return { ...part, [contentIndex === 0 ? 'thinking' : 'text']: bodies[contentIndex].slice(0, (step + 1) * 7) };
      }) };
      return { stage: 'sdk-event', value: { type: `${kinds[contentIndex]}_delta`, contentIndex, delta, partial } };
    });
    const payload = [...events, { stage: 'sdk-result', value: message }];
    emit(payload);
    const observed = valueOf(records()) as Array<{ stage: string; value: { contentIndex?: number; delta?: string } }>;
    for (const contentIndex of [0, 1, 2]) {
      const reconstructed = observed.filter(item => item.stage === 'sdk-event' && item.value.contentIndex === contentIndex)
        .map(item => item.value.delta ?? '').join('');
      expect(reconstructed).not.toContain(secrets[contentIndex]);
      expect(reconstructed).toContain(`KEEP_SDK_NEIGHBOR_${contentIndex}`);
    }
    expect(JSON.stringify(observed)).not.toContain(secrets[0]);
    expect(JSON.stringify(observed)).not.toContain(secrets[1]);
    expect(JSON.stringify(observed)).not.toContain(secrets[2]);
    expect(message.content[0].thinking).toBe(bodies[0]);
    expect(message.content[1].text).toBe(bodies[1]);
    expect(message.content[2].arguments.apiKey).toBe(secrets[2]);
    expect(events.map(event => event.value.delta)).toEqual(deltas.map(event => event.delta));
  });

  it('REQ-OPERATOR-090: native text and tool-argument fragments cannot reconstruct credentials while neighboring data survives', () => {
    const records = capture();
    const secret = 'native-fragment-sensitive-material-629';
    const body = JSON.stringify({ apiKey: secret, note: 'KEEP_NATIVE_NEIGHBOR' });
    const fragments = Array.from({ length: Math.ceil(body.length / 7) }, (_, index) => body.slice(index * 7, (index + 1) * 7));
    type NativeRecord = { stage: 'provider-stream-event'; value: { choices: Array<{ index: number; delta: {
      content: string; tool_calls: Array<{ index: number; function: { arguments: string } }>;
    } }> } };
    const nativeFrames: NativeRecord[] = fragments.map(fragment => ({ stage: 'provider-stream-event', value: { choices: [{ index: 0, delta: {
      content: fragment, tool_calls: [{ index: 0, function: { arguments: fragment } }],
    } }] } }));
    const payload = [
      ...nativeFrames,
      { stage: 'sdk-result', value: { role: 'assistant', provider: 'custom', model: 'saved', timestamp: 1,
        content: [{ type: 'text', text: body }, { type: 'toolCall', arguments: JSON.parse(body) }] } },
    ];
    emit(payload);
    const observed = valueOf(records()) as Array<{ stage: string; value: unknown }>;
    const native = observed.filter((item): item is NativeRecord => item.stage === 'provider-stream-event');
    const text = native.map(item => item.value.choices[0].delta.content).join('');
    const argumentsText = native.map(item => item.value.choices[0].delta.tool_calls[0].function.arguments).join('');
    for (const reconstructed of [text, argumentsText]) {
      expect(reconstructed).not.toContain(secret);
      expect(reconstructed).toContain('KEEP_NATIVE_NEIGHBOR');
    }
    expect(JSON.stringify(payload)).toContain(secret);
    expect(JSON.stringify(observed)).not.toContain(secret);
  });

  it('REQ-OPERATOR-090: native channels retain independent choices, tool indices and unrelated text branches', () => {
    const records = capture();
    const secrets = ['native-cross-branch-private-711', 'second-channel-sensitive-843'];
    const bodies = secrets.map((apiKey, index) => JSON.stringify({ apiKey, note: `KEEP_CHANNEL_${index}` }));
    const native = bodies.flatMap((body, index) => Array.from({ length: Math.ceil(body.length / 6) }, (_, part) => ({
      step: part, index, fragment: body.slice(part * 6, (part + 1) * 6),
    }))).sort((a, b) => a.step - b.step);
    const payload = [
      ...native.map(({ index, fragment }) => ({ stage: 'provider-stream-event', value: { choices: [{ index, delta: {
        content: fragment, tool_calls: [{ index, function: { arguments: fragment } }],
      } }] } })),
      { stage: 'provider-stream-event', value: { left: { text: 'native-cross-' }, right: { text: 'branch-private-711' } } },
    ];
    emit(payload);
    type NativeChoice = { index: number; delta: { content: string; tool_calls: Array<{ index: number; function: { arguments: string } }> } };
    const observed = valueOf(records()) as Array<{ value: { choices?: NativeChoice[]; left?: { text: string }; right?: { text: string } } }>;
    for (const index of [0, 1]) {
      const choices = observed.flatMap(record => record.value.choices ?? []).filter(choice => choice.index === index);
      const text = choices.map(choice => choice.delta.content).join('');
      const argumentsText = choices.flatMap(choice => choice.delta.tool_calls).map(call => call.function.arguments).join('');
      for (const reconstructed of [text, argumentsText]) {
        expect(reconstructed).not.toContain(secrets[index]);
        expect(reconstructed).toContain(`KEEP_CHANNEL_${index}`);
      }
    }
    expect(observed.at(-1)?.value.left?.text).toBe('native-cross-');
    expect(observed.at(-1)?.value.right?.text).toBe('branch-private-711');
    expect(JSON.stringify(payload)).toContain('native-cross-');
  });

  it('REQ-OPERATOR-090: AC2 OFF does not evaluate even a throwing lazy raw supplier and preserves output and original thrown values', async () => {
    const records = capture(); let effect = 'not evaluated';
    const disabled = { ...admitted, loggingEnabled: false };
    const diagnostic = () => Reflect.apply(inferenceDiagnostic, undefined, [disabled, metadata, () => {
      effect = 'evaluated'; throw new Error('LAZY_CAPTURE_MUST_NOT_RUN');
    }]);
    const response = new Response('original response bytes é🦊', { status: 207 });
    const operation = () => { diagnostic(); return response; };
    const output = operation();
    expect(output.status).toBe(207); expect(await output.text()).toBe('original response bytes é🦊');
    const original = { reason: 'original non-Error rejection' };
    const failing = async () => { try { throw original; } catch (error) { diagnostic(); throw error; } };
    await expect(failing()).rejects.toBe(original);
    expect(effect).toBe('not evaluated'); expect(records()).toEqual([]);
  });

  it.each(['supplier', 'unsafe proxy', 'console'] as const)('REQ-OPERATOR-082: AC3 %s capture failure cannot replace original success or rejection', async failure => {
    const records = capture();
    if (failure === 'console') for (const method of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation(() => { throw new Error('CONSOLE_UNAVAILABLE'); });
    const raw = failure === 'unsafe proxy' ? new Proxy({}, { ownKeys() { throw new Error('INSPECTION_UNAVAILABLE'); } }) : { output: 'original' };
    const diagnostic = () => Reflect.apply(inferenceDiagnostic, undefined, [admitted, metadata, () => {
      if (failure === 'supplier') throw new Error('CAPTURE_UNAVAILABLE');
      return raw;
    }]);
    const success = async () => { diagnostic(); return new Response('UNCHANGED_BYTES', { status: 201 }); };
    const response = await success(); expect(response.status).toBe(201); expect(await response.text()).toBe('UNCHANGED_BYTES');
    const original = new Error('ORIGINAL_WORK_FAILURE');
    const failed = async () => { try { throw original; } catch (error) { diagnostic(); throw error; } };
    await expect(failed()).rejects.toBe(original);
    if (failure !== 'console') expect(JSON.stringify(records())).toMatch(/unavailable/i);
  });
});
