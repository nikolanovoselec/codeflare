import { describe, expect, it } from 'vitest';
import { parseOperatorConsumerInvocation } from '../../operators/consumer-contracts';
import { parseOperatorPolicy } from '../../operators/policy';
import { resolveGate1Resources, type Gate1ResourceInput } from '../../operators/gate1-resources';

const activityId = 'activity-gate1';
const invocation = (resolvedActivityId = activityId) => parseOperatorConsumerInvocation({
  schemaVersion: 1,
  interfaceVersion: 1,
  consumerId: 'gate1-acceptance',
  activityId: resolvedActivityId,
  operatorId: 'codeflare-gate1-fixture',
  runId: 'run-gate1',
  source: { kind: 'direct', reference: 'gate1-session-smoke' },
  revision: { reference: 'gate1-v1', digest: 'a'.repeat(64) },
  inputDigest: 'b'.repeat(64),
  input: { scenario: 'session-smoke' },
  attachments: [],
  resources: {
    inference: { routeId: 'route-approved', reasoningLevel: 'high' },
    session: { profileId: 'gate1-pi-file-v1' },
    storage: { scopeId: 'gate1-output-v1' },
  },
});
const policy = () => parseOperatorPolicy({
  schemaVersion: 1,
  networkHosts: [],
  github: { repositories: [], methods: [] },
  storage: {
    readPrefixes: ['operator-fixtures/gate-1/'],
    writePrefixes: ['operator-fixtures/gate-1/'],
  },
  inference: {
    routeIds: ['route-approved'],
    defaultRouteId: 'route-approved',
    reasoningLevels: ['off', 'high'],
    defaultReasoningLevel: 'off',
    inheritUserDefaults: false,
  },
});
const human = {
  subject: 'human-gate1',
  email: 'Owner@Example.test',
  issuer: 'https://access.example.test',
  audiences: ['audience-gate1'],
  issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
};

function input(overrides: Partial<Gate1ResourceInput> = {}): Gate1ResourceInput {
  return {
    invocation: invocation(),
    operatorId: 'codeflare-gate1-fixture',
    activityId,
    ownerBucket: 'owner-bucket',
    policy: policy(),
    policyDigest: 'c'.repeat(64),
    deadline: Date.now() + 300_000,
    human,
    eligibleInference: {
      routeIds: ['route-approved', 'route-other'],
      defaultRouteId: 'route-other',
      defaultReasoningLevel: 'off',
    },
    ...overrides,
  };
}

describe('REQ-OPERATOR-005: parent-owned Gate 1 resource mapping', () => {
  it('derives the exact owned session, Pi profile, inference and storage target from parent state', async () => {
    const result = await resolveGate1Resources(input());
    expect(result.effectiveInference).toEqual({ routeId: 'route-approved', reasoningLevel: 'high' });
    const sessionId = result.profile.sessionId;
    expect(sessionId).toBe('gate15d1485c714851da8');
    expect(result.profile).toMatchObject({
      schemaVersion: 1,
      activityId,
      operatorId: 'codeflare-gate1-fixture',
      sessionId,
      ownerBucket: 'owner-bucket',
      policyDigest: 'c'.repeat(64),
      outputPrefix: `operator-fixtures/gate-1/${activityId}/${sessionId}/`,
      human: {
        subject: human.subject,
        email: 'owner@example.test',
        issuer: 'https://access.example.test/',
        audiences: human.audiences,
      },
      piProfile: {
        provider: 'codeflare-gateway',
        model: 'route-approved',
        thinkingLevel: 'high',
        tools: ['read', 'write'],
      },
    });
    expect(result.profile).not.toHaveProperty('accessJwt');
    expect(result.marker).toEqual({
      relativePath: 'gate1-marker.txt',
      storagePath: `operator-fixtures/gate-1/${activityId}/${sessionId}/gate1-marker.txt`,
      content: 'codeflare-gate1-marker-v1\n',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('derives stable and distinct session identities for distinct activities', async () => {
    const first = await resolveGate1Resources(input());
    const repeat = await resolveGate1Resources(input());
    const secondActivityId = 'activity-gate2';
    const second = await resolveGate1Resources(input({ activityId: secondActivityId,
      invocation: invocation(secondActivityId) }));
    expect(repeat.profile.sessionId).toBe(first.profile.sessionId);
    expect(second.profile.sessionId).toBe('gate17092f0f097bf1ee7');
    expect(second.profile.sessionId).not.toBe(first.profile.sessionId);
  });

  it.each([
    ['operator', { operatorId: 'another-operator' }],
    ['activity', { activityId: 'another-activity' }],
    ['session profile', { invocation: { ...invocation(), resources: { ...invocation().resources,
      session: { profileId: 'unknown-profile' } } } }],
    ['storage scope', { invocation: { ...invocation(), resources: { ...invocation().resources,
      storage: { scopeId: 'unknown-scope' } } } }],
    ['paired session resources', { invocation: { ...invocation(), resources: { ...invocation().resources,
      storage: null } } }],
  ])('rejects mismatched %s before deriving resources', async (_label, overrides) => {
    await expect(resolveGate1Resources(input(overrides))).rejects.toThrow(/Gate 1 resources/i);
  });

  it('rejects an expired parent authority and a deadline beyond that authority', async () => {
    await expect(resolveGate1Resources(input({ human: { ...human, expiresAt: 1 } })))
      .rejects.toThrow(/authority/i);
    await expect(resolveGate1Resources(input({ deadline: human.expiresAt * 1000 + 1 })))
      .rejects.toThrow(/authority/i);
  });

  it('fails closed when policy or current eligibility does not cover derived inference and storage', async () => {
    await expect(resolveGate1Resources(input({ policy: parseOperatorPolicy({ ...policy(), storage: {
      readPrefixes: [], writePrefixes: ['operator-fixtures/gate-1/'],
    } }) }))).rejects.toThrow(/Gate 1 resources/i);
    await expect(resolveGate1Resources(input({ eligibleInference: {
      routeIds: ['route-other'], defaultRouteId: 'route-other', defaultReasoningLevel: 'off',
    } }))).rejects.toThrow(/eligible/i);
  });
});
