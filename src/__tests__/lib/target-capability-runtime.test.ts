import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmInterceptor } from '../../llm-interceptor';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { capabilityCandidates } from '../../lib/ai-capability-discovery';
import { checkedRouteInventory, connectionFingerprint } from '../../lib/reasoning-verification';
import { PI_WIRE_CANARY_VERSION, parsePiSseText } from '../../lib/reasoning-discovery';
import { compatibilityImagesForModels, compatibilityRequest, compatibilityResponse } from '../../lib/ai-capability-discovery/compatibility-wire';

const active = { versionId: 'synthetic-v1', elements: [
  { id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } },
  { id: 'model', type: 'model', properties: { provider: 'future-provider', model: 'synthetic-new-2099' }, outputs: { success: { elementId: 'end' } } },
] };
vi.mock('../../lib/ai-gateway-management', async (original) => ({ ...await original<typeof import('../../lib/ai-gateway-management')>(), loadActiveRouteVersion: vi.fn(async () => active) }));
afterEach(() => vi.restoreAllMocks());
function interceptor(buffered: boolean, images?: 'bedrock-native-block') {
  const profile = capabilityCandidates(false, images)[buffered ? 1 : 0];
  const kv = createMockKV();
  const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/synthetic`;
  const token = 'synthetic-token'; const inventory = checkedRouteInventory(active);
  const ref = { id: profile.id, revision: profile.revision, hash: profile.hash };
  // Explicit synthetic server receipt. This fixture is NOT live certification.
  const verification = { schemaVersion: 1, profileRef: ref, routeVersion: active.versionId, inventoryDigest: inventory.inventoryDigest,
    connectionFingerprint: connectionFingerprint({ gatewayUrl, token }), canaryVersion: PI_WIRE_CANARY_VERSION,
    supportedLevels: [], scope: inventory.scope, checkedAt: new Date().toISOString(), capabilities: { schemaVersion: 1, tools: true, replay: true,
      cache: 'gateway-response', nativePromptCache: false, reasoning: 'provider-default', streaming: 'not-observed', grade: 'Acceptable' } };
  kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['future']);
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [profile], routeAssignments: { future: { activeProfile: ref, verification } },
    fallbackRouting: { enabled: true, routes: ['future'], defaultRoute: 'future', reasoning: 'max' } });
  const env = { KV: kv, AIG_GATEWAY_URL: gatewayUrl, AIG_TOKEN: token } as unknown as Env;
  return new LlmInterceptor({ props: { user: 'synthetic@example.invalid', sessionId: 'synthetic-session' } } as unknown as ExecutionContext, env);
}
const request = () => new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'future', stream: true, stream_options: { include_usage: true }, reasoning_effort: 'max', store: false,
    prompt_cache_key: 'public-synthetic-key', messages: [{ role: 'user', content: 'Synthetic canary' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }) });

describe('REQ-ENTERPRISE-074 discovered contract runtime parity', () => {
  it('translates OpenAI data-URI images only for a verified Bedrock compatibility wire', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } };
    const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic image' }, image] }] };
    const ordinary = compatibilityRequest(payload, { response: 'stream', toolNames: 'strict', transport: 'compat' });
    const bedrock = compatibilityRequest(payload, { response: 'stream', toolNames: 'strict', transport: 'compat', images: 'bedrock-native-block' } as any);

    expect(ordinary).toEqual(payload);
    const messages = bedrock.messages as Array<{ content: unknown[] }>;
    expect(messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } });
    expect(payload.messages[0].content[1]).toEqual(image);
  });

  it('selects Bedrock image translation only for homogeneous Anthropic Bedrock inventory', () => {
    expect(compatibilityImagesForModels([
      { provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-future-v1:0' },
      { provider: 'aws-bedrock', model: 'anthropic.claude-haiku-current-v1:0' },
    ])).toBe('bedrock-native-block');
    expect(compatibilityImagesForModels([
      { provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-future-v1:0' },
      { provider: 'workers-ai', model: '@cf/future/model' },
    ])).toBeUndefined();
    expect(compatibilityImagesForModels([])).toBeUndefined();
  });

  it('dispatches a verified Bedrock discovered profile with native image blocks', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"synthetic"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const response = await interceptor(false, 'bedrock-native-block').fetch(new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        model: 'future', stream: true, messages: [{ role: 'user', content: [
          { type: 'text', text: 'Synthetic image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
        ] }],
      }),
    }));
    expect(response.status).toBe(200);
    const outbound = fetcher.mock.calls[0][0] as Request;
    const body = await outbound.clone().json() as any;
    expect(outbound.url).toContain('/compat/chat/completions');
    expect(body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } });
  });

  it('dispatches the exact verified buffered compat operation and preserves tool IDs/argument bytes for Pi', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-id', type: 'function',
        function: { name: 'lookup', arguments: '{ "value" : "ok" }' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    });
    const response = await interceptor(true).fetch(request());
    const outbound = fetcher.mock.calls[0][0] as Request;
    expect(outbound.url).toBe(`https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/synthetic/compat/chat/completions`);
    const body = await outbound.clone().json() as Record<string, unknown>;
    expect(body.model).toBe('dynamic/future'); expect(body.stream).toBe(false);
    for (const field of ['stream_options', 'store', 'prompt_cache_key', 'reasoning_effort', 'cache_control']) expect(body).not.toHaveProperty(field);
    expect(response.status).toBe(200);
    const parsed = await parsePiSseText(await response.text());
    expect(parsed.toolCalls[0]).toMatchObject({ id: 'synthetic-id', name: 'lookup', argumentsText: '{ "value" : "ok" }' });
    expect(parsed.sawDone).toBe(true); expect(parsed.effectiveFinishReason).toBe('tool_calls');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('delivers a real public delta while later text, terminal events and EOF are withheld', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await interceptor(false).fetch(request()); expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const encode = (content: string, finish_reason: string | null) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      upstream.enqueue(encode('first-public-delta', null));
      const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Buffered before stop/EOF')), 500); })]);
      expect(first.done).toBe(false); expect(new TextDecoder().decode(first.value)).toContain('first-public-delta');
      upstream.enqueue(encode('later-public-delta', 'stop')); upstream.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); upstream.close();
      let rest = ''; while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
      expect(rest).toContain('later-public-delta'); expect(rest).toContain('[DONE]');
    } finally { clearTimeout(timeout); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  });

  it('does not fabricate OpenAI success from a native envelope or missing stop reason', async () => {
    const wire = { response: 'buffered', toolNames: 'strict' } as const;
    await expect(compatibilityResponse(Response.json({ content: [], stop_reason: 'end_turn' }), wire, true)).rejects.toThrow('compatibility_not_openai_chat');
    await expect(compatibilityResponse(Response.json({ choices: [{ message: { role: 'assistant', content: 'synthetic' } }] }), wire, true)).rejects.toThrow('compatibility_not_openai_chat');
  });
});
