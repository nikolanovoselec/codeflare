import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { decryptFromKV, importEncryptionKey } from '../../lib/kv-crypto';
import { sealOperatorSecret, openOperatorSecret, type OperatorSecretContext } from '../../operators/protected-secrets';

const env = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const context: OperatorSecretContext = { purpose: 'connection', recordId: 'operator-a' };
const secret = 'private-endpoint-connection-secret';

describe('REQ-OPERATOR-002: fail-closed protected secrets', () => {
  it('encrypts using the existing AES-GCM envelope and authenticated record/purpose context', async () => {
    const stored = await sealOperatorSecret(secret, env, context);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(await openOperatorSecret(stored, env, context)).toBe(secret);
    expect(await decryptFromKV(stored.slice(3), await importEncryptionKey(env.ENCRYPTION_KEY),
      JSON.stringify(['operator-secret-v1', context.purpose, context.recordId]))).toBe(secret);
    expect(await sealOperatorSecret(secret, env, context)).not.toBe(stored);
  });

  it.each([undefined, '', 'invalid', btoa('short')])('rejects unavailable or invalid keys on both paths: %s', async key => {
    await expect(sealOperatorSecret(secret, { ENCRYPTION_KEY: key }, context)).rejects.toBeInstanceOf(ValidationError);
    await expect(openOperatorSecret('v1:invalid', { ENCRYPTION_KEY: key }, context)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([
    { ...context, recordId: 'operator-b' },
    { ...context, purpose: 'human-access' as const },
    { ...context, purpose: 'webhook' as const },
  ])('does not decrypt for a different authenticated context: %j', async other => {
    const stored = await sealOperatorSecret(secret, env, context);
    await expect(openOperatorSecret(stored, env, other)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects plaintext instead of migrating or falling back', async () => {
    await expect(openOperatorSecret(secret, env, context)).rejects.toBeInstanceOf(ValidationError);
    await expect(openOperatorSecret(JSON.stringify({ secret }), env, context)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects changed ciphertext and a different encryption key', async () => {
    const stored = await sealOperatorSecret(secret, env, context);
    const bytes = atob(stored.slice(3));
    const changed = String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1);
    await expect(openOperatorSecret(`v1:${btoa(changed)}`, env, context)).rejects.toBeInstanceOf(ValidationError);
    await expect(openOperatorSecret(stored, { ENCRYPTION_KEY: btoa('z'.repeat(32)) }, context)).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not reflect input or key material in failure diagnostics', async () => {
    const result = await openOperatorSecret(secret, env, context).catch(error => error);
    expect(result).toBeInstanceOf(ValidationError);
    expect(result.message).not.toContain(secret);
    expect(result.message).not.toContain(env.ENCRYPTION_KEY);
  });
});
