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
