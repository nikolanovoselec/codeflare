import { expect, it } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { encryptForKV, importEncryptionKey } from '../../lib/kv-crypto';
import { getAigConfig } from '../../lib/aig-config';

it('REQ-ENTERPRISE-314 AC1: valid encrypted saved fields take precedence over conflicting deployment fields', async () => {
  const kv = createMockKV();
  const encryption = btoa('s'.repeat(32));
  const saved = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`,
    gatewayId: 'saved-gateway', token: 'saved-token-canary' };
  kv._store.set(SETUP_KEYS.AIG_GATEWAY_URL, saved.gatewayUrl);
  kv._store.set(SETUP_KEYS.AIG_GATEWAY_ID, saved.gatewayId);
  kv._store.set(SETUP_KEYS.AIG_TOKEN, await encryptForKV(JSON.stringify({ token: saved.token }),
    await importEncryptionKey(encryption), SETUP_KEYS.AIG_TOKEN));
  const before = new Map(kv._store);
  const env = { KV: kv, ENCRYPTION_KEY: encryption,
    AIG_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${'b'.repeat(32)}/environment-gateway`,
    AIG_GATEWAY_ID: 'environment-name', AIG_TOKEN: 'environment-token-canary' } as unknown as Env;
  expect(await getAigConfig(env)).toEqual(saved);
  expect(kv._store).toEqual(before);
  expect(kv._store.get(SETUP_KEYS.AIG_TOKEN)).not.toContain(saved.token);
});
