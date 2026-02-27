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

  describe('cross-environment domain validation', () => {
    it('does not match Access app by name when domain differs (POST not PUT)', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        // No user group upsert (all users are admins, regularUsers is empty)
        .mockResolvedValueOnce(cfSuccess([
          { id: 'app-prod', name: 'codeflare', domain: 'prod.example.com/app/*' }
        ])) // listAccessApps - has app with same name but DIFFERENT domain
        .mockResolvedValueOnce(cfSuccess({ id: 'app-new', aud: 'aud-new' })) // upsertAccessApp POST
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'integration.example.com',
        ['admin@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare'
      );

      // Verify the upsertAccessApp call used POST (4th fetch call, index 3)
      const upsertCall = mockFetch.mock.calls[3];
      expect(upsertCall[1].method).toBe('POST');
      expect(upsertCall[0]).not.toContain('app-prod'); // Should NOT reference prod app ID
    });

    it('does not match Access app by /app/* suffix when domain differs', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        // No user group upsert (all users are admins, regularUsers is empty)
        .mockResolvedValueOnce(cfSuccess([
          { id: 'app-prod', name: 'other-name', domain: 'prod.example.com/app/*' }
        ])) // listAccessApps - /app/* suffix but DIFFERENT domain
        .mockResolvedValueOnce(cfSuccess({ id: 'app-new', aud: 'aud-new' })) // POST new
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'integration.example.com',
        ['admin@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare'
      );

      const upsertCall = mockFetch.mock.calls[3];
      expect(upsertCall[1].method).toBe('POST');
    });

    it('matches Access app by name when domain also matches (PUT update)', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        // No user group upsert (all users are admins, regularUsers is empty)
        .mockResolvedValueOnce(cfSuccess([
          { id: 'app-existing', name: 'codeflare', domain: 'app.example.com/app/*' }
        ])) // listAccessApps - same name AND domain contains customDomain
        .mockResolvedValueOnce(cfSuccess({ id: 'app-existing', aud: 'aud-1' })) // PUT update
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'app.example.com',
        ['admin@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare'
      );

      const upsertCall = mockFetch.mock.calls[3];
      expect(upsertCall[1].method).toBe('PUT');
      expect(upsertCall[0]).toContain('app-existing');
    });
  });

  describe('null bug fixes', () => {
    it('upsertAccessApp throws SetupError when already-exists retry finds nothing', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        // No user group upsert (all users are admins, regularUsers is empty)
        .mockResolvedValueOnce(cfSuccess([])) // listAccessApps (empty)
        .mockResolvedValueOnce(cfError('already exists')) // upsertAccessApp POST fails
        .mockResolvedValueOnce(cfSuccess([])); // retry listAccessApps - still empty

      await expect(
        handleCreateAccessApp(
          'test-token', 'account-123', 'app.example.com',
          ['admin@example.com'], ['admin@example.com'],
          steps, mockKV as unknown as KVNamespace, 'codeflare'
        )
      ).rejects.toThrow(SetupError);
      expect(steps[0].status).toBe('error');
    });
  });

  describe('zero regular users (all users are admins)', () => {
    it('should not create a users group with empty members when all allowedUsers are admins', async () => {
      const steps: SetupStep[] = [];

      // When all allowedUsers are also adminUsers, regularUsers = [] (empty).
      // The bug: upsertAccessGroup was called with empty members for the users group,
      // which sends include: [] to the CF API and gets rejected.
      // After fix: user group upsert is skipped entirely when regularUsers is empty.
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' })) // create admin group
        // No user group creation (regularUsers is empty)
        .mockResolvedValueOnce(cfSuccess([])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-1', aud: 'aud-tag-1' })) // upsertAccessApp
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })); // org

      // Both lists are identical = 0 regular users
      await expect(
        handleCreateAccessApp(
          'test-token',
          'account-123',
          'app.example.com',
          ['admin@example.com'],
          ['admin@example.com'],
          steps,
          mockKV as unknown as KVNamespace,
          'codeflare'
        )
      ).resolves.toBeUndefined(); // Should succeed, NOT throw

      expect(steps[0].status).toBe('success');
    });

    it('should create an Access policy referencing only the admin group when there are no regular users', async () => {
      const steps: SetupStep[] = [];

      // Setup: only admin users, no regular users
      // After fix, the users group should either be skipped or handled gracefully.
      // The policy should only reference the admin group.
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' })) // create admin group
        // No user group creation expected after fix
        .mockResolvedValueOnce(cfSuccess([])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-1', aud: 'aud-tag-1' })) // upsertAccessApp
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })); // org

      await handleCreateAccessApp(
        'test-token',
        'account-123',
        'app.example.com',
        ['admin1@example.com', 'admin2@example.com'],
        ['admin1@example.com', 'admin2@example.com'],
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare'
      );

      expect(steps[0].status).toBe('success');

      // Verify the upsertAccessPolicy call does NOT include a user group reference.
      // The policy create call is the 6th fetch call (index 5).
      // After fix: it should only have the admin group in include.
      const policyCall = mockFetch.mock.calls.find((call: any[]) => {
        const url = typeof call[0] === 'string' ? call[0] : '';
        return url.includes('/policies') && call[1]?.method === 'POST';
      });
      expect(policyCall).toBeDefined();
      const policyBody = JSON.parse(policyCall![1]!.body as string);
      // Should only contain admin group, not user group
      expect(policyBody.include).toEqual([
        { group: { id: 'grp-admin' } },
      ]);
    });

    it('should still store access config correctly with only admin group when no regular users', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' })) // create admin group
        .mockResolvedValueOnce(cfSuccess([])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-1', aud: 'aud-tag-1' })) // upsertAccessApp
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })); // org

      await handleCreateAccessApp(
        'test-token',
        'account-123',
        'app.example.com',
        ['admin@example.com'],
        ['admin@example.com'],
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare'
      );

      expect(steps[0].status).toBe('success');
      expect(mockKV.put).toHaveBeenCalledWith('setup:access_aud', 'aud-tag-1');
      expect(mockKV.put).toHaveBeenCalledWith('setup:access_app_id', 'app-1');
    });
  });

  describe('error propagation', () => {
    it('listAccessApps errors propagate instead of returning empty array', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        // No user group upsert (all users are admins, regularUsers is empty)
        .mockRejectedValueOnce(new Error('Network failure')); // listAccessApps throws

      await expect(
        handleCreateAccessApp(
          'test-token', 'account-123', 'app.example.com',
          ['admin@example.com'], ['admin@example.com'],
          steps, mockKV as unknown as KVNamespace, 'codeflare'
        )
      ).rejects.toThrow();
      expect(steps[0].status).toBe('error');
    });
  });
});
