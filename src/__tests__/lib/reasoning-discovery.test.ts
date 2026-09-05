import { describe, expect, it, vi } from 'vitest';
import {
  PI_WIRE_CANARY_VERSION,
  applyProfileMapping,
  buildInitialPiRequest,
  buildPiReplayMessages,
  discoverPiCompatibility,
  parsePiSseText,
} from '../../lib/reasoning-discovery';
import { deriveCommonMapping, inventoryDynamicRoute } from '../../lib/dynamic-route-inventory';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const PROFILE = {
  id: 'mesh-binary',
  supportedLevels: ['off', 'medium', 'max'],
  removePaths: ['reasoning_effort', 'chat_template_kwargs.enable_thinking'],
  levels: {
    off: [{ path: 'chat_template_kwargs.enable_thinking', value: false }],
    medium: [{ path: 'chat_template_kwargs.enable_thinking', value: true }],
    max: [{ path: 'chat_template_kwargs.enable_thinking', value: true }],
  },
};

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function successfulFetcher(captured: Array<{ url: string; body: Record<string, unknown>; headers: Headers }>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    captured.push({ url: String(input), body, headers: new Headers(init?.headers) });
    const enabled = body.chat_template_kwargs?.enable_thinking === true;
    if (!body.tools) {
      return sse([
        { id: 'complete-response-id', choices: [{ delta: { content: 'generated-answer', ...(enabled ? { reasoning_content: 'generated-reasoning' } : {}) }, finish_reason: null }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
        '[DONE]',
      ]);
    }
    const replay = body.messages.some((message: { role?: string }) => message.role === 'tool');
    if (!replay) {
      return sse([
        { choices: [{ delta: enabled ? { reasoning_content: 'generated-reasoning' } : {}, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'private-call-id', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }, finish_reason: null }] },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
        '[DONE]',
      ]);
    }
    return sse([
      { choices: [{ delta: { content: 'generated-final' }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } },
      '[DONE]',
    ]);
  });
}

describe('REQ-ENTERPRISE-033 deterministic Pi discovery', () => {
  it('preserves the validated Pi 0.84.4 canary request and replay fixtures', async () => {
    expect(PI_WIRE_CANARY_VERSION).toBe('pi-openai-completions-0.84.4-canary-v1');
    const mapped = applyProfileMapping({ reasoning_effort: 'high', messages: [] }, PROFILE, 'off');
    expect(mapped).toEqual({ messages: [], chat_template_kwargs: { enable_thinking: false } });

    const initial = buildInitialPiRequest({
      route: 'dynamic/test',
      mapping: { chat_template_kwargs: { enable_thinking: true } },
      maxCompletionTokens: 16_384,
      sessionId: 'profile-discovery-v1',
    });
    expect(initial).toMatchObject({
      model: 'dynamic/test',
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: 16_384,
      tools: [{ type: 'function', function: { name: 'codeflare_profile_canary', strict: false } }],
    });

    const parsed = await parsePiSseText([
      'data: {"id":"must-not-leak","choices":[{"delta":{"reasoning_content":"think","reasoning":"duplicate"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-private","type":"function","function":{"name":"codeflare_profile_canary","arguments":"{\\"value\\":\\"ok\\"}"}}]},"finish_reason":null}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'));
    expect(parsed).toMatchObject({ effectiveFinishReason: 'tool_calls', finishReasonRepaired: true, sawDone: true });
    expect(parsed.reasoningBlocks).toEqual([{ signature: 'reasoning_content', text: 'think' }]);
    const replay = buildPiReplayMessages(initial.messages, parsed);
    expect(replay.at(-2)).toMatchObject({
      role: 'assistant',
      reasoning_content: 'think',
      tool_calls: [{ id: 'call-private', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }],
    });
    expect(replay.at(-1)).toEqual({ role: 'tool', content: 'ok', tool_call_id: 'call-private' });
  });

  it('counts one reasoning probe and one complete tool lifecycle per distinct semantic mapping', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fetcher = successfulFetcher(requests);
    const report = await discoverPiCompatibility({
      accountId: ACCOUNT_ID,
      gatewayId: 'gateway',
      apiToken: 'secret-token',
      route: 'dynamic/test',
      profile: PROFILE,
      maxCompletionTokens: 32,
      fetcher,
    });

    expect(requests).toHaveLength(6);
    expect(report.accounting).toEqual({ logicalProbes: 4, httpAttempts: 6, promptTokens: 24, completionTokens: 20, totalTokens: 44 });
    expect(report.piCompatibility).toEqual({ status: 'verified', verifiedLevels: ['off', 'medium', 'max'], failedLevels: [] });
    expect(report.reasoningConfiguration.off).toBe('verified-disabled');
    expect(report.classification).toBe('Verified');
  });

  it('uses compat only after fully consuming an exact REST 404 and strips only REST-incompatible fields', async () => {
    const calls: Array<{ compat: boolean; body: Record<string, unknown>; headers: Headers }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const compat = String(input).includes('/compat/');
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      calls.push({ compat, body, headers: new Headers(init?.headers) });
      if (!compat) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"errors":[{"code":7003}]}'));
            controller.close();
          },
        }), { status: 404 });
      }
      if (!body.tools) return sse([{ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }, '[DONE]']);
      if (!body.messages.some((message: { role?: string }) => message.role === 'tool')) {
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'private', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']);
      }
      return sse([{ choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }] }, '[DONE]']);
    });

    const report = await discoverPiCompatibility({
      accountId: ACCOUNT_ID,
      gatewayId: 'gateway',
      apiToken: 'secret-token',
      route: 'dynamic/compat-only',
      profile: { id: 'off-only', supportedLevels: ['off'], levels: { off: [{ path: 'reasoning_effort', value: null }] }, removePaths: [] },
      maxCompletionTokens: 32,
      fetcher,
    });

    expect(report.accounting).toMatchObject({ logicalProbes: 2, httpAttempts: 6 });
    expect(calls.map((call) => call.compat)).toEqual([false, true, false, true, false, true]);
    for (const call of calls.filter((item) => item.compat)) {
      expect(call.body).not.toHaveProperty('store');
      expect(call.body).not.toHaveProperty('prompt_cache_key');
      expect(call.body).toHaveProperty('stream', true);
      expect(call.body).toHaveProperty('stream_options');
      expect(call.headers.get('authorization')).toBeNull();
      expect(call.headers.get('cf-aig-authorization')).toBe('Bearer secret-token');
    }
  });

  it.each([400, 401, 403, 429, 500, 503])('stops after prohibited HTTP %s without fallback or another logical probe', async (status) => {
    const fetcher = vi.fn(async () => Response.json({ errors: [{ code: 7003, message: 'private provider body' }] }, { status }));
    const report = await discoverPiCompatibility({
      endpoint: { rest: 'https://example.invalid/rest', compat: 'https://example.invalid/compat' },
      apiToken: 'secret-token',
      route: 'dynamic/test',
      profile: PROFILE,
      maxCompletionTokens: 32,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.accounting).toEqual({ logicalProbes: 1, httpAttempts: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(report.classification).toBe('Inconclusive');
    expect(JSON.stringify(report)).not.toContain('private provider body');
  });

  it('classifies a per-attempt timeout without retrying or exposing the transport error', async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private transport failure')), { once: true });
    }));
    const report = await discoverPiCompatibility({
      endpoint: { rest: 'https://example.invalid/rest', compat: 'https://example.invalid/compat' },
      apiToken: 'secret-token',
      route: 'dynamic/test',
      profile: PROFILE,
      maxCompletionTokens: 32,
      timeoutMs: 1,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      classification: 'Inconclusive',
      accounting: { logicalProbes: 1, httpAttempts: 1 },
      distinctMappings: [{ reasoningProbe: { status: null, code: 'timeout' }, toolLifecycle: { stage: 'not-run' } }],
    });
    expect(JSON.stringify(report)).not.toContain('private transport failure');
  });

  it('rejects excessive ceilings and reasoning-probe budgets before provider I/O', async () => {
    const fetcher = vi.fn();
    await expect(discoverPiCompatibility({ route: 'dynamic/test', profile: PROFILE, maxCompletionTokens: 16_385, fetcher }))
      .rejects.toThrow(/ceiling|16384/i);

    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
    await expect(discoverPiCompatibility({
      route: 'dynamic/test',
      profile: {
        id: 'too-many-mappings',
        supportedLevels: levels,
        levels: Object.fromEntries(levels.map((level, index) => [level, [{ path: 'reasoning_effort', value: index }]])),
      },
      maxCompletionTokens: 32,
      apiToken: 'secret-token',
      endpoint: { rest: 'https://example.invalid/rest', compat: 'https://example.invalid/compat' },
      fetcher,
    })).rejects.toThrow(/five|reasoning probe/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns sanitized non-activating evidence with no credentials, generated text, response IDs, or error bodies', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const report = await discoverPiCompatibility({
      accountId: ACCOUNT_ID,
      gatewayId: 'gateway',
      apiToken: 'secret-token',
      route: 'dynamic/test',
      profile: PROFILE,
      maxCompletionTokens: 32,
      fetcher: successfulFetcher(requests),
    });
    const serialized = JSON.stringify(report);
    for (const forbidden of ['secret-token', 'generated-answer', 'generated-reasoning', 'generated-final', 'private-call-id', 'complete-response-id']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(report).not.toHaveProperty('activated');
    expect(report.normalizedDraft).toMatchObject({ schemaVersion: 1, profileId: 'mesh-binary', classification: 'Verified' });
  });
});

const meshGraph = [
  { id: 'start', type: 'start', outputs: { next: { elementId: 'split' } } },
  { id: 'split', type: 'conditional', properties: { conditions: { $and: [] } }, outputs: { true: { elementId: 'mesh' }, false: { elementId: 'kimi' } } },
  { id: 'mesh', type: 'model', properties: { provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh' }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'glm' } } },
  { id: 'kimi', type: 'model', properties: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } } },
  { id: 'glm', type: 'model', properties: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'end' } } },
  { id: 'end', type: 'end', outputs: {} },
];

describe('REQ-ENTERPRISE-033 dynamic-route inventory', () => {
  it('finds every conditional and fallback model while accepting mixed end/END sentinels', () => {
    const result = inventoryDynamicRoute({ versionId: 'route-v1', elements: meshGraph });
    expect(result).toEqual({
      schemaVersion: 1,
      versionId: 'route-v1',
      models: [
        { nodeId: 'mesh', provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh' },
        { nodeId: 'glm', provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' },
        { nodeId: 'kimi', provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' },
      ],
      paths: [
        { modelNodeId: 'mesh', branches: ['true'] },
        { modelNodeId: 'glm', branches: ['true', 'fallback'] },
        { modelNodeId: 'kimi', branches: ['false'] },
      ],
      reachableNodeCount: 5,
    });
  });

  it('retains every path when branches converge before a downstream model', () => {
    const result = inventoryDynamicRoute({ versionId: 'route-v1', elements: [
      { id: 'start', type: 'start', outputs: { next: { elementId: 'split' } } },
      { id: 'split', type: 'conditional', outputs: { true: { elementId: 'join' }, false: { elementId: 'join' } } },
      { id: 'join', type: 'conditional', outputs: { next: { elementId: 'model' } } },
      { id: 'model', type: 'model', properties: { provider: 'workers-ai', model: 'shared' }, outputs: { success: { elementId: 'end' } } },
    ] });
    expect(result.paths).toEqual([
      { modelNodeId: 'model', branches: ['true'] },
      { modelNodeId: 'model', branches: ['false'] },
    ]);
  });

  it.each([
    ['cycle', [
      { id: 'start', type: 'start', outputs: { next: { elementId: 'again' } } },
      { id: 'again', type: 'conditional', outputs: { true: { elementId: 'again' } } },
    ], 'inventory_cycle'],
    ['unresolved', [{ id: 'start', type: 'start', outputs: { next: { elementId: 'missing-model' } } }], 'inventory_unresolved_edge'],
    ['duplicate', [{ id: 'start', type: 'start', outputs: {} }, { id: 'start', type: 'end', outputs: {} }], 'inventory_duplicate_node'],
    ['missing-start', [{ id: 'model', type: 'model', properties: { provider: 'workers-ai', model: 'x' }, outputs: {} }], 'inventory_missing_start'],
    ['malformed', [{ id: 'start', type: 'start', outputs: { next: { target: 'model' } } }], 'inventory_malformed_graph'],
  ])('rejects %s graphs with a sanitized structural code', (_name, elements, code) => {
    try {
      inventoryDynamicRoute({ versionId: 'route-v1', elements });
      throw new Error('inventory unexpectedly accepted malformed input');
    } catch (error) {
      expect(error).toMatchObject({ code });
      expect(JSON.stringify(error)).not.toContain('missing-model');
    }
  });

  it('derives only byte-identical levels with current compatible tool/replay evidence', () => {
    const shared = { removePaths: ['reasoning_effort'], writes: [{ path: 'chat_template_kwargs.enable_thinking', value: true }] };
    expect(deriveCommonMapping([
      { nodeId: 'a', evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' }, levels: { medium: shared } },
      { nodeId: 'b', evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' }, levels: { medium: shared } },
    ])).toEqual({ levels: { medium: shared }, warnings: [], classification: 'Verified' });

    const stale = deriveCommonMapping([
      { nodeId: 'a', evidence: { current: true, toolReplay: true }, levels: { medium: shared } },
      { nodeId: 'b', evidence: { current: false, toolReplay: true }, levels: { medium: shared } },
    ]);
    expect(stale).toEqual({ levels: {}, warnings: ['stale_leg_evidence'], classification: 'Inconclusive' });

    const heterogeneous = deriveCommonMapping([
      { nodeId: 'a', evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' }, levels: { medium: shared } },
      { nodeId: 'b', evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' }, levels: { medium: { ...shared, writes: [{ path: 'chat_template_kwargs.enable_thinking', value: false }] } } },
    ]);
    expect(heterogeneous).toEqual({ levels: {}, warnings: ['heterogeneous_level_mapping'], classification: 'Heterogeneous' });

    expect(deriveCommonMapping([
      { nodeId: 'a', evidence: { current: true, toolReplay: true }, levels: { medium: shared } },
    ])).toEqual({ levels: {}, warnings: ['incompatible_ingress'], classification: 'Inconclusive' });
  });
});
