import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
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
      operatorId: 'renovate-dispatcher', revision: 3, artifactDigest: 'a'.repeat(64),
      manifestJson: '{}', policyJson: '{"schemaVersion":1}', profile: 'dispatcher',
    } }),
  };
  const env = {
    ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)),
    OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => activity },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
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
  it('admits a Dispatcher activity only with parent-bound repository and pull-request selection', async () => {
    const { post, prepared } = fixture();

    const response = await post({ operatorId: 'renovate-dispatcher', invocation: {
      repository: 'owner/repository', pullRequest: 17,
    } });

    expect(response.status).toBe(201);
    const body = await response.json() as { activityId: string; startCapability: string };
    expect(body).toMatchObject({ activityId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      startCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(prepared()).toMatchObject({
      intent: { operatorId: 'renovate-dispatcher', activityId: body.activityId,
        intentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      context: { activityId: body.activityId, operatorId: 'renovate-dispatcher', principal: 'operator' },
      invocationJson: JSON.stringify({ repository: 'owner/repository', pullRequest: 17 }),
    });
  });

  it.each([
    ['profile', { profile: 'conductor' }],
    ['session', { sessionId: 'caller-created-session' }],
    ['resources', { resources: { repository: 'other-owner/other-repository' } }],
  ])('denies caller-selected %s substitutions before any activity is prepared', async (_field, substitution) => {
    const { post, prepared } = fixture();

    const response = await post({ operatorId: 'renovate-dispatcher', invocation: {
      repository: 'other-owner/other-repository', pullRequest: 99, ...substitution,
    } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: expect.any(String) });
    expect(prepared()).toBeUndefined();
  });
});
