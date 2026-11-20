import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';

/**
 * REQ-SEC-018 AC2: warnIfNoEncryptionKey emits a CRITICAL log to the
 * structured logger the first time it is called with an undefined key,
 * and stays silent on every subsequent call (idempotent per isolate).
 *
 * The module under test caches the "warned" flag at module scope. Each
 * test below uses `vi.resetModules()` + dynamic import so the flag
 * starts fresh and we can observe the first-call behaviour cleanly.
 */
describe('warnIfNoEncryptionKey / REQ-SEC-018 AC2 (CRITICAL log fires once per isolate when ENCRYPTION_KEY absent)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The structured logger defaults to 'silent' in test environments so
    // log output doesn't pollute test results. CRITICAL warnings need the
    // 'error' level enabled before they reach console.error. We import
    // logger AFTER resetModules so its module-level minLogLevel is fresh.
    const { setLogLevel } = await import('../../lib/logger');
    setLogLevel('error');
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    const { setLogLevel } = await import('../../lib/logger');
    setLogLevel('silent');
  });

  it('emits a CRITICAL error log on first call when key is undefined', async () => {
    const { warnIfNoEncryptionKey } = await import('../../lib/kv-crypto');
    warnIfNoEncryptionKey(undefined);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = String(consoleErrorSpy.mock.calls[0][0]);
    expect(logged).toMatch(/CRITICAL/);
    expect(logged).toMatch(/ENCRYPTION_KEY/);
  });

  it('does not re-log on subsequent calls in the same isolate (dedup)', async () => {
    const { warnIfNoEncryptionKey } = await import('../../lib/kv-crypto');
    warnIfNoEncryptionKey(undefined);
    warnIfNoEncryptionKey(undefined);
    warnIfNoEncryptionKey(undefined);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not log when an encryption key string is provided', async () => {
    const { warnIfNoEncryptionKey } = await import('../../lib/kv-crypto');
    warnIfNoEncryptionKey('any-non-empty-key-value');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does not log when an empty string is provided (falsy guard suppresses warn)', async () => {
    // The implementation guards on `!encryptionKey`, so an empty string
    // is also "absent". This documents the contract: the warn fires only
    // when truthy keys are missing AND the dedup flag is unset.
    const { warnIfNoEncryptionKey } = await import('../../lib/kv-crypto');
    warnIfNoEncryptionKey('');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleErrorSpy.mock.calls[0][0])).toMatch(/CRITICAL/);
  });
});

// REQ-SEC-018 AC3 supplemental representation evidence, not a proof that every
// credential-route caller selects encryption or that all plaintext callers are allowlisted.
describe('REQ-SEC-018 AC3: KV secret representation and storage-name binding', () => {
  it('stores configured secret ciphertext bound to its KV name while unrelated preferences stay plaintext', async () => {
    const { encryptAndStore, getAndDecrypt, importEncryptionKey } = await import('../../lib/kv-crypto');
    const kv = createMockKV();
    const namespace = kv as unknown as KVNamespace;
    const key = await importEncryptionKey('A'.repeat(43) + '=');
    const prefs = JSON.stringify({ userTimezone: 'UTC' });
    await kv.put('user-prefs:owner', prefs);
    const secret = { token: 'synthetic-secret-not-for-output' };
    await encryptAndStore(namespace, 'llm-keys:owner', secret, key);
    const stored = await kv.get('llm-keys:owner') as string;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(secret.token);
    expect(await getAndDecrypt(namespace, 'llm-keys:owner', key)).toEqual(secret);
    await kv.put('llm-keys:other-owner', stored);
    expect(await getAndDecrypt(namespace, 'llm-keys:other-owner', key)).toBeNull();
    expect(await kv.get('user-prefs:owner')).toBe(prefs);
  });
});
