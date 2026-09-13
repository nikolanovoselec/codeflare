import { describe, expect, it, vi } from 'vitest';
import { discoverPiCompatibility, type DiscoveryInput } from '../../lib/reasoning-discovery';
import { getBuiltInProfile } from '../../lib/reasoning-profiles';
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

describe('REQ-ENTERPRISE-074: target-bound capability discovery', () => {
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
