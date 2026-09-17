import { describe, expect, it, vi } from 'vitest';
import { ContainerOwnedSessionRuntime } from '../../operators/gate1-runtime';
import type { OperatorContainerProfile } from '../../container/operator-context';

const profile = { schemaVersion: 1, activityId: 'activity-gate1', operatorId: 'codeflare-gate1-fixture',
  sessionId: 'gate1-activity-gate1', ownerBucket: 'owner-bucket', policyDigest: 'a'.repeat(64),
  deadline: Date.now() + 60_000, outputPrefix: 'operator-fixtures/gate-1/activity-gate1/gate1-activity-gate1/',
  human: { subject: 'human', email: 'owner@example.test', issuer: 'https://access.example.test/', audiences: ['aud'] },
  policy: { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
    storage: { readPrefixes: ['operator-fixtures/gate-1/'], writePrefixes: ['operator-fixtures/gate-1/'] },
    inference: { routeIds: ['route'], defaultRouteId: 'route', reasoningLevels: ['off'],
      defaultReasoningLevel: 'off', inheritUserDefaults: false } },
  jwtPolicy: { mode: 'off', destinations: [] },
  piProfile: { provider: 'codeflare-gateway', model: 'route', thinkingLevel: 'off', systemPrompt: 'fixed', tools: ['write'] },
} as OperatorContainerProfile;
const authority = { human: { ...profile.human, issuedAt: 1, expiresAt: Math.floor(profile.deadline / 1000) + 1 }, accessJwt: 'jwt' };

describe('REQ-OPERATOR-005: owned container runtime', () => {
  it('uses the exact parent-owned container identity for configure, readiness and restricted stop', async () => {
    const stub = {
      setBucketName: vi.fn(), configureOperatorContext: vi.fn(), startAndWaitForPorts: vi.fn(),
      getState: vi.fn(async () => ({ status: 'running' })),
      fetch: vi.fn(async () => Response.json({ initFlagObserved: true, terminalServiceReady: true })),
      stopOperatorSession: vi.fn(async () => 'stopped'),
    };
    const resolve = vi.fn(() => stub);
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, resolve });
    expect(await runtime.reserve({ requestId: 'request', requestDigest: 'b'.repeat(64),
      activityId: profile.activityId, ownerBucket: profile.ownerBucket, sessionId: profile.sessionId }))
      .toEqual({ sessionId: profile.sessionId });
    await runtime.configure(profile.sessionId, profile, authority);
    await runtime.start(profile.sessionId);
    expect(await runtime.readiness(profile.sessionId)).toBe('ready');
    expect(await runtime.stop(profile.sessionId, false)).toBe('stopped');
    expect(resolve).toHaveBeenCalledWith('owner-bucket-gate1-activity-gate1');
    expect(stub.setBucketName).toHaveBeenCalledWith(profile.ownerBucket);
    expect(stub.configureOperatorContext).toHaveBeenCalledWith(profile, authority);
    expect(stub.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://container/health' }));
    expect(stub.stopOperatorSession).toHaveBeenCalledWith(profile.activityId, profile.sessionId);
  });

  it('fails closed for mismatched ownership and maps uncertain observations without starting replacement compute', async () => {
    const stub = { getState: vi.fn(async () => { throw new Error('uncertain'); }) };
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, resolve: () => stub as never });
    await expect(runtime.reserve({ requestId: 'request', requestDigest: 'b'.repeat(64),
      activityId: 'other', ownerBucket: profile.ownerBucket, sessionId: profile.sessionId })).rejects.toThrow(/ownership/i);
    expect(await runtime.readiness(profile.sessionId)).toBe('unknown');
  });
});
