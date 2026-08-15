import { describe, expect, it, vi } from 'vitest';
import { checkVaultKeyRecoverable } from '../../lib/vault-local-readiness';

describe('REQ-VAULT-019: checkVaultKeyRecoverable', () => {
  const okResponse = (key: unknown) => ({ ok: true, json: async () => ({ key }) }) as unknown as Response;

  it('GETs the session /.vault-key endpoint with credentials and returns true on a non-empty key', async () => {
    const fetchRef = vi.fn(async () => okResponse('deadbeefkey')) as unknown as typeof fetch;
    const result = await checkVaultKeyRecoverable('session-1', { fetchRef });
    expect(result).toBe(true);
    expect(fetchRef).toHaveBeenCalledWith(
      '/api/vault/session-1/.vault-key',
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'include' }),
    );
  });

  it('returns false when the endpoint responds non-2xx (server key recovery failed)', async () => {
    const fetchRef = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Key recovery failed' }) }) as unknown as Response) as unknown as typeof fetch;
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef })).toBe(false);
  });

  it('returns false when the key is empty or missing', async () => {
    const empty = vi.fn(async () => okResponse('')) as unknown as typeof fetch;
    const missing = vi.fn(async () => okResponse(undefined)) as unknown as typeof fetch;
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef: empty })).toBe(false);
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef: missing })).toBe(false);
  });

  it('returns false when the request throws (cookie stripped / network down)', async () => {
    const fetchRef = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef })).toBe(false);
  });

  it('returns false when no fetch implementation is available', async () => {
    expect(await checkVaultKeyRecoverable('session-1', { fetchRef: null })).toBe(false);
  });
});
