/**
 * Test navigation: Random handoff-key generation and operator-bound encryption; route authorization and display-once UI have separate tests.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { createOperatorWebhookKey, openOperatorSecret } from '../../operators/protected-secrets';

const env = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };

describe('REQ-OPERATOR-002: optional per-operator webhook key', () => {
  it('generates independent 256-bit handoff keys and seals each for its operator', async () => {
    const first = await createOperatorWebhookKey('operator-a', env);
    const next = await createOperatorWebhookKey('operator-a', env);
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(atob(first.key.replace(/-/g, '+').replace(/_/g, '/') + '=').length).toBe(32);
    expect(next.key).not.toBe(first.key);
    expect(first.key).not.toBe(env.ENCRYPTION_KEY);
    expect(first.ciphertext.startsWith('v1:')).toBe(true);
    expect(first.ciphertext).not.toContain(first.key);
    expect(await openOperatorSecret(first.ciphertext, env, { purpose: 'webhook', recordId: 'operator-a' })).toBe(first.key);
    await expect(openOperatorSecret(first.ciphertext, env, { purpose: 'webhook', recordId: 'operator-b' })).rejects.toBeInstanceOf(ValidationError);
    await expect(openOperatorSecret(first.ciphertext, env, { purpose: 'connection', recordId: 'operator-a' })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([undefined, '', 'invalid'])('returns no handoff key when protected storage is unavailable: %s', async key => {
    await expect(createOperatorWebhookKey('operator-a', { ENCRYPTION_KEY: key })).rejects.toBeInstanceOf(ValidationError);
  });
});
