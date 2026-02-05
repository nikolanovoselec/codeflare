import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateAccessApp, getAccessGroupNames } from '../../../routes/setup/access';
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

function cfError(message: string, code = 0) {
  return new Response(JSON.stringify({ success: false, result: null, errors: [{ code, message }], messages: [] }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Setup Access', () => {
  let mockKV: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('getAccessGroupNames', () => {
    it('returns worker-scoped group names', () => {
      const names = getAccessGroupNames('myworker');
      expect(names.admin).toBe('myworker-admins');
      expect(names.user).toBe('myworker-users');
    });

    it('defaults to codeflare when no worker name provided', () => {
      const names = getAccessGroupNames();
      expect(names.admin).toBe('codeflare-admins');
      expect(names.user).toBe('codeflare-users');
    });

    it('trims and lowercases worker name', () => {
      const names = getAccessGroupNames('  MyWorker  ');
      expect(names.admin).toBe('myworker-admins');
      expect(names.user).toBe('myworker-users');
    });
  });

  describe('handleCreateAccessApp', () => {
    it('creates access groups, app, and policy on fresh setup', async () => {
      const steps: SetupStep[] = [];

      // Mock responses in order:
      // 1. listAccessGroups
      // 2. upsertAccessGroup (admin)
      // 3. upsertAccessGroup (user)
      // 4. listAccessApps
      // 5. upsertAccessApp (POST)
      // 6. listPolicies
      // 7. createPolicy
      // 8. fetchOrganization (for auth_domain)
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' })) // create admin group
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-user', name: 'codeflare-users' })) // create user group
        .mockResolvedValueOnce(cfSuccess([])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-1', aud: 'aud-tag-1' })) // create access app
        .mockResolvedValueOnce(cfSuccess([])) // list policies (empty => create)
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })); // org

      await handleCreateAccessApp(
        'test-token',
        'account-123',
        'app.example.com',
        ['admin@example.com', 'user@example.com'],
        ['admin@example.com'],
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare'
      );

      expect(steps).toHaveLength(1);
      expect(steps[0].status).toBe('success');
      expect(mockKV.put).toHaveBeenCalledWith('setup:access_aud', 'aud-tag-1');
      expect(mockKV.put).toHaveBeenCalledWith('setup:access_app_id', 'app-1');
    });

    it('throws SetupError when group creation fails', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfError('Permission denied', 9103)); // create admin group fails

      await expect(
        handleCreateAccessApp(
          'test-token',
          'account-123',
          'app.example.com',
          ['user@example.com'],
          ['admin@example.com'],
          steps,
          mockKV as unknown as KVNamespace
        )
      ).rejects.toThrow(SetupError);

      expect(steps[0].status).toBe('error');
    });
  });
});
