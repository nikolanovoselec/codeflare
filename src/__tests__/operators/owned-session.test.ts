// REQ-OPERATOR-005: owned session ordering/reconciliation independent of HTTP routes and Review schemas.
import { describe, expect, it, vi } from 'vitest';
import { OwnedOperatorSessionService, type OwnedOperatorSessionRuntime, type OwnedOperatorSessionState } from '../../operators/owned-session';
import type { OperatorContainerProfile } from '../../container/operator-context';

const profile: OperatorContainerProfile = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', ownerBucket: 'owner-bucket',
  policyDigest: 'b'.repeat(64), deadline: Date.now() + 500_000,
  outputPrefix: 'Remote Reviews/activity-1/session-1/', human: { subject: 'human-1', email: 'owner@example.test', issuer: 'https://issuer.example.test/', audiences: ['aud-1'] },
  policy: { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] }, storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } },
  jwtPolicy: { mode: 'off', destinations: [] }, piProfile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'off', systemPrompt: 'Approved', tools: ['read'] } };
const authority = { accessJwt: 'signed-jwt', human: { ...profile.human, issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 600 } };
const input = { requestId: 'ensure-1', requestDigest: 'a'.repeat(64), activityId: 'activity-1', ownerBucket: 'owner-bucket', profile, authority };

function fixture(initial: OwnedOperatorSessionState | null = null) {
  let state = initial ? structuredClone(initial) : null;
  const saves: OwnedOperatorSessionState[] = [];
  const calls: string[] = [];
  const store = { async load() { return state ? structuredClone(state) : null; }, async save(next: OwnedOperatorSessionState) {
    state = structuredClone(next); saves.push(structuredClone(next)); calls.push(`save:${next.status}`);
  } };
  const runtime: OwnedOperatorSessionRuntime = {
    reserve: vi.fn(async () => { calls.push('reserve'); return { sessionId: 'session-1' }; }),
    configure: vi.fn(async () => { calls.push('configure'); expect(state?.status).toBe('reserved'); }),
    start: vi.fn(async () => { calls.push('start'); }),
    readiness: vi.fn(async () => { calls.push('readiness'); return 'ready' as const; }),
    stop: vi.fn(async (_sessionId, drain) => { calls.push(`stop:${drain}`); return 'stopped' as const; }),
  };
  return { service: new OwnedOperatorSessionService(store, runtime), runtime, calls, saves, state: () => state };
}

describe('owned operator session service', () => {
  it('persists exact ownership/profile before configure and starts the reserved session once', async () => {
    const f = fixture();
    const result = await f.service.ensure(input);
    expect(result.status).toBe('ready');
    expect(f.calls).toEqual(['reserve', 'save:reserved', 'configure', 'save:configured', 'save:starting', 'start', 'readiness', 'save:ready']);
    expect(f.saves[0]).not.toHaveProperty('authority');
    expect(f.saves[0].profile).toEqual(profile);
  });

  it('reconciles the same ensure after a lost start response without reserving or starting again', async () => {
    const initial: OwnedOperatorSessionState = { schemaVersion: 1, requestId: 'ensure-1', requestDigest: 'a'.repeat(64),
      activityId: 'activity-1', ownerBucket: 'owner-bucket', sessionId: 'session-1', profile, status: 'starting' };
    const f = fixture(initial);
    expect((await f.service.ensure(input)).status).toBe('ready');
    expect(f.runtime.reserve).not.toHaveBeenCalled();
    expect(f.runtime.configure).not.toHaveBeenCalled();
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.calls).toEqual(['readiness', 'save:ready']);
  });

  it('retains a reserved record after configure failure so retry cannot create another session', async () => {
    const f = fixture();
    vi.mocked(f.runtime.configure).mockRejectedValueOnce(new Error('configure uncertain'));
    await expect(f.service.ensure(input)).rejects.toThrow('configure uncertain');
    expect(f.state()?.status).toBe('reserved');
    expect(f.runtime.reserve).toHaveBeenCalledTimes(1);
    expect((await f.service.ensure(input)).status).toBe('ready');
    expect(f.runtime.reserve).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting request/owner/profile identities before runtime calls', async () => {
    const f = fixture();
    await f.service.ensure(input);
    for (const changed of [
      { ...input, requestDigest: 'b'.repeat(64) }, { ...input, activityId: 'activity-2' },
      { ...input, ownerBucket: 'other' }, { ...input, profile: { ...profile, activityId: 'other' } },
    ]) await expect(f.service.ensure(changed)).rejects.toThrow(/conflict|identity/i);
    expect(f.runtime.reserve).toHaveBeenCalledTimes(1);
  });

  it('stops only the owned session and keeps drain policy explicit', async () => {
    const f = fixture();
    await f.service.ensure(input);
    await expect(f.service.stop({ activityId: 'other', ownerBucket: 'owner-bucket', drain: true })).rejects.toThrow(/ownership/i);
    const stopped = await f.service.stop({ activityId: 'activity-1', ownerBucket: 'owner-bucket', drain: false });
    expect(stopped.status).toBe('stopped');
    expect(f.calls.slice(-3)).toEqual(['save:stopping', 'stop:false', 'save:stopped']);
  });
});
