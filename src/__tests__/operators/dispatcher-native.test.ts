import { describe, expect, it } from 'vitest';
import type { Env } from '../../types';
import { OperatorRuntimeCapability } from '../../operators/gate1-production';

const activityId = 'dispatcher-activity';
const generation = 4;
const headSha = 'a'.repeat(40);

type RuntimePlan = {
  activityId: string;
  deadline: number;
  invocationJson: string;
  receipt: { operatorId: string; profile: 'dispatcher'; artifactDigest: string; policyJson: string };
};

function fixture(planOverrides: Partial<RuntimePlan> = {}) {
  const plan: RuntimePlan = {
    activityId, deadline: Date.now() + 60_000,
    invocationJson: JSON.stringify({ repository: 'owner/repository', pullRequest: 17, headSha }),
    receipt: { operatorId: 'renovate-dispatcher', profile: 'dispatcher', artifactDigest: 'b'.repeat(64), policyJson: '{"capabilities":["renovate"]}' },
    ...planOverrides,
  };
  const activity = { getRuntimePlan: async () => plan };
  const env = { OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
  const capability = new OperatorRuntimeCapability(
    { props: { activityId, generation } } as unknown as ExecutionContext, env,
  );
  const request = (path = '/v1/dispatcher/renovate', method = 'POST', body: unknown = {
    repository: 'owner/repository', pullRequest: 17, headSha,
  }) => new Request(`https://operator.internal${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  return { capability, request };
}

describe('REQ-OPERATOR-048: Dispatcher native capability contract', () => {
  it('runs approved Dispatcher work through the activity- and generation-bound native capability without a session', async () => {
    const { capability, request } = fixture();

    const response = await capability.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schemaVersion: 1, status: expect.stringMatching(/waiting|completed/),
      result: expect.objectContaining({ activityId, generation, repository: 'owner/repository', pullRequest: 17, headSha }) });
  });

  it('denies profile substitutions, session/container requests, and mutation paths at the native capability boundary', async () => {
    const { capability, request } = fixture();
    const attempts = [
      request('/v1/dispatcher/renovate', 'POST', { repository: 'owner/repository', pullRequest: 17, headSha, profile: 'conductor' }),
      request('/v1/dispatcher/renovate', 'POST', { repository: 'owner/repository', pullRequest: 17, headSha, sessionId: 'session-1' }),
      request('/v1/dispatcher/renovate', 'POST', { repository: 'owner/repository', pullRequest: 17, headSha, mutation: { method: 'PATCH' } }),
      request('/v1/dispatcher/session', 'POST', {}),
    ];

    for (const attempt of attempts) expect((await capability.fetch(attempt)).status).toBe(403);
  });
});
