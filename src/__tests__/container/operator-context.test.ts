// REQ-OPERATOR-005: parent-bound container origin/profile durability and fail-closed authority recovery.
import { describe, expect, it } from 'vitest';
import { bindOperatorAuthority, configureOperatorContext, restoreOperatorContext,
  type OperatorContainerProfile, type OperatorContextHost } from '../../container/operator-context';

const policy = { schemaVersion: 1 as const, networkHosts: ['allowed.example.test'],
  github: { repositories: ['octo/repo'], methods: ['GET'] },
  storage: { readPrefixes: ['input/'], writePrefixes: ['output/'] },
  inference: { routeIds: ['route-1'], defaultRouteId: 'route-1', reasoningLevels: ['medium'],
    defaultReasoningLevel: 'medium', inheritUserDefaults: false } };
const profile: OperatorContainerProfile = { schemaVersion: 1, activityId: 'activity-1', operatorId: 'operator-1', sessionId: 'session-1',
  ownerBucket: 'owner-bucket', policyDigest: 'b'.repeat(64), deadline: Date.now() + 500_000,
  outputPrefix: 'Remote Reviews/activity-1/session-1/', human: { subject: 'human-1', email: 'owner@example.test', issuer: 'https://issuer.example.test', audiences: ['aud-1'] },
  policy, jwtPolicy: { mode: 'list', destinations: ['allowed.example.test'] },
  piProfile: { provider: 'anthropic', model: 'approved-model', thinkingLevel: 'medium',
    systemPrompt: 'Approved operator context', tools: ['read', 'bash'] } };
const authority = { accessJwt: 'signed-access-jwt', human: { ...profile.human, issuedAt: 1,
  expiresAt: Math.floor(Date.now() / 1000) + 600 } };

function fixture(stored?: OperatorContainerProfile) {
  const values = new Map<string, unknown>();
  if (stored) values.set('operatorContainerProfile', structuredClone(stored));
  const order: string[] = [];
  const host: OperatorContextHost & { _strictEgress: boolean; _workspaceSyncEnabled: boolean } = {
    _bucketName: 'owner-bucket', _sessionId: 'session-1', envVars: {}, _strictEgress: false, _workspaceSyncEnabled: true,
    ctx: { storage: { async get<T>(key: string) { return values.get(key) as T | undefined; },
      async put(key, value) { order.push(`put:${key}`); values.set(key, structuredClone(value)); } } },
    refreshEnv() { order.push('refresh'); },
  } as OperatorContextHost & { _strictEgress: boolean; _workspaceSyncEnabled: boolean };
  return { host, values, order };
}

describe('operator container context', () => {
  it('persists the validated owner/activity/profile before enabling restricted startup', async () => {
    const f = fixture();
    await configureOperatorContext(f.host, profile, authority);
    expect(f.order).toEqual(['put:operatorContainerProfile', 'refresh']);
    expect(f.host._operatorPolicy).toEqual(policy);
    expect(f.host._jwtAuthority?.accessJwt).toBe('signed-access-jwt');
    expect(f.host._strictEgress).toBe(true);
    expect(f.host._workspaceSyncEnabled).toBe(false);
    expect(f.values.get('operatorContainerProfile')).not.toHaveProperty('accessJwt');
  });

  it('restores non-secret restrictions before env construction but no stale authority', async () => {
    const f = fixture(profile);
    f.host._jwtAuthority = authority;
    await restoreOperatorContext(f.host);
    expect(f.order).toEqual(['refresh']);
    expect(f.host._operatorPolicy).toEqual(policy);
    expect(f.host._jwtStamping).toEqual(profile.jwtPolicy);
    expect(f.host._jwtAuthority).toBeUndefined();
    expect(f.host._strictEgress).toBe(true);
    expect(f.host._workspaceSyncEnabled).toBe(false);
  });

  it('rejects cross-owner/session, malformed policy and mismatched or expired authority before persistence', async () => {
    for (const candidate of [
      { ...profile, ownerBucket: 'other' }, { ...profile, sessionId: 'other' },
      { ...profile, deadline: authority.human.expiresAt * 1000 + 1 },
      { ...profile, outputPrefix: '../escape/' },
      { ...profile, piProfile: { ...profile.piProfile, initialToolChoice: 'write' } },
      { ...profile, policy: { ...policy, networkHosts: ['https://bad.example.test'] } },
    ]) {
      const f = fixture();
      await expect(configureOperatorContext(f.host, candidate, authority)).rejects.toThrow();
      expect(f.order).toEqual([]);
    }
    const f = fixture();
    expect(() => bindOperatorAuthority(f.host, authority)).toThrow(/profile/i);
    await configureOperatorContext(f.host, profile, authority);
    expect(() => bindOperatorAuthority(f.host, { ...authority, human: { ...authority.human, subject: 'other' } })).toThrow(/authority/i);
    expect(() => bindOperatorAuthority(f.host, { ...authority, human: { ...authority.human, expiresAt: 1 } })).toThrow(/expired/i);
  });

  it('leaves in-memory execution disabled when durable persistence fails', async () => {
    const f = fixture();
    f.host.ctx.storage.put = async () => { throw new Error('storage unavailable'); };
    await expect(configureOperatorContext(f.host, profile, authority)).rejects.toThrow('storage unavailable');
    expect(f.host._operatorPolicy).toBeUndefined();
    expect(f.host._jwtAuthority).toBeUndefined();
    expect(f.order).toEqual([]);
  });
});
