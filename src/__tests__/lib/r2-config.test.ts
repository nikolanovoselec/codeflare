import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getR2Config } from '../../lib/r2-config';
import { createMockKV } from '../helpers/mock-kv';

describe('getR2Config', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      KV: mockKV as unknown as KVNamespace,
      ...overrides,
    } as any;
  }

  it('returns env values when R2_ACCOUNT_ID and R2_ENDPOINT are set', async () => {
    const env = createEnv({
      R2_ACCOUNT_ID: 'test-account-id',
      R2_ENDPOINT: 'https://test-account-id.r2.cloudflarestorage.com',
    });
    const config = await getR2Config(env);
    expect(config.accountId).toBe('test-account-id');
    expect(config.endpoint).toBe('https://test-account-id.r2.cloudflarestorage.com');
  });

  it('falls back to KV setup:account_id when env vars are empty strings', async () => {
    mockKV._store.set('setup:account_id', 'kv-account-id');
    const env = createEnv({ R2_ACCOUNT_ID: '', R2_ENDPOINT: '' });
    const config = await getR2Config(env);
    expect(config.accountId).toBe('kv-account-id');
    expect(config.endpoint).toBe('https://kv-account-id.r2.cloudflarestorage.com');
  });

  it('falls back to KV when env vars are undefined', async () => {
    mockKV._store.set('setup:account_id', 'kv-account-id');
    const env = createEnv({});
    const config = await getR2Config(env);
    expect(config.accountId).toBe('kv-account-id');
    expect(config.endpoint).toBe('https://kv-account-id.r2.cloudflarestorage.com');
  });

  it('computes R2_ENDPOINT from account ID', async () => {
    const env = createEnv({ R2_ACCOUNT_ID: 'abc123' });
    const config = await getR2Config(env);
    expect(config.endpoint).toBe('https://abc123.r2.cloudflarestorage.com');
  });

  it('throws when no env, KV, or API token available', async () => {
    const env = createEnv({});
    await expect(getR2Config(env)).rejects.toThrow(/R2 account ID/i);
  });

  it('prefers env over KV when both exist', async () => {
    mockKV._store.set('setup:account_id', 'kv-account-id');
    const env = createEnv({ R2_ACCOUNT_ID: 'env-account-id' });
    const config = await getR2Config(env);
    expect(config.accountId).toBe('env-account-id');
  });

  it('works with only account ID in KV (endpoint computed)', async () => {
    mockKV._store.set('setup:account_id', 'from-kv');
    const env = createEnv({});
    const config = await getR2Config(env);
    expect(config.accountId).toBe('from-kv');
    expect(config.endpoint).toBe('https://from-kv.r2.cloudflarestorage.com');
  });

  it('uses R2_ENDPOINT from env when provided alongside R2_ACCOUNT_ID', async () => {
    const env = createEnv({
      R2_ACCOUNT_ID: 'test-id',
      R2_ENDPOINT: 'https://custom-endpoint.example.com',
    });
    const config = await getR2Config(env);
    expect(config.endpoint).toBe('https://custom-endpoint.example.com');
  });

  it('does not call KV when env values are present', async () => {
    const env = createEnv({
      R2_ACCOUNT_ID: 'env-id',
      R2_ENDPOINT: 'https://env-id.r2.cloudflarestorage.com',
    });
    await getR2Config(env);
    expect(mockKV.get).not.toHaveBeenCalled();
  });

  it('throws descriptive error message', async () => {
    const env = createEnv({});
    await expect(getR2Config(env)).rejects.toThrow(/R2 account ID/i);
  });

  it('self-heals from API token when env and KV are empty', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        result: [{ id: 'api-resolved-account' }],
      }))
    );
    vi.stubGlobal('fetch', mockFetch);

    const env = createEnv({ CLOUDFLARE_API_TOKEN: 'test-token' });
    const config = await getR2Config(env);

    expect(config.accountId).toBe('api-resolved-account');
    expect(config.endpoint).toBe('https://api-resolved-account.r2.cloudflarestorage.com');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/accounts'),
      expect.objectContaining({
        headers: { 'Authorization': 'Bearer test-token' },
      })
    );

    // Verify KV was populated for next time
    expect(mockKV._store.get('setup:account_id')).toBe('api-resolved-account');
    expect(mockKV._store.get('setup:r2_endpoint')).toBe('https://api-resolved-account.r2.cloudflarestorage.com');

    vi.unstubAllGlobals();
  });

  it('throws when API token is present but API call fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false }))
    );
    vi.stubGlobal('fetch', mockFetch);

    const env = createEnv({ CLOUDFLARE_API_TOKEN: 'bad-token' });
    await expect(getR2Config(env)).rejects.toThrow(/R2 account ID/i);

    vi.unstubAllGlobals();
  });
});
