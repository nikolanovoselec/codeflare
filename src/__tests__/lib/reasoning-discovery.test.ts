import { describe, expect, it, vi } from 'vitest';

async function discoverySubject(): Promise<any> {
  const modulePath = '../../lib/reasoning-discovery';
  return import(modulePath);
}

async function inventorySubject(): Promise<any> {
  const modulePath = '../../lib/dynamic-route-inventory';
  return import(modulePath);
}

const meshGraph = [
  { id: 'start', type: 'start', outputs: { next: { elementId: 'split' } } },
  { id: 'split', type: 'conditional', properties: { conditions: { $and: [] } }, outputs: { true: { elementId: 'mesh' }, false: { elementId: 'kimi' } } },
  { id: 'mesh', type: 'model', properties: { provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh' }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'glm' } } },
  { id: 'kimi', type: 'model', properties: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } } },
  { id: 'glm', type: 'model', properties: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'end' } } },
  { id: 'end', type: 'end', outputs: {} },
];

describe('REQ-ENTERPRISE-031 dynamic-route inventory', () => {
  it('finds every conditional and fallback model and accepts mixed terminal sentinels', async () => {
    const { inventoryDynamicRoute } = await inventorySubject();
    const result = inventoryDynamicRoute({ versionId: 'route-v1', elements: meshGraph });
    expect(result.models.map((model: any) => [model.nodeId, model.provider, model.model])).toEqual(expect.arrayContaining([
      ['mesh', 'custom-codeflare-inference-mesh', 'codeflare-mesh'],
      ['glm', 'workers-ai', '@cf/zai-org/glm-5.3'],
      ['kimi', 'workers-ai', '@cf/moonshotai/kimi-k2.6'],
    ]));
    expect(result.models).toHaveLength(3);
    expect(result.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ branches: ['true', 'fallback'], modelNodeId: 'glm' }),
      expect.objectContaining({ branches: ['false'], modelNodeId: 'kimi' }),
    ]));
  });

  it('rejects cycles and unresolved non-terminal edges instead of truncating', async () => {
    const { inventoryDynamicRoute } = await inventorySubject();
    expect(() => inventoryDynamicRoute({ versionId: 'cycle', elements: [
      { id: 'start', type: 'start', outputs: { next: { elementId: 'again' } } },
      { id: 'again', type: 'conditional', outputs: { true: { elementId: 'again' } } },
    ] })).toThrow(/cycle/i);
    expect(() => inventoryDynamicRoute({ versionId: 'dangling', elements: [
      { id: 'start', type: 'start', outputs: { next: { elementId: 'missing-model' } } },
    ] })).toThrow(/unresolved/i);
  });

  it('derives only byte-identical common mappings with current tool/replay evidence', async () => {
    const { deriveCommonMapping } = await inventorySubject();
    const shared = { removePaths: ['reasoning_effort'], writes: [{ path: 'chat_template_kwargs.enable_thinking', value: true }] };
    const result = deriveCommonMapping([
      { nodeId: 'a', evidence: { current: true, toolReplay: true }, levels: { medium: shared, off: { removePaths: [], writes: [{ path: 'x', value: false }] } } },
      { nodeId: 'b', evidence: { current: true, toolReplay: true }, levels: { medium: shared } },
      { nodeId: 'c', evidence: { current: false, toolReplay: true }, levels: { medium: shared } },
    ]);
    expect(result.levels).toEqual({});
    expect(result.warnings).toContain('stale_leg_evidence');
  });
});

describe('REQ-ENTERPRISE-031 deterministic Pi discovery', () => {
  it('preserves the Pi 0.84.4 canary version and prototype accounting semantics', async () => {
    const subject = await discoverySubject();
    expect(subject.PI_WIRE_CANARY_VERSION).toBe('pi-openai-completions-0.84.4-canary-v1');
    const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const report = await subject.discoverPiCompatibility({
      route: 'dynamic/test',
      profile: { supportedLevels: ['off'], levels: { off: {} }, removePaths: [] },
      maxCompletionTokens: 32,
      endpoint: { rest: 'https://example.invalid/rest', compat: 'https://example.invalid/compat' },
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.accounting).toMatchObject({ httpAttempts: 1 });
    expect(report.classification).toMatch(/inconclusive/i);
  });

  it('rejects an excessive ceiling before provider I/O and never retries prohibited failures', async () => {
    const { discoverPiCompatibility } = await discoverySubject();
    const fetcher = vi.fn();
    await expect(discoverPiCompatibility({ route: 'dynamic/test', profile: {}, maxCompletionTokens: 16_385, fetcher }))
      .rejects.toThrow(/ceiling|16384/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
