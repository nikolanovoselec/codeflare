import { describe, expect, it, vi } from 'vitest';
import { discoverPiCompatibility, type DiscoveryInput } from '../../lib/reasoning-discovery';
import { getBuiltInProfile, translateRuntimeReasoningRequest } from '../../lib/reasoning-profiles';
import { adaptBedrockAnthropicResponse, buildBedrockAnthropicRequest, selectBedrockAnthropicTransport } from '../../lib/bedrock-anthropic-native-adapter';
import { discoverTargetCapabilities } from '../../lib/ai-capability-discovery';
import { bedrockChunkFrame, bedrockToolResponse } from '../helpers/bedrock-eventstream';

const input = (native = true) => ({ accountId: '0123456789abcdef0123456789abcdef', gatewayId: 'synthetic', apiToken: 'synthetic-token',
  route: native ? 'aws-bedrock/eu.anthropic.claude-synthetic-future-2099-v1:0' : 'dynamic/synthetic',
  profile: getBuiltInProfile(native ? 'bedrock-anthropic-native-provider-default' : 'dynamic-bedrock-anthropic-provider-default'),
  maxCompletionTokens: 2048, compatOnly: true, requireCacheEvidence: true,
  ...(native && { native: { model: 'eu.anthropic.claude-synthetic-future-2099-v1:0', region: 'eu-central-1', transport: 'aig-bedrock-anthropic-invoke' } }),
} as DiscoveryInput);
// Every response/signature below is synthetic, never live evidence.
const authentic = [{ type: 'thinking', thinking: 'synthetic private block', signature: 'synthetic-signature-not-live' },
  { type: 'tool_use', id: 'synthetic-call', name: 'codeflare_profile_canary', input: { value: 'ok' } }];
const final = [{ type: 'text', text: 'synthetic answer' }];

type NativeForm = 'default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const nativeForms: NativeForm[] = ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'];

// Classify only the audited provider wire forms, never the profile/model name.
function nativeForm(body: any): NativeForm | 'invalid' {
  if (body.thinking === undefined && body.output_config === undefined) return 'default';
  if (JSON.stringify(body.thinking) === '{"type":"disabled"}' && body.output_config === undefined) return 'off';
  if (JSON.stringify(body.thinking) === '{"type":"adaptive"}' && body.output_config
    && Object.keys(body.output_config).length === 1 && nativeForms.slice(2).includes(body.output_config.effort)) return body.output_config.effort;
  return 'invalid';
}

function nativeCapabilityFixture(options: {
  cache?: 'prefix' | 'gateway' | 'none';
  reject?: NativeForm[];
  offStillReasons?: boolean;
  hiddenOffThinking?: 'thinking' | 'redacted_thinking';
  replayFailure?: 'length' | 'refusal';
  cacheFailure?: 'max_tokens' | 'refusal';
  incremental?: boolean;
} = {}) {
  const requests: Array<{ url: string; headers: Headers; body: any; form: NativeForm | 'invalid'; stage: string }> = [];
  const originals = new Map<string, any[]>();
  const cacheBodies = new Map<string, number>();
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const form = nativeForm(body);
    const replay = body.messages.some((message: any) => message.content?.some?.((block: any) => block.type === 'tool_result'));
    const checkpoint = Array.isArray(body.system) && body.system.some((block: any) => block.cache_control);
    const stage = replay ? 'replay' : body.tools ? 'tool' : checkpoint ? 'cache' : 'reasoning';
    requests.push({ url: String(url), headers: new Headers(init?.headers), body, form, stage });
    if (form === 'invalid' || options.reject?.includes(form)) {
      return Response.json({ error: { code: 'ValidationException', message: 'synthetic private unsupported form' } }, { status: 400 });
    }
    const transport = String(url).endsWith('/invoke-with-response-stream') ? 'eventstream' : 'invoke';
    if (stage === 'cache') {
      const key = JSON.stringify(body);
      const read = (cacheBodies.get(key) ?? 0) > 0;
      cacheBodies.set(key, (cacheBodies.get(key) ?? 0) + 1);
      // Gateway HIT may replay old positive usage counters. Those counters must
      // not be presented as fresh native input-prefix evidence.
      const counters = options.cache === 'none' ? 0 : 8192;
      const usage = { input_tokens: 32, output_tokens: 16, cache_creation_input_tokens: read ? 0 : counters,
        cache_read_input_tokens: read ? counters : 0 };
      const stop_reason = options.cacheFailure ?? 'end_turn';
      const headers = { 'cf-aig-cache-status': options.cache === 'gateway' && read ? 'HIT' : 'MISS' };
      if (transport === 'invoke') return Response.json({ id: 'synthetic-private-cache-id', model: 'claude', content: final, stop_reason, usage }, { headers });
      const events = [
        { type: 'message_start', message: { id: 'synthetic-private-cache-id', model: 'claude', usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic answer' } },
        ...(options.incremental ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' continued' } }] : []),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason }, usage },
        { type: 'message_stop' },
      ];
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
        for (const [index, event] of events.entries()) {
          // Withhold the continuation and EOF in the synthetic upstream. A
          // transport flag or generated single-chunk SSE cannot satisfy this.
          if (options.incremental && index === 3) await new Promise((resolve) => setTimeout(resolve, 12));
          controller.enqueue(bedrockChunkFrame(event));
        }
        controller.close();
      } }), { headers: { ...headers, 'content-type': 'application/vnd.amazon.eventstream' } });
    }
    const signed = [{ type: 'thinking', thinking: `synthetic private ${form} reasoning`, signature: `synthetic-private-${form}-signature` },
      { type: 'redacted_thinking', data: `synthetic-private-${form}-redacted` }];
    const thinking = form === 'off' && !options.offStillReasons ? [] : signed;
    if (stage === 'tool') {
      const content = [...thinking, { type: 'tool_use', id: `synthetic-${form}-call`, name: 'codeflare_profile_canary', input: { value: 'ok' } }];
      originals.set(form, content);
      return bedrockToolResponse(content, transport);
    }
    if (stage === 'replay') {
      const assistant = body.messages.at(-2)?.content;
      const toolResult = body.messages.at(-1)?.content;
      if (JSON.stringify(assistant) !== JSON.stringify(originals.get(form))
        || JSON.stringify(toolResult) !== JSON.stringify([{ type: 'tool_result', tool_use_id: `synthetic-${form}-call`, content: 'ok' }])) {
        return Response.json({ error: { code: 'ValidationException', message: 'synthetic private replay mismatch' } }, { status: 400 });
      }
      if (options.replayFailure) {
        const stop_reason = options.replayFailure === 'length' ? 'max_tokens' : 'refusal';
        if (transport === 'invoke') return Response.json({ id: 'synthetic-private-failed-replay', content: final, stop_reason,
          usage: { input_tokens: 32, output_tokens: 2048 } });
        const events = [
          { type: 'message_start', message: { id: 'synthetic-private-failed-replay', usage: { input_tokens: 32 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic incomplete answer' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 2048 } }, { type: 'message_stop' },
        ];
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          for (const event of events) controller.enqueue(bedrockChunkFrame(event));
          controller.close();
        } }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
      }
      return bedrockToolResponse(final, transport);
    }
    if (form === 'off' && options.hiddenOffThinking) {
      return bedrockToolResponse([...signed.filter((block) => block.type === options.hiddenOffThinking), ...final], transport);
    }
    // Native adapters deliberately withhold private thinking text. Supply the
    // provider's measured thinking-token evidence, not an internal-engine mock
    // or an assumption that accepting an adaptive parameter proves reasoning.
    const usage = { input_tokens: 32, output_tokens: 16,
      output_tokens_details: { thinking_tokens: thinking.length ? 8 : 0 } };
    if (transport === 'invoke') return Response.json({ id: 'synthetic-private-reasoning-id', model: 'claude',
      content: [...thinking, ...final], stop_reason: 'end_turn', usage });
    const events = [
      { type: 'message_start', message: { id: 'synthetic-private-reasoning-id', model: 'claude', usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic answer' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }, { type: 'message_stop' },
    ];
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const event of events) controller.enqueue(bedrockChunkFrame(event));
      controller.close();
    } }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
  };
  return { fetcher, requests, originals };
}

describe('REQ-ENTERPRISE-074: target-bound capability discovery', () => {
  it.each([
    { transport: 'aig-bedrock-anthropic-auto', rejected: [] },
    { transport: 'aig-bedrock-anthropic-invoke', rejected: [] },
    { transport: 'aig-bedrock-anthropic-eventstream', rejected: ['xhigh', 'max'] },
  ] as const)('REQ-ENTERPRISE-074: discovers selectable native forms on an unknown model with exact replay and $transport dispatch', async ({ transport, rejected }) => {
    const fixture = nativeCapabilityFixture({ cache: 'prefix', reject: [...rejected] });
    const selected = input();
    const result = await discoverTargetCapabilities({ ...selected, native: { ...selected.native!, transport }, fetcher: fixture.fetcher });
    const expected = nativeForms.filter((form) => form !== 'default' && !rejected.some((item) => item === form));
    expect(result.assignable).toBe(true);
    // The fixture supports default too, but it is only a fallback when no
    // configurable form works, never an early exit hiding selectable controls.
    expect([...new Set(fixture.requests.filter((request) => request.stage === 'tool'
      && !rejected.some((item) => item === request.form)).map((request) => request.form))].sort()).toEqual([...expected].sort());
    expect(fixture.requests.filter((request) => request.form === 'default')).toEqual([]);
    expect(result.profile?.id).toMatch(/^bedrock-anthropic-native-discovered-[a-f0-9]{24}$/);
    expect(result.profile?.reasoningMode).not.toBe('provider-default');
    expect(result.profile?.supportedLevels.slice().sort()).toEqual([...expected, 'minimal'].sort());
    expect(result.profile?.aliases).toEqual({ minimal: 'low' });
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: expect.arrayContaining(expected.map((form) => ({
      levels: form === 'low' ? ['minimal', 'low'] : [form],
      transport: transport === 'aig-bedrock-anthropic-invoke' || (transport === 'aig-bedrock-anthropic-auto' && ['xhigh', 'max'].includes(form))
        ? 'bedrock-invoke' : 'bedrock-eventstream',
      tools: true, replay: true, reasoning: form === 'off' ? 'verified-disabled' : 'observed-enabled',
      cache: 'provider-prefix', streaming: 'not-observed',
    }))) });
    expect(result.capabilities).toHaveProperty('mappings.length', expected.length);
    expect(result.capabilities).not.toHaveProperty('grade');

    for (const form of expected) {
      const calls = fixture.requests.filter((request) => request.form === form);
      const initial = calls.filter((request) => request.stage === 'tool');
      const replay = calls.filter((request) => request.stage === 'replay');
      // Each semantic mapping needs its own successful tool turn, not copied
      // evidence or seven labels pointing at one provider-default execution.
      expect(initial).toHaveLength(1);
      expect(replay).toHaveLength(1);
      expect(replay[0].body.messages.at(-2).content).toEqual(fixture.originals.get(form));
      expect(replay[0].body.messages.at(-1).content).toEqual([{ type: 'tool_result', tool_use_id: `synthetic-${form}-call`, content: 'ok' }]);
      if (form !== 'default') expect(calls.filter((request) => request.stage === 'reasoning')).toHaveLength(1);
    }
    for (const request of fixture.requests) {
      const operation = transport === 'aig-bedrock-anthropic-invoke'
        || (transport === 'aig-bedrock-anthropic-auto' && ['xhigh', 'max'].includes(request.form)) ? 'invoke' : 'invoke-with-response-stream';
      expect(request.url).toBe(`https://gateway.ai.cloudflare.com/v1/${selected.accountId}/${selected.gatewayId}/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-synthetic-future-2099-v1%3A0/${operation}`);
      expect(request.headers.get('cf-aig-max-attempts')).toBe('1');
      expect(request.body.max_tokens).toBe(2048);
      expect(request.body).not.toHaveProperty('stream');
      expect(request.body).not.toHaveProperty('reasoning_effort');
      expect(request.form).not.toBe('invalid');
    }
    // Paid-I/O ceiling: six unique semantics plus default, not a model-list
    // scan or an extra canary for the Minimal -> Low alias.
    expect(new Set(fixture.requests.map((request) => request.form)).size).toBeLessThanOrEqual(7);
    expect(result.accounting.httpAttempts).toBe(fixture.requests.length);
    expect(fixture.requests.length).toBeLessThanOrEqual(40);
    const cachePair = fixture.requests.filter((request) => request.form === 'low' && request.stage === 'cache');
    expect(cachePair).toHaveLength(2);
    expect(cachePair[0].body).toEqual(cachePair[1].body);

    // Exercise the returned executable mappings and the actual native adapter,
    // rather than asserting that a draft merely contains effort labels.
    const profile = result.profile!;
    for (const level of profile.supportedLevels) {
      const translated = translateRuntimeReasoningRequest({ messages: [{ role: 'user', content: 'Synthetic runtime canary.' }],
        max_tokens: 2048, reasoning_effort: level }, profile, 'medium');
      const native = await buildBedrockAnthropicRequest(translated, { load: async () => null, save: async () => {} });
      const expectedForm = level === 'minimal' ? 'low' : level;
      expect(nativeForm(native)).toBe(expectedForm);
      expect(native.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Synthetic runtime canary.' }] }]);
      const configured = transport === 'aig-bedrock-anthropic-auto' ? 'auto'
        : transport === 'aig-bedrock-anthropic-invoke' ? 'invoke' : 'eventstream';
      expect(selectBedrockAnthropicTransport(configured, native.output_config?.effort)).toBe(
        configured === 'auto' ? ['xhigh', 'max'].includes(expectedForm) ? 'invoke' : 'eventstream' : configured);
    }
    for (const forbidden of ['synthetic private', 'synthetic-private-', 'synthetic-token', ...nativeForms.map((form) => `synthetic-${form}-call`)]) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
  });

  it('REQ-ENTERPRISE-072/078: preserves High incremental delivery beside XHigh and Max Invoke evidence in one native result', async () => {
    const fixture = nativeCapabilityFixture({ cache: 'prefix', incremental: true });
    const selected = input();
    const result = await discoverTargetCapabilities({ ...selected, native: { ...selected.native!, transport: 'aig-bedrock-anthropic-auto' }, fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: expect.arrayContaining([
      expect.objectContaining({ levels: ['high'], transport: 'bedrock-eventstream', streaming: 'incremental', reasoning: 'observed-enabled' }),
      expect.objectContaining({ levels: ['xhigh'], transport: 'bedrock-invoke', streaming: 'not-observed', reasoning: 'observed-enabled' }),
      expect.objectContaining({ levels: ['max'], transport: 'bedrock-invoke', streaming: 'not-observed', reasoning: 'observed-enabled' }),
    ]) });
    expect(result.profile?.supportedLevels).toEqual(expect.arrayContaining(['high', 'xhigh', 'max']));
    expect(fixture.requests.length).toBeLessThanOrEqual(40);
  });

  it('REQ-ENTERPRISE-072: uses provider default only when every configurable native form is rejected', async () => {
    const fixture = nativeCapabilityFixture({ cache: 'none', reject: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] });
    const result = await discoverTargetCapabilities({ ...input(), fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.profile?.reasoningMode).toBe('provider-default');
    expect(result.profile?.supportedLevels).toEqual([]);
    expect(result.profile?.aliases).toEqual({});
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: 'bedrock-invoke',
      tools: true, replay: true, reasoning: 'provider-default', cache: 'inconclusive', streaming: 'not-observed' }] });
    expect(fixture.requests.slice(0, 6).map((request) => request.form).sort()).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'].sort());
    expect(fixture.requests.slice(6).map((request) => [request.form, request.stage])).toEqual([
      ['default', 'tool'], ['default', 'replay'], ['default', 'cache'], ['default', 'cache'],
    ]);
    expect(result.accounting.httpAttempts).toBe(10);
  });

  it('REQ-ENTERPRISE-072: excludes rejected native controls and dangling Minimal aliases instead of borrowing default evidence', async () => {
    const fixture = nativeCapabilityFixture({ cache: 'prefix', reject: ['low', 'xhigh', 'max'] });
    const selected = input();
    const result = await discoverTargetCapabilities({ ...selected, native: { ...selected.native!, transport: 'aig-bedrock-anthropic-auto' }, fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.profile?.supportedLevels.slice().sort()).toEqual(['off', 'medium', 'high'].sort());
    expect(result.profile?.aliases).toEqual({});
    for (const level of ['low', 'minimal', 'xhigh', 'max']) expect(result.profile?.levels).not.toHaveProperty(level);
    for (const rejected of ['low', 'xhigh', 'max']) {
      expect(fixture.requests.filter((request) => request.form === rejected)).toHaveLength(1);
    }
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: expect.arrayContaining(['off', 'medium', 'high'].map((level) => ({
      levels: [level], transport: 'bedrock-eventstream', tools: true, replay: true,
      reasoning: level === 'off' ? 'verified-disabled' : 'observed-enabled', cache: 'provider-prefix', streaming: 'not-observed',
    }))) });
    expect(result.capabilities).toHaveProperty('mappings.length', 3);
    expect(JSON.stringify(result)).not.toContain('synthetic private unsupported form');
    expect(fixture.requests.length).toBeLessThanOrEqual(40);
  });

  it('REQ-ENTERPRISE-072: does not advertise Off when the disabled request still produces private thinking', async () => {
    const fixture = nativeCapabilityFixture({ cache: 'prefix', offStillReasons: true });
    const result = await discoverTargetCapabilities({ ...input(), fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.profile?.supportedLevels.slice().sort()).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].sort());
    expect(result.profile?.levels).not.toHaveProperty('off');
    expect(result.profile?.aliases).toEqual({ minimal: 'low' });
    expect(fixture.requests.filter((request) => request.form === 'off' && request.stage === 'reasoning')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('synthetic private off reasoning');
  });

  it.each([
    { transport: 'invoke', kind: 'thinking' }, { transport: 'invoke', kind: 'redacted_thinking' },
    { transport: 'eventstream', kind: 'thinking' }, { transport: 'eventstream', kind: 'redacted_thinking' },
  ] as const)('REQ-ENTERPRISE-072: private $kind without counters cannot prove Off after public stripping ($transport)', async ({ transport, kind }) => {
    const hidden = kind === 'thinking'
      ? { type: 'thinking', thinking: 'synthetic-private-hidden-thought', signature: 'synthetic-private-hidden-signature' }
      : { type: 'redacted_thinking', data: 'synthetic-private-hidden-redaction' };
    const publicResponse = await adaptBedrockAnthropicResponse(bedrockToolResponse([hidden, ...final], transport), transport,
      { load: async () => null, save: async () => {} }, true);
    const publicWire = await publicResponse.text();
    expect(publicWire).toContain('synthetic answer');
    expect(publicWire).not.toContain('synthetic-private-');
    expect(publicWire).not.toContain('reasoning_tokens');
    expect(publicWire).not.toContain('redacted_thinking');

    const fixture = nativeCapabilityFixture({ cache: 'prefix', hiddenOffThinking: kind });
    const selected = input();
    const result = await discoverTargetCapabilities({ ...selected, native: { ...selected.native!, transport: `aig-bedrock-anthropic-${transport}` }, fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.profile?.supportedLevels.slice().sort()).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].sort());
    expect(result.profile?.levels).not.toHaveProperty('off');
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max'].map((level) => ({
      levels: level === 'low' ? ['minimal', 'low'] : [level], transport: `bedrock-${transport}`, tools: true, replay: true,
      reasoning: 'observed-enabled', cache: 'provider-prefix', streaming: 'not-observed',
    }))) });
    expect(result.capabilities).toHaveProperty('mappings.length', 5);
    expect(fixture.requests.filter((request) => request.form === 'off' && request.stage === 'reasoning')).toHaveLength(1);
    for (const forbidden of ['synthetic private', 'synthetic-private-', 'synthetic-token']) expect(JSON.stringify(result)).not.toContain(forbidden);
  });

  it.each(['invoke', 'eventstream'] as const)('REQ-ENTERPRISE-075: keeps native tools and authentic replay assignable without input-cache evidence (%s)', async (transport) => {
    const fixture = nativeCapabilityFixture({ cache: 'none' });
    const selected = input();
    const result = await discoverPiCompatibility({ ...selected, native: { ...selected.native!, transport: `aig-bedrock-anthropic-${transport}` }, fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.capabilitySummary).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: `bedrock-${transport}`,
      tools: true, replay: true, reasoning: 'provider-default', cache: 'inconclusive', streaming: 'not-observed' }] });
    expect(result.capabilitySummary).not.toHaveProperty('grade');
    expect(fixture.requests.map((request) => request.stage)).toEqual(['tool', 'replay', 'cache', 'cache']);
    expect(fixture.requests[1].body.messages.at(-2).content).toEqual(fixture.originals.get('default'));
    expect(fixture.requests[2].body).toEqual(fixture.requests[3].body);
    expect(fixture.requests.every((request) => request.url.endsWith(transport === 'invoke' ? '/invoke' : '/invoke-with-response-stream'))).toBe(true);
  });

  it.each(['invoke', 'eventstream'] as const)('REQ-ENTERPRISE-083: Gateway HIT with cached provider counters never certifies native input-prefix reuse (%s)', async (transport) => {
    const fixture = nativeCapabilityFixture({ cache: 'gateway' });
    const selected = input();
    const result = await discoverPiCompatibility({ ...selected, native: { ...selected.native!, transport: `aig-bedrock-anthropic-${transport}` }, fetcher: fixture.fetcher });
    expect(result.assignable).toBe(true);
    expect(result.capabilitySummary).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: `bedrock-${transport}`,
      tools: true, replay: true, reasoning: 'provider-default', cache: 'gateway-response', streaming: 'not-observed' }] });
    expect(result.capabilitySummary).not.toHaveProperty('grade');
    expect(result.cacheEvidence.observations[1]).toMatchObject({ cacheStatus: 'HIT', cacheReadTokens: 8192 });
    expect(result.accounting.httpAttempts).toBe(4);
  });

  it.each([
    { transport: 'invoke', failure: 'length' }, { transport: 'eventstream', failure: 'length' },
    { transport: 'invoke', failure: 'refusal' }, { transport: 'eventstream', failure: 'refusal' },
  ] as const)('REQ-ENTERPRISE-035: does not accept a $failure replay as successful native tools/replay ($transport)', async ({ transport, failure }) => {
    const fixture = nativeCapabilityFixture({ replayFailure: failure });
    const selected = input();
    const result = await discoverPiCompatibility({ ...selected, native: { ...selected.native!, transport: `aig-bedrock-anthropic-${transport}` }, fetcher: fixture.fetcher });
    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    expect(result.capabilitySummary).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: `bedrock-${transport}`,
      tools: true, replay: false, reasoning: 'provider-default', cache: 'not-tested',
      streaming: expect.stringMatching(/^(?:not-observed|not-tested)$/) }] });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: failure === 'length' ? 'completion_limit' : 'provider_refusal' }));
    expect(fixture.requests.map((request) => request.stage)).toEqual(['tool', 'replay']);
    expect(JSON.stringify(result)).not.toContain('synthetic incomplete answer');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-');
  });

  it.each([
    { transport: 'invoke', failure: 'max_tokens' }, { transport: 'eventstream', failure: 'max_tokens' },
    { transport: 'invoke', failure: 'refusal' }, { transport: 'eventstream', failure: 'refusal' },
  ] as const)('REQ-ENTERPRISE-083: does not certify input caching from a $failure fill with positive writes ($transport)', async ({ transport, failure }) => {
    const fixture = nativeCapabilityFixture({ cache: 'prefix', cacheFailure: failure });
    const selected = input();
    const result = await discoverPiCompatibility({ ...selected, native: { ...selected.native!, transport: `aig-bedrock-anthropic-${transport}` }, fetcher: fixture.fetcher });
    // Optional cache failure cannot become positive input-cache evidence; the
    // already completed tool/replay facts survive independently.
    expect(result.capabilitySummary).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: `bedrock-${transport}`,
      tools: true, replay: true, reasoning: 'provider-default', cache: 'inconclusive',
      streaming: expect.stringMatching(/^(?:not-observed|not-tested)$/) }] });
    expect(result.cacheEvidence.observations).toEqual([expect.objectContaining({ valid: false, cacheWriteTokens: 8192, cacheReadTokens: 0 })]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ stage: 'cache-fill', code: failure === 'max_tokens' ? 'completion_limit' : 'provider_refusal' }));
    expect(fixture.requests.map((request) => request.stage)).toEqual(['tool', 'replay', 'cache']);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-');
  });

  it('verifies an unlisted native identifier, restores authentic replay, then measures prefix reads', async () => {
    const requests: any[] = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      const body = JSON.parse(init.body); requests.push(body);
      expect(String(url)).toContain('/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-synthetic-future-2099-v1%3A0/invoke');
      expect(body).not.toHaveProperty('stream');
      expect(body).not.toHaveProperty('thinking');
      expect(body.max_tokens).toBe(2048);
      expect(new Headers(init.headers).get('cf-aig-max-attempts')).toBe('1');
      const response = bedrockToolResponse(requests.length === 1 ? authentic : final, 'invoke');
      const data: any = await response.json();
      data.usage.cache_read_input_tokens = requests.length === 4 ? 8192 : 0;
      data.usage.cache_creation_input_tokens = requests.length === 3 ? 8192 : 0;
      return Response.json(data, { headers: { 'cf-aig-cache-status': 'MISS' } });
    });
    const result = await discoverPiCompatibility({ ...input(), fetcher });
    expect(result.assignable).toBe(true);
    expect(result.capabilitySummary).toMatchObject({ tools: true, replay: true, cache: 'provider-prefix', nativePromptCache: true,
      reasoning: 'provider-default', streaming: 'not-observed', grade: 'Acceptable' });
    expect(requests).toHaveLength(4);
    expect(requests[1].messages.at(-2).content).toEqual(authentic);
    expect(requests[2]).toEqual(requests[3]);
    expect(requests[2].system.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    const report = JSON.stringify(result);
    expect(report).not.toContain('synthetic-signature');
    expect(report).not.toContain('synthetic private block');
    expect(report).not.toContain('synthetic-token');
  });

  it.each(['selected-profile', 'normal-discovery'] as const)('REQ-ENTERPRISE-035: surfaces a sanitized cache-fill refusal after a positive write without submitting a read (%s)', async (entrypoint) => {
    const requests: Array<{ url: string; body: any; headers: Headers }> = [];
    const privateText = 'Synthetic withheld provider refusal text, not an incident quotation.';
    const responseId = 'synthetic-refused-fill-response-id';
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      if (requests.length <= 2) return bedrockToolResponse(requests.length === 1 ? authentic : final, 'eventstream');
      // Derived from the allowlisted fields in codeflare-discovery-failures-2026-09-13.md/.json.
      // Framing/CRCs, event layout, IDs and text are synthetic, NOT captured AWS wire.
      // No incident cache-status header was retained, so none is invented here.
      const events = [
        { type: 'message_start', message: { id: responseId, model: 'claude', usage: { input_tokens: 31 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: privateText } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } },
          usage: { input_tokens: 31, output_tokens: 126, cache_creation_input_tokens: 29779, cache_read_input_tokens: 0 } },
        { type: 'message_stop' },
      ];
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of events) controller.enqueue(bedrockChunkFrame(event));
        controller.close();
      } }), { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
    });
    const selected = input();
    const campaign = { ...selected, native: { ...selected.native!, transport: 'aig-bedrock-anthropic-eventstream' as const }, fetcher };
    const result: Record<string, any> = entrypoint === 'selected-profile'
      ? await discoverPiCompatibility(campaign) : await discoverTargetCapabilities(campaign);

    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    // Actual outbound submissions are a paid-I/O contract: tool + replay + fill,
    // never a paired read, retry, fallback, or another model/transport.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.accounting.httpAttempts).toBe(3);
    expect(requests.map(({ url }) => url)).toEqual(Array(3).fill(
      `https://gateway.ai.cloudflare.com/v1/${selected.accountId}/${selected.gatewayId}/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-synthetic-future-2099-v1%3A0/invoke-with-response-stream`));
    expect(requests[1].body.messages.at(-2).content).toEqual(authentic);
    expect(requests[1].body.messages.at(-1).content).toEqual([{ type: 'tool_result', tool_use_id: 'synthetic-call', content: 'ok' }]);
    expect(requests[2].body.system.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(requests[2].body).not.toHaveProperty('tools');
    for (const { body, headers } of requests) {
      expect(headers.get('cf-aig-max-attempts')).toBe('1');
      expect(body.max_tokens).toBe(2048);
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('stream');
    }
    for (const forbidden of [privateText, responseId, 'synthetic private block', 'synthetic-signature-not-live', 'synthetic-token']) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
    const capabilities = entrypoint === 'selected-profile' ? result.capabilitySummary : result.attempts[0].capabilities;
    expect(capabilities).toMatchObject({ tools: true, replay: true, cache: 'inconclusive', nativePromptCache: false, grade: 'Not qualified' });
    if (entrypoint === 'selected-profile') {
      expect(result.distinctMappings[0].toolLifecycle).toMatchObject({ passed: true, stage: 'complete' });
      expect(result.cacheEvidence.observations).toEqual([expect.objectContaining({ status: 200, valid: false,
        effectiveFinishReason: 'content_filter', promptTokens: 29810, completionTokens: 126,
        cacheWriteTokens: 29779, cacheReadTokens: 0 })]);
    } else {
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].httpAttempts).toBe(3);
      expect(result.profile).toBeUndefined();
      expect(result.report).toBeUndefined();
    }
    const diagnostics = entrypoint === 'selected-profile' ? result.diagnostics : result.attempts[0].diagnostics;
    expect(diagnostics).toEqual([expect.objectContaining({ stage: 'cache-fill', code: 'provider_refusal',
      status: 200, transport: 'bedrock-eventstream', effectiveFinishReason: 'content_filter',
      cacheWriteTokens: 29779, cacheReadTokens: 0, cacheReadAttempted: false })]);
    if (entrypoint === 'normal-discovery') {
      expect(result.explanation).toMatch(/refus/i);
      expect(result.explanation).toMatch(/cache[- ]fill/i);
      expect(result.explanation).toMatch(/29,?779/);
      expect(result.explanation).toMatch(/cache[- ]read.*(?:not (?:run|attempted|submitted)|never|unattempted)/i);
    }
  });

  it.each(['HIT', 'MISS'])('accepts Dynamic Gateway %s honestly, without native serialization or an all-branches gate', async (cache) => {
    let calls = 0;
    const fetcher = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); calls++;
      expect(typeof body.messages[0].content).toBe('string');
      expect(JSON.stringify(body)).not.toContain('cache_control');
      const delta = calls === 1 ? { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] } : { content: 'synthetic answer' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream', 'cf-aig-cache-status': calls === 4 ? cache : 'MISS', 'cf-aig-provider': 'aws-bedrock', 'cf-aig-model': 'synthetic-backend' } });
    });
    const result = await discoverPiCompatibility({ ...input(false), fetcher });
    expect(calls).toBe(4);
    expect(result.assignable).toBe(cache === 'HIT');
    expect(result.capabilitySummary).toMatchObject({ cache: cache === 'HIT' ? 'gateway-response' : 'inconclusive', nativePromptCache: false });
    if (cache === 'MISS') expect(result.classification).toBe('Inconclusive');
    expect(result.cacheEvidence.observations[1].backend).toEqual({ provider: 'aws-bedrock', model: 'synthetic-backend' });
  });

  it('does not probe cache after an authentication failure or retry another transport', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'Unauthorized', message: 'secret provider diagnostic' } }, { status: 403 }));
    const result = await discoverPiCompatibility({ ...input(), fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.assignable).toBe(false);
    expect(result.capabilitySummary).toMatchObject({ tools: false, cache: 'not-tested' });
    expect(JSON.stringify(result)).not.toContain('secret provider diagnostic');
  });

  it('does not combine tool evidence from one observed branch with cache evidence from another', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      const delta = calls === 1 ? { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] } : { content: 'synthetic answer' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'cf-aig-cache-status': calls === 4 ? 'HIT' : 'MISS', 'cf-aig-provider': 'aws-bedrock', 'cf-aig-model': calls <= 2 ? 'synthetic-tool-branch' : 'synthetic-cache-branch' } });
    });
    const result = await discoverPiCompatibility({ ...input(false), fetcher });
    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    expect(result.cacheEvidence.backendConsistent).toBe(false);
    expect(result.cacheEvidence.explanation).toContain('different');
    expect(result.distinctMappings[0].toolLifecycle.first.backend.model).toBe('synthetic-tool-branch');
  });

  it('bounds response acquisition even when a fetcher ignores AbortSignal', async () => {
    const result = await discoverPiCompatibility({ ...input(), timeoutMs: 15, fetcher: vi.fn(() => new Promise<Response>(() => {})) });
    expect(result.assignable).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'timeout' })]));
  }, 1000);
});
