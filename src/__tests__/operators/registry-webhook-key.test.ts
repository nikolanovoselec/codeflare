/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Test navigation: Ciphertext-only storage, atomic revision races and rotation failure preservation; no public plaintext recovery path.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { openOperatorSecret } from '../../operators/protected-secrets';
import { ValidationError } from '../../lib/error-types';

const protectedEnv = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
async function withRegistry(test: (registry: OperatorRegistry, ctx: DurableObjectState) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    await test(new OperatorRegistry(ctx, protectedEnv), ctx);
  });
}

describe('REQ-OPERATOR-002: encrypted registry webhook key rotation', () => {
  it('persists ciphertext only and keeps ordinary registration responses secret-free', () => withRegistry(async (registry, ctx) => {
    await registry.create('operator');
    expect(await registry.getEncryptedWebhookKey('operator')).toBeNull();
    const rotated = await registry.rotateWebhookKey('operator', 1);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('Expected successful rotation');
    expect(rotated.value.registration).toEqual({ operatorId: 'operator', revision: 2, enabled: false, approvedArtifactDigest: null });
    const recovered = new OperatorRegistry(ctx, protectedEnv);
    const ciphertext = await recovered.getEncryptedWebhookKey('operator');
    expect(ciphertext).toMatch(/^v1:/);
    expect(await openOperatorSecret(ciphertext!, protectedEnv, { purpose: 'webhook', recordId: 'operator' })).toBe(rotated.value.key);
    expect(JSON.stringify([...await ctx.storage.list()])).not.toContain(rotated.value.key);
    const approved = await recovered.approve('operator', 'a'.repeat(64), 2);
    expect(JSON.stringify(approved)).not.toContain(rotated.value.key);
    expect(JSON.stringify(approved)).not.toContain(ciphertext!);
  }));

  it('replaces the previous key without retaining retired plaintext or ciphertext', () => withRegistry(async (registry, ctx) => {
    await registry.create('operator');
    const first = await registry.rotateWebhookKey('operator', 1);
    const oldCiphertext = await registry.getEncryptedWebhookKey('operator');
    const second = await registry.rotateWebhookKey('operator', 2);
    if (!first.ok || !second.ok) throw new Error('Expected successful rotations');
    expect(second.value.key).not.toBe(first.value.key);
    expect(second.value.registration.revision).toBe(3);
    const stored = await registry.getEncryptedWebhookKey('operator');
    expect(await openOperatorSecret(stored!, protectedEnv, { purpose: 'webhook', recordId: 'operator' })).toBe(second.value.key);
    const allStorage = JSON.stringify([...await ctx.storage.list()]);
    expect(allStorage).not.toContain(first.value.key);
    expect(allStorage).not.toContain(second.value.key);
    expect(allStorage).not.toContain(oldCiphertext!);
    expect(await registry.getEncryptedWebhookKey('other')).toBeNull();
  }));

  it('serializes concurrent rotations and rejects stale or missing registrations', () => withRegistry(async registry => {
    await registry.create('operator');
    const results = await Promise.all([registry.rotateWebhookKey('operator', 1), registry.rotateWebhookKey('operator', 1)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'revision-conflict' }]);
    expect(await registry.rotateWebhookKey('operator', 1)).toEqual({ ok: false, reason: 'revision-conflict' });
    expect(await registry.rotateWebhookKey('missing', 1)).toEqual({ ok: false, reason: 'not-found' });
  }));

  it('leaves the existing key and revision untouched when encryption is unavailable', () => withRegistry(async (registry, ctx) => {
    await registry.create('operator');
    await registry.rotateWebhookKey('operator', 1);
    const ciphertext = await registry.getEncryptedWebhookKey('operator');
    const unavailable = new OperatorRegistry(ctx, {});
    await expect(unavailable.rotateWebhookKey('operator', 2)).rejects.toBeInstanceOf(ValidationError);
    expect(await registry.getEncryptedWebhookKey('operator')).toBe(ciphertext);
    expect(await registry.approve('operator', 'a'.repeat(64), 2)).toMatchObject({ ok: true, value: { revision: 3 } });
  }));
});
