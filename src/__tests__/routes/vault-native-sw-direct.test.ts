import { describe, it, expect } from 'vitest';

// CF-045
// Direct unit tests for src/routes/vault-native-sw.ts. The graft logic was
// previously exercised only through the src/routes/vault.ts re-export barrel.
// Importing the source module directly pins the key-recovery graft and its
// anchor-drift guard at the module boundary.
import {
  graftVaultKeyRecovery,
  VAULT_NATIVE_SW_VERBATIM,
  VAULT_NATIVE_SERVICE_WORKER_JS,
} from '../../routes/vault-native-sw';

describe('CF-045: vault-native-sw direct unit tests', () => {
  // REQ-VAULT-017 AC1: native SW served with the codeflare key-recovery graft
  it('grafting the verbatim worker reproduces the exported served worker', () => {
    expect(graftVaultKeyRecovery(VAULT_NATIVE_SW_VERBATIM)).toBe(VAULT_NATIVE_SERVICE_WORKER_JS);
  });

  it('the graft injects the __cfRecover helper that the verbatim worker lacks', () => {
    expect(VAULT_NATIVE_SW_VERBATIM).not.toContain('__cfRecover');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('async function __cfRecover()');
  });

  it('the graft calls __cfRecover before the get-encryption-key reply', () => {
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain(
      'case"get-encryption-key":{if(y===void 0)await __cfRecover()',
    );
  });

  it('throws when an anchor substring is missing (SilverBullet version drift guard)', () => {
    expect(() => graftVaultKeyRecovery('not the silverbullet worker at all')).toThrow(
      /anchor/i,
    );
  });

  it('the served worker differs from the verbatim upstream bytes', () => {
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).not.toBe(VAULT_NATIVE_SW_VERBATIM);
  });
});
