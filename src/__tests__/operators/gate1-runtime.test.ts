import { describe, expect, it, vi } from 'vitest';
import { ContainerOwnedSessionRuntime, type Gate1ContainerStub } from '../../operators/gate1-runtime';
import type { OperatorContainerProfile } from '../../container/operator-context';

const profile = { schemaVersion: 1, activityId: 'activity-gate1', operatorId: 'codeflare-gate1-fixture',
  sessionId: 'gate1a1b2c3d4e5f6a7b8', ownerBucket: 'owner-bucket', policyDigest: 'a'.repeat(64),
  deadline: Date.now() + 60_000, outputPrefix: 'operator-fixtures/gate-1/activity-gate1/gate1a1b2c3d4e5f6a7b8/',
  human: { subject: 'human', email: 'owner@example.test', issuer: 'https://access.example.test/', audiences: ['aud'] },
  policy: { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
    storage: { readPrefixes: ['operator-fixtures/gate-1/'], writePrefixes: ['operator-fixtures/gate-1/'] },
    inference: { routeIds: ['route'], defaultRouteId: 'route', reasoningLevels: ['off'],
      defaultReasoningLevel: 'off', inheritUserDefaults: false } },
  jwtPolicy: { mode: 'off', destinations: [] },
  piProfile: { provider: 'codeflare-gateway', model: 'route', thinkingLevel: 'off', systemPrompt: 'fixed', tools: ['write'] },
} as OperatorContainerProfile;
const authority = { human: { ...profile.human, issuedAt: 1, expiresAt: Math.floor(profile.deadline / 1000) + 1 }, accessJwt: 'jwt' };
const routes = { routeCatalog: ['route'], defaultRoute: 'route', defaultReasoning: 'off',
  routeContextWindows: { route: 256_000 }, routeReasoningLevels: { route: ['off'] },
  modelDisplayNames: { route: 'Route' }, promptCacheTargets: [] };

describe('REQ-OPERATOR-005: owned container runtime', () => {
  it('uses the exact parent-owned container identity for configure, readiness and restricted stop', async () => {
    let boundSessionId: string | null = null;
    const stub: Gate1ContainerStub = {
      setBucketName: vi.fn(async (_name: string, options: { sessionId: string }) => {
        boundSessionId = options.sessionId;
      }),
      configureOperatorContext: vi.fn(async (_profile: unknown,
        _authority: Parameters<Gate1ContainerStub['configureOperatorContext']>[1]) => {
        if (boundSessionId !== profile.sessionId) throw new Error('Operator container ownership mismatch');
      }),
      startAndWaitForPorts: vi.fn(async () => {}),
      getState: vi.fn(async () => ({ status: 'running' })),
      fetch: vi.fn(async (_request: Request) => Response.json({ initFlagObserved: true, terminalServiceReady: true })),
      stopOperatorSession: vi.fn(async (_activityId: string, _sessionId: string) => 'stopped' as const),
    };
    const resolve = vi.fn(() => stub);
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, routes, resolve });
    expect(await runtime.reserve({ requestId: 'request', requestDigest: 'b'.repeat(64),
      activityId: profile.activityId, ownerBucket: profile.ownerBucket, sessionId: profile.sessionId }))
      .toEqual({ sessionId: profile.sessionId });
    await runtime.configure(profile.sessionId, profile, authority);
    await runtime.start(profile.sessionId);
    expect(await runtime.readiness(profile.sessionId)).toBe('ready');
    expect(await runtime.stop(profile.sessionId, false)).toBe('stopped');
    expect(resolve).toHaveBeenCalledWith(`owner-bucket-${profile.sessionId}`);
    expect(stub.setBucketName).toHaveBeenCalledWith(profile.ownerBucket, { sessionId: profile.sessionId, ...routes });
    expect(stub.configureOperatorContext).toHaveBeenCalledWith(profile, authority);
    expect(stub.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://container/health' }));
    expect(stub.stopOperatorSession).toHaveBeenCalledWith(profile.activityId, profile.sessionId);
  });

  it('fails closed for mismatched ownership and maps uncertain observations without starting replacement compute', async () => {
    const stub = { getState: vi.fn(async () => { throw new Error('uncertain'); }) };
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, routes, resolve: () => stub as never });
    await expect(runtime.reserve({ requestId: 'request', requestDigest: 'b'.repeat(64),
      activityId: 'other', ownerBucket: profile.ownerBucket, sessionId: profile.sessionId })).rejects.toThrow(/ownership/i);
    expect(await runtime.readiness(profile.sessionId)).toBe('unknown');
  });
});
