import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleConfigureTurnstile } from '../../../routes/setup/turnstile';
import type { SetupStep } from '../../../routes/setup/shared';
import { SetupError } from '../../../lib/error-types';

vi.mock('../../../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function cfSuccess<T>(result: T) {
  return new Response(JSON.stringify({ success: true, result, errors: [], messages: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Setup Turnstile', () => {
  let mockKV: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('handleConfigureTurnstile', () => {
    it('creates a new Turnstile widget on fresh setup', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listWidgets (none existing)
        .mockResolvedValueOnce(cfSuccess({ sitekey: 'sk-123', secret: 'sec-456' })); // create widget

      await handleConfigureTurnstile(
        'test-token',
        'account-123',
        'app.example.com',
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare'
      );

      expect(steps[0].status).toBe('success');
      expect(mockKV.put).toHaveBeenCalledWith('setup:turnstile_site_key', 'sk-123');
      expect(mockKV.put).toHaveBeenCalledWith('setup:turnstile_secret_key', 'sec-456');
    });

    it('reuses existing widget matching by name and domain', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([
          { sitekey: 'sk-existing', name: 'codeflare', domains: ['app.example.com'] },
        ])) // listWidgets (one existing)
        .mockResolvedValueOnce(cfSuccess({ sitekey: 'sk-existing', secret: 'sec-rotated' })); // update widget

      await handleConfigureTurnstile(
        'test-token',
        'account-123',
        'app.example.com',
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare'
      );

      expect(steps[0].status).toBe('success');
      expect(mockKV.put).toHaveBeenCalledWith('setup:turnstile_site_key', 'sk-existing');
    });

    it('includes workers.dev hostname in domains when requestUrl provided', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listWidgets
        .mockResolvedValueOnce(cfSuccess({ sitekey: 'sk-123', secret: 'sec-456' })); // create widget

      await handleConfigureTurnstile(
        'test-token',
        'account-123',
        'app.example.com',
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare',
        'http://myapp.test.workers.dev'
      );

      // The create call should include both domains
      const createCall = mockFetch.mock.calls[1];
      const body = JSON.parse(createCall[1].body);
      expect(body.domains).toContain('app.example.com');
      expect(body.domains).toContain('myapp.test.workers.dev');
    });

    it('throws SetupError when widget creation fails', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listWidgets
        .mockResolvedValueOnce(new Response(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 9103, message: 'Permission denied' }],
            messages: [],
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )); // create widget fails

      await expect(
        handleConfigureTurnstile(
          'test-token',
          'account-123',
          'app.example.com',
          steps,
          mockKV as unknown as KVNamespace
        )
      ).rejects.toThrow(SetupError);

      expect(steps[0].status).toBe('error');
    });
  });
});
