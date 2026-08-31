import { createHash } from 'node:crypto';
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

import { managedExtensionsDocumentDigest, reconcileAgentConfigs } from '../../lib/r2-seed';

const document = (
  key: string,
  modes: Array<'default' | 'advanced'> = ['default'],
  content = `# ${key}`,
  contentType = 'text/markdown; charset=utf-8',
) => ({ key, contentType, content, modes });
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

  it('REQ-STOR-024 AC6: cacheless application cleans only current-release paths outside the effective mode', async () => {
    const priorDigest = '1'.repeat(64);
    const advancedOnlyKey = '.claude/skills/advanced/SKILL.md';
    const userOwnedKey = '.claude/skills/personal/SKILL.md';
    fetchR2.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        const marker = url.endsWith(`/${advancedOnlyKey}`) ? priorDigest : 'user-owned';
        return Promise.resolve(new Response('', { status: 200, headers: { 'x-amz-meta-codeflare-preseed': marker } }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection('2'.repeat(64), release(2, [
        document(advancedOnlyKey, ['advanced']),
        document('.claude/skills/current/SKILL.md'),
        document(userOwnedKey, ['advanced']),
      ])),
      priorManagedDigest: priorDigest,
    });

    expect(result.deleted).toEqual([advancedOnlyKey]);
    expect(fetchR2.mock.calls.some(([url]) => String(url).includes('list-type=2'))).toBe(false);
    expect(fetchR2.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([
      `${endpoint}/bucket/${advancedOnlyKey}`,
    ]);
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

  it('REQ-STOR-021 AC5: protected signed retirement deletes markerless prior content', async () => {
    const current = release(2, [document('.claude/current.md')]);
    current.retiredPaths = ['.pi/agent/extensions/retired.ts'];
    let policyBytes: BodyInit | null | undefined;
    fetchR2.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response('', { status: 200 });
      if (url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'PUT') policyBytes = init.body;
      if (url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'GET') return new Response(policyBytes, { status: 200 });
      return new Response('', { status: 200 });
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection('2'.repeat(64), current),
      resourcePolicy: 'immutable',
    });

    expect(result.deleted).toContain('.pi/agent/extensions/retired.ts');
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
    const managedRelease = await selection(
      'f'.repeat(64),
      release(3, [document('.pi/agent/skills/company/SKILL.md', ['advanced'])], [extension]),
    );
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'advanced', {
      overwrite: true,
      cleanup: true,
      managedRelease,
    });

    const writes = fetchR2.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes.map(([url]) => url)).not.toEqual(expect.arrayContaining([expect.stringContaining('Vault/'), expect.stringContaining('/sessions/') ]));
    const manifest = writes.find(([url]) => String(url).endsWith('/.codeflare/managed-extensions.json'));
    expect(manifest).toBeDefined();
    const manifestBody = manifest![1].body as string;
    expect(JSON.parse(manifestBody)).toEqual(expect.objectContaining({ extensions: [extension] }));
    expect(manifestBody).not.toContain('PK');
  });

  it('REQ-STOR-029 AC1: writes and read-verifies canonical protected policy after managed content', async () => {
    const digest = 'd'.repeat(64);
    const managedRelease = await selection(digest, release(2, [
      document('.claude/skills/company/SKILL.md', ['advanced']),
      document('.pi/agent/AGENTS.md', ['default']),
    ]));
    let policyBytes: BodyInit | null | undefined;
    fetchR2.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'PUT') policyBytes = init.body;
      if (url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'GET') return new Response(policyBytes, { status: 200 });
      return new Response('', { status: 200 });
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease,
      resourcePolicy: 'immutable',
    });

    const policy = JSON.parse(new TextDecoder().decode(policyBytes as Uint8Array));
    expect(policy).toMatchObject({
      schemaVersion: 1,
      releaseDigest: digest,
      resourcePolicy: 'immutable',
      resourceRoots: [],
    });
    expect(policy.paths).toContain('.claude/skills/company/SKILL.md');
    expect(policy.paths).toContain('.pi/agent/AGENTS.md');
    expect(result.managedPathsDigest).toMatch(/^[0-9a-f]{64}$/);
    const policyPut = fetchR2.mock.calls.find(([url, init]) => url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'PUT');
    expect(policyPut?.[1]?.headers).toMatchObject({ 'x-amz-meta-codeflare-preseed': digest });
    const policyCalls = fetchR2.mock.calls.filter(([url]) => String(url).endsWith('/.codeflare/managed-paths.json'));
    expect(policyCalls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET']);
    expect(fetchR2.mock.calls.at(-1)?.[1]?.method).toBe('GET');
  });

  it('REQ-STOR-029 AC2: exclusive cleanup bounds fail before every mutation', async () => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    const objects = Array.from({ length: 10_001 }, (_, index) => (
      `<Contents><Key>.claude/skills/personal-${index}.md</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>`
    )).join('');
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response('', { status: 404 })
      : new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${objects}</ListBucketResult>`, { status: 200 }));

    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease,
      resourcePolicy: 'exclusive',
    })).rejects.toThrow(/10,000 objects/);
    expect(fetchR2.mock.calls.some(([, init]) => ['PUT', 'DELETE', 'POST'].includes(String(init?.method)))).toBe(false);
  });

  it('REQ-STOR-029 AC2: exclusive cleanup rejects summed object size above 1 GiB with zero mutations', async () => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response('', { status: 404 })
      : new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>.claude/skills/a</Key><Size>1073741824</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents><Contents><Key>.claude/skills/b</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>', { status: 200 }));

    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true, cleanup: true, managedRelease, resourcePolicy: 'exclusive',
    })).rejects.toThrow(/1 GiB/);
    expect(fetchR2.mock.calls.some(([, init]) => ['PUT', 'DELETE', 'POST'].includes(String(init?.method)))).toBe(false);
  });

  it('REQ-STOR-029 AC2: exact root object size contributes to the exclusive cleanup bound', async () => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-length': '1073741824' } })
      : new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>.claude/skills/personal</Key><Size>1</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>', { status: 200 }));

    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true, cleanup: true, managedRelease, resourcePolicy: 'exclusive',
    })).rejects.toThrow(/1 GiB/);
    expect(fetchR2.mock.calls.some(([, init]) => ['PUT', 'DELETE', 'POST'].includes(String(init?.method)))).toBe(false);
  });

  it.each([null, 'invalid', '-1', '9007199254740992'])('REQ-STOR-029 AC5: invalid exact root size %s causes zero mutations', async (contentLength) => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response(null, { status: 200, headers: contentLength === null ? {} : { 'content-length': contentLength } })
      : new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 }));

    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true, cleanup: true, managedRelease, resourcePolicy: 'exclusive',
    })).rejects.toThrow(/root object size/);
    expect(fetchR2.mock.calls.some(([, init]) => ['PUT', 'DELETE', 'POST'].includes(String(init?.method)))).toBe(false);
  });

  it('REQ-STOR-029 AC3: exclusive cleanup preserves managed and similarly prefixed objects in one bounded delete batch', async () => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    let policyBytes: BodyInit | null | undefined;
    fetchR2.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD' && url.endsWith('/.claude/skills')) return new Response(null, { status: 200, headers: { 'content-length': '0' } });
      if (init?.method === 'GET' && url.includes('list-type=2')) {
        return new Response([
          '<ListBucketResult><IsTruncated>false</IsTruncated>',
          '<Contents><Key>.claude/skills/company/SKILL.md</Key><Size>10</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>',
          '<Contents><Key>.claude/skills/personal/SKILL.md</Key><Size>10</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>',
          '</ListBucketResult>',
        ].join(''), { status: 200 });
      }
      if (url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'PUT') policyBytes = init.body;
      if (url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'GET') return new Response(policyBytes, { status: 200 });
      if (url.endsWith('?delete') && init?.method === 'POST') return new Response('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>', { status: 200 });
      return new Response('', { status: 200 });
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease,
      resourcePolicy: 'exclusive',
    });

    expect(fetchR2.mock.calls.find(([url]) => String(url).includes('list-type=2'))?.[0]).toContain('prefix=.claude%2Fskills%2F');
    expect(result.deleted).toEqual(['.claude/skills', '.claude/skills/personal/SKILL.md']);
    const deleteBatches = fetchR2.mock.calls.filter(([url, init]) => String(url).endsWith('?delete') && init?.method === 'POST');
    expect(deleteBatches).toHaveLength(1);
    expect(String(deleteBatches[0][1].body)).toContain('<Key>.claude/skills/personal/SKILL.md</Key>');
    expect(String(deleteBatches[0][1].body)).not.toContain('.claude/skills/company/SKILL.md');
    expect(String(deleteBatches[0][1].body)).not.toContain('.claude/skills-other/personal.md');
  });

  it('REQ-STOR-029 AC4: partial exclusive batch failures prevent policy identity from being committed', async () => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    fetchR2.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response('', { status: 404 });
      if (init?.method === 'GET' && url.includes('list-type=2')) {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>.claude/skills/personal/SKILL.md</Key><Size>10</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>', { status: 200 });
      }
      if (url.endsWith('?delete') && init?.method === 'POST') {
        return new Response('<DeleteResult><Error><Key>.claude/skills/personal/SKILL.md</Key><Code>AccessDenied</Code><Message>Denied</Message></Error></DeleteResult>', { status: 200 });
      }
      return new Response('', { status: 200 });
    });

    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true, cleanup: true, managedRelease, resourcePolicy: 'exclusive',
    })).rejects.toThrow(/per-object errors/);
    expect(fetchR2.mock.calls.some(([url, init]) => url.endsWith('/.codeflare/managed-paths.json') && init?.method === 'PUT')).toBe(false);
  });

  it('REQ-STOR-029 AC5: malformed exclusive listings cause zero mutations', async () => {
    const managedRelease = await selection('d'.repeat(64), release(2, [document('.claude/skills/company/SKILL.md')]));
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response('', { status: 404 })
      : new Response('<ListBucketResult><Contents><Key>.claude/skills/personal.md</Key></Contents></ListBucketResult>', { status: 200 }));

    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease,
      resourcePolicy: 'exclusive',
    })).rejects.toThrow(/listing response/);
    expect(fetchR2.mock.calls.some(([, init]) => ['PUT', 'DELETE', 'POST'].includes(String(init?.method)))).toBe(false);
  });

  it('REQ-STOR-032 AC3: exclusive generation fails before every R2 request', async () => {
    const unknown = await selection('e'.repeat(64), release(3, [document('.claude/toolboxes/company.md')]));
    await expect(reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: unknown,
      resourcePolicy: 'exclusive',
    })).rejects.toThrow(/recognized managed resource category/);
    expect(fetchR2).not.toHaveBeenCalled();
  });

  it('REQ-STOR-029 AC6: mutable transition removes stale canonical policy', async () => {
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection('d'.repeat(64), release(2, [])),
      resourcePolicy: 'mutable',
    });

    expect(fetchR2).toHaveBeenCalledWith(
      `${endpoint}/bucket/.codeflare/managed-paths.json`,
      { method: 'DELETE' },
    );
  });

  it('REQ-STOR-024 AC4: trusted digest hashes the exact valid empty company manifest bytes', async () => {
    const managedRelease = await selection('f'.repeat(64), release(3, []));
    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease,
    });

    const manifest = fetchR2.mock.calls.find(([url, init]) => (
      init?.method === 'PUT' && String(url).endsWith('/.codeflare/managed-extensions.json')
    ));
    expect(manifest).toBeDefined();
    const manifestBody = manifest![1].body as string;
    expect(JSON.parse(manifestBody).extensions).toEqual([]);
    expect(await managedExtensionsDocumentDigest(managedRelease)).toBe(
      createHash('sha256').update(manifestBody).digest('hex'),
    );
  });

  it('REQ-STOR-033 AC1/AC2: direct delta handles a fifteen-release gap and writes only added or changed release paths', async () => {
    const prior = await selection('1'.repeat(64), release(26, [
      document('.claude/added-later.md', ['default'], 'old removed'),
      document('.claude/changed.md', ['default'], 'old content'),
      document('.claude/stable.md', ['default'], 'same content'),
      document('.claude/type.md', ['default'], 'same bytes', 'text/plain'),
    ]));
    const target = await selection('2'.repeat(64), release(41, [
      document('.claude/changed.md', ['default'], 'new content'),
      document('.claude/new.md', ['default'], 'new file'),
      document('.claude/stable.md', ['default'], 'same content'),
      document('.claude/type.md', ['default'], 'same bytes', 'text/markdown; charset=utf-8'),
    ]));
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => (
      init?.method === 'HEAD' ? new Response('', { status: 404 }) : new Response('', { status: 200 })
    ));

    await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: target,
      priorManagedRelease: { ...prior, mode: 'default' },
      automatic: { assumeEmpty: false },
    } as Parameters<typeof reconcileAgentConfigs>[4] & { automatic: { assumeEmpty: boolean } });

    const putUrls = fetchR2.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([url]) => String(url));
    expect(putUrls).toEqual([
      `${endpoint}/bucket/.claude/changed.md`,
      `${endpoint}/bucket/.claude/new.md`,
      `${endpoint}/bucket/.claude/type.md`,
      `${endpoint}/bucket/.codeflare/managed-extensions.json`,
    ]);
    expect(putUrls).not.toContain(`${endpoint}/bucket/.claude/stable.md`);
  });

  it('REQ-STOR-033 AC3: target provenance resumes interrupted automatic reconciliation', async () => {
    const targetDigest = '2'.repeat(64);
    fetchR2.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response('', { status: 200, headers: { 'x-amz-meta-codeflare-preseed': targetDigest } });
      }
      return new Response('', { status: 200 });
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: await selection(targetDigest, release(41, [document('.claude/already-done.md')])),
      automatic: { assumeEmpty: false },
    } as Parameters<typeof reconcileAgentConfigs>[4] & { automatic: { assumeEmpty: boolean } });

    expect(result.written).toEqual([]);
    expect(result.skipped).toContain('.claude/already-done.md');
    expect(fetchR2.mock.calls.some(([url, init]) => (
      String(url).endsWith('/.claude/already-done.md') && init?.method === 'PUT'
    ))).toBe(false);
  });

  it('REQ-STOR-021 AC2 + REQ-STOR-033 AC5: direct delta cleanup accepts older valid markers and preserves markerless edits', async () => {
    const prior = await selection('1'.repeat(64), release(40, [
      document('.claude/markerless-edit.md'),
      document('.claude/old-managed.md'),
      document('.claude/stable.md'),
    ]));
    const target = await selection('2'.repeat(64), release(41, [document('.claude/stable.md')]));
    fetchR2.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        const marker = url.endsWith('/old-managed.md') ? '0'.repeat(64) : null;
        return new Response('', { status: 200, headers: marker ? { 'x-amz-meta-codeflare-preseed': marker } : {} });
      }
      return new Response('', { status: 200 });
    });

    const result = await reconcileAgentConfigs(env, 'bucket', endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      managedRelease: target,
      priorManagedRelease: { ...prior, mode: 'default' },
      automatic: { assumeEmpty: false },
    } as Parameters<typeof reconcileAgentConfigs>[4] & { automatic: { assumeEmpty: boolean } });

    expect(result.deleted).toEqual(['.claude/old-managed.md']);
    expect(fetchR2.mock.calls.some(([url, init]) => (
      String(url).endsWith('/markerless-edit.md') && init?.method === 'DELETE'
    ))).toBe(false);
    expect(fetchR2.mock.calls.some(([url, init]) => (
      String(url).endsWith('/stable.md') && ['HEAD', 'DELETE', 'PUT'].includes(String(init?.method))
    ))).toBe(false);
  });
});
