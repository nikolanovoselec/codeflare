/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * REQ-OPERATOR-045: management and invocation are independently authorized at
 * their HTTP boundaries. The authenticated identity comes from the existing
 * middleware boundary; no route accepts an identity in its JSON payload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../index';
import type { Env } from '../../types';

const actor = vi.hoisted(() => ({ email: 'manager@example.test', groups: ['operators'] as string[] | undefined }));

vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: actor.email, role: 'user', authenticated: true });
    return next();
  },
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({
    human: {
      subject: actor.email, email: actor.email, issuer: 'https://issuer.example.test', audiences: ['operator-management'],
      groups: actor.groups, issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 300,
    },
    // The resolver receives a verified Access credential, not a caller-supplied
    // user or group value from the management request body.
    accessJwt: `verified-${actor.email}`,
  }),
}));

function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
  return worker.fetch(new Request(`https://operators.example.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'verified-access-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), {
    ENTERPRISE_MODE: 'active',
  } as Env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
}

const registration = {
  repositoryUrl: 'https://github.com/acme/release-operator', githubPat: 'write-only-fixture-pat',
  profile: 'conductor', realm: 'internal',
  managers: { users: ['manager@example.test'], groups: [{ issuer: 'https://issuer.example.test', id: 'operators' }] },
  invokers: { users: ['invoker@example.test'], groups: [] },
  policy: { capabilities: [], resourceProfileId: null },
};

beforeEach(() => {
  actor.email = 'manager@example.test';
  actor.groups = ['operators'];
});

describe('REQ-OPERATOR-045: delegated management and invocation', () => {
  it('allows a manager to create and enumerate only its operator while an invoker cannot enumerate or mutate it', async () => {
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; enabled: boolean };
    expect(operator).toMatchObject({ id: expect.any(String), enabled: false });

    const managerCatalog = await request('/api/operator-management/operators');
    expect(managerCatalog.status).toBe(200);
    expect(await managerCatalog.json()).toMatchObject({ items: [expect.objectContaining({ id: operator.id })], cursor: null });

    actor.email = 'invoker@example.test';
    const deniedCatalog = await request('/api/operator-management/operators');
    expect(deniedCatalog.status).toBe(404);
    expect(await deniedCatalog.text()).not.toContain(operator.id);
    const deniedGrantChange = await request(`/api/operator-management/operators/${operator.id}/grants`, 'POST', {
      managers: registration.managers, invokers: registration.invokers, revision: 1,
    });
    expect(deniedGrantChange.status).toBe(404);
    expect(await deniedGrantChange.text()).not.toContain(operator.id);

    const invoked = await request('/api/operator-activities', 'POST', {
      operatorId: operator.id, invocation: { repository: 'acme/release-operator' },
    });
    expect(invoked.status).toBe(201);

    actor.email = 'manager@example.test';
    const managerInvocation = await request('/api/operator-activities', 'POST', {
      operatorId: operator.id, invocation: { repository: 'acme/release-operator' },
    });
    expect(managerInvocation.status).toBe(404);
  });

  it('uses verified group membership for the current request, revokes it immediately, and fails closed when resolution is unavailable', async () => {
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);

    actor.email = 'group-member@example.test';
    actor.groups = ['operators'];
    const groupManager = await request('/api/operator-management/operators');
    expect(groupManager.status).toBe(200);
    expect(await groupManager.json()).toMatchObject({ items: [expect.objectContaining({ id: expect.any(String) })] });

    // Membership is resolved again at this protected HTTP request rather than
    // cached from the preceding successful management request.
    actor.groups = [];
    const revoked = await request('/api/operator-management/operators');
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).not.toHaveProperty('items');

    actor.groups = undefined;
    const unavailable = await request('/api/operator-management/operators');
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).not.toHaveProperty('items');
  });
});
