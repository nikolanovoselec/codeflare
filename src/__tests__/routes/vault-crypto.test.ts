import { describe, it, expect } from 'vitest';
import { getVaultEncryptionKey } from '../../routes/vault-crypto';

// REQ-VAULT-021: the vault key is derived deterministically from the server master
// secret + the user's bucket name, so every session for a bucket gets the same key —
// the persisted (encrypted) IndexedDB cache decrypts next session instead of forcing
// a full re-index.
describe('getVaultEncryptionKey (REQ-VAULT-021 bucket-derived key)', () => {
  const env = { ENCRYPTION_KEY: 'master-secret-value' };

  it('is deterministic per bucket (same key every session)', async () => {
    const a = await getVaultEncryptionKey(env, 'codeflare-alice');
    const b = await getVaultEncryptionKey(env, 'codeflare-alice');
    expect(a).toBe(b);
  });

  it('differs across buckets (one vault key per user)', async () => {
    const alice = await getVaultEncryptionKey(env, 'codeflare-alice');
    const bob = await getVaultEncryptionKey(env, 'codeflare-bob');
    expect(alice).not.toBe(bob);
  });

  it('differs when the master secret rotates', async () => {
    const k1 = await getVaultEncryptionKey({ ENCRYPTION_KEY: 'm1' }, 'codeflare-alice');
    const k2 = await getVaultEncryptionKey({ ENCRYPTION_KEY: 'm2' }, 'codeflare-alice');
    expect(k1).not.toBe(k2);
  });

  it('returns base64 of exactly 32 bytes (the format SilverBullet expects)', async () => {
    const key = await getVaultEncryptionKey(env, 'codeflare-alice');
    expect(atob(key).length).toBe(32);
  });

  it('throws when ENCRYPTION_KEY is not configured', async () => {
    await expect(getVaultEncryptionKey({}, 'codeflare-alice')).rejects.toThrow(/ENCRYPTION_KEY/);
  });
});
