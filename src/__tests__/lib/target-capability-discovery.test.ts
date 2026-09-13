import { describe, expect, it, vi } from 'vitest';
import { capabilityCandidates, discoverTargetCapabilities } from '../../lib/ai-capability-discovery';
import { MAX_CAPABILITY_SUBMISSIONS } from '../../lib/ai-capability-discovery/contract';
import { normalizeCustomProfile } from '../../lib/reasoning-profiles';

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

describe('REQ-ENTERPRISE-074 dedicated target capability discovery', () => {
  it('automatically returns a canonical shared configuration and grade, not a profile shopping list', async () => {
    const bodies: any[] = [];
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/never-listed-route', maxCompletionTokens: 256,
      fetcher: vi.fn(async (_url, init) => { const body = JSON.parse(String(init!.body)); bodies.push(body); return response(body, bodies.length === 4 ? 'HIT' : 'MISS'); }) });
    expect(result.assignable).toBe(true);
    expect(result.capabilities).toMatchObject({ tools: true, replay: true, cache: 'gateway-response', reasoning: 'provider-default', grade: 'Acceptable' });
    expect(result).not.toHaveProperty('matchedProfiles');
    expect(result.profile).toEqual(normalizeCustomProfile(result.profile));
    expect(result.profile!.id).not.toContain('never-listed');
    expect(result.profile!.reasoningMode).toBe('provider-default');
    expect(bodies[1].messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'synthetic-call')).toBe(true);
    expect(bodies[2]).toEqual(bodies[3]);
    expect(bodies).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(coordinates.apiToken);
  });

  it('finds a buffered working contract when SSE does not yield cache evidence, without pretending it streams', async () => {
    const bodies: any[] = [];
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/future-bedrock-route', maxCompletionTokens: 256,
      fetcher: vi.fn(async (_url, init) => { const body = JSON.parse(String(init!.body)); bodies.push(body); return response(body, !body.stream && bodies.filter((item) => !item.stream).length === 4 ? 'HIT' : 'MISS'); }) });
    expect(result.assignable).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.profile!.compatibility).toEqual({ response: 'buffered', toolNames: 'repeated-complete', transport: 'compat' });
    expect(result.capabilities).toMatchObject({ cache: 'gateway-response', streaming: 'not-observed', grade: 'Acceptable' });
    expect(bodies.filter((body) => !body.stream)).toHaveLength(4);
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
    expect(result.assignable).toBe(false);
    expect(result.classification).toBe('Inconclusive');
    expect(result.profile).toBeUndefined();
    expect(result.explanation).toContain('cache');
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
      expect(result.capabilities).toMatchObject({ tools: true, replay: true, cache: 'gateway-response', reasoning: 'observed-enabled', grade: 'Acceptable' });
      expect(result.report?.cacheEvidence.backendIdentified).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(7);
    } else {
      expect(result.attempts[2].diagnostics).toContainEqual(expect.objectContaining({ stage: 'branch-correlation', code: 'backend_changed' }));
      expect(result.attempts[2].capabilities?.grade).toBe('Not qualified');
      expect(result.assignable).toBe(false);
      expect(result.classification).toBe('Inconclusive');
      expect(result.profile).toBeUndefined();
      expect(result.report).toBeUndefined();
    }
  });

  it.each([
    { reasoningContent: 'private synthetic reasoning content', reasoning: 'observed-enabled', grade: 'Acceptable' },
    { reasoningContent: '', reasoning: 'unverified', grade: 'Minimum' },
  ])('grades reasoning content without token counters as $reasoning', async ({ reasoningContent, reasoning, grade }) => {
    const fetcher = enabledMappingFetcher({ reasoningContent });
    const result = await discoverTargetCapabilities({ ...coordinates, route: 'dynamic/reasoning-content', maxCompletionTokens: 256,
      requireBackendIdentity: true, fetcher });
    expect(result.assignable).toBe(true);
    expect(result.profile?.hash).toBe(capabilityCandidates(false)[2].hash);
    expect(result.report?.distinctMappings[0].reasoningProbe).toMatchObject({ status: 200, reasoningTokens: null,
      reasoningLength: reasoningContent.length, reasoningField: reasoningContent ? 'reasoning_content' : null });
    expect(JSON.stringify(result)).not.toContain('private synthetic reasoning content');
    expect(result.capabilities).toMatchObject({ tools: true, replay: true, cache: 'gateway-response', reasoning, grade });
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
