import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { ADMIN_CONFIGURATION_KEYS, SETUP_KEYS } from '../../lib/kv-keys';

let mockRole = 'admin';
let mockAuthReject = false;

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (mockAuthReject) throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    c.set('user', { email: 'admin@example.com', authenticated: true, role: mockRole });
    c.set('bucketName', 'codeflare-admin');
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => {
    if (c.get('user')?.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
}));

import configurationRunRoutes from '../../routes/admin/configuration-runs';

function createApp(envOverrides: Partial<Env> = {}) {
  const kv = createMockKV();
  const env = { KV: kv as unknown as KVNamespace, ...envOverrides } as Env;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.env = env;
    return next();
  });
  app.route('/admin/configuration-runs', configurationRunRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    return c.json({ error: String(err) }, 500);
  });
  return { app, kv };
}

type TestApp = ReturnType<typeof createApp>['app'];

const githubValues = {
  providerType: 'app',
  appClientId: 'github-client-id',
  appReplacementSecret: '',
  oauthClientId: '',
  oauthReplacementSecret: '',
};

function post(app: TestApp, body: unknown): Promise<Response> {
  return Promise.resolve(app.request('/admin/configuration-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function snapshots(text: string): any[] {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('configuration runs (REQ-SETUP-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'admin';
    mockAuthReject = false;
  });

  it('rejects unauthenticated and non-admin requests', async () => {
    const { app } = createApp();
    mockAuthReject = true;
    expect((await post(app, { section: 'github', baseRevision: 0, values: githubValues })).status).toBe(401);
    mockAuthReject = false;
    mockRole = 'user';
    expect((await post(app, { section: 'github', baseRevision: 0, values: githubValues })).status).toBe(403);
  });

  it('returns typed conflicts before streaming for Setup, active runs, and stale revisions', async () => {
    const setup = createApp();
    await setup.kv.put(SETUP_KEYS.CONFIGURING, String(Date.now()));
    const setupResponse = await post(setup.app, { section: 'github', baseRevision: 0, values: githubValues });
    expect(setupResponse.status).toBe(409);
    expect(await setupResponse.json()).toMatchObject({ code: 'setup_configuration_active' });

    const active = createApp();
    await active.kv.put(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN, JSON.stringify({
      runId: 'active-run', updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const activeResponse = await post(active.app, { section: 'github', baseRevision: 0, values: githubValues });
    expect(activeResponse.status).toBe(409);
    expect(await activeResponse.json()).toMatchObject({ code: 'configuration_run_active', activeRunId: 'active-run' });

    const staleRevision = createApp();
    await staleRevision.kv.put(ADMIN_CONFIGURATION_KEYS.REVISION, '2');
    const revisionResponse = await post(staleRevision.app, { section: 'github', baseRevision: 1, values: githubValues });
    expect(revisionResponse.status).toBe(409);
    expect(await revisionResponse.json()).toMatchObject({ code: 'configuration_revision_conflict', currentRevision: 2 });
  });

  it('streams sanitized snapshots, applies one section, increments revision once, and releases admission', async () => {
    const { app, kv } = createApp();
    const secretMarker = 'must-never-enter-run-record';

    const response = await post(app, {
      section: 'github',
      baseRevision: 0,
      values: { ...githubValues, appReplacementSecret: secretMarker },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await response.text();
    const events = snapshots(text);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every((event) => event.type === 'snapshot')).toBe(true);
    expect(events[0].run.state).toBe('queued');
    expect(events.at(-1).run).toMatchObject({
      version: 1,
      section: 'github',
      baseRevision: 0,
      resultingRevision: 1,
      initiatedBy: 'admin@example.com',
      state: 'succeeded',
      tasks: [{ id: 'configure_github', state: 'succeeded' }],
    });
    expect(text).not.toContain(secretMarker);
    expect(await kv.get(SETUP_KEYS.GITHUB_PROVIDER_TYPE)).toBe('app');
    expect(await kv.get(SETUP_KEYS.GITHUB_APP_CLIENT_ID)).toBe('github-client-id');
    expect(await kv.get(ADMIN_CONFIGURATION_KEYS.REVISION)).toBe('1');
    expect(await kv.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN)).toBeNull();

    const runId = events[0].run.runId as string;
    const persisted = await kv.get(`${ADMIN_CONFIGURATION_KEYS.RUN_PREFIX}${runId}`) as string;
    expect(persisted).not.toContain(secretMarker);
    expect(JSON.parse(persisted)).toEqual(events.at(-1).run);
    expect(JSON.parse(await kv.get(`admin:configuration:latest:github`) as string)).toMatchObject({ runId, state: 'succeeded' });
  });

  it('reconnects to the same run shape and lists Activity newest-first with a stable cursor', async () => {
    const { app } = createApp();
    const first = snapshots(await (await post(app, { section: 'github', baseRevision: 0, values: githubValues })).text()).at(-1).run;
    const second = snapshots(await (await post(app, { section: 'github', baseRevision: 1, values: githubValues })).text()).at(-1).run;

    const reconnect = await app.request(`/admin/configuration-runs/${encodeURIComponent(first.runId)}`);
    expect(reconnect.status).toBe(200);
    expect(await reconnect.json()).toEqual(first);

    const pageOne = await (await app.request('/admin/configuration-runs?limit=1')).json() as any;
    expect(pageOne.items).toEqual([second]);
    expect(pageOne.nextCursor).toBe(second.runId);
    const pageTwo = await (await app.request(`/admin/configuration-runs?limit=1&cursor=${encodeURIComponent(pageOne.nextCursor)}`)).json() as any;
    expect(pageTwo.items).toEqual([first]);
  });

  it('marks a stale prior run interrupted before admitting new work', async () => {
    const { app, kv } = createApp();
    const prior = {
      version: 1,
      runId: '0000000000001:prior',
      section: 'github',
      baseRevision: 0,
      initiatedBy: 'admin@example.com',
      state: 'running',
      tasks: [{ id: 'configure_github', state: 'running' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await kv.put(`${ADMIN_CONFIGURATION_KEYS.RUN_PREFIX}${prior.runId}`, JSON.stringify(prior));
    await kv.put(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN, JSON.stringify({
      runId: prior.runId,
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
    }));

    expect((await post(app, { section: 'github', baseRevision: 0, values: githubValues })).status).toBe(200);
    const recovered = JSON.parse(await kv.get(`${ADMIN_CONFIGURATION_KEYS.RUN_PREFIX}${prior.runId}`) as string);
    expect(recovered).toMatchObject({ state: 'interrupted', error: { code: 'configuration_run_interrupted', retryable: true } });
    expect(recovered.tasks[0].state).toBe('failed');
  });

  it('persists failure, skips remaining tasks, leaves revision unchanged, and releases admission', async () => {
    const { app, kv } = createApp({ ENTERPRISE_MODE: 'active' });
    const originalPut = vi.mocked(kv.put).getMockImplementation();
    vi.mocked(kv.put).mockImplementation(async (key, value, options) => {
      if (key === SETUP_KEYS.R2_SSE_DISABLED) throw new Error('provider unavailable: secret detail');
      if (originalPut) return originalPut(key, value, options);
      kv._store.set(key, value);
    });

    const response = await post(app, {
      section: 'dataGovernance',
      baseRevision: 0,
      values: { governedMode: true, viewOnlyStorage: true },
    });
    expect(response.status).toBe(200);
    const terminal = snapshots(await response.text()).at(-1).run;
    expect(terminal.state).toBe('failed');
    expect(terminal.tasks).toEqual([
      expect.objectContaining({ id: 'configure_r2_sse', state: 'failed' }),
      expect.objectContaining({ id: 'configure_downloads_disabled', state: 'skipped' }),
    ]);
    expect(terminal.error).toMatchObject({ retryable: true, operatorAction: expect.any(String) });
    expect(JSON.stringify(terminal)).not.toContain('secret detail');
    expect(await kv.get(ADMIN_CONFIGURATION_KEYS.REVISION)).toBeNull();
    expect(await kv.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN)).toBeNull();
  });
});
