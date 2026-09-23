import { describe, expect, it } from 'vitest';
import type { Env } from '../../types';
import { OperatorRuntimeCapability } from '../../operators/gate1-production';

const activityId = 'renovate-activity';
const generation = 2;
const headSha = 'b'.repeat(40);

function request(body: unknown) {
  return new Request('https://operator.internal/v1/dispatcher/renovate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function capability() {
  const activity = { getRuntimePlan: async () => ({ activityId, deadline: Date.now() + 60_000,
    invocationJson: JSON.stringify({ repository: 'owner/repository', pullRequest: 17, headSha }),
    receipt: { operatorId: 'renovate-dispatcher', profile: 'dispatcher', artifactDigest: 'a'.repeat(64),
      policyJson: '{"capabilities":["renovate"]}' },
  }) };
  const env = { OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
  return new OperatorRuntimeCapability({ props: { activityId, generation } } as unknown as ExecutionContext, env);
}

describe('REQ-OPERATOR-051: Renovate Dispatcher assessment', () => {
  it('returns a bounded read-only assessment for the authorized Renovate repository, bot, PR, checks, and diff', async () => {
    const response = await capability().fetch(request({ repository: 'owner/repository', pullRequest: 17, headSha,
      bot: 'renovate[bot]', checks: [{ name: 'tests', conclusion: 'success' }],
      diff: { files: 2, bytes: 1024, truncated: false },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schemaVersion: 1,
      result: { repository: 'owner/repository', pullRequest: 17, observedHead: headSha,
        readOnly: true, evidence: { complete: true } } });
  });

  it('binds recommendations to the exact observed head and reports stale or incomplete evidence instead of treating it as current', async () => {
    const response = await capability().fetch(request({ repository: 'owner/repository', pullRequest: 17,
      headSha: 'c'.repeat(40), bot: 'renovate[bot]', checks: [],
      diff: { files: 300, bytes: 2_000_000, truncated: true }, evidence: { rateLimited: true },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { observedHead: 'c'.repeat(40),
      evidence: { stale: true, complete: false, truncated: true, rateLimited: true } } });
  });

  it('denies foreign bots and all repository, session, container, and unattended-rerun mutations', async () => {
    const attempts = [
      { repository: 'owner/repository', pullRequest: 17, headSha, bot: 'dependabot[bot]' },
      { repository: 'owner/repository', pullRequest: 17, headSha, mutation: { method: 'POST', path: '/merge' } },
      { repository: 'owner/repository', pullRequest: 17, headSha, createSession: true },
      { repository: 'owner/repository', pullRequest: 17, headSha, createContainer: true },
      { repository: 'owner/repository', pullRequest: 17, headSha, schedule: 'hourly' },
    ];

    for (const body of attempts) expect((await capability().fetch(request(body))).status).toBe(403);
  });
});
