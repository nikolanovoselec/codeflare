// Public route outcomes with supplied auth context and real pool D1/KV.
// These cases do not qualify real authentication, container no-start, query
// budgets, primary consistency or hosted runtime behavior.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccessUser, Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { D1SessionRepository } from '../../lib/session-repository';
import { getDefaultTiers, resetTierConfigCache } from '../../lib/subscription';
import { getPreferencesKey, getTiersConfigKey } from '../../lib/kv-keys';
import crud from '../../routes/session/crud';
import lifecycle from '../../routes/session/lifecycle';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import completion from '../../../migrations/usage/0003_complete_session_cutover.sql?raw';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import boundary from '../../../migrations/usage/0004_boundary_activity.sql?raw';

const bindings = env as unknown as Env;
const db = bindings.USAGE_DB;
let owner: string;
const user: AccessUser = { email: 'session-d1-test@example.com', authenticated: true, role: 'user', subscriptionTier: 'free' };
function app(overrides: Partial<Env> = {}) {
  const application = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  application.onError((error, context) => error instanceof AppError
    ? context.json(error.toJSON(), error.statusCode as ContentfulStatusCode)
    : context.json({ error: error.message }, 500));
  application.use('*', async (context, next) => {
    context.env = { ...bindings, SAAS_MODE: undefined, ENTERPRISE_MODE: undefined, STRESS_TEST_MODE: undefined, ...overrides };
    context.set('bucketName', owner);
    context.set('user', user);
    await next();
  });
  application.route('/sessions', lifecycle);
  application.route('/sessions', crud);
  return application;
}
const request = (application: ReturnType<typeof app>, path: string, method: string, body: unknown) =>
  application.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  for (const source of [migration, completion, boundary]) {
    for (const statement of source.split(';').map((part: string) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
});
beforeEach(async () => {
  owner = `public-d1-owner-${crypto.randomUUID()}`;
  resetTierConfigCache();
  await bindings.KV.delete(getTiersConfigKey());
});

describe('REQ-SESSION-001 subsets: public CRUD with supplied owner context and real D1', () => {
  it('AC3/4/5 subsets: Create persists defaults and stopped generation zero; immutable PATCH preserves the row', async () => {
    const application = app();
    const response = await request(application, '/sessions', 'POST', { name: '  Durable name  ', agentType: 'bash', clone: { repo: 'example/repo', ref: 'main' } });
    expect(response.status).toBe(201);
    const body = await response.json() as { session: { id: string } };
    expect(body.session).toMatchObject({ name: 'Durable name', agentType: 'bash', workspace: 'terminal', terminalMode: 'classic', lifecycle: 'stopped', generation: 0, revision: 0 });
    expect(body.session).not.toHaveProperty('userId');
    const repository = new D1SessionRepository(db);
    const persisted = await repository.getSession(owner, body.session.id);
    expect(persisted).toMatchObject({ ownerKey: owner, sessionId: body.session.id, name: 'Durable name', agentType: 'bash',
      createdAt: expect.any(String), lastAccessedAt: expect.any(String), lifecycleState: 'stopped', lifecycleGeneration: 0,
      responseRevision: 0, observationSequence: -1, workspace: 'terminal', terminalMode: 'classic',
      clone: { repo: 'example/repo', ref: 'main' }, editorReady: false, editorReadyError: false });
    const catalog = await application.request('/sessions');
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ sessions: [body.session] });
    for (const patch of [{ workspace: 'vscode' }, { terminalMode: 'herdr' }]) {
      expect((await request(application, `/sessions/${body.session.id}`, 'PATCH', patch)).status).toBe(400);
      expect(await repository.getSession(owner, body.session.id)).toEqual(persisted);
    }
    expect((await request(application, `/sessions/${body.session.id}`, 'PATCH', { name: 'Renamed' })).status).toBe(200);
    expect(await repository.getSession(owner, body.session.id)).toMatchObject({ name: 'Renamed', workspace: 'terminal', terminalMode: 'classic', responseRevision: 1 });
  });

  it('AC4 subset: advanced VS Code/Herdr preferences stamp immutable workspace choices', async () => {
    await bindings.KV.put(getPreferencesKey(owner), JSON.stringify({ sessionMode: 'advanced', defaultWorkspace: 'vscode', herdrEnabled: true }));
    const application = app();
    const response = await request(application, '/sessions', 'POST', { name: 'IDE' });
    expect(response.status).toBe(201);
    const body = await response.json() as { session: { id: string } };
    expect(body.session).toMatchObject({ workspace: 'vscode', terminalMode: 'herdr' });
    const repository = new D1SessionRepository(db);
    const before = await repository.getSession(owner, body.session.id);
    expect((await request(application, `/sessions/${body.session.id}`, 'PATCH', { name: 'Changed', workspace: 'terminal', terminalMode: 'classic' })).status).toBe(400);
    expect(await repository.getSession(owner, body.session.id)).toEqual(before);
  });

  it('AC6 subset: cached SaaS storage above the tier cap denies creation without inserting a row', async () => {
    await bindings.KV.put(getTiersConfigKey(), JSON.stringify(getDefaultTiers().map(tier => tier.id === 'free' ? { ...tier, maxStorageBytes: 100 } : tier)));
    await bindings.KV.put(`storage-stats:${owner}`, JSON.stringify({ totalSizeBytes: 101 }));
    const response = await request(app({ SAAS_MODE: 'active' }), '/sessions', 'POST', { name: 'Over quota' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('Storage quota exceeded');
    expect(await new D1SessionRepository(db).listSessions(owner)).toEqual([]);
  });

  it('AC6 subset: route limiter rejects request eleven without creating any invalid session', async () => {
    const application = app();
    for (let index = 0; index < 10; index++) expect((await request(application, '/sessions', 'POST', { name: 42 })).status).toBe(400);
    const denied = await request(application, '/sessions', 'POST', { name: 'Beyond limit' });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(await new D1SessionRepository(db).listSessions(owner)).toEqual([]);
  });
});

describe('REQ-SESSION-028/030: legacy session records have no authority', () => {
  it('serves D1 catalog/status/create without importing or deleting conflicting legacy records', async () => {
    const repository = new D1SessionRepository(db);
    await repository.create({ ownerKey: owner, sessionId: 'session01', name: 'D1 authority',
      createdAt: '2027-01-01T00:00:00.000Z', lastAccessedAt: '2027-01-01T00:00:00.000Z', workspace: 'terminal', terminalMode: 'classic' });
    const legacy = JSON.stringify({ id: 'session01', name: 'Legacy conflict', status: 'running', userId: owner });
    const orphan = JSON.stringify({ id: 'legacy01', name: 'Legacy only', status: 'running', userId: owner });
    const preferences = JSON.stringify({ sleepAfter: '1h' });
    await bindings.KV.put(`session:${owner}:session01`, legacy);
    await bindings.KV.put(`session:${owner}:legacy01`, orphan);
    await bindings.KV.put(getPreferencesKey(owner), preferences);
    const application = app();
    const catalog = await application.request('/sessions');
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ sessions: [{ id: 'session01', name: 'D1 authority', lifecycle: 'stopped' }] });
    const status = await application.request('/sessions/batch-status');
    expect(status.status).toBe(200);
    const body = await status.json() as { statuses: Record<string, unknown> };
    expect(Object.keys(body.statuses)).toEqual(['session01']);
    expect(body.statuses.session01).toMatchObject({ lifecycle: 'stopped', generation: 0 });
    expect((await request(application, '/sessions', 'POST', { name: 'New D1 session' })).status).toBe(201);
    expect((await repository.listSessions(owner)).map(session => session.name).sort()).toEqual(['D1 authority', 'New D1 session']);
    expect(await bindings.KV.get(`session:${owner}:session01`)).toBe(legacy);
    expect(await bindings.KV.get(`session:${owner}:legacy01`)).toBe(orphan);
    expect(await bindings.KV.get(getPreferencesKey(owner))).toBe(preferences);
  });

  it('fails closed during a D1 outage rather than falling back to preserved legacy sessions', async () => {
    const key = `session:${owner}:legacy01`;
    const legacy = JSON.stringify({ id: 'legacy01', name: 'Legacy only', status: 'running', userId: owner });
    await bindings.KV.put(key, legacy);
    const unavailable = { prepare() { throw new Error('D1 unavailable'); } } as unknown as D1Database;
    const application = app({ USAGE_DB: unavailable });
    for (const path of ['/sessions', '/sessions/batch-status']) {
      const response = await application.request(path);
      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty('sessions');
    }
    expect((await request(application, '/sessions', 'POST', { name: 'Cannot create' })).status).toBe(500);
    expect(await bindings.KV.get(key)).toBe(legacy);
    expect(await new D1SessionRepository(db).listSessions(owner)).toEqual([]);
  });
});

describe('REQ-SESSION-010 subsets: real D1 batch route with supplied owner context', () => {
  it('AC1/2 subsets: owner filtering, seeded lifecycle metadata and no-store response contract', async () => {
    const repository = new D1SessionRepository(db);
    const create = (ownerKey: string, sessionId: string) => repository.create({ ownerKey, sessionId, name: 'Terminal', createdAt: '2027-01-01T00:00:00.000Z', lastAccessedAt: '2027-01-01T00:00:00.000Z', workspace: 'terminal', terminalMode: 'classic' });
    await create(owner, 'session01');
    await create(`${owner}-other`, 'foreign01');
    await repository.start(owner, 'session01', '2027-01-01T00:00:01.000Z');
    await repository.project(owner, 'session01', 1, 0, { lifecycleState: 'running', observedAt: '2027-01-01T00:00:02.000Z', cpu: '12%', memory: '1GB', disk: '2GB', syncStatus: 'success', editorReady: true });
    await repository.observeUnreachable(owner, 'session01', 1, 1, 'incident-one', Date.parse('2027-01-01T00:00:03.000Z'));
    const response = await app().request('/sessions/batch-status?include=storage,usage&includePreseedCheck=true');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    const body = await response.json() as { statuses: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['statuses']);
    expect(Object.keys(body.statuses)).toEqual(['session01']);
    expect(body.statuses.session01).toMatchObject({ status: 'unreachable', lifecycle: 'unreachable', generation: 1, revision: 3,
      editorReady: true, editorReadyError: false, unreachableIncidentId: 'incident-one', unreachableDeadlineMs: Date.parse('2027-01-01T00:02:03.000Z'),
      metrics: { cpu: '12%', mem: '1GB', hdd: '2GB', syncStatus: 'success', updatedAt: '2027-01-01T00:00:02.000Z' } });
  });
});
