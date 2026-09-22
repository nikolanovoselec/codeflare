import { describe, expect, it, vi } from 'vitest';
import { ContainerOwnedSessionRuntime, type OperatorContainerStub,
  type OperatorSessionBootstrap } from '../../operators/owned-session-runtime';
import type { OperatorContainerProfile } from '../../container/operator-context';

const profile = { schemaVersion: 1, activityId: 'activity-gate1', operatorId: 'codeflare-gate1-fixture',
  sessionId: 'gate1a1b2c3d4e5f6a7b8', ownerBucket: 'owner-bucket', policyDigest: 'a'.repeat(64),
  deadline: Date.now() + 60_000, outputPrefix: 'Operators/',
  human: { subject: 'human', email: 'owner@example.test', issuer: 'https://access.example.test/', audiences: ['aud'] },
  policy: { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
    storage: { readPrefixes: ['Operators/'], writePrefixes: ['Operators/'] },
    inference: { routeIds: ['route'], defaultRouteId: 'route', reasoningLevels: ['off'],
      defaultReasoningLevel: 'off', inheritUserDefaults: false } },
  jwtPolicy: { mode: 'off', destinations: [] },
  piProfile: { provider: 'codeflare-gateway', model: 'route', thinkingLevel: 'off', systemPrompt: 'fixed', tools: ['write'] },
} as OperatorContainerProfile;
const authority = { human: { ...profile.human, issuedAt: 1, expiresAt: Math.floor(profile.deadline / 1000) + 1 }, accessJwt: 'jwt' };
const routes = { routeCatalog: ['route'], defaultRoute: 'route', defaultReasoning: 'off',
  routeContextWindows: { route: 256_000 }, routeReasoningLevels: { route: ['off'] },
  modelDisplayNames: { route: 'Route' }, promptCacheTargets: [] };
const userEmail = 'owner@example.test';
const userGroups = ['engineering'];
const bootstrap: OperatorSessionBootstrap = {
  r2AccessKeyId: 'scoped-key', r2SecretAccessKey: 'scoped-secret', r2AccountId: 'account',
  r2Endpoint: 'https://account.r2.cloudflarestorage.com', r2SseDisabled: true,
  workspaceSyncEnabled: false, fastStartEnabled: true, sessionMode: 'advanced',
  sessionWorkspace: 'terminal' as const, terminalMode: 'classic' as const,
  remoteCurationActive: true, remoteCurationReleaseDigest: 'c'.repeat(64),
  remoteCurationManifestDigest: 'd'.repeat(64), managedResourcePolicy: 'exclusive' as const,
  managedResourcePathsDigest: 'e'.repeat(64),
};

describe('REQ-OPERATOR-005: owned container runtime', () => {
  it('configures package resources before context and prevents start after failed restore', async () => {
    const order: string[] = [];
    const packageResources = { schemaVersion: 1 as const, artifactDigest: 'f'.repeat(64), files: [{
      destination: '/home/user/.config/operator/resource.md', content: 'resource', size: 8, sha256: 'e'.repeat(64),
    }] };
    const stub: OperatorContainerStub = {
      setBucketName: vi.fn(async () => { order.push('bucket'); }),
      configureOperatorResources: vi.fn(async () => { order.push('resources'); throw new Error('restore failed'); }),
      configureOperatorContext: vi.fn(async () => { order.push('context'); }),
      startAndWaitForPorts: vi.fn(async () => { order.push('start'); }),
      getState: vi.fn(async () => ({ status: 'stopped' })), fetch: vi.fn(),
      stopOperatorSession: vi.fn(async () => 'stopped' as const),
    };
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, userEmail, userGroups, routes, bootstrap,
      packageResources, resolve: () => stub });
    await expect(runtime.configure(profile.sessionId, profile, authority)).rejects.toThrow(/configuration failed/i);
    expect(order).toEqual(['bucket', 'resources']);
    expect(stub.configureOperatorContext).not.toHaveBeenCalled();
    expect(stub.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it('configures opaque attachment declarations before context and prevents start after failed restore', async () => {
    const order: string[] = [];
    const attachments = { schemaVersion: 1 as const, activityId: profile.activityId, files: [{
      name: 'packet.json', mediaType: 'application/json', size: 12, sha256: 'f'.repeat(64), locator: 'packet-1',
    }] };
    const stub: OperatorContainerStub = {
      setBucketName: vi.fn(async () => { order.push('bucket'); }),
      configureOperatorAttachments: vi.fn(async () => { order.push('attachments'); throw new Error('restore failed'); }),
      configureOperatorContext: vi.fn(async () => { order.push('context'); }),
      startAndWaitForPorts: vi.fn(async () => { order.push('start'); }),
      getState: vi.fn(async () => ({ status: 'stopped' })), fetch: vi.fn(),
      stopOperatorSession: vi.fn(async () => 'stopped' as const),
    };
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, userEmail, userGroups, routes, bootstrap,
      attachments, resolve: () => stub });
    await expect(runtime.configure(profile.sessionId, profile, authority)).rejects.toThrow(/configuration failed/i);
    expect(order).toEqual(['bucket', 'attachments']);
    expect(stub.configureOperatorContext).not.toHaveBeenCalled();
    expect(stub.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it('uses the exact parent-owned container identity for configure, readiness and restricted stop', async () => {
    let boundSessionId: string | null = null;
    const stub: OperatorContainerStub = {
      setBucketName: vi.fn(async (_name: string, options: { sessionId: string }) => {
        boundSessionId = options.sessionId;
      }),
      configureOperatorContext: vi.fn(async (_profile: unknown,
        _authority: Parameters<OperatorContainerStub['configureOperatorContext']>[1]) => {
        if (boundSessionId !== profile.sessionId) throw new Error('Operator container ownership mismatch');
      }),
      startAndWaitForPorts: vi.fn(async () => {}),
      getState: vi.fn(async () => ({ status: 'running' })),
      fetch: vi.fn(async (_request: Request) => Response.json({ initFlagObserved: true, terminalServiceReady: true })),
      stopOperatorSession: vi.fn(async (_activityId: string, _sessionId: string) => 'stopped' as const),
    };
    const resolve = vi.fn(() => stub);
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, userEmail, userGroups, routes, bootstrap, resolve });
    expect(await runtime.reserve({ requestId: 'request', requestDigest: 'b'.repeat(64),
      activityId: profile.activityId, ownerBucket: profile.ownerBucket, sessionId: profile.sessionId }))
      .toEqual({ sessionId: profile.sessionId });
    await runtime.configure(profile.sessionId, profile, authority);
    await runtime.start(profile.sessionId);
    expect(await runtime.readiness(profile.sessionId)).toBe('ready');
    expect(await runtime.stop(profile.sessionId, false)).toBe('stopped');
    expect(resolve).toHaveBeenCalledWith(`owner-bucket-${profile.sessionId}`);
    expect(stub.setBucketName).toHaveBeenCalledWith(profile.ownerBucket,
      { sessionId: profile.sessionId, userEmail, userGroups, ...routes, ...bootstrap });
    expect(stub.configureOperatorContext).toHaveBeenCalledWith(profile, authority);
    expect(stub.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://container/health' }));
    expect(stub.stopOperatorSession).toHaveBeenCalledWith(profile.activityId, profile.sessionId);
  });

  it('classifies configuration and startup failures without exposing platform details', async () => {
    const stub = {
      setBucketName: vi.fn(async () => { throw new Error('secret configuration detail'); }),
      configureOperatorContext: vi.fn(), startAndWaitForPorts: vi.fn(async () => { throw new Error('secret startup detail'); }),
      getState: vi.fn(async () => ({ status: 'running' })),
      fetch: vi.fn(async () => Response.json({ initFlagObserved: false, terminalServiceReady: false })),
    };
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, userEmail, userGroups, routes, bootstrap,
      resolve: () => stub as never });
    await expect(runtime.configure(profile.sessionId, profile, authority)).rejects.toThrow('Operator session configuration failed');
    await expect(runtime.start(profile.sessionId)).rejects.toThrow('Operator session startup failed:init-not-ready');
  });

  it('fails closed for mismatched ownership and maps uncertain observations without starting replacement compute', async () => {
    const stub = { getState: vi.fn(async () => { throw new Error('uncertain'); }) };
    const runtime = new ContainerOwnedSessionRuntime({ activityId: profile.activityId,
      ownerBucket: profile.ownerBucket, sessionId: profile.sessionId, userEmail, userGroups, routes, bootstrap,
      resolve: () => stub as never });
    await expect(runtime.reserve({ requestId: 'request', requestDigest: 'b'.repeat(64),
      activityId: 'other', ownerBucket: profile.ownerBucket, sessionId: profile.sessionId })).rejects.toThrow(/ownership/i);
    expect(await runtime.readiness(profile.sessionId)).toBe('unknown');
  });
});
