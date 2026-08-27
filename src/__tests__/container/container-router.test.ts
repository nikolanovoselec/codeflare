import { describe, it, expect, vi } from 'vitest';

/**
 * CF-016 typed internal-route dispatch tests.
 *
 * These exercise the typed route table (INTERNAL_ROUTES) and the
 * dispatchInternalRoute() lookup that replaced the previous stringly-typed
 * `${method}:${pathname}` Map dispatch in src/container/index.ts. The wire
 * contract (three paths, their methods, JSON responses) MUST stay identical;
 * these tests pin that contract to the typed table and verify the
 * method+path match / miss-fallthrough semantics.
 */

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

import {
  INTERNAL_ROUTES,
  dispatchInternalRoute,
  type ContainerHost,
} from '../../container/container-router';

/** Build a minimal ContainerHost stub with no bucket set. */
function makeHost(overrides: Partial<ContainerHost> = {}): ContainerHost {
  const storage = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  };
  return {
    env: {} as any,
    ctx: { storage } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    envVars: {},
    idleTimeoutPref: '2h',
    _bucketName: null,
    _vaultKey: null,
    _sessionId: null,
    _userEmail: null,
    _routeCatalog: [],
    _routeContextWindows: {},
    _sessionWorkspace: 'terminal',
    ...(overrides as any),
  } as ContainerHost;
}

describe('CF-016 typed internal-route table', () => {
  it('declares exactly the three internal routes with their wire method+path', () => {
    // The table is the source of truth for the wire contract. If a route is
    // added/removed/retyped this assertion forces a deliberate update.
    const contract = INTERNAL_ROUTES.map((r) => ({ name: r.name, method: r.method, path: r.path }));
    expect(contract).toEqual([
      { name: 'setBucketName', method: 'POST', path: '/_internal/setBucketName' },
      { name: 'setSessionId', method: 'PUT', path: '/_internal/setSessionId' },
      { name: 'getBucketName', method: 'GET', path: '/_internal/getBucketName' },
    ]);
  });

  it('every route name is unique (discriminant integrity)', () => {
    const names = INTERNAL_ROUTES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every (method, path) pair is unique (no shadowed routes)', () => {
    const keys = INTERNAL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('CF-016 dispatchInternalRoute', () => {
  it('routes GET /_internal/getBucketName to the getBucketName handler and returns the typed body', async () => {
    const host = makeHost({ _bucketName: 'my-bucket' });
    const request = new Request('http://container/_internal/getBucketName', { method: 'GET' });

    const result = dispatchInternalRoute(host, request);
    expect(result).not.toBeNull();
    const response = await result!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bucketName: 'my-bucket' });
  });

  it('routes PUT /_internal/setSessionId to the setSessionId handler and stores the id', async () => {
    const host = makeHost();
    const request = new Request('http://container/_internal/setSessionId', {
      method: 'PUT',
      body: JSON.stringify({ sessionId: 'sess-123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect((host.ctx.storage.put as any)).toHaveBeenCalledWith('_sessionId', 'sess-123');
    expect(host._sessionId).toBe('sess-123');
  });

  it('returns null (fall-through) when the path is not an internal route', () => {
    const host = makeHost();
    const request = new Request('http://container/internal/bisync-trigger', { method: 'POST' });
    expect(dispatchInternalRoute(host, request)).toBeNull();
  });

  it('returns null when the path matches but the method does not (e.g. GET on a POST route)', () => {
    // Wire-contract guard: GET /_internal/setBucketName must NOT dispatch to
    // the POST handler - the old Map keyed on method too, so the miss falls
    // through to the container-forward path.
    const host = makeHost();
    const request = new Request('http://container/_internal/setBucketName', { method: 'GET' });
    expect(dispatchInternalRoute(host, request)).toBeNull();
  });

  // The Worker calls the same idempotent config route before every start. A woken
  // Durable Object already has its bucket but not the memory-only clone fields.
  it('REQ-GITHUB-014 AC1: restores the clone directive when a stopped session resumes with a fresh container', async () => {
    const host = makeHost({
      _bucketName: 'b',
      _gitCloneRepo: null,
      _gitCloneRef: null,
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({ bucketName: 'b', gitCloneRepo: 'octo/repo', gitCloneRef: 'develop' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(409);
    expect(host._gitCloneRepo).toBe('octo/repo');
    expect(host._gitCloneRef).toBe('develop');
    expect(host.envVars.GIT_CLONE_REPO).toBe('octo/repo');
    expect(host.envVars.GIT_CLONE_REF).toBe('develop');
  });

  it('restores scoped R2 credentials from the validated restart payload after a Durable Object wake', async () => {
    const host = makeHost({
      _bucketName: 'b',
      _r2AccessKeyId: null,
      _r2SecretAccessKey: null,
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({
        bucketName: 'b',
        r2AccessKeyId: 'scoped-access',
        r2SecretAccessKey: 'scoped-secret',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(409);
    expect(host._r2AccessKeyId).toBe('scoped-access');
    expect(host._r2SecretAccessKey).toBe('scoped-secret');
  });

  it('REQ-ENTERPRISE-026: refreshes warm strict interception with a changed scoped pair', async () => {
    let activeCatchAll: { fetch(request: Request): Promise<Response> } | undefined;
    const EgressController = vi.fn(({ props }: { props: { r2AccessKeyId: string } }) => ({
      fetch: vi.fn(async () => new Response(props.r2AccessKeyId)),
    }));
    const host = makeHost({
      env: { ENTERPRISE_MODE: 'active' } as any,
      ctx: {
        storage: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
        exports: { EgressController },
        container: {
          interceptOutboundHttps: vi.fn(async (pattern: string, worker: typeof activeCatchAll) => {
            if (pattern === '*') activeCatchAll = worker;
          }),
        },
      } as any,
      _bucketName: 'b',
      _r2AccountId: 'account',
      _r2AccessKeyId: 'prior-access',
      _r2SecretAccessKey: 'prior-secret',
      _strictEgress: true,
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({
        bucketName: 'b',
        r2AccessKeyId: 'replacement-access',
        r2SecretAccessKey: 'replacement-secret',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(409);
    expect(EgressController).toHaveBeenCalledWith({
      props: {
        accountId: 'account',
        bucket: 'b',
        r2AccessKeyId: 'replacement-access',
        r2SecretAccessKey: 'replacement-secret',
        resourcePolicy: 'mutable',
        strict: true,
      },
    });
    expect(activeCatchAll).toBeDefined();
    expect(await (await activeCatchAll!.fetch(new Request('https://account.r2.cloudflarestorage.com/b/key'))).text())
      .toBe('replacement-access');
  });

  it('REQ-ENTERPRISE-027: rejects injected policy digests when policy mode is omitted', async () => {
    const EgressController = vi.fn(() => ({ id: 'replacement' }));
    const host = makeHost({
      env: { ENTERPRISE_MODE: 'active' } as any,
      ctx: {
        storage: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
        exports: { EgressController },
        container: { interceptOutboundHttps: vi.fn() },
      } as any,
      _bucketName: 'b',
      _r2AccessKeyId: 'scoped-access',
      _r2SecretAccessKey: 'scoped-secret',
      _strictEgress: true,
      _managedResourcePolicy: 'mutable',
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({ bucketName: 'b', managedResourceReleaseDigest: 'd'.repeat(64) }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(400);
    expect(EgressController).not.toHaveBeenCalled();
    expect(host._managedResourcePolicy).toBe('mutable');
    expect(host._managedResourceReleaseDigest).toBeUndefined();
  });

  it('REQ-ENTERPRISE-027: refreshes warm strict interception when only policy identity changes', async () => {
    const EgressController = vi.fn(() => ({ id: 'replacement' }));
    const interceptOutboundHttps = vi.fn();
    const host = makeHost({
      env: { ENTERPRISE_MODE: 'active' } as any,
      ctx: {
        storage: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
        exports: { EgressController },
        container: { interceptOutboundHttps },
      } as any,
      _bucketName: 'b',
      _r2AccountId: 'account',
      _r2AccessKeyId: 'scoped-access',
      _r2SecretAccessKey: 'scoped-secret',
      _strictEgress: true,
      _managedResourcePolicy: 'immutable',
      _managedResourceReleaseDigest: 'a'.repeat(64),
      _managedResourcePathsDigest: 'b'.repeat(64),
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({
        bucketName: 'b',
        r2AccessKeyId: 'scoped-access',
        r2SecretAccessKey: 'scoped-secret',
        managedResourcePolicy: 'exclusive',
        managedResourceReleaseDigest: 'd'.repeat(64),
        managedResourcePathsDigest: 'e'.repeat(64),
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(409);
    expect(EgressController).toHaveBeenCalledWith({
      props: {
        accountId: 'account',
        bucket: 'b',
        r2AccessKeyId: 'scoped-access',
        r2SecretAccessKey: 'scoped-secret',
        resourcePolicy: 'exclusive',
        releaseDigest: 'd'.repeat(64),
        pathsDigest: 'e'.repeat(64),
        strict: true,
      },
    });
    expect(interceptOutboundHttps).toHaveBeenCalledWith('*', expect.anything());
    expect(host._managedResourcePolicy).toBe('exclusive');
    expect(host._managedResourceReleaseDigest).toBe('d'.repeat(64));
    expect(host._managedResourcePathsDigest).toBe('e'.repeat(64));
  });

  it('REQ-ENTERPRISE-026: preserves the prior pair when warm catch-all replacement fails', async () => {
    const host = makeHost({
      env: { ENTERPRISE_MODE: 'active' } as any,
      ctx: {
        storage: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
        exports: { EgressController: vi.fn(() => ({ id: 'replacement' })) },
        container: { interceptOutboundHttps: vi.fn().mockRejectedValue(new Error('registration failed')) },
      } as any,
      _bucketName: 'b',
      _r2AccountId: 'account',
      _r2AccessKeyId: 'prior-access',
      _r2SecretAccessKey: 'prior-secret',
      _strictEgress: true,
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({
        bucketName: 'b',
        r2AccessKeyId: 'replacement-access',
        r2SecretAccessKey: 'replacement-secret',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(500);
    expect(host._r2AccessKeyId).toBe('prior-access');
    expect(host._r2SecretAccessKey).toBe('prior-secret');
  });

  it('REQ-ENTERPRISE-026: does not replace warm interception when the scoped pair is unchanged', async () => {
    const EgressController = vi.fn(() => ({ id: 'replacement' }));
    const interceptOutboundHttps = vi.fn();
    const host = makeHost({
      env: { ENTERPRISE_MODE: 'active' } as any,
      ctx: {
        storage: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
        exports: { EgressController },
        container: { interceptOutboundHttps },
      } as any,
      _bucketName: 'b',
      _r2AccountId: 'account',
      _r2AccessKeyId: 'scoped-access',
      _r2SecretAccessKey: 'scoped-secret',
      _strictEgress: true,
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({
        bucketName: 'b',
        r2AccessKeyId: 'scoped-access',
        r2SecretAccessKey: 'scoped-secret',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(409);
    expect(EgressController).not.toHaveBeenCalled();
    expect(interceptOutboundHttps).not.toHaveBeenCalled();
  });

  it('rejects invalid restart credentials without replacing the in-memory scoped pair', async () => {
    const host = makeHost({
      _bucketName: 'b',
      _r2AccessKeyId: 'prior-access',
      _r2SecretAccessKey: 'prior-secret',
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({
        bucketName: 'b',
        r2AccessKeyId: '',
        r2SecretAccessKey: 'replacement-secret',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(400);
    expect(host._r2AccessKeyId).toBe('prior-access');
    expect(host._r2SecretAccessKey).toBe('prior-secret');
  });

  it.each([
    { r2AccessKeyId: 'replacement-access' },
    { r2SecretAccessKey: 'replacement-secret' },
  ])('rejects a partial restart credential pair without mutating prior credentials: %o', async (credentials) => {
    const host = makeHost({
      _bucketName: 'b',
      _r2AccessKeyId: 'prior-access',
      _r2SecretAccessKey: 'prior-secret',
      _sessionMode: 'default',
    });
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({ bucketName: 'b', ...credentials }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await dispatchInternalRoute(host, request)!;

    expect(response.status).toBe(400);
    expect(host._r2AccessKeyId).toBe('prior-access');
    expect(host._r2SecretAccessKey).toBe('prior-secret');
  });

  // REQ-ENTERPRISE-005: the first-config persistence path must store an EMPTY-STRING
  // default route/reasoning (the "reasoning off / first-route fallback" reset), not swallow
  // it the way a truthiness guard would - mirroring applyPrefsOnRestart's empty-reset
  // contract (container-restart-prefs.test.ts). The puts fire before applySetBucketName, so
  // this asserts the observable storage writes regardless of the R2 setup outcome. Reverting
  // the guard to `if (defaultRoute)` makes both puts disappear and fails this test.
  it('persists an empty-string defaultRoute/defaultReasoning on first config (empty-reset, not swallowed)', async () => {
    const host = makeHost();
    const request = new Request('http://container/_internal/setBucketName', {
      method: 'POST',
      body: JSON.stringify({ bucketName: 'b', routeCatalog: ['development'], defaultRoute: '', defaultReasoning: '' }),
      headers: { 'Content-Type': 'application/json' },
    });

    await dispatchInternalRoute(host, request)!;

    expect((host.ctx.storage.put as any)).toHaveBeenCalledWith('defaultRoute', '');
    expect((host.ctx.storage.put as any)).toHaveBeenCalledWith('defaultReasoning', '');
    expect(host._defaultRoute).toBe('');
    expect(host._defaultReasoning).toBe('');
  });
});
