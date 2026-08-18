import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import type { ManagedRelease } from '../../lib/remote-curation';

const fetchR2 = vi.hoisted(() => vi.fn());
vi.mock('../../lib/r2-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r2-client')>()),
  createR2Client: () => ({ fetch: fetchR2 }),
  getR2Url: (endpoint: string, bucket: string, key?: string) =>
    key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`,
}));
vi.mock('../../lib/tutorial-seed.generated', () => ({ SEEDED_DOCUMENTS: [] }));
vi.mock('../../lib/agent-seed.generated', () => ({
  AGENTS_SEEDED_CONFIGS: [],
  PRESEED_CONTENT_HASH: 'baked-digest',
  RETIRED_PRESEED_KEYS: [],
}));

import { reconcileAgentConfigs } from '../../lib/r2-seed';

const document = (key: string, modes: Array<'default' | 'advanced'> = ['default']) => ({
  key,
  contentType: 'text/markdown; charset=utf-8',
  content: `# ${key}`,
  modes,
});
const release = (sequence: number, documents: ReturnType<typeof document>[], managedExtensions: ManagedRelease['managedExtensions'] = []): ManagedRelease => ({
  seedAbi: 1,
  sequence,
  source: {
    repositoryId: 7,
    commitSha: 'a'.repeat(40),
    releaseTag: `v${sequence}`,
    compilerCommit: 'b'.repeat(40),
  },
  runtimeDependencyHash: 'c'.repeat(64),
  documents,
  retiredPaths: [],
  managedExtensions,
});

const env = { R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret' } as Env;
const endpoint = 'https://r2.example.com';

beforeEach(() => {
  fetchR2.mockReset();
  fetchR2.mockResolvedValue(new Response('', { status: 200 }));
});

describe('managed release user-bucket reconciliation', () => {
  it('filters verified documents by mode and marks every write with the active release digest', async () => {
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: {
        digest: 'd'.repeat(64),
        release: release(2, [document('.claude/common.md', ['default', 'advanced']), document('.claude/pro.md', ['advanced'])]),
      },
    });

    const puts = fetchR2.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts.map(([url]) => url)).toEqual([
      `${endpoint}/bucket/.claude/common.md`,
      `${endpoint}/bucket/.codeflare/managed-extensions.json`,
    ]);
    for (const [, init] of puts) {
      expect(init.headers['x-amz-meta-codeflare-preseed']).toBe('d'.repeat(64));
    }
    expect(JSON.parse(puts[1][1].body)).toMatchObject({ schemaVersion: 1, release: { sequence: 2, digest: 'd'.repeat(64) }, extensions: [] });
  });

  it('deletes only prior-set-minus-current keys whose marker still matches the prior digest', async () => {
    const priorDigest = '1'.repeat(64);
    fetchR2.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        const marker = url.endsWith('/edited.md') ? 'someone-else' : priorDigest;
        return Promise.resolve(new Response('', { status: 200, headers: { 'x-amz-meta-codeflare-preseed': marker } }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: { digest: '2'.repeat(64), release: release(2, [document('.claude/current.md')]) },
      priorManagedRelease: {
        digest: priorDigest,
        mode: 'default',
        release: release(1, [document('.claude/current.md'), document('.claude/obsolete.md'), document('.claude/edited.md')]),
      },
    });

    expect(result.deleted).toEqual(['.claude/obsolete.md']);
    const deletes = fetchR2.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url);
    expect(deletes).toEqual([`${endpoint}/bucket/.claude/obsolete.md`]);
  });

  it('bounds R2 concurrency for a maximum-size managed document set', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchR2.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      inFlight -= 1;
      return new Response('', { status: 200 });
    });
    const documents = Array.from({ length: 5_000 }, (_, index) => document(`.claude/skills/company-${index}/SKILL.md`));

    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: { digest: 'd'.repeat(64), release: release(4, documents) },
    });

    expect(fetchR2).toHaveBeenCalledTimes(5_001);
    expect(peak).toBeLessThanOrEqual(16);
  });

  it('stores company extension metadata only and never writes VSIX bytes or user roots', async () => {
    const extension: ManagedRelease['managedExtensions'][number] = {
      id: 'company.markdown', publisher: 'company', name: 'markdown', version: '1.2.3',
      targetPlatform: 'linux-x64', engine: '^1.0.0', entrypoint: './dist/extension.js',
      extensionPack: [], extensionDependencies: [], size: 1234, sha256: 'e'.repeat(64),
      downloadUrl: 'https://open-vsx.org/api/company/markdown/1.2.3/file/company.markdown.vsix',
    };
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'advanced', {
      overwrite: true,
      cleanup: true,
      managedRelease: {
        digest: 'f'.repeat(64),
        release: release(3, [document('.pi/agent/skills/company/SKILL.md', ['advanced'])], [extension]),
      },
    });

    const writes = fetchR2.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes.map(([url]) => url)).not.toEqual(expect.arrayContaining([expect.stringContaining('Vault/'), expect.stringContaining('/sessions/') ]));
    const manifest = writes.find(([url]) => String(url).endsWith('/.codeflare/managed-extensions.json'));
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest![1].body)).toEqual(expect.objectContaining({ extensions: [extension] }));
    expect(manifest![1].body).not.toContain('PK');
  });
});
