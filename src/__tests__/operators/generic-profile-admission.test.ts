import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import routes from '../../routes/operator-activities';

const claims = {
  subject: 'human-subject', email: 'human@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({ human: claims, accessJwt: 'private.access.jwt' }),
}));

type PreparedActivity = { intent: unknown; context: unknown; invocationJson: string };

function fixture() {
  let prepared: PreparedActivity | undefined;
  const activity = {
    prepareAuthorized: async (intent: unknown, context: unknown, invocationJson: string) => {
      prepared = { intent, context, invocationJson };
      return { ok: true as const, phase: 'prepared' as const };
    },
  };
  const registry = {
    resolveForExecution: async () => ({ ok: true as const, value: {
      operatorId: 'example-dispatcher', revision: 3, artifactDigest: 'a'.repeat(64),
      manifestJson: '{}', policyJson: '{"schemaVersion":1}', profile: 'dispatcher',
    } }),
  };
  const env = {
    ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)),
    OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => activity },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError
    ? c.json(error.toJSON(), error.statusCode as never)
    : c.json({ error: 'Internal error' }, 500));
  app.route('/api/operator-activities', routes);
  const post = (body: unknown) => app.request('https://enterprise.example.test/api/operator-activities', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest',
      'cf-access-authenticated-user-email': claims.email,
    }, body: JSON.stringify(body),
  }, env);
  return { post, prepared: () => prepared };
}

beforeEach(() => vi.clearAllMocks());

describe('REQ-OPERATOR-047: generic directed profile admission', () => {
  it('admits a bounded Dispatcher package invocation without interpreting package business fields', async () => {
    const { post, prepared } = fixture();

    const response = await post({ operatorId: 'example-dispatcher', invocation: {
      packageAction: 'assess', target: { project: 'package-owned-value', item: 17 },
    } });

    expect(response.status).toBe(201);
    const body = await response.json() as { activityId: string; startCapability: string };
    expect(body).toMatchObject({ activityId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      startCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(prepared()).toMatchObject({
      intent: { operatorId: 'example-dispatcher', activityId: body.activityId,
        intentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      context: { activityId: body.activityId, operatorId: 'example-dispatcher', principal: 'operator' },
      invocationJson: JSON.stringify({ packageAction: 'assess', target: { project: 'package-owned-value', item: 17 } }),
    });
  });

  it('keeps platform authority outside the opaque package invocation', async () => {
    const { post, prepared } = fixture();

    const response = await post({ operatorId: 'example-dispatcher', installationId: 'caller-selected',
      invocation: { packageAction: 'assess' } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: expect.any(String) });
    expect(prepared()).toBeUndefined();
  });
});
