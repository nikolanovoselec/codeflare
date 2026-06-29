// REQ-ENTERPRISE-017: the customer's AI Gateway URL + token are resolved wizard-first
// (KV) with the deploy-time GitHub secret (env) as an OPTIONAL fallback, each field
// independently. A KV/crypto fault at the container-start seam must degrade to the env
// fallback, never throw. These assertions catch a regression in the resolution order,
// the per-field independence, the token decrypt, or the fail-soft behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAndDecrypt = vi.hoisted(() => vi.fn());
const mockGetOrImportKey = vi.hoisted(() => vi.fn());
vi.mock('../../lib/kv-crypto', () => ({
  getAndDecrypt: (...args: unknown[]) => mockGetAndDecrypt(...args),
  getOrImportKey: (...args: unknown[]) => mockGetOrImportKey(...args),
}));

import { getAigConfig } from '../../lib/aig-config';
import { SETUP_KEYS } from '../../lib/kv-keys';
import type { Env } from '../../types';

function makeEnv(opts: { kvUrl?: string | null; envUrl?: string; envToken?: string } = {}): Env {
  return {
    AIG_GATEWAY_URL: opts.envUrl,
    AIG_TOKEN: opts.envToken,
    KV: {
      get: vi.fn(async (key: string) => (key === SETUP_KEYS.AIG_GATEWAY_URL ? (opts.kvUrl ?? null) : null)),
    },
  } as unknown as Env;
}

describe('getAigConfig (REQ-ENTERPRISE-017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrImportKey.mockResolvedValue({} as CryptoKey);
  });

  it('KV-first: wizard KV values win over the deploy-secret env values', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce({ token: 'kv-token' });
    const cfg = await getAigConfig(makeEnv({ kvUrl: 'https://kv.example/v1/a/g', envUrl: 'https://env.example/v1/a/g', envToken: 'env-token' }));
    expect(cfg.gatewayUrl).toBe('https://kv.example/v1/a/g');
    expect(cfg.token).toBe('kv-token');
    // The token is read from the dedicated encrypted Setup key.
    expect(mockGetAndDecrypt).toHaveBeenCalledWith(expect.anything(), SETUP_KEYS.AIG_TOKEN, expect.anything());
  });

  it('env fallback: with KV unset, the deploy-secret env values are used', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce(null);
    const cfg = await getAigConfig(makeEnv({ kvUrl: null, envUrl: 'https://env.example/v1/a/g', envToken: 'env-token' }));
    expect(cfg.gatewayUrl).toBe('https://env.example/v1/a/g');
    expect(cfg.token).toBe('env-token');
  });

  it('resolves each field independently: KV URL + env token fallback', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce(null); // no KV token
    const cfg = await getAigConfig(makeEnv({ kvUrl: 'https://kv.example/v1/a/g', envToken: 'env-token' }));
    expect(cfg.gatewayUrl).toBe('https://kv.example/v1/a/g');
    expect(cfg.token).toBe('env-token');
  });

  it('returns undefined for a field that is unset in BOTH KV and env', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce(null);
    const cfg = await getAigConfig(makeEnv({}));
    expect(cfg.gatewayUrl).toBeUndefined();
    expect(cfg.token).toBeUndefined();
  });

  it('fail-soft: a KV/crypto error degrades to the env fallback (never throws)', async () => {
    mockGetOrImportKey.mockRejectedValueOnce(new Error('crypto unavailable'));
    const cfg = await getAigConfig(makeEnv({ envUrl: 'https://env.example/v1/a/g', envToken: 'env-token' }));
    expect(cfg.gatewayUrl).toBe('https://env.example/v1/a/g');
    expect(cfg.token).toBe('env-token');
  });
});
