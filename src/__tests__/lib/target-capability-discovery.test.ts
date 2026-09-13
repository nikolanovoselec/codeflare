import { describe, expect, it, vi } from 'vitest';
import { capabilityCandidates, discoverTargetCapabilities } from '../../lib/ai-capability-discovery';
import { MAX_CAPABILITY_SUBMISSIONS } from '../../lib/ai-capability-discovery/contract';
import { normalizeCustomProfile, translateRuntimeReasoningRequest } from '../../lib/reasoning-profiles';

// Synthetic wire fixtures. Unknown marketing names prove absence of name
// coupling, not that an unreleased model is available or live certified.
const coordinates = { accountId: 'a'.repeat(32), gatewayId: 'synthetic', apiToken: 'synthetic-token' };
const tool = { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-call', type: 'function',
  function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] };
function response(body: any, cache = 'MISS', evidence: { model?: string; reasoningContent?: string; reasoningTokens?: number } = {}) {
  const isTool = Array.isArray(body.tools) && !body.messages.some((message: any) => message.role === 'tool');
  const message: any = isTool ? tool : { role: 'assistant', content: 'Synthetic public result.',
    ...(evidence.reasoningContent !== undefined && { reasoning_content: evidence.reasoningContent }) };
  const finish_reason = isTool ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 8192, completion_tokens: 16,
    ...(evidence.reasoningTokens !== undefined && { completion_tokens_details: { reasoning_tokens: evidence.reasoningTokens } }) };
  const headers = { 'cf-aig-cache-status': cache, 'cf-aig-provider': 'synthetic-provider', 'cf-aig-model': evidence.model ?? 'never-listed-model-2099' };
  if (!body.stream) return Response.json({ choices: [{ message, finish_reason }], usage }, { headers });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { ...message, ...(isTool && { tool_calls: message.tool_calls!.map((call: any) => ({ ...call, index: 0 })) }) }, finish_reason }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { ...headers, 'content-type': 'text/event-stream' } });
}

// Reject the two provider-default candidates at the HTTP boundary, then exercise
// the real finite enabled mapping: reasoning, tool call, replay, cache fill/read.
function enabledMappingFetcher(evidence: Parameters<typeof response>[2]) {
  let enabledCalls = 0;
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    if (body.reasoning_effort !== 'medium') return Response.json({ error: { code: 'invalid_parameter' } }, { status: 400 });
    const stage = enabledCalls++ % 5;
    return response(body, stage === 4 ? 'HIT' : 'MISS', stage === 0 ? evidence : {});
  });
}

// Cold, genuinely separated public deltas: framing a buffered answer as SSE
// must not be enough to establish incremental delivery.
function coldIncrementalResponse(body: any, cache = 'MISS'): Response {
  if (body.tools || !body.stream) return response(body, cache);
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic ' }, finish_reason: null }] })}\n\n`));
    await new Promise((resolve) => setTimeout(resolve, 12));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'public result.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8192, completion_tokens: 16 } })}\n\ndata: [DONE]\n\n`));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'cf-aig-cache-status': cache,
    'cf-aig-provider': 'synthetic-provider', 'cf-aig-model': 'never-listed-model-2099' } });
}

describe('REQ-ENTERPRISE-074 dedicated target capability discovery', () => {
  it('REQ-ENTERPRISE-035: keeps a working streaming Dynamic path assignable without cache reuse or buffered cache chasing', async () => {
    const bodies: any[] = [];
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/never-listed-route', maxCompletionTokens: 2048,
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        // A buffered candidate WOULD get HIT. It must never be submitted merely
        // to improve cache evidence after streaming tools and exact replay work.
        return coldIncrementalResponse(body, body.stream ? 'MISS' : 'HIT');
      } });
    expect(result.assignable).toBe(true);
    expect(result.profile?.compatibility?.response).toBe('stream');
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: 'compat', tools: true, replay: true,
      reasoning: 'provider-default', streaming: 'incremental', cache: 'inconclusive' }] });
    expect(result.capabilities).not.toHaveProperty('grade');
    // Outbound submissions are a cost/transport contract, not an internal spy count.
    expect(bodies.map((body) => body.stream)).toEqual([true, true, true, true]);
    expect(result.accounting.httpAttempts).toBe(4);
    expect(bodies[1].messages.at(-2)).toEqual({ role: 'assistant', tool_calls: tool.tool_calls });
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'synthetic-call', content: 'ok' });
    expect(bodies[2]).toEqual(bodies[3]);
    expect(result.attempts).toHaveLength(1);
  });

  it('REQ-ENTERPRISE-083: reports Gateway HIT separately without inventing input caching or a grade', async () => {
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/never-listed-cache-route', maxCompletionTokens: 2048,
      fetcher: async (_url, init) => response(JSON.parse(String(init?.body)), 'HIT') });
    expect(result.assignable).toBe(true);
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: [{ levels: [], transport: 'compat', tools: true, replay: true,
      cache: 'gateway-response', reasoning: 'provider-default', streaming: 'not-observed' }] });
    expect(result.capabilities).not.toHaveProperty('grade');
    expect(result).not.toHaveProperty('grade');
    for (const attempt of result.attempts) expect(attempt.capabilities).not.toHaveProperty('grade');
    expect(result.profile).toEqual(normalizeCustomProfile(result.profile));
  });

  it.each([
    { reasoningContent: 'private enabled-reasoning evidence', reasoning: 'observed-enabled' },
    { reasoningContent: '', reasoning: 'accepted-unverified' },
  ])('REQ-ENTERPRISE-075: returns independent $reasoning capability rows without input caching while retaining seven Dynamic preferences', async ({ reasoningContent, reasoning }) => {
    const bodies: any[] = [];
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/unknown-independent-capabilities', maxCompletionTokens: 2048,
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (body.reasoning_effort !== 'medium') return Response.json({ error: { code: 'invalid_parameter' } }, { status: 400 });
        return response(body, 'MISS', { reasoningContent });
      } });
    expect(result.assignable).toBe(true);
    expect(result.profile?.levels.medium).toEqual([{ path: 'reasoning_effort', value: 'medium' }]);
    expect(result.capabilities).toEqual({ schemaVersion: 2, mappings: [{ levels: ['medium'], transport: 'compat', tools: true, replay: true,
      reasoning, cache: 'inconclusive', streaming: 'not-observed' }] });
    expect(result.capabilities).not.toHaveProperty('grade');
    expect(JSON.stringify(result)).not.toContain('private enabled-reasoning evidence');
    // No second enabled buffered campaign after a complete working stream contract.
    expect(bodies.filter((body) => body.reasoning_effort === 'medium').map((body) => body.stream)).toEqual([true, true, true, true, true]);
    for (const preference of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const translated = translateRuntimeReasoningRequest({ messages: [{ role: 'user', content: 'Synthetic preference canary.' }],
        reasoning_effort: preference }, result.profile!, 'medium');
      expect(translated).toEqual({ messages: [{ role: 'user', content: 'Synthetic preference canary.' }], reasoning_effort: 'medium' });
    }
  });

  it('automatically returns a canonical shared configuration and independent evidence, not a profile shopping list', async () => {
    const bodies: any[] = [];
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/never-listed-route', maxCompletionTokens: 256,
      fetcher: vi.fn(async (_url, init) => { const body = JSON.parse(String(init!.body)); bodies.push(body); return response(body, bodies.length === 4 ? 'HIT' : 'MISS'); }) });
    expect(result.assignable).toBe(true);
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ tools: true, replay: true, cache: 'gateway-response', reasoning: 'provider-default' }] });
    expect(result).not.toHaveProperty('matchedProfiles');
    expect(result.profile).toEqual(normalizeCustomProfile(result.profile));
    expect(result.profile!.id).not.toContain('never-listed');
    expect(result.profile!.reasoningMode).toBe('provider-default');
    expect(bodies[1].messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'synthetic-call')).toBe(true);
    expect(bodies[2]).toEqual(bodies[3]);
    expect(bodies).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(coordinates.apiToken);
  });

  it('finds a buffered working contract when SSE does not yield a tool call, without pretending it streams', async () => {
    const bodies: any[] = [];
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/future-bedrock-route', maxCompletionTokens: 256,
      fetcher: vi.fn(async (_url, init) => { const body = JSON.parse(String(init!.body)); bodies.push(body);
        if (body.stream) return response({ ...body, tools: undefined });
        return response(body, bodies.filter((item) => !item.stream).length === 4 ? 'HIT' : 'MISS'); }) });
    expect(result.assignable).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.profile!.compatibility).toEqual({ response: 'buffered', toolNames: 'repeated-complete', transport: 'compat' });
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ cache: 'gateway-response', streaming: 'not-observed' }] });
    expect(bodies.filter((body) => !body.stream)).toHaveLength(4);
  });

  it('REQ-ENTERPRISE-035: classifies a buffered Dynamic native envelope as unexpected response format without replay or qualification', async () => {
    const bodies: any[] = [];
    const privateText = 'Synthetic redacted native content, not an incident quotation.';
    const responseId = 'synthetic-buffered-native-response-id';
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      expect(String(url)).toBe(`https://gateway.ai.cloudflare.com/v1/${coordinates.accountId}/${coordinates.gatewayId}/compat/chat/completions`);
      expect(new Headers(init?.headers).get('cf-aig-max-attempts')).toBe('1');
      if (body.stream) return response({ ...body, tools: undefined }); // Valid framing, but no required tool call.
      // Synthetic content-redacted envelope derived from the incident projection's
      // native field shape and tool_use stop. Not an original captured response,
      // nor evidence that Dynamic supports a native adapter.
      return Response.json({ model: 'anthropic/claude-opus-5', id: responseId, type: 'message', role: 'assistant',
        content: [{ type: 'text', text: privateText },
          { type: 'tool_use', id: 'synthetic-native-call', name: 'codeflare_profile_canary', input: { value: 'ok' } }],
        stop_reason: 'tool_use', stop_sequence: null, stop_details: null,
        usage: { input_tokens: 445, output_tokens: 55, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }, { status: 200 });
    });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/buffered-native-envelope', maxCompletionTokens: 2048, fetcher });

    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    expect(result.profile).toBeUndefined();
    expect(result.report).toBeUndefined();
    // One stream without the required tool call, then one buffered submission:
    // no replay of the incompatible envelope, retry, or native/other-contract fallback.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.accounting.httpAttempts).toBe(2);
    expect(bodies.map((body) => body.stream)).toEqual([true, false]);
    expect(bodies[1].tools[0].function.name).toBe('codeflare_profile_canary');
    expect(bodies[1].messages.map((message: any) => message.role)).toEqual(['system', 'user']);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ httpAttempts: 1,
      capabilities: { schemaVersion: 2, mappings: [{ tools: false, replay: false, cache: 'not-tested' }] } });
    expect(result.attempts[1]).toMatchObject({ httpAttempts: 1, classification: 'Inconclusive',
      capabilities: { schemaVersion: 2, mappings: [{ tools: false, replay: false, cache: 'not-tested' }] } });
    for (const forbidden of [privateText, responseId, 'synthetic-native-call', coordinates.apiToken]) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
    }
    expect(result.attempts[1].diagnostics).toEqual([expect.objectContaining({ stage: 'tool-call',
      code: 'unexpected_response_format', status: 200, transport: 'compat' })]);
    expect(result.attempts[1].diagnostics).not.toContainEqual(expect.objectContaining({ code: 'transport_error' }));
  });

  it('automatically tries a documented mapping after a default tool-call incompatibility', async () => {
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/unknown-compatible-model', maxCompletionTokens: 256,
      fetcher: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init!.body));
        if (body.reasoning_effort !== 'medium') return Response.json({ error: { code: 'invalid_parameter', message: 'synthetic rejection' } }, { status: 400 });
        return response(body, body.tools ? 'MISS' : 'HIT');
      }) });
    expect(result.assignable).toBe(true);
    expect(result.profile!.levels.medium).toEqual([{ path: 'reasoning_effort', value: 'medium' }]);
    expect(result.profile!.supportedLevels).toEqual(['medium']);
    expect(result.attempts.length).toBeGreaterThan(1);
  });

  it('does not confuse absent cache observations with proof that caching is unsupported', async () => {
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/unknown', maxCompletionTokens: 256,
      fetcher: vi.fn(async (_url, init) => response(JSON.parse(String(init!.body)))) });
    expect(result.assignable).toBe(true);
    expect(result.classification).toBe('Verified');
    expect(result.profile).toBeDefined();
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ tools: true, replay: true, cache: 'inconclusive' }] });
  });

  it('stops the campaign on authentication failure without trying another contract or transport', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'Unauthorized', message: 'private diagnostic' } }, { status: 403 }));
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/unknown', maxCompletionTokens: 256, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.assignable).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });

  it('rejects unimplemented native protocols before provider I/O', async () => {
    const fetcher = vi.fn();
    await expect(discoverTargetCapabilities({ ...coordinates, route: 'azure/future-model', maxCompletionTokens: 256, fetcher })).rejects.toThrow('supported');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports the exact failed cache stage and sanitized provider code without losing it behind an empty diagnostic list', async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_url, init) => {
      calls++;
      if (calls === 3) return Response.json({ error: { code: 'Unauthorized', type: 'authentication_error', message: 'private provider detail' } }, { status: 403 });
      return response(JSON.parse(String(init!.body)));
    });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/cache-failure', maxCompletionTokens: 256, fetcher });
    expect(result.assignable).toBe(false);
    expect(result.accounting.httpAttempts).toBe(3);
    expect(result.attempts[0].diagnostics).toContainEqual(expect.objectContaining({ stage: 'cache-fill', code: 'request_rejected', status: 403,
      providerCode: 'Unauthorized', providerType: 'authentication_error', transport: 'compat' }));
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it.each([
    { stage: 'cache-fill', failedCall: 3 },
    { stage: 'cache-read', failedCall: 4 },
  ])('stops after malformed HTTP 200 SSE at $stage without trying another contract', async ({ stage, failedCall }) => {
    const bodies: any[] = [];
    const privateBody = 'private malformed cache payload';
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      if (bodies.length === failedCall) return new Response(`data: {"private":"${privateBody}"\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
      // A later candidate would work, so continuing cannot hide behind misses.
      return response(body, body.tools ? 'MISS' : 'HIT');
    });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/malformed-cache', maxCompletionTokens: 256, fetcher });
    expect(result.attempts[0].diagnostics).toContainEqual(expect.objectContaining({ stage, code: 'malformed_response', status: 200, transport: 'compat' }));
    expect(JSON.stringify(result)).not.toContain(privateBody);
    expect(fetcher).toHaveBeenCalledTimes(failedCall);
    expect(result.accounting.httpAttempts).toBe(failedCall);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].classification).toBe('Inconclusive');
    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    expect(result.profile).toBeUndefined();
    expect(result.report).toBeUndefined();
  });

  it.each([
    { reasoningModel: 'other-backend-model', sameBackend: false },
    { reasoningModel: 'never-listed-model-2099', sameBackend: true },
  ])('qualifies token-backed reasoning with tools/cache only on the same backend ($sameBackend)', async ({ reasoningModel, sameBackend }) => {
    const fetcher = enabledMappingFetcher({ model: reasoningModel, reasoningTokens: 8 });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/reasoning-backends', maxCompletionTokens: 256,
      requireBackendIdentity: true, fetcher });
    if (sameBackend) {
      expect(result.assignable).toBe(true);
      expect(result.classification).toBe('Verified');
      expect(result.profile?.hash).toBe(capabilityCandidates(false)[2].hash);
      expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ tools: true, replay: true, cache: 'gateway-response', reasoning: 'observed-enabled' }] });
      expect(result.report?.cacheEvidence.backendIdentified).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(7);
    } else {
      expect(result.attempts[2].diagnostics).toContainEqual(expect.objectContaining({ stage: 'branch-correlation', code: 'backend_changed' }));
      expect(result.attempts[2].capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ tools: true, replay: true, cache: 'inconclusive' }] });
      expect(result.assignable).toBe(false);
      expect(result.classification).toBe('Inconclusive');
      expect(result.profile).toBeUndefined();
      expect(result.report).toBeUndefined();
    }
  });

  it.each([
    { reasoningContent: 'private synthetic reasoning content', reasoning: 'observed-enabled' },
    { reasoningContent: '', reasoning: 'accepted-unverified' },
  ])('reports reasoning content without token counters as $reasoning', async ({ reasoningContent, reasoning }) => {
    const fetcher = enabledMappingFetcher({ reasoningContent });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/reasoning-content', maxCompletionTokens: 256,
      requireBackendIdentity: true, fetcher });
    expect(result.assignable).toBe(true);
    expect(result.profile?.hash).toBe(capabilityCandidates(false)[2].hash);
    expect(result.report?.distinctMappings[0].reasoningProbe).toMatchObject({ status: 200, reasoningTokens: null,
      reasoningLength: reasoningContent.length, reasoningField: reasoningContent ? 'reasoning_content' : null });
    expect(JSON.stringify(result)).not.toContain('private synthetic reasoning content');
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ tools: true, replay: true, cache: 'gateway-response', reasoning }] });
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it('does not issue multi-backend certification when the exercised backend cannot be identified', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const result = response(JSON.parse(String(init!.body)), 'HIT');
      result.headers.delete('cf-aig-provider'); result.headers.delete('cf-aig-model');
      return result;
    });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/multiple-backends', maxCompletionTokens: 256,
      requireBackendIdentity: true, fetcher });
    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    expect(result.attempts[0].diagnostics).toContainEqual(expect.objectContaining({ code: 'observed_backend_unidentified' }));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('bounds the full finite search independently of added model names and binds wire choices to canonical identity', () => {
    const candidates = capabilityCandidates(false);
    const maximum = candidates.reduce((calls, profile) => calls + (profile.reasoningMode === 'provider-default' ? 4 : 5), 0);
    expect(maximum).toBe(38);
    expect(maximum).toBeLessThanOrEqual(MAX_CAPABILITY_SUBMISSIONS);
    const stream = candidates[0]; const buffered = candidates[1];
    expect(stream.hash).not.toBe(buffered.hash);
    expect(() => normalizeCustomProfile({ ...stream, compatibility: { ...stream.compatibility, headers: { 'x-injected': 'not-allowed' } } })).toThrow();
    expect(() => normalizeCustomProfile({ ...stream, compatibility: { ...stream.compatibility, transport: 'https://untrusted.invalid' } })).toThrow();
  });
});
