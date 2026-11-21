import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessUser, Env } from '../../types';
import { gzipBytes, parseManagedReleaseStream, type ManagedRelease } from '../../lib/remote-curation';
import {
  getActiveVerifiedManagedRelease,
  type ActiveVerifiedManagedRelease,
  type VerifiedManagedReleaseContent,
} from '../../lib/managed-release-active';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import { getManagedEnvironmentPatKey, SETUP_KEYS } from '../../lib/kv-keys';
import { managedExtensionsDocumentContent } from '../../lib/r2-seed';

const state = vi.hoisted(() => ({
  active: null as ActiveVerifiedManagedRelease | null,
  activeError: null as Error | null,
  cached: null as VerifiedManagedReleaseContent | null,
  cachedByDigest: new Map<string, VerifiedManagedReleaseContent>(),
  resourcePolicy: 'mutable' as 'mutable' | 'immutable' | 'exclusive',
  migrating: false,
  sseDisabled: false,
  containerStatus: 'running',
  containerError: null as Error | null,
  bakedDocuments: [] as ReturnType<typeof import('../../lib/r2-seed').getConfigsForMode>,
}));
const reconcile = vi.hoisted(() => vi.fn<typeof import('../../lib/r2-seed').reconcileAgentConfigs>(async () => (
  { written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined }
)));
const reseedContext = vi.hoisted(() => vi.fn(async () => ({ written: [], skipped: [] })));
const createBucket = vi.hoisted(() => vi.fn(async () => ({ success: true, created: false })));
const fetchR2 = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('', { status: 200 })));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    getState: vi.fn(async () => {
      if (state.containerError) throw state.containerError;
      return { status: state.containerStatus };
    }),
  })),
}));
vi.mock('../../lib/managed-release-active', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/managed-release-active')>()),
  getActiveVerifiedManagedRelease: vi.fn(async () => {
    if (state.activeError) throw state.activeError;
    return state.active;
  }),
  getActiveManagedRelease: vi.fn(async () => state.active ? ({
    digest: state.active.digest,
    pointer: state.active.pointer,
    resourcePolicy: state.resourcePolicy,
  }) : null),
  getCachedManagedReleaseByDigest: vi.fn(async (_env: Env, digest: string) => state.cachedByDigest.get(digest) ?? state.cached),
}));
vi.mock('../../lib/remote-curation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remote-curation')>()),
  getManagedEnvironmentConfig: vi.fn(async () => ({ resourcePolicy: state.resourcePolicy })),
}));
vi.mock('../../lib/r2-seed', async () => {
  const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
  return {
    ...actual,
    seedGettingStartedDocs: vi.fn(),
    reconcileAgentConfigs: reconcile,
    reseedContextModePlugin: reseedContext,
  };
});
vi.mock('../../lib/r2-admin', () => ({ createBucketIfNotExists: createBucket }));
vi.mock('../../lib/r2-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r2-client')>()),
  createR2Client: () => ({ fetch: fetchR2 }),
  getR2Url: (endpoint: string, bucket: string, key?: string) => key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`,
}));
vi.mock('../../lib/tutorial-seed.generated', () => ({ SEEDED_DOCUMENTS: [] }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'account', endpoint: 'https://r2.example.com' })) }));
vi.mock('../../lib/r2-migration', () => ({
  isBucketMigrating: vi.fn(async () => state.migrating),
  resolveBucketSseOnEnsure: vi.fn(async () => state.sseDisabled),
}));
vi.mock('../../lib/agent-seed.generated', () => ({
  get AGENTS_SEEDED_CONFIGS() { return state.bakedDocuments; },
  PRESEED_CONTENT_HASH: 'baked-hash',
  RETIRED_PRESEED_KEYS: [],
}));

import routes from '../../routes/storage/seed';

const PROJECTION_ALL = 'v1:claude-code,codex,copilot,antigravity,opencode,pi';
const PROJECTION_CLAUDE_PI = 'v1:claude-code,pi';

const release: ManagedRelease = {
  seedAbi: 1,
  sequence: 9,
  source: { repositoryId: 7, commitSha: 'a'.repeat(40), releaseTag: 'v9', compilerCommit: 'b'.repeat(40) },
  runtimeDependencyHash: 'c'.repeat(64),
  documents: [{ key: '.claude/company.md', contentType: 'text/markdown; charset=utf-8', content: '# Company', modes: ['advanced'] }],
  retiredPaths: [],
  managedExtensions: [],
};

function appFor(
  mockKV: ReturnType<typeof createMockKV>,
  user: AccessUser = { email: 'user@example.com', authenticated: true, accessTier: 'unlimited' as never },
  envOverrides: Partial<Env> = {},
) {
  return createTestApp({
    routes: [{ path: '/seed', handler: routes }],
    mockKV,
    bucketName: 'user-bucket',
    user,
    envOverrides: { R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', CLOUDFLARE_API_TOKEN: 'token', ...envOverrides },
  });
}

// In-file R2 wire peer: retain bytes and headers across the real writer's
// HEAD/PUT/GET/DELETE operations; no reconciler-option assertions are needed.
async function storedR2Peer(empty = false) {
  // Give these route cases a real, signed cleanup target without changing
  // the file's shared release fixture or relying on a fabricated LIST result.
  const compressed = await gzipBytes(new TextEncoder().encode(JSON.stringify({
    ...release, retiredPaths: ['.claude/rules/retired.md'],
  })));
  state.active = { ...state.active!, compressed, release: await parseManagedReleaseStream(compressed) };
  const objects = new Map<string, { body: string; contentType: string; marker?: string }>(empty ? [] : [
    ['.claude/company.md', { body: 'markerless local edit', contentType: 'text/plain' }],
    ['.codeflare/managed-extensions.json', { body: 'markerless manifest edit', contentType: 'text/plain' }],
    ['.claude/rules/retired.md', { body: 'retired bytes', contentType: 'text/plain', marker: '1'.repeat(64) }],
  ]);
  if (!empty) objects.set('personal.txt', { body: 'preserve personal bytes', contentType: 'text/plain' });
  const requests: Array<{ method: string; key: string }> = [];
  fetchR2.mockImplementation(async (url, init) => {
    const parsed = new URL(url);
    const key = decodeURIComponent(parsed.pathname.slice('/user-bucket/'.length));
    const method = init?.method ?? 'GET';
    requests.push({ method, key });
    if (method === 'GET' && parsed.searchParams.get('list-type') === '2') {
      const prefix = parsed.searchParams.get('prefix') ?? '';
      const contents = [...objects].filter(([name]) => name.startsWith(prefix))
        .map(([name, object]) => `<Contents><Key>${name}</Key><Size>${new TextEncoder().encode(object.body).length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`).join('');
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const object = objects.get(key);
    if (method === 'HEAD' || method === 'GET') {
      return new Response(method === 'HEAD' ? null : object?.body ?? null, {
        status: object ? 200 : 404,
        headers: object ? { 'Content-Type': object.contentType, ETag: '"current"',
          ...(object.marker ? { 'x-amz-meta-codeflare-preseed': object.marker } : {}) } : {},
      });
    }
    if (method === 'PUT') {
      const headers = new Headers(init?.headers);
      const marker = headers.get('x-amz-meta-codeflare-preseed');
      objects.set(key, { body: await new Response(init?.body).text(),
        contentType: headers.get('Content-Type')!, ...(marker ? { marker } : {}) });
      return new Response(null, { status: 200 });
    }
    if (method === 'POST' && parsed.searchParams.has('delete')) {
      const xml = await new Response(init?.body).text();
      const keys = Array.from(xml.matchAll(/<Object><Key>([^<]+)<\/Key><\/Object>/g), match => match[1]);
      expect(keys).toEqual(['.claude/rules/retired.md']);
      for (const name of keys) objects.delete(name);
      return new Response('<DeleteResult />');
    }
    if (method === 'DELETE') {
      const condition = new Headers(init?.headers).get('If-Match');
      if (condition && condition !== '"current"') return new Response(null, { status: 412 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected R2 request: ${method} ${url}`);
  });
  return { objects, requests };
}

describe('managed storage reconcile', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const compressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(release)));
    state.active = {
      digest: 'd'.repeat(64),
      compressed,
      pointer: {
        schemaVersion: 1,
        seedAbi: 1,
        sequence: release.sequence,
        digest: 'd'.repeat(64),
        repositoryId: release.source.repositoryId,
        releaseId: 9,
        releaseTag: release.source.releaseTag,
        sourceCommit: release.source.commitSha,
        runtimeDependencyHash: release.runtimeDependencyHash,
        activatedAt: '2026-08-19T00:00:00.000Z',
      },
      release: await parseManagedReleaseStream(compressed),
    };
    state.activeError = null;
    state.cached = null;
    state.cachedByDigest.clear();
    state.resourcePolicy = 'mutable';
    state.migrating = false;
    state.sseDisabled = false;
    state.containerStatus = 'running';
    state.containerError = null;
    state.bakedDocuments = [];
    fetchR2.mockClear();
    fetchR2.mockImplementation(async () => new Response('', { status: 200 }));
  });

  it('REQ-SETUP-014 AC6: configured repository credentials never enter user-bucket writes', async () => {
    const credential = 'github_pat_user_bucket_forbidden';
    const configFingerprint = 'f'.repeat(64);
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    kv._set(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, {
      enabled: true,
      configFingerprint,
      repository: 'acme/curation',
    });
    kv._store.set(getManagedEnvironmentPatKey(configFingerprint), credential);

    const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
    // Exercise the real writer while the journal and reauthorization callback are live,
    // not by replaying a completed request after its pending state was cleared.
    reconcile.mockImplementationOnce(actual.reconcileAgentConfigs);
    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const r2Calls = fetchR2.mock.calls as unknown as Array<[string, RequestInit?]>;
    const writes = r2Calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes.length).toBeGreaterThan(0);
    const serializedWrites = writes.map(([url, init]) => JSON.stringify({ url, headers: init?.headers, body: init?.body })).join('\n');
    expect(serializedWrites).not.toContain(credential);
  });

  it('REQ-STOR-024 AC1+AC4: successful managed reconcile loads cached content and stamps applied state last', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced', workspaceSyncEnabled: true });
    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(getActiveVerifiedManagedRelease).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced', expect.objectContaining({
      managedRelease: expect.objectContaining({
        digest: 'd'.repeat(64),
        compressed: expect.any(Uint8Array),
        release: expect.objectContaining({ sequence: 9 }),
      }),
    }));
    expect(reseedContext).toHaveBeenCalled();
    const applied = await kv.get('user-prefs:user-bucket', 'json') as any;
    const expectedManifestBytes = managedExtensionsDocumentContent({
      digest: state.active!.digest,
      compressed: state.active!.compressed,
      release: state.active!.release,
    });
    expect(applied.managedEnvironmentApplied).toMatchObject({
      digest: 'd'.repeat(64),
      managedExtensionsDigest: createHash('sha256').update(expectedManifestBytes).digest('hex'),
      sequence: 9,
      mode: 'advanced',
    });
    expect(Date.parse(applied.managedEnvironmentApplied.appliedAt)).not.toBeNaN();
    const finalPut = kv.put.mock.calls.at(-1)!;
    expect(finalPut[0]).toBe('user-prefs:user-bucket');
  });

  it('REQ-STOR-035 AC1/AC3: journals the canonical projection before R2 work and publishes it with applied state', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    reconcile.mockImplementationOnce(async () => {
      const during = await kv.get('user-prefs:user-bucket', 'json') as any;
      expect(during.managedEnvironmentApplied).toBeUndefined();
      expect(during.managedEnvironmentReconciliation).toEqual({
        targets: [{
          digest: 'd'.repeat(64),
          sequence: 9,
          mode: 'advanced',
          projectionIdentity: PROJECTION_CLAUDE_PI,
        }],
      });
      return { written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv, undefined, { CODING_AGENTS: 'pi, claude-code,pi' })
      .request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(200);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied.projectionIdentity).toBe(PROJECTION_CLAUDE_PI);
    expect(preferences.managedEnvironmentReconciliation).toBeUndefined();
  });

  it.each([
    ['legacy identity', undefined, 'mutable', 'mutable'],
    ['selection change', 'v1:claude-code', 'mutable', 'mutable'],
    ['policy change', PROJECTION_CLAUDE_PI, 'mutable', 'exclusive'],
  ] as const)('REQ-STOR-033 AC3: same-release %s forces a full selected-target pass', async (_case, priorProjection, appliedPolicy, desiredPolicy) => {
    state.resourcePolicy = desiredPolicy;
    const { objects, requests } = await storedR2Peer();
    const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
    reconcile.mockImplementationOnce(actual.reconcileAgentConfigs);
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: 'd'.repeat(64),
        managedExtensionsDigest: 'e'.repeat(64),
        sequence: 9,
        mode: 'advanced',
        resourcePolicy: appliedPolicy,
        ...(priorProjection ? { projectionIdentity: priorProjection } : {}),
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await appFor(kv, undefined, { CODING_AGENTS: 'pi,claude-code' })
      .request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(objects.get('.claude/company.md')).toEqual({
      body: '# Company', contentType: 'text/markdown; charset=utf-8', marker: 'd'.repeat(64),
    });
    expect(objects.get('.codeflare/managed-extensions.json')?.body).toBe(managedExtensionsDocumentContent(state.active!));
    expect(objects.get('personal.txt')?.body).toBe('preserve personal bytes');
    const firstCleanup = requests.findIndex(request => request.method === (desiredPolicy === 'exclusive' ? 'POST' : 'DELETE'));
    expect(firstCleanup).toBeGreaterThan(-1);
    expect(objects.has('.claude/rules/retired.md')).toBe(false);
    for (const key of ['.claude/company.md', '.codeflare/managed-extensions.json']) {
      const verification = requests.findIndex(request => request.method === 'GET' && request.key === key);
      expect(verification).toBeGreaterThan(-1);
      expect(verification).toBeLessThan(firstCleanup);
    }
    expect(await kv.get('user-prefs:user-bucket', 'json')).toMatchObject({
      managedEnvironmentApplied: {
        digest: 'd'.repeat(64),
        projectionIdentity: PROJECTION_CLAUDE_PI,
        resourcePolicy: desiredPolicy,
      },
    });
  });

  it.each(['fresh bucket', 'missing history', 'manual recreation'] as const)(
    'REQ-STOR-033 AC4: %s materializes all selected bytes before cleanup', async (cause) => {
      const kv = createMockKV();
      kv._set('user-prefs:user-bucket', {
        sessionMode: 'advanced',
        managedEnvironmentApplied: {
          digest: cause === 'missing history' ? '1'.repeat(64) : 'd'.repeat(64),
          managedExtensionsDigest: 'e'.repeat(64), sequence: cause === 'missing history' ? 8 : 9,
          mode: 'advanced', resourcePolicy: 'mutable', projectionIdentity: PROJECTION_CLAUDE_PI,
          appliedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const { objects, requests } = await storedR2Peer(cause === 'fresh bucket');
      // Existing buckets contain a signed-retired object; a freshly created bucket
      // starts empty. Both must write the complete selected target.
      if (cause === 'fresh bucket') createBucket.mockResolvedValueOnce({ success: true, created: true });
      const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
      reconcile.mockImplementationOnce(actual.reconcileAgentConfigs);
      const route = cause === 'manual recreation' ? '/seed/agent-configs' : '/seed/agent-configs/upgrade';
      const response = await appFor(kv, undefined, { CODING_AGENTS: 'claude-code,pi' }).request(route, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(objects.get('.claude/company.md')).toEqual({
        body: '# Company', contentType: 'text/markdown; charset=utf-8', marker: 'd'.repeat(64),
      });
      expect(objects.get('.codeflare/managed-extensions.json')?.body).toBe(managedExtensionsDocumentContent(state.active!));
      expect(objects.get('personal.txt')?.body).toBe(cause === 'fresh bucket' ? undefined : 'preserve personal bytes');
      // On a fresh bucket the retired-path HEAD is the cleanup boundary; its
      // 404 must not turn into a delete. Existing buckets must delete the target.
      const firstCleanup = requests.findIndex(request => request.key === '.claude/rules/retired.md'
        && request.method === (cause === 'fresh bucket' ? 'HEAD' : 'DELETE'));
      expect(firstCleanup).toBeGreaterThan(-1);
      if (cause === 'fresh bucket') expect(requests.some(({ method }) => method === 'DELETE' || method === 'POST')).toBe(false);
      for (const key of ['.claude/company.md', '.codeflare/managed-extensions.json']) {
        const write = requests.findIndex(request => request.method === 'PUT' && request.key === key);
        expect(write).toBeGreaterThan(-1);
        expect(write).toBeLessThan(firstCleanup);
      }
      expect(objects.has('.claude/rules/retired.md')).toBe(false);
      expect(await kv.get('user-prefs:user-bucket', 'json')).toMatchObject({
        managedEnvironmentApplied: { digest: 'd'.repeat(64), projectionIdentity: PROJECTION_CLAUDE_PI },
      });
      expect((await kv.get('user-prefs:user-bucket', 'json') as any).managedEnvironmentReconciliation).toBeUndefined();
    },
  );

  it.each(['encryption', 'migration', 'session ownership', 'resource policy', 'pending targets'] as const)(
    'REQ-STOR-035 AC7: %s drift after completed R2 work refuses applied publication', async (cause) => {
      const kv = createMockKV();
      kv._set('user-prefs:user-bucket', { sessionMode: 'advanced', workspaceSyncEnabled: true });
      const { objects } = await storedR2Peer();
      const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
      reconcile.mockImplementationOnce(actual.reconcileAgentConfigs);
      let retainedTargets: unknown;
      reseedContext.mockImplementationOnce(async () => {
        const current = await kv.get('user-prefs:user-bucket', 'json') as any;
        if (cause === 'encryption') state.sseDisabled = true;
        if (cause === 'migration') state.migrating = true;
        if (cause === 'session ownership') kv._set('session:user-bucket:new-session', { id: 'new-session', status: 'starting' });
        if (cause === 'resource policy') state.resourcePolicy = 'immutable';
        if (cause === 'pending targets') current.managedEnvironmentReconciliation.targets.push({
          digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: 'v1:pi',
        });
        current.workspaceSyncEnabled = false; // unrelated concurrent writer must survive refusal
        kv._set('user-prefs:user-bucket', current);
        retainedTargets = current.managedEnvironmentReconciliation.targets;
        return { written: [], skipped: [] };
      });
      const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
      expect(response.status).toBe(cause === 'migration' || cause === 'session ownership' ? 409 : 500);
      expect(await response.json()).toMatchObject({ code: cause === 'migration' ? 'BUCKET_MIGRATING'
        : cause === 'session ownership' ? 'MANAGED_ENVIRONMENT_UPDATE_PENDING' : 'CONTAINER_ERROR' });
      expect(objects.get('.claude/company.md')?.body).toBe('# Company');
      expect(objects.get('.codeflare/managed-extensions.json')?.body).toBe(managedExtensionsDocumentContent(state.active!));
      const final = await kv.get('user-prefs:user-bucket', 'json') as any;
      expect(final.managedEnvironmentApplied).toBeUndefined();
      expect(final.managedEnvironmentReconciliation.targets).toEqual(retainedTargets);
      expect(final.workspaceSyncEnabled).toBe(false);
    },
  );

  it('REQ-STOR-035 AC2: a legacy pending target remains journaled and forces a full retry', async () => {
    const legacyTarget = { digest: 'd'.repeat(64), sequence: 9, mode: 'advanced' as const };
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: 'd'.repeat(64), managedExtensionsDigest: 'e'.repeat(64), sequence: 9,
        mode: 'advanced', projectionIdentity: PROJECTION_CLAUDE_PI,
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
      managedEnvironmentReconciliation: { targets: [legacyTarget] },
    });
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      const during = await kv.get('user-prefs:user-bucket', 'json') as any;
      expect(during.managedEnvironmentReconciliation.targets).toEqual([
        legacyTarget,
        { ...legacyTarget, projectionIdentity: PROJECTION_CLAUDE_PI },
      ]);
      expect(args[4].automatic.fullReconciliation).toBe(true);
      return { written: [], skipped: ['.claude/company.md'], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv, undefined, { CODING_AGENTS: 'claude-code,pi' })
      .request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await kv.get('user-prefs:user-bucket', 'json')).toMatchObject({
      managedEnvironmentApplied: { projectionIdentity: PROJECTION_CLAUDE_PI },
    });
  });

  it('REQ-STOR-035 AC7: selection drift after journaling blocks applied publication', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      const env = args[0] as Env;
      env.CODING_AGENTS = 'pi';
      await args[4].automatic.beforeCleanup();
      return { written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv, undefined, { CODING_AGENTS: 'claude-code,pi' })
      .request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(500);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
    expect(preferences.managedEnvironmentReconciliation.targets).toEqual([
      { digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: PROJECTION_CLAUDE_PI },
    ]);
  });

  it('REQ-STOR-029 AC7: transports configured policy and stamps verified identity last', async () => {
    state.resourcePolicy = 'exclusive';
    reconcile.mockResolvedValueOnce({
      written: ['.claude/company.md'],
      skipped: [],
      deleted: [],
      warnings: [],
      managedPathsDigest: '9'.repeat(64),
    });
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      'user-bucket',
      'https://r2.example.com',
      'advanced',
      expect.objectContaining({ resourcePolicy: 'exclusive' }),
    );
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toMatchObject({
      digest: 'd'.repeat(64),
      resourcePolicy: 'exclusive',
      managedPathsDigest: '9'.repeat(64),
    });
    expect(kv.put.mock.calls.at(-1)?.[0]).toBe('user-prefs:user-bucket');
  });

  it('reconciles and stamps the entitlement-clamped mode for a downgraded SaaS user', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });

    const response = await appFor(kv, {
      email: 'user@example.com',
      authenticated: true,
      subscriptionTier: 'advanced',
      billingStatus: 'canceled',
    }, { SAAS_MODE: 'active' }).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      'user-bucket',
      'https://r2.example.com',
      'default',
      expect.anything(),
    );
    const applied = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(applied.managedEnvironmentApplied.mode).toBe('default');
  });

  it('REQ-STOR-010 AC5: cleanup warnings fail the endpoint without replacing a protected applied identity', async () => {
    state.resourcePolicy = 'exclusive';
    const priorApplied = {
      digest: 'a'.repeat(64), sequence: 8, mode: 'advanced', projectionIdentity: PROJECTION_ALL,
      managedExtensionsDigest: 'b'.repeat(64), resourcePolicy: 'exclusive',
      managedPathsDigest: '9'.repeat(64), appliedAt: '2026-08-18T00:00:00.000Z',
    };
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced', workspaceSyncEnabled: true, managedEnvironmentApplied: priorApplied,
    });
    reconcile.mockResolvedValueOnce({
      written: ['.claude/company.md'], skipped: [], deleted: [],
      warnings: ['DELETE .claude/retired.md: HTTP 503'], managedPathsDigest: 'f'.repeat(64),
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'CONTAINER_ERROR' });
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toEqual(priorApplied);
    expect(preferences.workspaceSyncEnabled).toBe(true);
    expect(preferences.sessionMode).toBe('advanced');
    expect(preferences.managedEnvironmentReconciliation.targets).toEqual([
      { digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: PROJECTION_ALL },
    ]);

    // The same target can publish once cleanup completes without warnings.
    reconcile.mockResolvedValueOnce({
      written: ['.claude/company.md'], skipped: [], deleted: [],
      warnings: [], managedPathsDigest: 'f'.repeat(64),
    });
    const retry = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
    expect(retry.status).toBe(200);
    const published = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(published.managedEnvironmentApplied).toMatchObject({
      digest: 'd'.repeat(64), sequence: 9, resourcePolicy: 'exclusive', managedPathsDigest: 'f'.repeat(64),
    });
    expect(published.managedEnvironmentReconciliation).toBeUndefined();
  });

  it('REQ-STOR-024 AC4: does not stamp applied state when context-mode reconciliation fails', async () => {
    reseedContext.mockRejectedValueOnce(new Error('context failed'));
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
  });

  it('returns a typed 409 before bucket creation or R2 writes when any session is running', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    kv._set('session:user-bucket:running123456789', { id: 'running123456789', status: 'running' }, { s: 'r' });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe('MANAGED_ENVIRONMENT_UPDATE_PENDING');
    expect(createBucket).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('retries automatic reconciliation when stale running metadata points to persisted stopped state', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    kv._set('session:user-bucket:stale12345678', { id: 'stale12345678', status: 'stopped' }, { s: 'r' });
    state.containerStatus = 'stopped';

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not substitute baked content when enabled curation has no verified active release', async () => {
    state.active = null;
    state.activeError = new Error('verified active release unavailable');
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: { digest: '1'.repeat(64), managedExtensionsDigest: '2'.repeat(64), sequence: 8, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(reconcile).not.toHaveBeenCalled();
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied?.digest).toBe('1'.repeat(64));
    expect(preferences.lastPreseedHash).toBeUndefined();
  });

  it('REQ-STOR-024 AC5 + REQ-STOR-033 AC5: reconciles from current release when disposable cache history is absent', async () => {
    state.cached = null;
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64),
        managedExtensionsDigest: '2'.repeat(64),
        sequence: 8,
        mode: 'advanced',
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced', expect.objectContaining({
      managedRelease: expect.objectContaining({ digest: 'd'.repeat(64) }),
      priorManagedDigest: '1'.repeat(64),
    }));
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      'user-bucket',
      'https://r2.example.com',
      'advanced',
      expect.not.objectContaining({ priorManagedRelease: expect.anything() }),
    );
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied.digest).toBe('d'.repeat(64));
  });

  it('REQ-STOR-022 AC7 + REQ-STOR-024 AC7: cacheless disable fails closed with applied state intact', async () => {
    state.active = null;
    state.cached = null;
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64),
        managedExtensionsDigest: '2'.repeat(64),
        sequence: 8,
        mode: 'advanced',
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(reconcile).not.toHaveBeenCalled();
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied?.digest).toBe('1'.repeat(64));
  });

  it('REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent', async () => {
    state.active = null;
    const bakedDocument = { key: '.claude/rules/baked.md', contentType: 'text/markdown; charset=utf-8',
      content: '# Baked replacement', modes: ['advanced' as const] };
    state.bakedDocuments = [bakedDocument];
    const prior = { ...release, sequence: 8 };
    const compressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(prior)));
    state.cached = { compressed, release: await parseManagedReleaseStream(compressed) };
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      workspaceSyncEnabled: true,
      managedEnvironmentApplied: { digest: '1'.repeat(64), managedExtensionsDigest: '2'.repeat(64), sequence: 8, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
    });

    const personalIntent = JSON.stringify({ version: 1, securityWarningShown: true,
      extensions: { 'example.personal': { version: '1.2.3' } }, settings: { 'personal.enabled': true } });
    const objects = new Map<string, { body: string; marker?: string }>([
      ['.codeflare/ide-extensions.json', { body: personalIntent }],
      ['.codeflare/managed-extensions.json', { body: '{"extensions":[]}', marker: '1'.repeat(64) }],
      ['.claude/company.md', { body: '# Company', marker: '1'.repeat(64) }],
      [bakedDocument.key, { body: '# Outdated baked config', marker: 'old-baked-hash' }],
      ['.claude/rules/retired.md', { body: '# Retired baked config', marker: 'old-baked-hash' }],
    ]);
    fetchR2.mockImplementation(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const key = parsed.pathname.slice('/user-bucket/'.length);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && parsed.searchParams.get('list-type') === '2') {
        const prefix = parsed.searchParams.get('prefix') ?? '';
        const contents = [...objects].filter(([name]) => name.startsWith(prefix))
          .map(([name, object]) => `<Contents><Key>${name}</Key><Size>${object.body.length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`).join('');
        return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      if (method === 'HEAD' || method === 'GET') {
        const object = objects.get(key);
        return new Response(method === 'HEAD' ? null : object?.body, { status: object ? 200 : 404,
          headers: object ? { ETag: '"current"', ...(object.marker ? { 'x-amz-meta-codeflare-preseed': object.marker } : {}) } : {} });
      }
      if (method === 'PUT') {
        const marker = new Headers(init?.headers).get('x-amz-meta-codeflare-preseed');
        objects.set(key, { body: await new Response(init?.body).text(), ...(marker ? { marker } : {}) });
        return new Response(null, { status: 200 });
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected disable I/O: ${method} ${key}`);
    });
    const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
    reconcile.mockImplementationOnce(actual.reconcileAgentConfigs);
    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(objects.get('.codeflare/ide-extensions.json')?.body).toBe(personalIntent);
    expect(objects.get(bakedDocument.key)).toEqual({ body: bakedDocument.content, marker: 'baked-hash' });
    expect(objects.has('.claude/rules/retired.md')).toBe(false);
    expect(objects.has('.codeflare/managed-extensions.json')).toBe(false);
    expect(objects.has('.claude/company.md')).toBe(false);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
    expect(preferences.workspaceSyncEnabled).toBe(true);
    expect(preferences.lastPreseedHash).toBe('baked-hash');
    expect(preferences.lastPreseedProjectionIdentity).toBe(PROJECTION_ALL);
  });

  it('REQ-STOR-033 AC7: automatic endpoint is separate and manual Recreate remains full overwrite', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64), managedExtensionsDigest: '2'.repeat(64), sequence: 8,
        mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const prior = { ...release, sequence: 8 };
    const priorCompressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(prior)));
    state.cached = { compressed: priorCompressed, release: await parseManagedReleaseStream(priorCompressed) };

    const automatic = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
    expect(automatic.status).toBe(200);
    expect(reconcile).toHaveBeenLastCalledWith(
      expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced',
      expect.objectContaining({ automatic: expect.objectContaining({ assumeEmpty: false }) }),
    );

    reconcile.mockClear();
    const manual = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
    expect(manual.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced',
      expect.not.objectContaining({ automatic: expect.anything() }),
    );
  });

  it('REQ-STOR-024 AC4 + REQ-STOR-039 AC1: failed automatic byte verification does not publish applied state', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    reconcile.mockRejectedValueOnce(new Error('Managed object verification failed'));

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(500);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
    expect(preferences.managedEnvironmentReconciliation).toEqual({
      targets: [{ digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: PROJECTION_ALL }],
    });
  });

  it('REQ-STOR-035 AC1/AC2: failed manual Recreate records and retains its active target', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64), managedExtensionsDigest: '4'.repeat(64), sequence: 8,
        mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    reconcile.mockRejectedValueOnce(new Error('partial write'));

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentReconciliation).toEqual({
      targets: [{ digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: PROJECTION_ALL }],
    });
  });

  it('REQ-STOR-035 AC3: manual Recreate repairs interrupted targets before clearing their state', async () => {
    const appliedRelease = { ...release, sequence: 8 };
    const appliedCompressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(appliedRelease)));
    state.cachedByDigest.set('1'.repeat(64), {
      compressed: appliedCompressed,
      release: await parseManagedReleaseStream(appliedCompressed),
    });
    const interruptedRelease = { ...release, sequence: 7 };
    const interruptedCompressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(interruptedRelease)));
    state.cachedByDigest.set('2'.repeat(64), {
      compressed: interruptedCompressed,
      release: await parseManagedReleaseStream(interruptedCompressed),
    });
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64), managedExtensionsDigest: '4'.repeat(64), sequence: 8,
        mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z',
      },
      managedEnvironmentReconciliation: {
        targets: [{ digest: '2'.repeat(64), sequence: 7, mode: 'advanced' }],
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced',
      expect.objectContaining({
        interruptedManagedReleases: [expect.objectContaining({ digest: '2'.repeat(64), mode: 'advanced' })],
      }),
    );
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentReconciliation).toBeUndefined();
  });

  it('REQ-STOR-035 AC3: managed disable cleans interrupted targets before clearing their state', async () => {
    state.active = null;
    const appliedRelease = { ...release, sequence: 8 };
    const appliedCompressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(appliedRelease)));
    state.cachedByDigest.set('1'.repeat(64), {
      compressed: appliedCompressed,
      release: await parseManagedReleaseStream(appliedCompressed),
    });
    const interruptedRelease = { ...release, sequence: 7 };
    const interruptedCompressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(interruptedRelease)));
    state.cachedByDigest.set('2'.repeat(64), {
      compressed: interruptedCompressed,
      release: await parseManagedReleaseStream(interruptedCompressed),
    });
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64), managedExtensionsDigest: '4'.repeat(64), sequence: 8,
        mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z',
      },
      managedEnvironmentReconciliation: {
        targets: [{ digest: '2'.repeat(64), sequence: 7, mode: 'advanced' }],
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced',
      expect.objectContaining({
        managedRelease: null,
        interruptedManagedReleases: [expect.objectContaining({ digest: '2'.repeat(64), mode: 'advanced' })],
      }),
    );
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
    expect(preferences.managedEnvironmentReconciliation).toBeUndefined();
  });

  it('REQ-STOR-033 AC6: invalid applied identity fails closed before bucket mutation', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: 'invalid', managedExtensionsDigest: '2'.repeat(64), sequence: 8,
        mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
    expect(response.status).toBe(500);
    expect(createBucket).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([undefined, 'default'] as const)(
    'REQ-STOR-035 AC7: unchanged effective default mode (%s) and structural target identity permit publication', async sessionMode => {
      const kv = createMockKV();
      kv._set('user-prefs:user-bucket', { sessionMode });
      reconcile.mockImplementationOnce(async () => {
        const latest = await kv.get('user-prefs:user-bucket', 'json') as import('../../types').UserPreferences;
        const target = latest.managedEnvironmentReconciliation!.targets[0];
        // JSON property order is not part of the pending target identity.
        kv._set('user-prefs:user-bucket', { ...latest, sessionMode: 'default',
          managedEnvironmentReconciliation: { targets: [{
            projectionIdentity: target.projectionIdentity, mode: target.mode,
            sequence: target.sequence, digest: target.digest,
          }] },
        });
        return { written: [], skipped: [], deleted: [], warnings: [] };
      });
      const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
      expect(response.status).toBe(200);
      const stored = await kv.get('user-prefs:user-bucket', 'json') as import('../../types').UserPreferences;
      expect(stored.managedEnvironmentApplied).toMatchObject({ digest: state.active!.digest, mode: 'default' });
      expect(stored.managedEnvironmentReconciliation).toBeUndefined();
    },
  );

  it.each(['release', 'policy', 'mode', 'projection', 'owner', 'migration', 'encryption', 'pending'] as const)(
    'REQ-STOR-035 AC7: manual Recreate refuses %s drift and retains its journal', async drift => {
      const kv = createMockKV();
      const envOverrides: Partial<Env> = { CODING_AGENTS: 'pi' };
      kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
      reconcile.mockImplementationOnce(async (...args: any[]) => {
        if (drift === 'projection') args[0].CODING_AGENTS = 'claude-code';
        if (drift === 'release') state.active = { ...state.active!, digest: 'e'.repeat(64) };
        if (drift === 'policy') state.resourcePolicy = 'exclusive';
        if (drift === 'mode' || drift === 'pending') {
          const latest = await kv.get('user-prefs:user-bucket', 'json') as any;
          kv._set('user-prefs:user-bucket', { ...latest, ...(drift === 'mode' ? { sessionMode: 'default' } : {
            managedEnvironmentReconciliation: { targets: [] },
          }) });
        }
        if (drift === 'owner') kv._set('session:user-bucket:race-session', { id: 'race-session', status: 'running', userId: 'user@example.com', lifecycleGeneration: 1 });
        if (drift === 'migration') vi.mocked((await import('../../lib/r2-migration')).isBucketMigrating).mockResolvedValueOnce(true);
        if (drift === 'encryption') vi.mocked((await import('../../lib/r2-migration')).resolveBucketSseOnEnsure).mockResolvedValueOnce(true);
        return { written: [], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
      });
      const app = appFor(kv, undefined, envOverrides);
      const response = await app.request('/seed/agent-configs', { method: 'POST' });
      expect(response.status).not.toBe(200);
      const stored = await kv.get('user-prefs:user-bucket', 'json') as any;
      expect(stored.managedEnvironmentApplied).toBeUndefined();
      if (drift !== 'pending') expect(stored.managedEnvironmentReconciliation.targets).toHaveLength(1);
    });

  it('REQ-STOR-035 AC2: unavailable interrupted history fails before bucket mutation and retains state', async () => {
    const kv = createMockKV();
    const pending = {
      targets: [{ digest: '2'.repeat(64), sequence: 8, mode: 'advanced' as const }],
    };
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentReconciliation: pending,
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(createBucket).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentReconciliation).toEqual(pending);
  });

  it('REQ-STOR-035 AC1: rejects unbounded interrupted target state before bucket mutation', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentReconciliation: {
        targets: Array.from({ length: 33 }, (_, index) => ({
          digest: (index + 1).toString(16).padStart(64, '0'),
          sequence: index + 1,
          mode: 'advanced',
        })),
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(createBucket).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('REQ-STOR-035 AC1/AC3: records automatic target ownership before writes and clears it with applied publication', async () => {
    const interruptedRelease = { ...release, sequence: 8 };
    const interruptedCompressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(interruptedRelease)));
    state.cachedByDigest.set('2'.repeat(64), {
      compressed: interruptedCompressed,
      release: await parseManagedReleaseStream(interruptedCompressed),
    });
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64), managedExtensionsDigest: '4'.repeat(64), sequence: 7,
        mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z',
      },
      managedEnvironmentReconciliation: {
        targets: [{ digest: '2'.repeat(64), sequence: 8, mode: 'advanced' }],
      },
    });
    state.cached = {
      compressed: interruptedCompressed,
      release: { ...(await parseManagedReleaseStream(interruptedCompressed)), sequence: 7 },
    };
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      const during = await kv.get('user-prefs:user-bucket', 'json') as any;
      expect(during.managedEnvironmentReconciliation.targets).toEqual([
        { digest: '2'.repeat(64), sequence: 8, mode: 'advanced' },
        { digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: PROJECTION_ALL },
      ]);
      expect(args[4].interruptedManagedReleases).toEqual([
        expect.objectContaining({ digest: '2'.repeat(64), mode: 'advanced' }),
      ]);
      return { written: [], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });

    expect(response.status).toBe(200);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied.digest).toBe('d'.repeat(64));
    expect(preferences.managedEnvironmentReconciliation).toBeUndefined();
  });

  it('REQ-STOR-035 AC2/AC7: target changes before cleanup, preserves pending ownership, and prevents finalization', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      state.active = {
        ...state.active!,
        digest: 'e'.repeat(64),
        pointer: { ...state.active!.pointer, digest: 'e'.repeat(64), sequence: 10 },
      };
      await args[4].automatic.beforeCleanup();
      return { written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
    expect(response.status).toBe(500);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
    expect(preferences.managedEnvironmentReconciliation).toEqual({
      targets: [{ digest: 'd'.repeat(64), sequence: 9, mode: 'advanced', projectionIdentity: PROJECTION_ALL }],
    });
  });

  it('REQ-STOR-034 AC2: public progress moves from planning through writing to finalizing', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      const progress = () => kv.get('managed-reconcile-progress:user-bucket', 'json');
      expect(await progress()).toMatchObject({ phase: 'planning', completed: 0, total: 0 });
      await args[4].automatic.onProgress({ completed: 0, total: 2 });
      expect(await progress()).toMatchObject({ phase: 'writing', completed: 0, total: 2 });
      await args[4].automatic.onProgress({ completed: 2, total: 2 });
      expect(await progress()).toMatchObject({ phase: 'finalizing', completed: 2, total: 2 });
      return { written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });
    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      managedReleaseProgress: { phase: 'finalizing', completed: 2, total: 2 },
    });
    // Progress reporting is not physical finalization or concurrency safety proof.
  });

  it('REQ-STOR-034 AC2: finalizing progress is persisted before cleanup begins', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      const options = args[4] as { automatic: { onProgress: (value: { completed: number; total: number }) => Promise<void> } };
      await options.automatic.onProgress({ completed: 0, total: 0 });
      const progress = await kv.get('managed-reconcile-progress:user-bucket', 'json') as { phase?: string };
      expect(progress.phase).toBe('finalizing');
      return { written: [], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
    expect(response.status).toBe(200);
  });

  it('REQ-STOR-034 AC4/AC5/AC6: response and stored completion survive a stale KV read', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    const read = kv.get.getMockImplementation()!;
    kv.get.mockImplementation((key, type) => key === 'managed-reconcile-progress:user-bucket'
      ? Promise.resolve({
          schemaVersion: 1, targetDigest: 'd'.repeat(64), phase: 'planning', completed: 0, total: 0,
          updatedAt: '2026-09-03T12:00:00.000Z',
        })
      : read(key, type));
    reconcile.mockImplementationOnce(async (...args: any[]) => {
      await args[4].automatic.onProgress({ completed: 61, total: 61 });
      return { written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [], managedPathsDigest: undefined };
    });

    const response = await appFor(kv).request('/seed/agent-configs/upgrade', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      managedReleaseProgress: { phase: 'finalizing', completed: 61, total: 61 },
    });
    expect(await kv.get('managed-reconcile-progress:user-bucket', 'json')).toMatchObject({ phase: 'planning' });
    const progressWrites = kv.put.mock.calls.filter(([key]) => key === 'managed-reconcile-progress:user-bucket');
    expect(progressWrites.length).toBeGreaterThan(0);
    expect(progressWrites.every(([, , options]) => options?.expirationTtl === 86_400)).toBe(true);
    expect(kv.put.mock.calls.some(([key]) => key === 'user-prefs:user-bucket')).toBe(true);
    expect(kv.delete.mock.calls.some(([key]) => key === 'managed-reconcile-progress:user-bucket')).toBe(false);
    expect(JSON.parse(kv._store.get('managed-reconcile-progress:user-bucket')!)).toMatchObject({
      phase: 'finalizing', completed: 61, total: 61,
    });
  });
});
