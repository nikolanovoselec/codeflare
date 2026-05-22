import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetAccount } from '../../../routes/setup/account';
import type { SetupStep } from '../../../routes/setup/shared';
import { SetupError } from '../../../lib/error-types';

vi.mock('../../../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Setup Account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleGetAccount', () => {
    it('returns account ID on success', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: [{ id: 'acc-123' }],
          errors: [],
          messages: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const accountId = await handleGetAccount('test-token', steps);

      expect(accountId).toBe('acc-123');
      expect(steps[0].status).toBe('success');
    });

    it('throws SetupError when API returns no accounts', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          result: [],
          errors: [],
          messages: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(handleGetAccount('test-token', steps)).rejects.toThrow(SetupError);
      expect(steps[0].status).toBe('error');
    });

    it('throws SetupError when API call fails', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(handleGetAccount('test-token', steps)).rejects.toThrow(SetupError);
      expect(steps[0].status).toBe('error');
    });

    it('throws SetupError when API returns failure', async () => {
      const steps: SetupStep[] = [];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: false,
          result: null,
          errors: [{ code: 9103, message: 'Authentication error' }],
          messages: [],
        }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(handleGetAccount('test-token', steps)).rejects.toThrow(SetupError);
      expect(steps[0].status).toBe('error');
    });
  });
});
