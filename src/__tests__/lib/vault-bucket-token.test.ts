import { describe, it, expect } from 'vitest';
import { getVaultBucketToken, VAULT_BUCKET_TOKEN_PATTERN } from '../../lib/vault-bucket-token';

// REQ-VAULT-021: the bucket-stable vault URL token. Its whole job is to be a
// deterministic, opaque, per-bucket value so the served vault URL — and therefore
// SilverBullet's IndexedDB names — are identical across sessions for one user.
describe('getVaultBucketToken (REQ-VAULT-021)', () => {
  it('is deterministic for the same bucket (stable across sessions)', async () => {
    const a = await getVaultBucketToken('codeflare-user-example-com');
    const b = await getVaultBucketToken('codeflare-user-example-com');
    expect(a).toBe(b);
  });

  it('differs across buckets', async () => {
    const alice = await getVaultBucketToken('codeflare-alice-example-com');
    const bob = await getVaultBucketToken('codeflare-bob-example-com');
    expect(alice).not.toBe(bob);
  });

  it('is a 32-hex opaque token (no bucket/email substring leaks into the URL)', async () => {
    const token = await getVaultBucketToken('codeflare-alice-example-com');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(VAULT_BUCKET_TOKEN_PATTERN.test(token)).toBe(true);
    expect(token).not.toContain('alice');
    expect(token).not.toContain('example');
  });

  it('is format-disjoint from a session id (32 chars never matches the 8-24 sid pattern)', async () => {
    const token = await getVaultBucketToken('codeflare-x');
    // SESSION_ID_PATTERN is /^[a-z0-9]{8,24}$/ — a 32-char token must not match it,
    // so route dispatch between sid-path and token-path is unambiguous.
    expect(/^[a-z0-9]{8,24}$/.test(token)).toBe(false);
  });
});
