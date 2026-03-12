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
          key: '.claude/skills/consult-llm/SKILL.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Consult',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
        // Variant-per-mode: same key, different content per mode (instructions files)
        {
          key: '.codex/AGENTS.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Default instructions',
          modes: ['default'] as ('default' | 'advanced')[],
        },
        {
          key: '.codex/AGENTS.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Advanced instructions with more rules',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
        {
          key: '.codex/skills/ship/SKILL.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Ship',
          modes: ['default', 'advanced'] as ('default' | 'advanced')[],
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
  seedAgentConfigs,
  deleteNonModeConfigs,
  reconcileAgentConfigs,
} from '../../lib/r2-seed';

const env = {
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
} as unknown as Env;
const endpoint = 'https://test.r2.cloudflarestorage.com';
const bucket = 'test-bucket';

describe('getConfigsForMode', () => {
  it('returns only default-mode documents for "default"', () => {
    const docs = getConfigsForMode('default');
    expect(docs).toHaveLength(3);
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('.claude/rules/common.md');
    expect(keys).toContain('.codex/AGENTS.md');
    expect(keys).toContain('.codex/skills/ship/SKILL.md');
  });

  it('returns all documents for "advanced"', () => {
    const docs = getConfigsForMode('advanced');
    expect(docs).toHaveLength(5);
  });

  it('returns only one variant per key within a mode', () => {
    const defaultDocs = getConfigsForMode('default');
    const codexInstructions = defaultDocs.filter((d) => d.key === '.codex/AGENTS.md');
    expect(codexInstructions).toHaveLength(1);
    expect(codexInstructions[0].content).toBe('# Default instructions');

    const advancedDocs = getConfigsForMode('advanced');
    const codexInstructionsAdv = advancedDocs.filter((d) => d.key === '.codex/AGENTS.md');
    expect(codexInstructionsAdv).toHaveLength(1);
    expect(codexInstructionsAdv[0].content).toBe('# Advanced instructions with more rules');
  });

  it('throws on duplicate keys within a mode', () => {
    const original = [...testState.agentDocs];
    testState.agentDocs.push({
      key: '.codex/AGENTS.md',
      contentType: 'text/markdown; charset=utf-8',
      content: '# Duplicate!',
      modes: ['default'],
    });
    expect(() => getConfigsForMode('default')).toThrow('Duplicate key ".codex/AGENTS.md"');
    testState.agentDocs.length = 0;
    testState.agentDocs.push(...original);
  });
});

describe('getPreseedKeysNotInMode', () => {
  it('returns advanced-only keys for "default" mode', () => {
    const keys = getPreseedKeysNotInMode('default');
    expect(keys).toEqual([
      '.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json',
      '.claude/skills/consult-llm/SKILL.md',
    ]);
  });

  it('does NOT return variant-per-mode keys that have a default variant', () => {
    const keys = getPreseedKeysNotInMode('default');
    // .codex/AGENTS.md has both a default and advanced variant — must not be deleted
    expect(keys).not.toContain('.codex/AGENTS.md');
  });

  it('returns empty array for "advanced"', () => {
    expect(getPreseedKeysNotInMode('advanced')).toEqual([]);
  });
});

describe('seedAgentConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('with mode="default" only uploads default docs', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await seedAgentConfigs(env, bucket, endpoint, {
      overwrite: true,
      mode: 'default',
    });

    expect(result.written).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('with mode="advanced" uploads all docs', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await seedAgentConfigs(env, bucket, endpoint, {
      overwrite: true,
      mode: 'advanced',
    });

    expect(result.written).toHaveLength(5);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe('deleteNonModeConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes advanced-only keys for "default" mode', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    expect(result.deleted).toEqual([
      '.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json',
      '.claude/skills/consult-llm/SKILL.md',
    ]);
    expect(result.warnings).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('performs zero DELETEs for "advanced" mode', async () => {
    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats 404 as successful delete (idempotent)', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 404 }));

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    expect(result.deleted).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('returns warnings for partial delete failure', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    expect(result.deleted).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('HTTP 500');
  });
});

describe('reconcileAgentConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds and cleans up for "default" mode with cleanup=true', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: true,
    });

    expect(result.written).toHaveLength(3);
    expect(result.deleted).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('skips cleanup when cleanup=false', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: false,
    });

    expect(result.written).toHaveLength(3);
    expect(result.deleted).toEqual([]);
    // 3 PUTs, no DELETE calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
