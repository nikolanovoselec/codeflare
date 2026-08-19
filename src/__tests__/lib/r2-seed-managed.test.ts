import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import {
  gzipBytes,
  parseManagedReleaseStream,
  type ManagedRelease,
} from '../../lib/remote-curation';

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
const encoder = new TextEncoder();

async function selection(digest: string, value: ManagedRelease) {
  const compressed = await gzipBytes(encoder.encode(JSON.stringify(value)));
  return { digest, compressed, release: await parseManagedReleaseStream(compressed) };
}

beforeEach(() => {
  fetchR2.mockReset();
  fetchR2.mockResolvedValue(new Response('', { status: 200 }));
});

describe('managed release user-bucket reconciliation', () => {
  it('REQ-STOR-021 AC1 + REQ-STOR-024 AC2: Default and Advanced stream identical mode payloads with active release provenance', async () => {
    const digest = 'd'.repeat(64);
    const managedRelease = await selection(
      digest,
      release(2, [document('.claude/common.md', ['advanced', 'default']), document('.claude/pro.md', ['advanced'])]),
    );

    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease,
    });

    const defaultPuts = fetchR2.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(defaultPuts.map(([url]) => url)).toEqual([
      `${endpoint}/bucket/.claude/common.md`,
      `${endpoint}/bucket/.codeflare/managed-extensions.json`,
    ]);
    expect(defaultPuts[0][1]).toMatchObject({
      body: '# .claude/common.md',
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'x-amz-meta-codeflare-preseed': digest,
      },
    });
    expect(JSON.parse(defaultPuts[1][1].body)).toEqual({
      schemaVersion: 1,
      release: { digest, sequence: 2 },
      extensions: [],
    });

    fetchR2.mockClear();
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'advanced', {
      overwrite: true,
      cleanup: true,
      managedRelease,
    });

    const advancedPuts = fetchR2.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(advancedPuts.map(([url]) => url)).toEqual([
      `${endpoint}/bucket/.claude/common.md`,
      `${endpoint}/bucket/.claude/pro.md`,
      `${endpoint}/bucket/.codeflare/managed-extensions.json`,
    ]);
    expect(advancedPuts.slice(0, 2).map(([url, init]) => ({ url, body: init.body, contentType: init.headers['Content-Type'], marker: init.headers['x-amz-meta-codeflare-preseed'] }))).toEqual([
      { url: `${endpoint}/bucket/.claude/common.md`, body: '# .claude/common.md', contentType: 'text/markdown; charset=utf-8', marker: digest },
      { url: `${endpoint}/bucket/.claude/pro.md`, body: '# .claude/pro.md', contentType: 'text/markdown; charset=utf-8', marker: digest },
    ]);
  });

  it('REQ-STOR-021 AC2: prior release markers guard managed cleanup', async () => {
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
      managedRelease: await selection('2'.repeat(64), release(2, [document('.claude/current.md')])),
      priorManagedRelease: {
        ...await selection(priorDigest, release(1, [document('.claude/current.md'), document('.claude/edited.md'), document('.claude/obsolete.md')])),
        mode: 'default',
      },
    });

    expect(result.deleted).toEqual(['.claude/obsolete.md']);
    const deletes = fetchR2.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url);
    expect(deletes).toEqual([`${endpoint}/bucket/.claude/obsolete.md`]);
  });

  it('REQ-STOR-021 AC3: signed retirements delete only Codeflare-owned paths', async () => {
    const current = release(2, [document('.claude/current.md')]);
    current.retiredPaths = ['.pi/agent/extensions/legacy-owned.ts', '.pi/agent/extensions/user-owned.ts'];
    fetchR2.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        const marker = url.endsWith('/legacy-owned.ts') ? 'baked-digest' : null;
        return Promise.resolve(new Response('', { status: 200, headers: marker ? { 'x-amz-meta-codeflare-preseed': marker } : {} }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection('2'.repeat(64), current),
    });

    expect(result.deleted).toEqual(['.pi/agent/extensions/legacy-owned.ts']);
    expect(fetchR2.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([
      `${endpoint}/bucket/.pi/agent/extensions/legacy-owned.ts`,
    ]);
  });

  it('REQ-STOR-024 AC3: bounds R2 concurrency for a maximum-size managed document set', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchR2.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      inFlight -= 1;
      return new Response('', { status: 200 });
    });
    const documents = Array.from(
      { length: 5_000 },
      (_, index) => document(`.claude/skills/company-${String(index).padStart(4, '0')}/SKILL.md`),
    );

    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection('d'.repeat(64), release(4, documents)),
    });

    expect(fetchR2).toHaveBeenCalledTimes(5_001);
    expect(peak).toBe(6);
  });

  it('REQ-STOR-021 AC4: image-owned and user-owned roots remain outside managed documents', async () => {
    const extension: ManagedRelease['managedExtensions'][number] = {
      id: 'company.markdown', publisher: 'company', name: 'markdown', version: '1.2.3',
      targetPlatform: 'linux-x64', engine: '^1.0.0', entrypoint: './dist/extension.js',
      extensionPack: [], extensionDependencies: [], size: 1234, sha256: 'e'.repeat(64),
      downloadUrl: 'https://open-vsx.org/api/company/markdown/1.2.3/file/company.markdown.vsix',
    };
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'advanced', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection(
        'f'.repeat(64),
        release(3, [document('.pi/agent/skills/company/SKILL.md', ['advanced'])], [extension]),
      ),
    });

    const writes = fetchR2.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes.map(([url]) => url)).not.toEqual(expect.arrayContaining([expect.stringContaining('Vault/'), expect.stringContaining('/sessions/') ]));
    const manifest = writes.find(([url]) => String(url).endsWith('/.codeflare/managed-extensions.json'));
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest![1].body)).toEqual(expect.objectContaining({ extensions: [extension] }));
    expect(manifest![1].body).not.toContain('PK');
  });
});
