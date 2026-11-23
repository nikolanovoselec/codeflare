import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { D1SessionRepository } from '../../lib/session-repository';
import { createMockSessionStop, withMockStartClaim } from '../helpers/mock-session-stop';

// ---------------------------------------------------------------------------
// Mock container stub
// ---------------------------------------------------------------------------
function createMockContainer() {
  return {
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ bucketName: null }), { status: 200 })),
    destroy: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn(),
    getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
    startSession: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Shared mutable state - vi.hoisted ensures this runs before vi.mock factories
// ---------------------------------------------------------------------------
const testState = vi.hoisted(() => ({
  kv: null as ReturnType<typeof createMockKV> | null,
  container: null as ReturnType<typeof createMockContainer> | null,
  createBucketResult: { success: true, created: false } as { success: boolean; error?: string; created?: boolean },
}));

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => withMockStartClaim(testState.container!, testState.kv!)),
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: vi.fn(async () => testState.createBucketResult),
  getOrCreateScopedR2Token: vi.fn(async () => ({
    accessKeyId: 'scoped-ak',
    secretAccessKey: 'scoped-sk',
    tokenId: 'scoped-tok',
  })),
}));

vi.mock('../../lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return { ...actual, requireOperatorHumanContext: async (request: Request, _env: Env, email: string) => {
    if (request.headers.get('cf-access-jwt-assertion') !== 'human-credential' || email !== 'test@example.com') {
      throw new Error('Verified human Access required');
    }
    return { human: { subject: 'owner', email, issuer: 'https://team.cloudflareaccess.com',
      audiences: ['aud'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'human-credential' };
  } };
});

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn(async () => ({ written: ['Getting-Started.md'], skipped: [] })),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://test.r2.cloudflarestorage.com' })),
}));

// Mock circuit breakers to be pass-through
const passThroughCB = { execute: (fn: () => Promise<unknown>) => fn(), reset: vi.fn() };
vi.mock('../../lib/circuit-breakers', () => ({
  getContainerHealthCB: () => passThroughCB,
  getContainerInternalCB: () => passThroughCB,
  getContainerSessionsCB: () => passThroughCB,
}));

import lifecycleRoutes from '../../routes/container/lifecycle';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';
import { SETUP_KEYS } from '../../lib/kv-keys';

describe('Container Lifecycle Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  // Mock execution context for waitUntil support
  const mockExecutionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };

  beforeEach(() => {
    mockKV = createMockKV();
    testState.kv = mockKV;
    testState.container = createMockContainer();
    testState.createBucketResult = { success: true, created: false };
    // Seed a session in KV so the session existence check (S3 fix) passes
    mockKV._set('session:test-bucket:abcdef1234567890abcdef12', {
      id: 'abcdef1234567890abcdef12',
      name: 'Test Session',
      userId: 'test-bucket',
      status: 'stopped',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Creates a test app and returns a fetch helper that provides ExecutionContext.
   * Lifecycle routes use c.executionCtx.waitUntil(), which requires the
   * ExecutionContext parameter in app.fetch().
   */
  function createLifecycleApp(bucketName = 'test-bucket', extraEnv: Partial<Env> = {}) {
    container().stopSession.mockImplementation(createMockSessionStop(mockKV, () => container().destroy()));
    const app = createTestApp({
      routes: [{ path: '/container', handler: lifecycleRoutes }],
      mockKV,
      bucketName,
      envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', ...extraEnv } as Partial<Env>,
    });

    // Return a fetch helper that includes ExecutionContext
    const fetch = (path: string, init?: RequestInit) => {
      const req = new Request(`http://localhost${path}`, init);
      return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
    };

    return fetch;
  }

  // Shorthand for the mock container
  function container() {
    return testState.container!;
  }

  // #29: The fake DO records only its public identity binding and configuration
  // surface. A successful start alone must not imply operator authority.
  describe('Enterprise lifecycle human binding (#29)', () => {
    const path = '/container/start?sessionId=abcdef1234567890abcdef12';
    const principal = 'test@example.com';

    function enterpriseHarness(running: boolean, enterprise = true,
      pauseConfiguration?: { entered: () => void; wait: Promise<void> }, staleHuman = false) {
      if (running) mockKV._set('session:test-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12', userId: 'test-bucket', status: 'running', lifecycleGeneration: 1,
      });
      let boundHuman: string | null = running || staleHuman ? principal : null;
      const retainedOwner = principal;
      let configured = false;
      let retired = false;
      const stub = container() as ReturnType<typeof createMockContainer> & {
        bindReviewHuman: ReturnType<typeof vi.fn>;
        getReviewHuman: ReturnType<typeof vi.fn>;
      };
      stub.getReviewHuman = vi.fn(async () => boundHuman);
      stub.bindReviewHuman = vi.fn(async (authority: { human: { email: string } } | null) => {
        if (!configured) throw new Error('binding preceded lifecycle configuration');
        if (authority && retired) throw new Error('Retired session cannot bind authority');
        if (authority && authority.human.email !== retainedOwner) throw new Error('Session human mismatch');
        boundHuman = authority?.human.email ?? null;
      });
      stub.getState.mockResolvedValue({ status: running ? 'running' : 'stopped' });
      stub.fetch.mockImplementation(async (request: Request) => {
        if (request.url.endsWith('/_internal/getBucketName')) {
          return Response.json({ bucketName: running ? 'test-bucket' : null });
        }
        if (request.url.endsWith('/_internal/setBucketName')) {
          configured = true;
          pauseConfiguration?.entered();
          if (pauseConfiguration) await pauseConfiguration.wait;
          return new Response(null, { status: running ? 409 : 200 });
        }
        throw new Error(`Unexpected DO request: ${request.url}`);
      });
      stub.destroy.mockImplementation(async () => { retired = true; boundHuman = null; });
      return {
        stub,
        fetch: createLifecycleApp('test-bucket', enterprise ? { ENTERPRISE_MODE: 'active' } : {}),
        lookup: async () => boundHuman,
      };
    }

    it.each([
      { allowed: true, source: 'pi-native' },
      { allowed: false, source: 'pi-native' },
      { allowed: true, source: 'managed' },
      { allowed: true, source: undefined },
    ])('REQ-ENTERPRISE-088/089: human start carries resolved fallback source $source without granting permission ($allowed)', async ({ allowed, source }) => {
      mockKV._set(SETUP_KEYS.REASONING_CONFIGURATION, {
        schemaVersion: 1, customProfileRevisions: [], routeAssignments: {},
        fallbackRouting: { enabled: true, routes: [], defaultRoute: '', reasoning: 'off',
          allowPersonalPiProviders: allowed, ...(source !== undefined && { piDefaultSource: source }) },
      });
      const { fetch, stub } = enterpriseHarness(false);
      const response = await fetch(path, { method: 'POST', headers: { 'cf-access-jwt-assertion': 'human-credential' } });
      expect(response.status).toBe(200);
      const configuredRequest = stub.fetch.mock.calls.map(([request]) => request as Request)
        .find(request => request.url.endsWith('/_internal/setBucketName'))!;
      // Intentional Worker-to-container startup wire contract, resolved from saved policy.
      expect(await configuredRequest.json()).toMatchObject({
        routeCatalog: [], defaultRoute: '', defaultReasoning: '',
        piDefaultSource: source ?? 'managed', allowPersonalPiProviders: allowed,
      });
    });

    for (const running of [false, true]) {
      it(`#29: authenticated Enterprise ${running ? 'reconnect' : 'cold start'} binds the same human after configuration`, async () => {
        const { fetch, lookup } = enterpriseHarness(running);
        const response = await fetch(path, {
          method: 'POST', headers: { 'cf-access-jwt-assertion': 'human-credential' },
        });
        expect(response.status).toBe(200);
        expect((await response.json() as { status: string }).status).toBe(running ? 'already_running' : 'starting');
        await vi.waitFor(async () => expect(await lookup()).toBe(principal));
      });
    }

    for (const [kind, headers] of [
      ['missing', {}],
      ['service-only', { 'cf-access-jwt-assertion': 'service-credential' }],
      ['expired', { 'cf-access-jwt-assertion': 'expired-human-credential' }],
      ['mismatched', { 'cf-access-jwt-assertion': 'other-human-credential' }],
    ] as const) {
      it(`#29: ${kind} Access allows ordinary start but removes stale operator authority`, async () => {
        const { fetch, lookup } = enterpriseHarness(false, true, undefined, true);
        expect(await lookup()).toBe(principal);
        const response = await fetch(path, { method: 'POST', headers });
        expect(response.status).toBe(200);
        expect((await response.json() as { status: string }).status).toBe('starting');
        await vi.waitFor(async () => expect(await lookup()).toBeNull());
      });
    }

    it('#29: an unbound cold start without human authority leaves operator authority absent', async () => {
      const { fetch, lookup } = enterpriseHarness(false);
      const response = await fetch(path, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await lookup()).toBeNull();
    });

    it('#29: teardown during reconnect cannot rebind a retired human', async () => {
      let entered!: () => void; let release!: () => void;
      const atConfiguration = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      const { fetch, lookup } = enterpriseHarness(true, true, { entered, wait });
      const reconnect = fetch(path, { method: 'POST', headers: { 'cf-access-jwt-assertion': 'human-credential' } });
      try {
        await atConfiguration;
        const teardown = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', { method: 'POST' });
        expect(teardown.status).toBe(200);
      } finally { release(); }
      await reconnect;
      expect(await lookup()).toBeNull();
    });

    it('#29: disabling Enterprise leaves ordinary start without an operator human binding', async () => {
      const { fetch, lookup } = enterpriseHarness(false, false);
      const response = await fetch(path, { method: 'POST' });
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe('starting');
      expect(await lookup()).toBeNull();
    });
  });

  // =========================================================================
  // POST /container/start
  // =========================================================================
  describe('POST /container/start', () => {
    it.each([
      { terminalMode: 'classic', surface: 'chat' }, { terminalMode: 'classic', surface: 'terminal' },
      { terminalMode: 'herdr', surface: 'chat' }, { terminalMode: 'herdr', surface: 'terminal' },
    ] as const)('REQ-AGENT-272 AC1: forwards $terminalMode $surface only with the exact Start claim', async ({ terminalMode, surface }) => {
      const id = 'abcdef1234567890abcdef12';
      const key = `session:test-bucket:${id}`;
      const session = await mockKV.get(key, 'json') as Session;
      mockKV._set(key, { ...session, agentType: 'pi', workspace: 'terminal', terminalMode, lifecycleGeneration: 4 });
      const launches: unknown[] = [];
      const configs: Array<{ previousGeneration: string | null; body: unknown }> = [];
      container().startSession.mockImplementation(async input => { launches.push(input); });
      container().fetch.mockImplementation(async (request: Request) => {
        if (new URL(request.url).pathname === '/_internal/setBucketName') {
          configs.push({ previousGeneration: request.headers.get('X-Codeflare-Start-Generation'), body: await request.json() });
        }
        return Response.json({ bucketName: 'test-bucket' });
      });

      const response = await createLifecycleApp()(`/container/start?sessionId=${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surface }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'starting', generation: 5 });
      expect(await new D1SessionRepository(createMockSessionD1(mockKV)).getSession('test-bucket', id))
        .toMatchObject({ workspace: 'terminal', lifecycleState: 'starting', lifecycleGeneration: 5 });
      expect(configs).toEqual([{
        previousGeneration: '4',
        body: expect.objectContaining({ bucketName: 'test-bucket', sessionId: id, sessionWorkspace: 'terminal', terminalMode, surface }),
      }]);
      expect(launches).toEqual([expect.objectContaining({ bucket: 'test-bucket', sessionId: id, generation: 5 })]);
    });

    it.each([
      { label: 'unrecognized surface', surface: 'editor', fields: {} },
      { label: 'VS Code workspace', surface: 'chat', fields: { workspace: 'vscode' } },
      { label: 'non-Pi agent', surface: 'chat', fields: { agentType: 'bash' } },
      { label: 'non-Pi primary command', surface: 'chat', fields: {
        terminalMode: 'herdr', tabConfig: [{ id: '1', label: 'Terminal 1', command: '' }],
      } },
    ])('REQ-AGENT-272 AC1: rejects $label before claiming an explicit-surface Start', async ({ surface, fields }) => {
      const id = 'abcdef1234567890abcdef12';
      const key = `session:test-bucket:${id}`;
      const session = await mockKV.get(key, 'json') as Session;
      mockKV._set(key, { ...session, agentType: 'pi', workspace: 'terminal', ...fields });
      container().fetch.mockImplementation(async () => Response.json({ bucketName: 'test-bucket' }));
      const response = await createLifecycleApp()(`/container/start?sessionId=${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surface }),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await new D1SessionRepository(createMockSessionD1(mockKV)).getSession('test-bucket', id))
        .toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 0 });
    });

    it('returns starting status when container is stopped', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; status: string };
      expect(body.success).toBe(true);
      expect(body.status).toBe('starting');
    });

    it('rejects an SDK-running process without a D1 running assignment', async () => {
      const fetch = createLifecycleApp('test-bucket');
      const key = 'session:test-bucket:abcdef1234567890abcdef12';
      mockKV._set(key, {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'test-bucket',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: '2024-01-01T00:05:00.000Z',
      });
      container().getState.mockResolvedValue({ status: 'running' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'test-bucket' }), { status: 200 })
      );

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      expect(await mockKV.get(key, 'json')).toMatchObject({
        lastAccessedAt: '2024-01-01T00:05:00.000Z',
      });
      expect((await mockKV.get(key, 'json') as Session).status).toBeUndefined();
      const listed = await mockKV.list({ prefix: key });
      expect(listed.keys[0]?.metadata).toBeNull();
    });

    it('returns already_running when container is healthy with correct bucket', async () => {
      mockKV._set('session:test-bucket:abcdef1234567890abcdef12', { id: 'abcdef1234567890abcdef12', status: 'running' });
      const fetch = createLifecycleApp('test-bucket');
      container().getState.mockResolvedValue({ status: 'healthy' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'test-bucket' }), { status: 200 })
      );

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; status: string };
      expect(body.success).toBe(true);
      expect(body.status).toBe('already_running');
    });

    it('returns 500 when missing sessionId', async () => {
      const fetch = createLifecycleApp();

      const res = await fetch('/container/start', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
    });

    it('creates R2 bucket before starting container', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(createBucketIfNotExists).toHaveBeenCalledWith(
        'test-account',
        'test-token',
        'my-bucket'
      );
    });

    it('seeds getting-started docs when bucket is newly created', async () => {
      const fetch = createLifecycleApp('my-bucket');
      testState.createBucketResult = { success: true, created: true };
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });

      expect(seedGettingStartedDocs).toHaveBeenCalledWith(
        expect.any(Object),
        'my-bucket',
        'https://test.r2.cloudflarestorage.com',
        { overwrite: false, r2SseDisabled: false }
      );
    });

    it.each(['Europe/Zurich', undefined] as const)(
      'REQ-SESSION-016 AC3: Start consumes saved timezone %s without inventing an absent override', async userTimezone => {
        const fetch = createLifecycleApp();
        if (userTimezone !== undefined) mockKV._set('user-prefs:test-bucket', { userTimezone });
        const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
        container().fetch.mockImplementation(async (request: Request) => {
          const path = new URL(request.url).pathname;
          requests.push({ path, body: request.method === 'POST' ? await request.clone().json() : null });
          return Response.json({ bucketName: null });
        });
        const response = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });
        expect(response.status).toBe(200);
        const configuration = requests.filter(request => request.path === '/_internal/setBucketName');
        expect(configuration).toHaveLength(1);
        if (userTimezone === undefined) expect(configuration[0].body).not.toHaveProperty('userTimezone');
        else expect(configuration[0].body).toMatchObject({ userTimezone: 'Europe/Zurich' });
        expect(await new D1SessionRepository(createMockSessionD1(mockKV)).getSession('test-bucket', 'abcdef1234567890abcdef12'))
          .toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 1 });
      },
    );

    it.each([
      { preference: undefined, enabled: true },
      { preference: false, enabled: false },
    ])('REQ-AGENT-012 AC1: Start forwards the effective Fast Start choice $enabled', async ({ preference, enabled }) => {
      const fetch = createLifecycleApp();
      if (preference !== undefined) mockKV._set('user-prefs:test-bucket', { fastStartEnabled: preference });
      container().fetch.mockImplementation(async () => Response.json({ bucketName: null }));

      const response = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });

      expect(response.status).toBe(200);
      const configuration = container().fetch.mock.calls.map(call => call[0] as Request)
        .find(request => new URL(request.url).pathname === '/_internal/setBucketName');
      expect(configuration).toBeDefined();
      expect(await configuration!.json()).toMatchObject({ fastStartEnabled: enabled });
    });

    it.each([undefined, 'include', 'exclude'] as const)('REQ-SESSION-008: transports current global sync policy %s on start', async policy => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12', name: 'Test', userId: 'my-bucket', status: 'stopped',
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      });
      if (policy !== undefined) await mockKV.put('setup:sync_policy_mode', policy);
      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });
      const request = container().fetch.mock.calls.map(call => call[0] as Request)
        .find(request => new URL(request.url).pathname === '/_internal/setBucketName');
      expect(request).toBeDefined();
      expect(await request!.json()).toMatchObject({ syncPolicyMode: policy ?? 'exclude', workspaceSyncEnabled: false });
    });

    it('passes workspaceSyncEnabled preference to setBucketName', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      mockKV._set('user-prefs:my-bucket', {
        workspaceSyncEnabled: true,
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: null }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      const setBucketRequest = container().fetch.mock.calls[1]?.[0] as Request;
      expect(setBucketRequest).toBeDefined();
      const body = await setBucketRequest.json() as { workspaceSyncEnabled?: boolean };
      expect(body.workspaceSyncEnabled).toBe(true);
    });

    it('REQ-SESSION-006 AC4: restart applies changed sync preference to the same retained workspace', async () => {
      const owner = 'my-bucket';
      const id = 'abcdef1234567890abcdef12';
      const db = createMockSessionD1(mockKV);
      const repository = new D1SessionRepository(db);
      const identity = {
        id, userId: owner, name: 'Retained workspace', status: 'stopped',
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
        workspace: 'terminal', terminalMode: 'classic',
      };
      mockKV._set(`session:${owner}:${id}`, identity);
      mockKV._set(`user-prefs:${owner}`, { workspaceSyncEnabled: false });
      const fetch = createLifecycleApp(owner, { USAGE_DB: db });
      const configurations: Array<{ sessionId: string; bucketName: string; workspaceSyncEnabled: boolean }> = [];
      container().fetch.mockImplementation(async (request: Request) => {
        if (new URL(request.url).pathname === '/_internal/getBucketName') return Response.json({ bucketName: owner });
        if (new URL(request.url).pathname === '/_internal/setBucketName') {
          configurations.push(await request.json());
          return new Response(null, { status: 200 });
        }
        throw Error(`Unexpected container request: ${request.url}`);
      });
      const first = await fetch(`/container/start?sessionId=${id}`, { method: 'POST' });
      expect(first.status).toBe(200);
      const initial = await repository.getSession(owner, id);
      expect(initial).toMatchObject({ ownerKey: owner, sessionId: id, lifecycleState: 'starting', lifecycleGeneration: 1 });
      // Existing public repository lifecycle seam models confirmed exit, not an
      // invented prestart RPC or a direct mutation of the successful Start state.
      expect(await repository.claimStop(owner, id, 'restart-preference-stop', identity.createdAt, 1)).not.toBeNull();
      expect(await repository.confirmStopped(owner, id, 1, 'restart-preference-stop', identity.createdAt)).toBe(true);
      mockKV._set(`user-prefs:${owner}`, { workspaceSyncEnabled: true });
      const second = await fetch(`/container/start?sessionId=${id}`, { method: 'POST' });
      expect(second.status).toBe(200);
      expect(configurations).toEqual([
        expect.objectContaining({ sessionId: id, bucketName: owner, workspaceSyncEnabled: false }),
        expect.objectContaining({ sessionId: id, bucketName: owner, workspaceSyncEnabled: true }),
      ]);
      const restarted = await repository.getSession(owner, id);
      expect(restarted).toMatchObject({
        ownerKey: owner, sessionId: id, name: identity.name, createdAt: identity.createdAt,
        workspace: identity.workspace, terminalMode: identity.terminalMode,
        lifecycleState: 'starting', lifecycleGeneration: 2,
      });
      expect(await repository.listSessions(owner)).toHaveLength(1);
    });

    it('REQ-IDE-048 AC2: starts from the immutable session workspace instead of current preferences', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'VS Code Session',
        userId: 'my-bucket',
        status: 'stopped',
        workspace: 'vscode',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      mockKV._set('user-prefs:my-bucket', { defaultWorkspace: 'terminal' });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ bucketName: null }), { status: 200 }))
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });

      const setBucketRequest = container().fetch.mock.calls[1]?.[0] as Request;
      expect(await setBucketRequest.json()).toMatchObject({ sessionWorkspace: 'vscode' });
    });

    it('REQ-ENTERPRISE-001 AC2: enterprise start resolves sessionMode=advanced with no stored preference (JIT user)', async () => {
      const fetch = createLifecycleApp('my-bucket', { ENTERPRISE_MODE: 'active' } as Partial<Env>);
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      // Deliberately NO user-prefs entry: a JIT-provisioned enterprise user has none.
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: null }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      const setBucketRequest = container().fetch.mock.calls[1]?.[0] as Request;
      expect(setBucketRequest).toBeDefined();
      const body = await setBucketRequest.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });

    it('flag-off: start with no stored preference still resolves sessionMode=default', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: null }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      const setBucketRequest = container().fetch.mock.calls[1]?.[0] as Request;
      expect(setBucketRequest).toBeDefined();
      const body = await setBucketRequest.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('default');
    });

    it('returns error when bucket creation fails', async () => {
      const fetch = createLifecycleApp();
      testState.createBucketResult = { success: false, error: 'Permission denied' };

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('CONTAINER_ERROR');
    });

    it('REQ-SESSION-008: Start leaves a conflicting running bucket untouched', async () => {
      const fetch = createLifecycleApp('new-bucket');
      mockKV._set('session:new-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'new-bucket',
        status: 'running',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'running' });

      let running = true;
      container().destroy.mockImplementation(async () => { running = false; });
      container().fetch
        .mockResolvedValueOnce(Response.json({ bucketName: 'old-bucket' }))
        .mockResolvedValueOnce(Response.json({ error: 'Session configuration no longer authorized' }, { status: 412 }));

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: 'CONTAINER_ERROR' });
      expect(running).toBe(true);
      expect(await mockKV.get('session:new-bucket:abcdef1234567890abcdef12', 'json'))
        .toMatchObject({ status: 'running', userId: 'new-bucket' });
    });

    it('throws ContainerError when setBucketName fails (Q11)', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });

      // First fetch: getBucketName returns null (needs update)
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: null }), { status: 200 })
        )
        // Second fetch: setBucketName fails
        .mockRejectedValueOnce(new Error('DO not reachable'));

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('CONTAINER_ERROR');
    });

    it('aborts container start when setBucketName throws', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });

      // getBucketName returns different bucket name -> needs update
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: 'different-bucket' }), { status: 200 })
        )
        // setBucketName fails
        .mockRejectedValueOnce(new Error('Connection refused'));

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      // Container should NOT have been started
      expect(container().startSession).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Session Limits
  // =========================================================================
  describe('Session limits / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN with env overrides) / REQ-SEC-019 AC2 (per-user concurrent session caps)', () => {
    it('returns 429 when running sessions exceed limit', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 3 running sessions (default limit for regular users)
      for (let i = 1; i <= 3; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(402);
      const body = await res.json() as { code: string; error: string };
      expect(body.code).toBe('QUOTA_EXCEEDED');
    });

    it('REQ-SESSION-007 AC6 / REQ-SUB-013 AC5: simultaneous starts can exceed the best-effort limit', async () => {
      const secondSessionId = 'fedcba0987654321fedcba09';
      mockKV._set(`session:test-bucket:${secondSessionId}`, {
        id: secondSessionId,
        name: 'Second Session',
        userId: 'test-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });

      let arrivals = 0;
      let releaseBoth = (): void => undefined;
      const bothValidated = new Promise<void>((resolve) => { releaseBoth = resolve; });
      vi.mocked(createBucketIfNotExists).mockImplementation(async () => {
        arrivals += 1;
        if (arrivals === 2) releaseBoth();
        await bothValidated;
        return { success: true, created: false };
      });

      const fetch = createLifecycleApp('test-bucket', { MAX_SESSIONS_USER: '1' });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      const [firstResponse, secondResponse] = await Promise.all([
        fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' }),
        fetch(`/container/start?sessionId=${secondSessionId}`, { method: 'POST' }),
      ]);

      expect([firstResponse.status, secondResponse.status]).toEqual([200, 200]);
      const first = await mockKV.get('session:test-bucket:abcdef1234567890abcdef12', 'json') as Session | null;
      const second = await mockKV.get(`session:test-bucket:${secondSessionId}`, 'json') as Session | null;
      expect([first?.status, second?.status]).toEqual(['starting', 'starting']);
    });

    it('REQ-SESSION-007 AC4: enterprise uses the non-SaaS stored-user role limit', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        user: { email: 'enterprise@example.com', authenticated: true, role: 'user' },
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', ENTERPRISE_MODE: 'active' } as Partial<Env>,
      });
      const fetchEnterprise = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );
      for (let i = 1; i <= 3; i++) {
        const id = `enterprise${String(i).padStart(14, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Enterprise ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchEnterprise('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(402);
    });

    it('allows start when under the limit', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed only 2 running sessions (under default limit of 3)
      for (let i = 1; i <= 2; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });

    it('counts every KV-running session against the limit regardless of metrics-heartbeat age', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      const staleU = new Date(Date.now() - 600_000).toISOString(); // 10 min ago

      // 2 running sessions with a fresh heartbeat ...
      for (let i = 1; i <= 2; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        const session = {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          metrics: { cpu: '5%', mem: '128MB', hdd: '1GB', syncStatus: 'success', updatedAt: new Date().toISOString() },
        };
        mockKV._set(`session:test-bucket:${id}`, session);
      }
      // ... plus a 3rd running session whose heartbeat is stale. The shared
      // fixture presents these records through its D1 adapter; heartbeat age
      // does not release capacity -> 3 running == limit of 3 -> Start is blocked.
      const stale = {
        id: 'stalesession0000000001',
        name: 'Stale',
        userId: 'test-bucket',
        status: 'running' as const,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        metrics: { cpu: '5%', mem: '128MB', hdd: '1GB', syncStatus: 'success', updatedAt: staleU },
      };
      mockKV._set('session:test-bucket:stalesession0000000001', stale);

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(402);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('QUOTA_EXCEEDED');
    });

    it('excludes an already running session from its own concurrent cap', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'running' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'test-bucket' }), { status: 200 })
      );

      // Seed 3 running sessions, one of which is the session being restarted
      mockKV._set('session:test-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Restarting Session',
        userId: 'test-bucket',
        status: 'running',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      for (let i = 1; i <= 2; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      // Should succeed because the session itself is excluded from count (2 others < 3)
      expect(res.status).toBe(200);
    });

    it('REQ-SESSION-007 AC4: enterprise stored admin gets the role-based admin limit', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        user: { email: 'admin@example.com', authenticated: true, role: 'admin' },
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', ENTERPRISE_MODE: 'active' } as Partial<Env>,
      });

      const fetchAdmin = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      for (let i = 1; i <= 9; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const allowed = await fetchAdmin('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(allowed.status).toBe(200);

      const tenthId = 'runningsession00000010';
      mockKV._set(`session:test-bucket:${tenthId}`, {
        id: tenthId,
        name: 'Running 10',
        userId: 'test-bucket',
        status: 'running',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      const rejected = await fetchAdmin('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(rejected.status).toBe(402);
    });

    it('REQ-SESSION-007 AC7: respects MAX_SESSIONS_USER env var override', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', MAX_SESSIONS_USER: '5' } as Partial<Env>,
      });

      const fetchWithOverride = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 4 running sessions (above default 3 but below override 5)
      for (let i = 1; i <= 4; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchWithOverride('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });

    it('REQ-SESSION-007 AC7: respects MAX_SESSIONS_ADMIN env var override', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        user: { email: 'admin@example.com', authenticated: true, role: 'admin' },
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', MAX_SESSIONS_ADMIN: '2' } as Partial<Env>,
      });
      const fetchAdminOverride = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };
      for (let i = 1; i <= 2; i++) {
        const id = `adminoverride${String(i).padStart(11, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Admin Override ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchAdminOverride('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(res.status).toBe(402);
    });

    it('falls back to default when env var is invalid', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', MAX_SESSIONS_USER: 'invalid' } as Partial<Env>,
      });

      const fetchBadEnv = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 3 running sessions (hits default limit of 3)
      for (let i = 1; i <= 3; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchBadEnv('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      // Should use default limit of 3, so 3 running = 402
      expect(res.status).toBe(402);
    });

    it('bypasses session limit when STRESS_TEST_MODE is active', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', STRESS_TEST_MODE: 'active' } as Partial<Env>,
      });

      const fetchStress = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 5 running sessions (above default limit of 3)
      for (let i = 1; i <= 5; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchStress('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      // STRESS_TEST_MODE bypasses session limit - should succeed despite 5 running
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // POST /container/destroy
  // =========================================================================
  describe('POST /container/destroy', () => {
    it('destroys the container and returns success', async () => {
      const key = 'session:test-bucket:abcdef1234567890abcdef12';
      mockKV._set(key, { id: 'abcdef1234567890abcdef12', status: 'running', lifecycleGeneration: 1 });
      const fetch = createLifecycleApp();

      const res = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Container destroyed');
      expect(await mockKV.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 1 });
    });

    it('does not issue native teardown for an already stopped session', async () => {
      const key = 'session:test-bucket:abcdef1234567890abcdef12';
      const fetch = createLifecycleApp();
      container().destroy.mockRejectedValue(new Error('An existing stopped row needs no destroy'));
      const res = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await mockKV.get(key, 'json')).toMatchObject({ status: 'stopped' });
    });

    it('REQ-SESSION-018 AC4: a delayed Destroy cannot stop the replacement', async () => {
      const key = 'session:test-bucket:abcdef1234567890abcdef12';
      mockKV._set(key, { id: 'abcdef1234567890abcdef12', status: 'running', lifecycleGeneration: 1 });
      const fetch = createLifecycleApp();
      let replacementRunning = true;
      const stop = createMockSessionStop(mockKV, async () => { replacementRunning = false; });
      container().stopSession.mockImplementation(async input => {
        // The originally captured request reaches the DO only after a restart.
        mockKV._set(key, { id: 'abcdef1234567890abcdef12', status: 'running', lifecycleGeneration: 2 });
        await stop(input);
      });
      const response = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', { method: 'POST' });
      expect(response.status).toBe(500);
      expect(replacementRunning).toBe(true);
      expect(await mockKV.get(key, 'json')).toMatchObject({ status: 'running', lifecycleGeneration: 2 });
    });

    it('returns 500 when destroy fails', async () => {
      mockKV._set('session:test-bucket:abcdef1234567890abcdef12', { id: 'abcdef1234567890abcdef12', status: 'running' });
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'running' });
      container().destroy.mockRejectedValue(new Error('Destroy failed'));

      const res = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('CONTAINER_ERROR');
    });

    it('returns 400 when missing sessionId', async () => {
      const fetch = createLifecycleApp();

      const res = await fetch('/container/destroy', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
    });
  });

});
