import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleConfigureCustomDomain } from '../../../routes/setup/custom-domain';
import type { SetupStep } from '../../../routes/setup/shared';
import { SetupError, ValidationError } from '../../../lib/error-types';

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

function cfFailure(status: number, code: number, message: string) {
  return new Response(JSON.stringify({ success: false, result: null, errors: [{ code, message }], messages: [] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Setup Custom Domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleConfigureCustomDomain', () => {
    it('throws ValidationError for invalid domain format', async () => {
      const steps: SetupStep[] = [];

      await expect(
        handleConfigureCustomDomain(
          'test-token',
          'account-123',
          'not a valid domain!',
          'http://codeflare.test.workers.dev',
          steps
        )
      ).rejects.toThrow(ValidationError);
    });

    it('configures DNS and worker route on success', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        // resolveZone
        .mockResolvedValueOnce(cfSuccess([{ id: 'zone-123' }]))
        // resolveAccountSubdomain
        .mockResolvedValueOnce(cfSuccess({ subdomain: 'myaccount' }))
        // DNS lookup (existing records)
        .mockResolvedValueOnce(cfSuccess([]))
        // DNS create
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        // Worker route create
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      const zoneId = await handleConfigureCustomDomain(
        'test-token',
        'account-123',
        'app.example.com',
        'http://codeflare.test.workers.dev',
        steps
      );

      expect(zoneId).toBe('zone-123');
      expect(steps[0].status).toBe('success');
    });

    it('throws SetupError when zone not found', async () => {
      const steps: SetupStep[] = [];

      // resolveZone - no results for any suffix
      mockFetch
        .mockResolvedValueOnce(cfSuccess([]))  // app.example.com
        .mockResolvedValueOnce(cfSuccess([])); // example.com

      await expect(
        handleConfigureCustomDomain(
          'test-token',
          'account-123',
          'app.example.com',
          'http://codeflare.test.workers.dev',
          steps
        )
      ).rejects.toThrow(SetupError);

      expect(steps[0].status).toBe('error');
    });

    it('uses envWorkerName when provided', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([{ id: 'zone-123' }])) // zone
        .mockResolvedValueOnce(cfSuccess({ subdomain: 'myaccount' })) // subdomain
        .mockResolvedValueOnce(cfSuccess([])) // DNS lookup
        .mockResolvedValueOnce(new Response('', { status: 200 })) // DNS create
        .mockResolvedValueOnce(new Response('', { status: 200 })); // worker route

      await handleConfigureCustomDomain(
        'test-token',
        'account-123',
        'app.example.com',
        'http://custom.example.com',
        steps,
        'my-worker'
      );

      // Worker route should reference envWorkerName
      const routeCall = mockFetch.mock.calls[4];
      const routeBody = JSON.parse(routeCall[1].body);
      expect(routeBody.script).toBe('my-worker');
    });

    it('accepts an already-existing worker route only when its current state is correct', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([{ id: 'zone-123' }]))
        .mockResolvedValueOnce(cfSuccess({ subdomain: 'myaccount' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(cfFailure(409, 10020, 'Route already exists'))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'route-123', pattern: 'app.example.com/*', script: 'codeflare' },
        ]));

      await expect(handleConfigureCustomDomain(
        'test-token',
        'account-123',
        'app.example.com',
        'http://custom.example.com',
        steps,
        'codeflare'
      )).resolves.toBe('zone-123');

      const routePut = mockFetch.mock.calls.find(([url, init]) =>
        String(url).includes('/workers/routes/') && init?.method === 'PUT'
      );
      expect(routePut).toBeUndefined();
    });

    it('updates an already-existing worker route whose state is wrong', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([{ id: 'zone-123' }]))
        .mockResolvedValueOnce(cfSuccess({ subdomain: 'myaccount' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(cfFailure(409, 10020, 'Route already exists'))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'route-123', pattern: 'app.example.com/*', script: 'old-worker' },
        ]))
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await handleConfigureCustomDomain(
        'test-token',
        'account-123',
        'app.example.com',
        'http://custom.example.com',
        steps,
        'codeflare'
      );

      const routePut = mockFetch.mock.calls.find(([url, init]) =>
        String(url).endsWith('/workers/routes/route-123') && init?.method === 'PUT'
      );
      expect(routePut).toBeDefined();
      expect(JSON.parse(routePut![1].body)).toEqual({ pattern: 'app.example.com/*', script: 'codeflare' });
    });

    it('fails setup when an incorrect worker route cannot be updated', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([{ id: 'zone-123' }]))
        .mockResolvedValueOnce(cfSuccess({ subdomain: 'myaccount' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(cfFailure(409, 10020, 'Route already exists'))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'route-123', pattern: 'app.example.com/*', script: 'old-worker' },
        ]))
        .mockResolvedValueOnce(cfFailure(500, 1000, 'Update failed'));

      await expect(handleConfigureCustomDomain(
        'test-token',
        'account-123',
        'app.example.com',
        'http://custom.example.com',
        steps,
        'codeflare'
      )).rejects.toThrow(SetupError);

      expect(steps[0]).toMatchObject({ step: 'configure_custom_domain', status: 'error' });
    });

    it('resolves a duplicate DNS create and corrects its target and proxy state', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([{ id: 'zone-123' }]))
        .mockResolvedValueOnce(cfSuccess({ subdomain: 'myaccount' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(cfFailure(409, 81057, 'Record already exists'))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'dns-123', type: 'CNAME', content: 'old.example.net', proxied: false },
        ]))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await handleConfigureCustomDomain(
        'test-token',
        'account-123',
        'app.example.com',
        'http://custom.example.com',
        steps,
        'codeflare'
      );

      const dnsPut = mockFetch.mock.calls.find(([url, init]) =>
        String(url).endsWith('/dns_records/dns-123') && init?.method === 'PUT'
      );
      expect(dnsPut).toBeDefined();
      expect(JSON.parse(dnsPut![1].body)).toMatchObject({
        type: 'CNAME',
        content: 'codeflare.myaccount.workers.dev',
        proxied: true,
      });
    });
  });
});
