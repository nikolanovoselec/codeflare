import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDeriveR2Credentials } from '../../../routes/setup/credentials';
import type { SetupStep } from '../../../routes/setup/shared';
import { SetupError } from '../../../lib/error-types';

vi.mock('../../../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Setup Credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleDeriveR2Credentials', () => {
    it('returns derived R2 credentials on success', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: { id: 'token-id-123', status: 'active' },
          errors: [],
          messages: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const creds = await handleDeriveR2Credentials('test-token-value', steps);

      expect(creds.accessKeyId).toBe('token-id-123');
      // R2 credential derivation contract: independently fixed SHA-256 vector.
      expect(creds.secretAccessKey).toBe('bc6a34869b72942287fb20fdce092fc392e924b4f1986b5dfa47fbc101e2c7fb');
      expect(steps[0].status).toBe('success');
    });

    it('throws SetupError when token verification fails', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: false,
          result: null,
          errors: [{ code: 1000, message: 'Invalid token' }],
          messages: [],
        }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(handleDeriveR2Credentials('bad-token', steps)).rejects.toThrow(SetupError);
      expect(steps[0].status).toBe('error');
    });

    it('throws SetupError when network fails', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(handleDeriveR2Credentials('test-token', steps)).rejects.toThrow(SetupError);
      expect(steps[0].status).toBe('error');
    });
  });
});
