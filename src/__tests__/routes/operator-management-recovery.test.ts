import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import routes from '../../routes/operator-management';
import { AppError } from '../../lib/error-types';
import type { Env } from '../../types';

const identity = vi.hoisted(() => ({ manager: true, current: true }));
vi.mock('../../middleware/auth', () => ({ authMiddleware: async (c: any, next: () => Promise<void>) => {
  c.set('user', { email: 'owner@example.test', role: 'user' }); c.set('bucketName', 'owner-bucket'); await next();
} }));
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: 'owner@example.test', role: 'user' } }),
  requireOperatorHumanContext: async () => {
    if (!identity.current) throw new AppError('NOT_FOUND', 404, 'Operator not found');
    return { human: { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test', audiences: ['aud'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, groups: [] }, accessJwt: 'private' };
  },
}));
beforeEach(() => { identity.manager = true; identity.current = true; });
function fixture() {
  const grant = { users: ['owner@example.test'], groups: [] };
  const policy = { capabilities: ['fetch'], resourceProfileId: null };
  const observed: unknown[] = [];
  const failure: { value?: Error } = {};
  const registry = {
    getManagementControls: async () => ({ revision: 1, managers: grant, ceiling: { capabilities: ['fetch'], resourceProfileIds: [] } }),
    getManagementInstallation: async () => ({ ok: true, value: { id: 'install', operatorId: 'operator', revision: 7, enabled: false, policy } }),
    getManagementOperator: async () => ({ ok: true, value: { id: 'operator', revision: 2, policy,
      managers: identity.manager ? grant : { users: [], groups: [] }, invokers: grant } }),
    recoverApplication: async (input: any) => {
      observed.push(input);
      if (failure.value) throw failure.value;
      return input.operation === 'preview' ? { items: [], nextCursor: null } : { requestId: input.requestId, reset: 0, skipped: [] };
    },
  };
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError ? c.json(error.toJSON(), error.statusCode as never) : c.json({}, 500));
  app.route('/api/operator-management', routes);
  const request = (operation: string, input: unknown, csrf = true) => app.request(`https://enterprise.example.test/api/operator-management/installations/install/recovery/${operation}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}) }, body: JSON.stringify(input) },
    { ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env);
  return { request, observed, failure };
}
describe('recovery browser POST boundary', () => {
  it('accepts bounded preview and reset for a disabled installation without enabling it', async () => {
    const f = fixture();
    const preview = await f.request('preview', { revision: 7 });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.json()).toEqual({ items: [], nextCursor: null });
    const requestId = crypto.randomUUID();
    const reset = await f.request('reset', { revision: 7, requestId, entries: [{ key: 'opaque:one', version: 'a'.repeat(64) }] });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ requestId, reset: 0, skipped: [] });
    expect(f.observed).toEqual([expect.objectContaining({ operation: 'preview', installationId: 'install', revision: 7 }),
      expect.objectContaining({ operation: 'reset', requestId, authority: expect.objectContaining({ operatorRevision: 2, controlsRevision: 1 }) })]);
  });
  it.each(['csrf', 'manager', 'body', 'oversize'] as const)('denies %s before recovery', async name => {
    const f = fixture();
    if (name === 'manager') identity.manager = false;
    const response = await f.request('preview', name === 'body' ? { revision: -1 } : name === 'oversize'
      ? { revision: 7, after: 'x'.repeat(70 * 1024) } : { revision: 7 }, name !== 'csrf');
    expect(response.status).toBe({ csrf: 403, manager: 404, body: 400, oversize: 413 }[name]);
    expect(f.observed).toEqual([]);
  });
  it.each([['revision', new Error('Application recovery conflict'), 409],
    ['authority', new Error('Operator not found'), 404], ['service', new Error('SDK timeout'), 503]] as const)(
    'preserves %s failure semantics across RPC', async (_, error, status) => {
      const f = fixture(); f.failure.value = error;
      expect((await f.request('preview', { revision: 7 })).status).toBe(status);
    });
});
