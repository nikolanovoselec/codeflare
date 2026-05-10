import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';

const { mockFetch, mockCreateR2Client, mockGetR2Url, testState } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
      key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
    ),
    testState: {
      // Five-doc fixture isolating the tier-gating dimension:
      //   - common rule (default + advanced, NOT context-mode) - never gated
      //   - codeflare-hooks plugin (advanced, NOT context-mode)  - mode-only gate
      //   - context-mode plugin manifest (advanced, IS context-mode)
      //   - context-mode hooks.json (advanced, IS context-mode)
      //   - context-mode README (advanced, IS context-mode)
      agentDocs: [
        {
          key: '.claude/rules/common.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Common',
          modes: ['default', 'advanced'] as ('default' | 'advanced')[],
        },
        {
          key: '.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json',
          contentType: 'application/json; charset=utf-8',
          content: '{"name":"codeflare-hooks"}',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
        {
          key: '.claude/plugins/context-mode/.claude-plugin/plugin.json',
          contentType: 'application/json; charset=utf-8',
          content: '{"name":"context-mode","version":"1.0.111"}',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
        {
          key: '.claude/plugins/context-mode/hooks/hooks.json',
          contentType: 'application/json; charset=utf-8',
          content: '{"hooks":{}}',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
        {
          key: '.claude/plugins/context-mode/README.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# context-mode',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
      ],
    },
  };
});

vi.mock('../../lib/r2-client', () => ({
  createR2Client: mockCreateR2Client,
  getR2Url: mockGetR2Url,
}));

vi.mock('../../lib/tutorial-seed.generated', () => ({
  SEEDED_DOCUMENTS: [],
}));

vi.mock('../../lib/agent-seed.generated', () => ({
  get AGENTS_SEEDED_CONFIGS() {
    return testState.agentDocs;
  },
}));

import {
  getConfigsForMode,
  getPreseedKeysNotInMode,
  reconcileAgentConfigs,
} from '../../lib/r2-seed';

const env = {
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
} as unknown as Env;
const endpoint = 'https://test.r2.cloudflarestorage.com';
const bucket = 'test-bucket';

describe('getConfigsForMode tier gating', () => {
  it('contextModeEnabled=true returns full advanced set including context-mode files', () => {
    const docs = getConfigsForMode('advanced', true);
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
    expect(keys).toContain('.claude/plugins/context-mode/hooks/hooks.json');
    expect(keys).toContain('.claude/plugins/context-mode/README.md');
    expect(keys).toContain('.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json');
    expect(keys).toContain('.claude/rules/common.md');
    expect(docs).toHaveLength(5);
  });

  it('contextModeEnabled=false strips ALL context-mode keys but keeps other advanced files', () => {
    const docs = getConfigsForMode('advanced', false);
    const keys = docs.map((d) => d.key);
    expect(keys).not.toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
    expect(keys).not.toContain('.claude/plugins/context-mode/hooks/hooks.json');
    expect(keys).not.toContain('.claude/plugins/context-mode/README.md');
    // Non-context-mode advanced files still present:
    expect(keys).toContain('.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json');
    expect(keys).toContain('.claude/rules/common.md');
    expect(docs).toHaveLength(2);
  });

  it('default mode is not affected by contextModeEnabled flag', () => {
    const enabled = getConfigsForMode('default', true);
    const disabled = getConfigsForMode('default', false);
    // No context-mode files in default mode regardless - they are advanced-only
    expect(enabled.map((d) => d.key)).toEqual(['.claude/rules/common.md']);
    expect(disabled.map((d) => d.key)).toEqual(['.claude/rules/common.md']);
  });

  it('default contextModeEnabled is false (fail-closed: callers must opt in to ship the gated subtree)', () => {
    const explicitFalse = getConfigsForMode('advanced', false);
    const omitted = getConfigsForMode('advanced');
    expect(omitted.map((d) => d.key).sort()).toEqual(explicitFalse.map((d) => d.key).sort());
  });
});

describe('getPreseedKeysNotInMode tier gating', () => {
  it('contextModeEnabled=true behaves as the original (advanced-only keys for default mode)', () => {
    const keys = getPreseedKeysNotInMode('default', true);
    expect(keys).toContain('.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json');
    expect(keys).toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
  });

  it('contextModeEnabled=false in advanced mode flags context-mode keys for cleanup', () => {
    const keys = getPreseedKeysNotInMode('advanced', false);
    expect(keys).toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
    expect(keys).toContain('.claude/plugins/context-mode/hooks/hooks.json');
    expect(keys).toContain('.claude/plugins/context-mode/README.md');
    // Non-context-mode advanced files NOT flagged for cleanup:
    expect(keys).not.toContain('.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json');
    expect(keys).not.toContain('.claude/rules/common.md');
  });

  it('contextModeEnabled=true in advanced mode returns empty (everything is in scope)', () => {
    expect(getPreseedKeysNotInMode('advanced', true)).toEqual([]);
  });
});

describe('reconcileAgentConfigs tier gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Pro mode + non-Custom tier: writes advanced files MINUS context-mode subtree', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'advanced', {
      overwrite: true,
      cleanup: false,
      contextModeEnabled: false,
    });

    expect(result.written).toHaveLength(2);
    expect(result.written).toContain('.claude/rules/common.md');
    expect(result.written).toContain('.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json');
    expect(result.written).not.toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
  });

  it('Pro mode + Custom tier: writes full advanced set including context-mode', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'advanced', {
      overwrite: true,
      cleanup: false,
      contextModeEnabled: true,
    });

    expect(result.written).toHaveLength(5);
    expect(result.written).toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
    expect(result.written).toContain('.claude/plugins/context-mode/hooks/hooks.json');
    expect(result.written).toContain('.claude/plugins/context-mode/README.md');
  });

  it('Tier downgrade scenario: Pro mode + cleanup=true + contextModeEnabled=false deletes context-mode subtree', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'advanced', {
      overwrite: true,
      cleanup: true,
      contextModeEnabled: false,
    });

    // 2 advanced non-context-mode files written, 3 context-mode files deleted
    expect(result.written).toHaveLength(2);
    expect(result.deleted).toContain('.claude/plugins/context-mode/.claude-plugin/plugin.json');
    expect(result.deleted).toContain('.claude/plugins/context-mode/hooks/hooks.json');
    expect(result.deleted).toContain('.claude/plugins/context-mode/README.md');
    expect(result.deleted).toHaveLength(3);
  });

  it('Standard mode never deploys context-mode regardless of contextModeEnabled', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    // Even with contextModeEnabled=true, default mode excludes the advanced-only files
    const enabled = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: false,
      contextModeEnabled: true,
    });
    expect(enabled.written).toEqual(['.claude/rules/common.md']);

    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));
    const disabled = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: false,
      contextModeEnabled: false,
    });
    expect(disabled.written).toEqual(['.claude/rules/common.md']);
  });
});
