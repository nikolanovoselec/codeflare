/**
 * REQ-AGENT-004: Two Session Modes (reconcileAgentConfigs behavior)
 * REQ-AGENT-005: Pro Mode Includes Additional Skills, Rules, Agents, MCP Servers
 * REQ-AGENT-014: Manifest-Driven Preseed Pipeline (getConfigsForMode + getPreseedKeysNotInMode)
 *
 * Tests the pure functions getConfigsForMode, getPreseedKeysNotInMode, and the
 * orchestration function reconcileAgentConfigs. All R2 network calls are mocked
 * via vi.hoisted so the logic under test is real production code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';

// ── Hoist shared mock state so vi.mock factories can close over it ────────────
const { mockFetch, mockCreateR2Client, testState } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    testState: {
      agentDocs: [] as Array<{
        key: string;
        contentType: string;
        content: string;
        modes: string[];
      }>,
    },
  };
});

vi.mock('../../lib/r2-client', () => ({
  createR2Client: mockCreateR2Client,
  getR2Url: vi.fn((endpoint: string, bucket: string, key: string) =>
    `${endpoint}/${bucket}/${key}`
  ),
}));

vi.mock('../../lib/agent-seed.generated', () => ({
  get AGENTS_SEEDED_CONFIGS() {
    return testState.agentDocs;
  },
}));

vi.stubGlobal('fetch', mockFetch);

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  })),
}));

import { getConfigsForMode, getPreseedKeysNotInMode, reconcileAgentConfigs } from '../../lib/r2-seed';

const ENV = {
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
} as unknown as Env;

const ENDPOINT = 'https://test.r2.cloudflarestorage.com';
const BUCKET = 'test-bucket';

function makeDoc(key: string, modes: ('default' | 'advanced')[]) {
  return {
    key,
    contentType: 'text/markdown; charset=utf-8',
    content: `# ${key}`,
    modes,
  };
}

// ─── REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode ────────────────────────

describe('REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.agentDocs = [
      makeDoc('.claude/rules/env.md', ['default', 'advanced']),
      makeDoc('.claude/skills/ship/SKILL.md', ['default', 'advanced']),
      makeDoc('.claude/plugins/context-mode/plugin.json', ['advanced']),
      makeDoc('.claude/agents/code-reviewer.md', ['advanced']),
    ];
  });

  it('REQ-AGENT-005 AC2: getConfigsForMode("default") returns only docs whose modes include "default"', () => {
    const docs = getConfigsForMode('default');
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('.claude/rules/env.md');
    expect(keys).toContain('.claude/skills/ship/SKILL.md');
    expect(keys).not.toContain('.claude/plugins/context-mode/plugin.json');
    expect(keys).not.toContain('.claude/agents/code-reviewer.md');
  });

  it('REQ-AGENT-005 AC2: getConfigsForMode("advanced") returns docs for both default and advanced modes', () => {
    // contextModeEnabled=true so the context-mode subtree (.claude/plugins/context-mode/)
    // is included; AC2 is about mode coverage, not the orthogonal tier gate (covered by
    // the contextModeEnabled-specific tests below).
    const docs = getConfigsForMode('advanced', true);
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('.claude/rules/env.md');
    expect(keys).toContain('.claude/skills/ship/SKILL.md');
    expect(keys).toContain('.claude/plugins/context-mode/plugin.json');
    expect(keys).toContain('.claude/agents/code-reviewer.md');
  });

  it('REQ-AGENT-005 AC1: advanced mode returns more docs than default mode', () => {
    const defaultDocs = getConfigsForMode('default');
    const advancedDocs = getConfigsForMode('advanced');
    expect(advancedDocs.length).toBeGreaterThan(defaultDocs.length);
  });

  it('REQ-AGENT-014 AC6: getConfigsForMode throws when the same key appears twice in one mode', () => {
    testState.agentDocs = [
      makeDoc('.claude/rules/env.md', ['default']),
      makeDoc('.claude/rules/env.md', ['default']), // duplicate within default
    ];
    expect(() => getConfigsForMode('default')).toThrow(/[Dd]uplicate/);
  });

  it('REQ-AGENT-014 AC6: getConfigsForMode does NOT throw for same key in different modes (variant-per-mode)', () => {
    testState.agentDocs = [
      { ...makeDoc('.codex/AGENTS.md', ['default']), content: '# default content' },
      { ...makeDoc('.codex/AGENTS.md', ['advanced']), content: '# advanced content' },
    ];
    expect(() => getConfigsForMode('default')).not.toThrow();
    expect(() => getConfigsForMode('advanced')).not.toThrow();
  });

  it('REQ-AGENT-005: getConfigsForMode strips context-mode keys when contextModeEnabled=false', () => {
    const docs = getConfigsForMode('advanced', false);
    const keys = docs.map((d) => d.key);
    expect(keys).not.toContain('.claude/plugins/context-mode/plugin.json');
  });

  it('REQ-AGENT-005: getConfigsForMode includes context-mode keys when contextModeEnabled=true', () => {
    const docs = getConfigsForMode('advanced', true);
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('.claude/plugins/context-mode/plugin.json');
  });
});

// ─── REQ-AGENT-014: getPreseedKeysNotInMode ───────────────────────────────────

describe('REQ-AGENT-014 AC7: getPreseedKeysNotInMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.agentDocs = [
      makeDoc('.claude/rules/env.md', ['default', 'advanced']),
      makeDoc('.claude/plugins/context-mode/plugin.json', ['advanced']),
      makeDoc('.claude/agents/code-reviewer.md', ['advanced']),
    ];
  });

  it('REQ-AGENT-014 AC7: returns keys NOT in default mode', () => {
    const keys = getPreseedKeysNotInMode('default');
    expect(keys).toContain('.claude/plugins/context-mode/plugin.json');
    expect(keys).toContain('.claude/agents/code-reviewer.md');
    expect(keys).not.toContain('.claude/rules/env.md');
  });

  it('REQ-AGENT-014 AC7: returns empty when all keys are in the target mode', () => {
    testState.agentDocs = [
      makeDoc('.claude/rules/env.md', ['default', 'advanced']),
    ];
    expect(getPreseedKeysNotInMode('default')).toEqual([]);
    expect(getPreseedKeysNotInMode('advanced')).toEqual([]);
  });

  it('REQ-AGENT-014 AC7: variant-per-mode keys excluded from cleanup (key exists in target mode)', () => {
    testState.agentDocs = [
      { ...makeDoc('.codex/AGENTS.md', ['default']), content: '# default' },
      { ...makeDoc('.codex/AGENTS.md', ['advanced']), content: '# advanced' },
    ];
    const notInDefault = getPreseedKeysNotInMode('default');
    expect(notInDefault).not.toContain('.codex/AGENTS.md');
  });

  it('REQ-AGENT-014 AC7: context-mode keys appear in notInMode when contextModeEnabled=false', () => {
    testState.agentDocs = [
      makeDoc('.claude/plugins/context-mode/plugin.json', ['advanced']),
    ];
    const keys = getPreseedKeysNotInMode('advanced', false);
    expect(keys).toContain('.claude/plugins/context-mode/plugin.json');
  });
});

// ─── REQ-AGENT-004: reconcileAgentConfigs orchestration ─────────────────────

describe('REQ-AGENT-004: reconcileAgentConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.agentDocs = [
      makeDoc('.claude/rules/env.md', ['default', 'advanced']),
      makeDoc('.claude/agents/code-reviewer.md', ['advanced']),
    ];
  });

  it('REQ-AGENT-004 AC4: overwrite:false skips existing R2 objects (new-bucket path)', async () => {
    // HEAD 200 = file exists; overwrite:false must skip it
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(ENV, BUCKET, ENDPOINT, 'default', {
      overwrite: false,
      cleanup: false,
    });

    expect(result.skipped).toContain('.claude/rules/env.md');
    expect(result.written).toHaveLength(0);
  });

  it('REQ-AGENT-004 AC4: overwrite:true writes all docs regardless of existing state (recreate button)', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(ENV, BUCKET, ENDPOINT, 'default', {
      overwrite: true,
      cleanup: false,
    });

    expect(result.written).toContain('.claude/rules/env.md');
    expect(result.skipped).toHaveLength(0);
  });

  it('REQ-AGENT-004 AC5: cleanup:true deletes advanced-only keys when switching to default mode', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(ENV, BUCKET, ENDPOINT, 'default', {
      overwrite: true,
      cleanup: true,
    });

    expect(result.deleted).toContain('.claude/agents/code-reviewer.md');
    expect(result.deleted).not.toContain('.claude/rules/env.md');
  });

  it('REQ-AGENT-004 AC5: cleanup:false leaves advanced-only keys untouched', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(ENV, BUCKET, ENDPOINT, 'default', {
      overwrite: true,
      cleanup: false,
    });

    expect(result.deleted).toHaveLength(0);
  });

  it('REQ-AGENT-004 AC6: reconcileAgentConfigs is non-fatal when DELETE calls fail', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 200 })) // PUT default doc
      .mockRejectedValueOnce(new Error('Network error on DELETE')); // DELETE advanced-only

    const result = await reconcileAgentConfigs(ENV, BUCKET, ENDPOINT, 'default', {
      overwrite: true,
      cleanup: true,
    });

    expect(result).toBeDefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('REQ-AGENT-004 AC4: result shape always has written, skipped, deleted, warnings arrays', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(ENV, BUCKET, ENDPOINT, 'advanced', {
      overwrite: false,
      cleanup: false,
    });

    expect(Array.isArray(result.written)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(Array.isArray(result.deleted)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
