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
          modes: ['default', 'advanced'],
        },
        {
          key: '.claude/hooks/block-attributed-commits.sh',
          contentType: 'application/x-shellscript; charset=utf-8',
          content: '#!/bin/bash',
          modes: ['advanced'],
        },
        {
          key: '.claude/skills/consult-llm/SKILL.md',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Consult',
          modes: ['advanced'],
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
    expect(docs).toHaveLength(1);
    expect(docs[0].key).toBe('.claude/rules/common.md');
  });

  it('returns all documents for "advanced"', () => {
    const docs = getConfigsForMode('advanced');
    expect(docs).toHaveLength(3);
  });
});

describe('getPreseedKeysNotInMode', () => {
  it('returns advanced-only keys for "default"', () => {
    const keys = getPreseedKeysNotInMode('default');
    expect(keys).toEqual([
      '.claude/hooks/block-attributed-commits.sh',
      '.claude/skills/consult-llm/SKILL.md',
    ]);
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

    expect(result.written).toEqual(['.claude/rules/common.md']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('with mode="advanced" uploads all docs', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await seedAgentConfigs(env, bucket, endpoint, {
      overwrite: true,
      mode: 'advanced',
    });

    expect(result.written).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('deleteNonModeConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes advanced-only keys for "default" mode', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 204 }));

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    expect(result.deleted).toEqual([
      '.claude/hooks/block-attributed-commits.sh',
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
      .mockResolvedValueOnce(new Response('', { status: 204 }))
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
    // Seed PUT + Delete calls
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: true,
    });

    expect(result.written).toEqual(['.claude/rules/common.md']);
    expect(result.deleted).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('skips cleanup when cleanup=false', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: false,
    });

    expect(result.written).toEqual(['.claude/rules/common.md']);
    expect(result.deleted).toEqual([]);
    // Only 1 PUT, no DELETE calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
