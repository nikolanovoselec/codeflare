/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { ValidationError } from '../../lib/error-types';

const policy = { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
    reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } };
async function withRegistry(test: (registry: OperatorRegistry) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    await registry.create('operator');
    await test(registry);
  });
}

describe('REQ-OPERATOR-002: restrictive policy snapshots and safe listing', () => {
  it('persists policy and admission through the configured SQLite registry RPC binding', async () => {
    const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace<OperatorRegistry> }).OPERATOR_REGISTRY;
    const id = namespace.newUniqueId();
    const registry = namespace.get(id);
    expect(await registry.create('operator')).toMatchObject({ ok: true });
    expect(await registry.setPolicy('operator', JSON.stringify(policy), 1)).toMatchObject({ ok: true });
    await registry.approve('operator', 'a'.repeat(64), 2);
    await registry.setEnabled('operator', true, 3);
    const request = { operatorId: 'operator', activityId: 'activity', intentDigest: 'b'.repeat(64), expectedRevision: 4, deadline: Date.now() + 60_000 };
    expect(await registry.admit(request)).toMatchObject({ ok: true, value: { policyJson: JSON.stringify(policy) } });
    expect(await namespace.get(id).getReceipt('activity')).toMatchObject({ ok: true, value: { policyJson: JSON.stringify(policy) } });
  });
  it('pins admitted restrictions despite later policy replacement', () => withRegistry(async registry => {
    expect(await registry.getPolicy('operator')).toBeNull();
    expect(await registry.setPolicy('operator', JSON.stringify(policy), 1)).toMatchObject({ ok: true, value: { revision: 2, enabled: false } });
    await registry.approve('operator', 'a'.repeat(64), 2);
    await registry.setEnabled('operator', true, 3);
    const request = { operatorId: 'operator', activityId: 'activity', intentDigest: 'b'.repeat(64), expectedRevision: 4, deadline: Date.now() + 60_000 };
    const receipt = await registry.admit(request);
    expect(receipt).toMatchObject({ ok: true, value: { policyJson: JSON.stringify(policy) } });
    const replacement = { ...policy, networkHosts: ['allowed.example.test'] };
    expect(await registry.setPolicy('operator', JSON.stringify(replacement), 4)).toMatchObject({ ok: true, value: { revision: 5, enabled: false } });
    expect(await registry.getPolicy('operator')).toBe(JSON.stringify(replacement));
    expect(await registry.admit(request)).toEqual(receipt);
    expect(await registry.admit({ ...request, activityId: 'new', expectedRevision: 5 })).toEqual({ ok: false, reason: 'disabled' });
  }));
  it('rejects malformed, stale and absent policy updates without mutation', () => withRegistry(async registry => {
    await registry.setPolicy('operator', JSON.stringify(policy), 1);
    await expect(registry.setPolicy('operator', '{', 2)).rejects.toBeInstanceOf(ValidationError);
    await expect(registry.setPolicy('operator', JSON.stringify({ ...policy, bucket: 'other' }), 2)).rejects.toBeInstanceOf(ValidationError);
    expect(await registry.setPolicy('operator', JSON.stringify(policy), 1)).toEqual({ ok: false, reason: 'revision-conflict' });
    expect(await registry.setPolicy('missing', JSON.stringify(policy), 1)).toEqual({ ok: false, reason: 'not-found' });
    expect(await registry.getPolicy('operator')).toBe(JSON.stringify(policy));
  }));
  it('lists registrations without leaking protected configuration or keys', () => withRegistry(async registry => {
    await registry.setDistribution('operator', 'https://operator.example.test/', 'private-connection', 1);
    const rotation = await registry.rotateWebhookKey('operator', 2);
    if (!rotation.ok) throw new Error('Expected rotation');
    expect(await registry.listRegistrations()).toEqual([{ operatorId: 'operator', revision: 3, enabled: false, approvedArtifactDigest: null }]);
    expect(JSON.stringify(await registry.listRegistrations())).not.toContain(rotation.value.key);
  }));
});
