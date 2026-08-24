import { beforeEach, describe, expect, it } from 'vitest';
import crudRoutes from '../../routes/session/crud';
import type { AccessUser, Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';

describe('REQ-IDE-052 AC1/AC2/AC3: immutable session workspace snapshot', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  function createApp(options: { env?: Partial<Env>; user?: AccessUser } = {}) {
    return createTestApp({
      routes: [{ path: '/sessions', handler: crudRoutes }],
      mockKV,
      ...(options.env && { envOverrides: options.env }),
      ...(options.user && { user: options.user }),
    });
  }

  async function createSession(body: Record<string, unknown> = {}) {
    const response = await createApp().request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { session: Session };
    return { response, session: payload.session };
  }

  it('rejects client-supplied workspace selectors', async () => {
    const response = await createApp().request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: 'vscode' }),
    });

    expect(response.status).toBe(400);
  });

  it('REQ-SESSION-001 AC3 / REQ-IDE-052 AC1: persists and retrieves the immutable workspace snapshot', async () => {
    mockKV._set('user-prefs:test-bucket', {
      sessionMode: 'advanced',
      defaultWorkspace: 'vscode',
    });

    const { response, session } = await createSession();

    expect(response.status).toBe(201);
    expect(session.workspace).toBe('vscode');
    const stored = await mockKV.get(`session:test-bucket:${session.id}`, 'json') as Session;
    expect(stored.workspace).toBe('vscode');

    const restartedApp = createApp();
    const retrieved = await restartedApp.request(`/sessions/${session.id}`);
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json() as { session: Session }).session.workspace).toBe('vscode');
  });

  it('honors the enterprise Advanced entitlement without a stored session mode', async () => {
    mockKV._set('user-prefs:test-bucket', { defaultWorkspace: 'vscode' });
    const app = createApp({ env: { ENTERPRISE_MODE: 'active' } });

    const response = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { session } = await response.json() as { session: Session };

    expect(response.status).toBe(201);
    expect(session.workspace).toBe('vscode');
    expect((await mockKV.get(`session:test-bucket:${session.id}`, 'json') as Session).workspace).toBe('vscode');
  });

  it.each([
    ['missing preferences', undefined],
    ['missing workspace preference', { sessionMode: 'advanced' }],
    ['default mode', { sessionMode: 'default', defaultWorkspace: 'vscode' }],
    ['Terminal preference', { sessionMode: 'advanced', defaultWorkspace: 'terminal' }],
  ])('resolves %s to Terminal without persisting a terminal marker', async (_label, preferences) => {
    if (preferences) mockKV._set('user-prefs:test-bucket', preferences);

    const { response, session } = await createSession();

    expect(response.status).toBe(201);
    expect(session.workspace).toBe('terminal');
    const stored = await mockKV.get(`session:test-bucket:${session.id}`, 'json') as Session;
    expect(stored.workspace).toBeUndefined();
  });

  it('resolves a stale Advanced preference to Terminal after entitlement loss', async () => {
    mockKV._set('user-prefs:test-bucket', {
      sessionMode: 'advanced',
      defaultWorkspace: 'vscode',
    });
    const app = createApp({
      env: { SAAS_MODE: 'active' },
      user: {
        email: 'test@example.com',
        authenticated: true,
        subscriptionTier: 'advanced',
        billingStatus: 'canceled',
      },
    });

    const response = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { session } = await response.json() as { session: Session };

    expect(response.status).toBe(201);
    expect(session.workspace).toBe('terminal');
    expect((await mockKV.get(`session:test-bucket:${session.id}`, 'json') as Session).workspace).toBeUndefined();
  });

  it('REQ-SESSION-001 AC4: historical sessions resolve to Terminal', async () => {
    const historical: Session = {
      id: 'historical12345678',
      name: 'Historical',
      userId: 'test-bucket',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastAccessedAt: '2024-01-01T00:00:00.000Z',
    };
    const editor: Session = {
      ...historical,
      id: 'editorsession1234',
      name: 'Editor',
      workspace: 'vscode',
      lastAccessedAt: '2024-01-02T00:00:00.000Z',
    };
    mockKV._set('session:test-bucket:historical12345678', historical);
    mockKV._set('session:test-bucket:editorsession1234', editor);
    const app = createApp();

    const getResponse = await app.request('/sessions/historical12345678');
    const listResponse = await app.request('/sessions');
    const listed = (await listResponse.json() as { sessions: Session[] }).sessions;

    expect((await getResponse.json() as { session: Session }).session.workspace).toBe('terminal');
    expect(listed.map(({ id, workspace }) => ({ id, workspace }))).toEqual([
      { id: 'editorsession1234', workspace: 'vscode' },
      { id: 'historical12345678', workspace: 'terminal' },
    ]);
  });

  it('keeps an existing VS Code snapshot unchanged after a Standard downgrade', async () => {
    mockKV._set('user-prefs:test-bucket', {
      sessionMode: 'advanced',
      defaultWorkspace: 'vscode',
    });
    const { session } = await createSession();
    mockKV._set('user-prefs:test-bucket', {
      sessionMode: 'default',
      defaultWorkspace: 'terminal',
    });

    const response = await createApp().request(`/sessions/${session.id}`);

    expect((await response.json() as { session: Session }).session.workspace).toBe('vscode');
    expect((await mockKV.get(`session:test-bucket:${session.id}`, 'json') as Session).workspace).toBe('vscode');
  });

  it('uses same workspace snapshot path for clone creation', async () => {
    mockKV._set('user-prefs:test-bucket', {
      sessionMode: 'advanced',
      defaultWorkspace: 'vscode',
    });

    const { response, session } = await createSession({ clone: { repo: 'octo/repo' } });

    expect(response.status).toBe(201);
    expect(session).toMatchObject({ workspace: 'vscode', clone: { repo: 'octo/repo' } });
    expect(await mockKV.get(`session:test-bucket:${session.id}`, 'json')).toMatchObject({
      workspace: 'vscode',
      clone: { repo: 'octo/repo' },
    });
  });
});
