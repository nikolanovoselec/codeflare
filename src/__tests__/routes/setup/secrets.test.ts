import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSetSecrets } from '../../../routes/setup/secrets';
import type { SetupStep } from '../../../routes/setup/shared';
import { SetupError } from '../../../lib/error-types';

vi.mock('../../../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Setup Secrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleSetSecrets', () => {
    it('sets R2 secrets successfully', async () => {
      const steps: SetupStep[] = [];

      // Both secret PUTs succeed
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 200 }))  // R2_ACCESS_KEY_ID
        .mockResolvedValueOnce(new Response('', { status: 200 })); // R2_SECRET_ACCESS_KEY

      await handleSetSecrets(
        'test-token',
        'account-123',
        'r2-key-id',
        'r2-secret',
        'http://codeflare.test.workers.dev',
        steps
      );

      expect(steps[0].status).toBe('success');
      // Two PUT calls for two secrets
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('uses envWorkerName when hostname is not workers.dev', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await handleSetSecrets(
        'test-token',
        'account-123',
        'r2-key-id',
        'r2-secret',
        'http://custom.example.com',
        steps,
        'my-worker'
      );

      // Both API calls should target the envWorkerName
      const firstCallUrl = mockFetch.mock.calls[0][0];
      expect(firstCallUrl).toContain('/workers/scripts/my-worker/secrets');
    });

    it('retries after deploying latest version on error 10215', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        // First PUT fails with 10215
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ errors: [{ code: 10215, message: 'Version not deployed' }] }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ))
        // List versions
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ success: true, result: { items: [{ id: 'ver-1' }] }, errors: [], messages: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ))
        // Deploy latest version
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        // Retry first secret PUT (success)
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        // Second secret PUT (success)
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await handleSetSecrets(
        'test-token',
        'account-123',
        'r2-key-id',
        'r2-secret',
        'http://codeflare.test.workers.dev',
        steps
      );

      expect(steps[0].status).toBe('success');
    });

    it('throws SetupError when secret PUT fails permanently', async () => {
      const steps: SetupStep[] = [];

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: [{ code: 9103, message: 'Permission denied' }] }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(
        handleSetSecrets(
          'test-token',
          'account-123',
          'r2-key-id',
          'r2-secret',
          'http://codeflare.test.workers.dev',
          steps
        )
      ).rejects.toThrow(SetupError);

      expect(steps[0].status).toBe('error');
    });
  });
});
