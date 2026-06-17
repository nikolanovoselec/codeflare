import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { AppError } from '../../lib/error-types';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

// authMiddleware authenticates via this; pin a stable identity + bucket.
vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { email: 'u@example.com', authenticated: true, role: 'user' },
    bucketName: 'test-bucket',
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Container DO fetch is the forward target for POST /api/github/clone. The mock
// returns whatever containerFetch resolves to so each test controls the
// upstream status/body the route must relay.
const containerFetch = vi.fn();
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({ fetch: containerFetch })),
}));

import githubRoutes from '../../routes/github';
import { getContainer } from '@cloudflare/containers';

const KEY = 'deploy-keys:test-bucket';
const ENT: Partial<Env> = {
  ENTERPRISE_MODE: 'active',
  GITHUB_APP_CLIENT_ID: 'app-cid',
  GITHUB_APP_CLIENT_SECRET: 'app-sec',
  OAUTH_JWT_SECRET: 'state-secret',
};

let mockKV: ReturnType<typeof createMockKV>;

function createTestApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'Unexpected error' }, 500);
  });
  app.use('*', async (c, next) => {
    (c.env as unknown) = { KV: mockKV, ...env };
    return next();
  });
  app.route('/api/github', githubRoutes);
  return app;
}
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();
});

// ─── GET /status (REQ-GITHUB-002 AC1) ───────────────────────────────────────

describe('GET /api/github/status', () => {
  it('reports enabled outside enterprise too (panel available in every mode)', async () => {
    const res = await createTestApp({}).request('/api/github/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.connected).toBe(false);
  });

  it('reports enabled + not connected in enterprise with no token', async () => {
    const res = await createTestApp(ENT).request('/api/github/status');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.connected).toBe(false);
  });

  it('reports connected with login + source when a token exists', async () => {
    mockKV._set(KEY, { githubToken: 'gho_x', githubTokenSource: 'app', githubLogin: 'octo' } satisfies DeployKeys);
    const res = await createTestApp(ENT).request('/api/github/status');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect(body.login).toBe('octo');
    expect(body.source).toBe('app');
  });
});

// ─── GET /repos (REQ-GITHUB-002 AC2) ────────────────────────────────────────

describe('GET /api/github/repos', () => {
  it('401s when not connected and never calls GitHub', async () => {
    const res = await createTestApp(ENT).request('/api/github/repos');
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).code).toBe('NOT_CONNECTED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is reachable in non-enterprise (panel no longer enterprise-gated) — 401 when not connected', async () => {
    const res = await createTestApp({}).request('/api/github/repos');
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).code).toBe('NOT_CONNECTED');
  });

  it('proxies the user repos with the stored token and never returns the token', async () => {
    mockKV._set(KEY, { githubToken: 'gho_secret_tok', githubTokenSource: 'app' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(
      ok([
        { full_name: 'octo/repo', name: 'repo', owner: { login: 'octo' }, private: true, default_branch: 'main', updated_at: '2026-01-01T00:00:00Z' },
      ]),
    );

    const res = await createTestApp(ENT).request('/api/github/repos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: Array<Record<string, unknown>>; page: number; hasMore: boolean };
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({ full_name: 'octo/repo', owner: 'octo', private: true, visibility: 'private', default_branch: 'main' });

    // upstream call carried the token + API version; response never leaks it
    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer gho_secret_tok',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(JSON.stringify(body)).not.toContain('gho_secret_tok');
  });
});

// ─── GET /connect (REQ-GITHUB-001 / 002) ────────────────────────────────────

describe('GET /api/github/connect', () => {
  it('redirects to the provider authorize URL with a signed state + connect callback', async () => {
    const res = await createTestApp(ENT).request('/api/github/connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('github.com');
    expect(loc.pathname).toBe('/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('app-cid');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('redirect_uri')).toMatch(/\/auth\/github\/connect\/callback$/);
  });

  it('503s when no provider is configured', async () => {
    const res = await createTestApp({ ENTERPRISE_MODE: 'active' }).request('/api/github/connect');
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).code).toBe('GITHUB_NOT_CONFIGURED');
  });

  it('is reachable for a non-advanced authed user in non-enterprise (connect is not panel-gated)', async () => {
    const res = await createTestApp({ OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' })
      .request('/api/github/connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('github.com');
    expect(loc.searchParams.get('state')).toBeTruthy();
  });

  it('feeds the scope tier into the OAuth-App authorize scope param', async () => {
    const env = { OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec', OAUTH_JWT_SECRET: 'state-secret' };
    const advanced = new URL(
      (await createTestApp(env).request('/api/github/connect?tier=advanced')).headers.get('location')!,
    );
    expect(advanced.searchParams.get('scope')).toContain('admin:repo_hook');
    const minimal = new URL(
      (await createTestApp(env).request('/api/github/connect?tier=minimal')).headers.get('location')!,
    );
    expect(minimal.searchParams.get('scope')).not.toContain('admin:repo_hook');
  });
});

// ─── POST /disconnect (REQ-GITHUB-005) ──────────────────────────────────────

describe('POST /api/github/disconnect', () => {
  it('revokes + clears the token and returns success', async () => {
    mockKV._set(KEY, { githubToken: 'gho_x', githubTokenSource: 'app' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });

    const res = await createTestApp(ENT).request('/api/github/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).success).toBe(true);
    expect(await mockKV.get(KEY)).toBeNull();
  });
});

// ─── POST /clone (REQ-GITHUB-004 running-session path) ───────────────────────

function containerJson(status: number, json: unknown) {
  return { status, json: async () => json };
}

describe('POST /api/github/clone', () => {
  const SID = 'sid12345678';

  it('is reachable in non-enterprise (panel no longer enterprise-gated) and forwards to the container', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' }));
    const res = await createTestApp({}).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(200);
    expect(containerFetch).toHaveBeenCalled();
  });

  it('forwards to the container /internal/git-clone and relays a 200', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/home/user/workspace/repo' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', ref: 'develop', sessionId: SID }),
    });

    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).status).toBe('cloned');

    // The forwarded request hit the internal clone path and carried repo+ref.
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const forwarded = containerFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/internal/git-clone');
    expect(forwarded.method).toBe('POST');
    const sentBody = await forwarded.json() as Record<string, unknown>;
    expect(sentBody).toEqual({ repo: 'octo/repo', ref: 'develop' });
    // Container is addressed by the bucket+session-derived id.
    expect(vi.mocked(getContainer).mock.calls[0][1]).toBe('test-bucket-sid12345678');
  });

  it('relays a 409 collision verbatim', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(409, { error: 'exists', code: 'CLONE_TARGET_EXISTS' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, unknown>).code).toBe('CLONE_TARGET_EXISTS');
  });

  it('relays a 502 clone failure verbatim', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(502, { error: 'failed', code: 'CLONE_FAILED' }));

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(502);
    expect((await res.json() as Record<string, unknown>).code).toBe('CLONE_FAILED');
  });

  it('omits ref from the forwarded body when not supplied', async () => {
    containerFetch.mockResolvedValueOnce(containerJson(200, { status: 'cloned', path: '/x' }));

    await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    const forwarded = containerFetch.mock.calls[0][0] as Request;
    expect(await forwarded.json() as Record<string, unknown>).toEqual({ repo: 'octo/repo' });
  });

  it('rejects a malformed repo with 400 and never forwards', async () => {
    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'not-valid', sessionId: SID }),
    });
    expect(res.status).toBe(400);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing sessionId with 400 and never forwards', async () => {
    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo' }),
    });
    expect(res.status).toBe(400);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when the container body is not JSON (asleep DO)', async () => {
    containerFetch.mockResolvedValueOnce({ status: 503, json: async () => { throw new Error('not json'); } });

    const res = await createTestApp(ENT).request('/api/github/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'octo/repo', sessionId: SID }),
    });
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).code).toBe('NOT_RUNNING');
  });
});
