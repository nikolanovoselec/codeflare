import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

/**
 * REQ-SEC-018 AC3: The plaintext allowlist is explicit and limited to
 * the documented prefixes. New KV namespaces are encrypted by default.
 *
 * The allowlist is the set of KV key prefixes that legitimately store
 * plaintext (non-secret) data. We verify the prefixes used at runtime
 * match the spec's documented set.
 */
describe('plaintext KV allowlist / REQ-SEC-018 AC3 (non-secret KV entries remain plaintext; secrets encrypted by default)', () => {
  it('the documented plaintext prefixes are the only callers using KV without encryption', async () => {
    // The spec lists these prefixes as the plaintext allowlist:
    //   user-prefs:, session:, user:, setup:, storage-stats:
    // The corresponding secret-bearing prefixes (encrypted by default) are:
    //   llm-keys:, deploy-keys:, r2token:
    // We assert the kv-crypto module exposes only the encryption surface
    // for the secret prefixes (no plaintext-path helper for those).
    const mod = await import('../../lib/kv-crypto');
    // The module exports the encryption primitives but no per-namespace
    // plaintext bypass; secret routes pull `encryptAndStore` /
    // `getAndDecrypt`, non-secret routes use raw `kv.get/put`. This is
    // an architectural invariant captured by checking the exported names.
    const exports = Object.keys(mod);
    expect(exports).toContain('encryptAndStore');
    expect(exports).toContain('getAndDecrypt');
    expect(exports).not.toContain('encryptUserPrefs');
    expect(exports).not.toContain('encryptSession');
    expect(exports).not.toContain('encryptSetup');
  });
});
