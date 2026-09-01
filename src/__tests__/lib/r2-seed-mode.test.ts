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
          key: '.claude/extensions/common.md',
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
          key: '.claude/extensions/consult-llm/index.ts',
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
          content: '// advanced extension instructions with more rules',
          modes: ['advanced'] as ('default' | 'advanced')[],
        },
        {
          key: '.codex/config/ship/index.ts',
          contentType: 'text/markdown; charset=utf-8',
          content: '# Ship',
          modes: ['default', 'advanced'] as ('default' | 'advanced')[],
        },
      ],
      retiredKeys: ['.claude/extensions/karpathy.md'] as readonly string[],
    },
  };
});

// Partial: the sweep parses real ListObjectsV2 XML, so the parser stays real and
// the fixtures below are the wire format rather than a hand-shaped parse result.
vi.mock('../../lib/r2-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r2-client')>()),
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
  get RETIRED_PRESEED_KEYS() {
    return testState.retiredKeys;
  },
  PRESEED_CONTENT_HASH: 'testhash00000000',
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

// REQ-STOR-010: Agent Configs Auto-Seeded Based on Session Mode

describe('getConfigsForMode', () => {
  it('returns only default-mode documents for "default"', () => {
    const docs = getConfigsForMode('default');
    expect(docs).toHaveLength(3);
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('.claude/extensions/common.md');
    expect(keys).toContain('.codex/AGENTS.md');
    expect(keys).toContain('.codex/config/ship/index.ts');
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
    expect(codexInstructionsAdv[0].content).toBe('// advanced extension instructions with more rules');
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
      '.claude/extensions/consult-llm/index.ts',
    ]);
  });

  it('does NOT return variant-per-mode keys that have a default variant', () => {
    const keys = getPreseedKeysNotInMode('default');
    // .codex/AGENTS.md has both a default and advanced variant - must not be deleted
    expect(keys).not.toContain('.codex/AGENTS.md');
  });

  it('returns empty array for "advanced"', () => {
    expect(getPreseedKeysNotInMode('advanced')).toEqual([]);
  });
});

describe('seedAgentConfigs provenance marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const putHeaders = (): Record<string, string>[] =>
    mockFetch.mock.calls
      .filter((call) => (call[1] as { method?: string })?.method === 'PUT')
      .map((call) => (call[1] as { headers: Record<string, string> }).headers);

  it('stamps the marker on every overwrite write', async () => {
    // Presence of this header is the only thing separating a file codeflare
    // wrote from one the user created; an unstamped write is invisible to
    // cleanup forever.
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    await seedAgentConfigs(env, bucket, endpoint, { overwrite: true, mode: 'advanced' });

    const headers = putHeaders();
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h['x-amz-meta-codeflare-preseed']).toBe('testhash00000000');
    }
  });

  it('stamps the marker on writes issued by the non-overwrite path', async () => {
    // The 404-missing branch is a different PUT call site; an unmarked file
    // written here would never be reclaimable.
    mockFetch.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(new Response('', { status: init?.method === 'HEAD' ? 404 : 200 })),
    );

    await seedAgentConfigs(env, bucket, endpoint, { overwrite: false, mode: 'advanced' });

    const headers = putHeaders();
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(h['x-amz-meta-codeflare-preseed']).toBe('testhash00000000');
    }
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

const listXml = (...keys: string[]): string =>
  `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys
    .map(
      (k) =>
        `<Contents><Key>${k}</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>"x"</ETag></Contents>`,
    )
    .join('')}</ListBucketResult>`;

/**
 * Route mocked R2 traffic by method. `listed` is what every LIST returns;
 * `markers` gives each key's provenance header (undefined = unmarked).
 */
const mockR2 = (opts: {
  listed?: string[];
  markers?: Record<string, string>;
  deleteStatus?: number;
} = {}): void => {
  const { listed = [], markers = {}, deleteStatus = 204 } = opts;
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      // Filter by prefix the way R2 does, so a test that asserts something is
      // out of listing scope actually exercises that.
      const prefix = new URL(String(url)).searchParams.get('prefix') ?? '';
      return Promise.resolve(
        new Response(listXml(...listed.filter((k) => k.startsWith(prefix))), { status: 200 }),
      );
    }
    const key = String(url).replace(`${endpoint}/${bucket}/`, '');
    if (method === 'HEAD') {
      const marker = markers[key];
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: marker ? { 'x-amz-meta-codeflare-preseed': marker, etag: '"observed"' } : {},
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: deleteStatus }));
  });
};

const listedPrefixes = (): string[] =>
  mockFetch.mock.calls
    .filter((call) => ((call[1] as { method?: string })?.method ?? 'GET') === 'GET')
    .map((call) => new URL(String(call[0])).searchParams.get('prefix') ?? '');

const headRequests = (): string[] =>
  mockFetch.mock.calls
    .filter((call) => (call[1] as { method?: string })?.method === 'HEAD')
    .map((call) => String(call[0]).replace(`${endpoint}/${bucket}/`, ''));

const deleteRequests = (): string[] =>
  mockFetch.mock.calls
    .filter((call) => (call[1] as { method?: string })?.method === 'DELETE')
    .map((call) => String(call[0]).replace(`${endpoint}/${bucket}/`, ''));

describe('deleteNonModeConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.retiredKeys = ['.claude/extensions/karpathy.md'];
  });

  it('deletes advanced-only keys for "default" mode', async () => {
    mockR2();

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    // Out-of-mode keys first, then the frozen pre-marker list, which belongs to
    // no mode in this build and so is swept in every mode.
    expect(result.deleted).toEqual([
      '.claude/plugins/codeflare-hooks/.claude-plugin/plugin.json',
      '.claude/extensions/consult-llm/index.ts',
      '.claude/extensions/karpathy.md',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('sweeps the pre-marker list even when no key is out of mode', async () => {
    mockR2();

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual(['.claude/extensions/karpathy.md']);
    expect(result.warnings).toEqual([]);
  });

  it('never deletes a key the current build still seeds, by name or by sweep', async () => {
    // Seeding and deleting the same key in one reconcile would leave the bucket
    // missing a live file. The generator rejects such a list; this is the
    // runtime backstop, exercised through both paths at once -- the key is on
    // the frozen list AND listed carrying a foreign marker.
    const live = '.claude/extensions/common.md';
    testState.retiredKeys = [live];
    mockR2({ listed: [live], markers: { [live]: 'an-older-build' } });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(deleteRequests()).toEqual([]);
  });

  it('treats 404 as successful delete (idempotent)', async () => {
    mockR2({ deleteStatus: 404 });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    expect(result.deleted).toHaveLength(3);
    expect(result.warnings).toEqual([]);
  });

  it('returns warnings for partial delete failure', async () => {
    const failing = '.claude/extensions/consult-llm/index.ts';
    mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(new Response(listXml(), { status: 200 }));
      return Promise.resolve(new Response(null, { status: String(url).endsWith(failing) ? 500 : 204 }));
    });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'default');

    expect(result.deleted).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('HTTP 500');
  });
});

// A key retired after the provenance marker shipped is identified by the marker
// it still carries, so nothing has to enumerate it at build time.
describe('deleteNonModeConfigs stale-marker sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.retiredKeys = [];
  });

  it('deletes an object carrying a different build marker', async () => {
    const orphan = '.claude/extensions/retired-later/index.ts';
    mockR2({ listed: [orphan], markers: { [orphan]: 'an-older-build' } });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toContain(orphan);
    expect(deleteRequests()).toContain(orphan);
  });

  it('keeps an unmarked object as the user file', async () => {
    // Both cases land here: a file they created, and one of ours they edited
    // (the rewrite drops the metadata).
    const theirs = '.claude/extensions/my-own/index.ts';
    mockR2({ listed: [theirs] });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(deleteRequests()).toEqual([]);
  });

  it('does not touch a key the current build just seeded', async () => {
    const live = '.claude/extensions/common.md';
    mockR2({ listed: [live], markers: { [live]: 'an-older-build' } });

    await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(deleteRequests()).not.toContain(live);
  });

  it('lists only inside the seed two-segment prefixes', async () => {
    // Two things ride on this. The getting-started docs (REQ-STOR-009) are
    // stamped by the same helper but live at top-level paths, so a broader
    // listing would put them in scope for deletion; and a runtime root such as
    // `.claude/projects/` holds a session transcript per session, so listing at
    // one segment would page the whole bucket on every reconcile.
    mockR2();

    await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    const listed = listedPrefixes();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toContain('.claude/extensions/');
    expect(listed).toContain('.claude/extensions/');
    // Never a bare runtime root, and never an unbounded listing.
    expect(listed).not.toContain('.claude/');
    expect(listed).not.toContain('');
    for (const prefix of listed) expect(prefix).not.toMatch(/^\.[a-z]+\/$/);
  });

  it('never HEADs a key under a runtime tree outside those prefixes', async () => {
    // A session transcript is not reachable by the sweep at all: it is not under
    // any listed prefix, so it never becomes a candidate.
    const transcript = '.claude/projects/abc/transcript.jsonl';
    mockR2({ listed: [transcript], markers: { [transcript]: 'an-older-build' } });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    // Marked as ours on purpose: if it were ever listed it would be deleted, so
    // asserting no HEAD is what proves it is out of listing scope rather than
    // merely surviving the marker check.
    expect(headRequests()).not.toContain(transcript);
    expect(result.deleted).toEqual([]);
    expect(deleteRequests()).toEqual([]);
  });

  it('never probes the runtime-managed plugin cache', async () => {
    // Excluded before the candidate count, so a large cache cannot trip the cap
    // and silently disable the sweep on the buckets that accumulated the most.
    const cached = '.claude/plugins/cache/some-plugin/1.0.0/plugin.json';
    mockR2({ listed: [cached], markers: { [cached]: 'an-older-build' } });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(headRequests()).not.toContain(cached);
    expect(result.deleted).toEqual([]);
  });

  it('keeps an object carrying the current build marker', async () => {
    // Written by this very reconcile under a key the mode does not list. The
    // by-name paths own that case; deleting on marker presence alone would make
    // any future key stamped by the shared writer disappear.
    const current = '.claude/extensions/other/index.ts';
    mockR2({ listed: [current], markers: { [current]: 'testhash00000000' } });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(deleteRequests()).toEqual([]);
  });

  it('follows the continuation token across pages', async () => {
    // Page one is truncated; the orphan only appears on page two, so a sweep
    // that stopped at the first page would silently never see it.
    const orphan = '.claude/extensions/page-two/index.ts';
    let page = 0;
    mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const prefix = new URL(String(url)).searchParams.get('prefix') ?? '';
        if (prefix !== '.claude/extensions/') return Promise.resolve(new Response(listXml(), { status: 200 }));
        page += 1;
        return Promise.resolve(
          new Response(
            page === 1
              ? `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken></ListBucketResult>`
              : listXml(orphan),
            { status: 200 },
          ),
        );
      }
      if (method === 'HEAD') {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { 'x-amz-meta-codeflare-preseed': 'an-older-build', etag: '"observed"' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(page).toBeGreaterThan(1);
    expect(result.deleted).toContain(orphan);
  });

  it('treats a truncated page with no continuation token as a failed listing', async () => {
    // The parser sets IsTruncated and the token independently, so deriving
    // completeness from the token would read this as a finished listing and
    // sweep the partial view it returned.
    const partial = '.claude/extensions/seen-before-truncation/index.ts';
    mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const prefix = new URL(String(url)).searchParams.get('prefix') ?? '';
        if (prefix !== '.claude/extensions/') return Promise.resolve(new Response(listXml(), { status: 200 }));
        return Promise.resolve(
          new Response(
            `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>${partial}</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>"x"</ETag></Contents></ListBucketResult>`,
            { status: 200 },
          ),
        );
      }
      if (method === 'HEAD') {
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'x-amz-meta-codeflare-preseed': 'an-older-build' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).not.toContain(partial);
    expect(deleteRequests()).not.toContain(partial);
    expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('issues no listing for a seeded key too shallow to have a directory', async () => {
    // `.codex/AGENTS.md` and friends would list only themselves, and they are
    // seeded, so the request could never produce a candidate.
    mockR2();

    await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(listedPrefixes()).not.toContain('.codex/AGENTS.md');
    for (const prefix of listedPrefixes()) expect(prefix.endsWith('/')).toBe(true);
  });

  it('deletes nothing from a prefix whose listing failed part-way', async () => {
    // Page one succeeded and named a marked orphan, page two failed. Acting on
    // that is deleting on the strength of not having looked, so the whole
    // prefix is discarded.
    const partial = '.claude/extensions/seen-on-page-one/index.ts';
    let page = 0;
    mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const prefix = new URL(String(url)).searchParams.get('prefix') ?? '';
        if (prefix !== '.claude/extensions/') return Promise.resolve(new Response(listXml(), { status: 200 }));
        page += 1;
        if (page === 1) {
          return Promise.resolve(
            new Response(
              `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken><Contents><Key>${partial}</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>"x"</ETag></Contents></ListBucketResult>`,
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response('denied', { status: 403 }));
      }
      if (method === 'HEAD') {
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'x-amz-meta-codeflare-preseed': 'an-older-build' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).not.toContain(partial);
    expect(deleteRequests()).not.toContain(partial);
    expect(result.warnings.some((w) => w.includes('HTTP 403'))).toBe(true);
  });

  it('skips the sweep when two prefixes are each under the cap but over it combined', async () => {
    // The per-prefix page guard cannot see this: neither prefix trips it. The
    // cross-prefix check after the merge is the only remaining bound on total
    // HEAD and DELETE subrequests.
    const extensions = Array.from({ length: 150 }, (_, i) => `.claude/extensions/s${i}/index.ts`);
    const plugins = Array.from({ length: 150 }, (_, i) => `.claude/plugins/p${i}/index.js`);
    const all = [...extensions, ...plugins];
    mockR2({ listed: all, markers: Object.fromEntries(all.map((k) => [k, 'an-older-build'])) });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(headRequests()).toEqual([]);
    expect(deleteRequests()).toEqual([]);
    expect(result.warnings.some((w) => w.includes('across the seed prefixes'))).toBe(true);
  });

  it('skips the sweep and warns when the candidate set is implausibly large', async () => {
    // The caller has already spent a PUT per live key in this request, so an
    // unbounded fan-out is what would hit the subrequest ceiling.
    const many = Array.from({ length: 250 }, (_, i) => `.claude/extensions/x${i}/index.ts`);
    mockR2({ listed: many, markers: Object.fromEntries(many.map((k) => [k, 'an-older-build'])) });

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(deleteRequests()).toEqual([]);
    expect(result.warnings.some((w) => w.includes('stale-marker sweep skipped'))).toBe(true);
  });

  it('warns and deletes nothing when a prefix cannot be listed', async () => {
    mockFetch.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(
        (init?.method ?? 'GET') === 'GET'
          ? new Response('denied', { status: 403 })
          : new Response(null, { status: 204 }),
      ),
    );

    const result = await deleteNonModeConfigs(env, bucket, endpoint, 'advanced');

    expect(result.deleted).toEqual([]);
    expect(result.warnings.some((w) => w.includes('HTTP 403'))).toBe(true);
  });
});

// REQ-MEM-011 AC4: reconcileAgentConfigs seeds mode-appropriate files and
// deletes preseed-managed files not in the current mode. It never touches
// user-created files because deleteNonModeConfigs only operates on keys
// declared in AGENTS_SEEDED_CONFIGS (the manifest-generated set), which
// excludes arbitrary user-uploaded paths by construction.
describe('reconcileAgentConfigs / REQ-MEM-011 AC4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pinned rather than inherited: this suite's delete counts are about mode
    // scoping, and leaving the frozen list to whatever ran before makes them
    // depend on suite order.
    testState.retiredKeys = [];
  });

  it('seeds and cleans up for "default" mode with cleanup=true', async () => {
    // A fresh Response per call, not one shared instance: the sweep reads the
    // body of every listing, and this mode derives two prefixes, so a shared
    // instance is already consumed by the second LIST.
    mockFetch.mockImplementation(() => new Response('', { status: 200 }));

    const result = await reconcileAgentConfigs(env, bucket, endpoint, 'default', {
      overwrite: true,
      cleanup: true,
    });

    expect(result.written).toHaveLength(3);
    // Out-of-mode keys only; the frozen list is empty for this suite.
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
