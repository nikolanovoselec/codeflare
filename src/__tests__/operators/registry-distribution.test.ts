/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Test navigation: Native storage configuration replacement, secret protection and receipt preservation; no HTTP authorization is simulated here.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { openOperatorSecret } from '../../operators/protected-secrets';
import { ValidationError } from '../../lib/error-types';

const protectedEnv = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const endpoint = 'https://operator.example.test/discovery';
const secret = 'endpoint-connection-secret';
async function withRegistry(test: (registry: OperatorRegistry, ctx: DurableObjectState) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, protectedEnv);
    await registry.create('operator');
    await test(registry, ctx);
  });
}

describe('REQ-OPERATOR-002: protected distribution registration', () => {
  it('persists encrypted connection configuration without exposing secrets in registration responses', () => withRegistry(async (registry, ctx) => {
    expect(await registry.getProtectedDistribution('operator')).toBeNull();
    const result = await registry.setDistribution('operator', endpoint, secret, 1);
    expect(result).toEqual({ ok: true, value: { operatorId: 'operator', revision: 2, enabled: false, approvedArtifactDigest: null } });
    const stored = await new OperatorRegistry(ctx, protectedEnv).getProtectedDistribution('operator');
    expect(stored?.endpoint).toBe(endpoint);
    expect(await openOperatorSecret(stored!.connectionSecretCiphertext, protectedEnv, { purpose: 'connection', recordId: 'operator' })).toBe(secret);
    expect(JSON.stringify([...await ctx.storage.list()])).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(stored!.connectionSecretCiphertext);
    expect(await registry.getProtectedDistribution('other')).toBeNull();
  }));

  it('invalidates approval and disables on configuration replacement without changing admitted receipts', () => withRegistry(async registry => {
    await registry.setDistribution('operator', endpoint, secret, 1);
    await registry.approve('operator', 'a'.repeat(64), 2);
    await registry.setEnabled('operator', true, 3);
    const request = { operatorId: 'operator', activityId: 'activity', intentDigest: 'b'.repeat(64), expectedRevision: 4, deadline: Date.now() + 60_000 };
    const admitted = await registry.admit(request);
    expect(admitted.ok).toBe(true);
    expect(await registry.setDistribution('operator', 'https://replacement.example.test/', 'replacement-secret', 4))
      .toEqual({ ok: true, value: { operatorId: 'operator', revision: 5, enabled: false, approvedArtifactDigest: null } });
    expect(await registry.setEnabled('operator', true, 5)).toEqual({ ok: false, reason: 'artifact-unapproved' });
    expect(await registry.admit(request)).toEqual(admitted);
    expect(await registry.admit({ ...request, activityId: 'new', expectedRevision: 5 })).toEqual({ ok: false, reason: 'disabled' });
  }));

  it('rejects stale and missing configuration updates without overwriting the winner', () => withRegistry(async registry => {
    await registry.setDistribution('operator', endpoint, secret, 1);
    const before = await registry.getProtectedDistribution('operator');
    expect(await registry.setDistribution('operator', 'https://other.example.test/', 'other', 1)).toEqual({ ok: false, reason: 'revision-conflict' });
    expect(await registry.setDistribution('missing', endpoint, secret, 1)).toEqual({ ok: false, reason: 'not-found' });
    expect(await registry.getProtectedDistribution('operator')).toEqual(before);
  }));

  it.each(['http://operator.example.test/', 'https://user:password@operator.example.test/', 'https://127.0.0.1/'])
  ('rejects unsafe endpoint %s without changing registration', unsafe => withRegistry(async registry => {
    await expect(registry.setDistribution('operator', unsafe, secret, 1)).rejects.toBeInstanceOf(ValidationError);
    expect(await registry.getProtectedDistribution('operator')).toBeNull();
    expect(await registry.approve('operator', 'a'.repeat(64), 1)).toMatchObject({ ok: true });
  }));

  it('rejects blank secrets and unavailable encryption without mutating persisted configuration', () => withRegistry(async (registry, ctx) => {
    await registry.setDistribution('operator', endpoint, secret, 1);
    const before = await registry.getProtectedDistribution('operator');
    await expect(registry.setDistribution('operator', endpoint, '  ', 2)).rejects.toBeInstanceOf(ValidationError);
    await expect(new OperatorRegistry(ctx, {}).setDistribution('operator', endpoint, 'replacement', 2)).rejects.toBeInstanceOf(ValidationError);
    expect(await registry.getProtectedDistribution('operator')).toEqual(before);
    expect(await registry.approve('operator', 'a'.repeat(64), 2)).toMatchObject({ ok: true });
  }));
});
