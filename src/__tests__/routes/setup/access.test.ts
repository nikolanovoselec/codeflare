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

  // Mock IdP list response — prepended to every test's fetch chain since
  // listIdentityProviders() runs first in handleCreateAccessApp()
  const mockIdpList = [
    { id: 'idp-google', type: 'google', name: 'Google' },
    { id: 'idp-github', type: 'github', name: 'GitHub' },
  ];

  describe('handleCreateAccessApp', () => {
    it('creates access groups, app, and policy on fresh setup', async () => {
      const steps: SetupStep[] = [];

      // Mock responses in order:
      // 0. listIdentityProviders
      // 1. listAccessGroups
      // 2. upsertAccessGroup (admin)
      // 3. upsertAccessGroup (user)
      // 4. listAccessApps
      // 5. upsertAccessApp (POST)
      // 6. listPolicies
      // 7. createPolicy
      // 8. fetchOrganization (for auth_domain)
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
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

      // Default/SaaS mode stays path-scoped: primary domain is /app/* and the
      // destinations enumerate the protected paths (so /, /public/*, /auth/*
      // remain public). This locks the non-enterprise behavior unchanged.
      const defaultAppBody = JSON.parse((mockFetch.mock.calls[5][1] as RequestInit).body as string);
      expect(defaultAppBody.domain).toBe('app.example.com/app/*');
      expect(defaultAppBody.destinations).toContainEqual({ type: 'public', uri: 'app.example.com/api/*' });
    });

    it('enterprise mode creates a host-scoped app (bare host domain + whole-host destination)', async () => {
      const steps: SetupStep[] = [];

      // Same fetch chain as fresh setup (saasMode=false => user group created):
      // 0 listIdP, 1 listGroups, 2 admin group, 3 user group, 4 listApps,
      // 5 upsertApp (POST), 6 listPolicies, 7 createPolicy, 8 org
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-enterprise-admins' }))
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-user', name: 'codeflare-enterprise-users' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(cfSuccess({ id: 'app-ent', aud: 'aud-ent' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token',
        'account-123',
        'enterprise.example.com',
        ['admin@example.com', 'user@example.com'],
        ['admin@example.com'],
        steps,
        mockKV as unknown as KVNamespace,
        'codeflare-enterprise',
        false, // saasMode
        true   // enterprise
      );

      expect(steps[0].status).toBe('success');

      // The upsertAccessApp POST is the 6th fetch (index 5). Enterprise must
      // protect the WHOLE host (bare domain, single whole-host destination) so
      // the CF Access session cookie is host-wide and covers /api/* — a
      // path-scoped /app app would 401 /api/* and the SPA would redirect-loop.
      const appBody = JSON.parse((mockFetch.mock.calls[5][1] as RequestInit).body as string);
      expect(appBody.domain).toBe('enterprise.example.com');
      expect(appBody.destinations).toEqual([{ type: 'public', uri: 'enterprise.example.com' }]);
    });

    it('throws SetupError when group creation fails', async () => {
      const steps: SetupStep[] = [];

      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
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

    it('enterprise mode provisions a higher-precedence SW-bypass Access app (decision: bypass, include everyone)', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList))                                   // 0 listIdP
        .mockResolvedValueOnce(cfSuccess([]))                                            // 1 listGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-enterprise-admins' })) // 2
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-user', name: 'codeflare-enterprise-users' }))   // 3
        .mockResolvedValueOnce(cfSuccess([]))                                            // 4 listApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-ent', aud: 'aud-ent' }))            // 5 upsertApp
        .mockResolvedValueOnce(cfSuccess([]))                                            // 6 listPolicies
        .mockResolvedValueOnce(new Response('', { status: 200 }))                        // 7 createPolicy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })) // 8 org
        .mockResolvedValueOnce(cfSuccess({ id: 'sw-bypass-app' }))                       // 9 SW-bypass upsert
        .mockResolvedValueOnce(cfSuccess([]))                                            // 10 SW-policy list
        .mockResolvedValueOnce(cfSuccess({ id: 'sw-pol' }));                             // 11 SW-policy create

      await handleCreateAccessApp(
        'test-token', 'account-123', 'enterprise.example.com',
        ['admin@example.com', 'user@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare-enterprise', false, true,
      );

      expect(steps[0].status).toBe('success');
      // SW-bypass app: index-9 fetch is a self-hosted app scoped to the SW path.
      const swAppCall = mockFetch.mock.calls[9];
      const swAppBody = JSON.parse((swAppCall[1] as RequestInit).body as string);
      expect(swAppBody.type).toBe('self_hosted');
      expect(swAppBody.domain).toBe('enterprise.example.com/api/vault/*/service_worker.js');
      // SW-bypass policy: index-11 create carries decision 'bypass' + include everyone.
      const swPolCall = mockFetch.mock.calls[11];
      const swPolBody = JSON.parse((swPolCall[1] as RequestInit).body as string);
      expect(swPolBody.decision).toBe('bypass');
      expect(swPolBody.include).toContainEqual({ everyone: {} });
      // App id is persisted under the new SETUP_KEYS entry.
      expect(mockKV.put).toHaveBeenCalledWith('setup:access_sw_bypass_app_id', 'sw-bypass-app');
    });

    it('default (non-enterprise) mode does NOT create a SW-bypass app', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-user', name: 'codeflare-users' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(cfSuccess({ id: 'app-1', aud: 'aud-1' }))
        .mockResolvedValueOnce(cfSuccess([]))
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'app.example.com',
        ['admin@example.com', 'user@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare',
      );

      expect(steps[0].status).toBe('success');
      // Exactly the 9 default-mode fetches — no SW-bypass app/policy calls.
      expect(mockFetch.mock.calls).toHaveLength(9);
      expect(mockKV.put).not.toHaveBeenCalledWith('setup:access_sw_bypass_app_id', expect.anything());
    });

    it('rolls back a freshly-created SW-bypass app when the bypass policy fails (best-effort; parent step still succeeds, id not persisted)', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList))                                   // 0 listIdP
        .mockResolvedValueOnce(cfSuccess([]))                                            // 1 listGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-enterprise-admins' })) // 2
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-user', name: 'codeflare-enterprise-users' }))   // 3
        .mockResolvedValueOnce(cfSuccess([]))                                            // 4 listApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-ent', aud: 'aud-ent' }))            // 5 upsertApp
        .mockResolvedValueOnce(cfSuccess([]))                                            // 6 listPolicies
        .mockResolvedValueOnce(new Response('', { status: 200 }))                        // 7 createPolicy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })) // 8 org
        .mockResolvedValueOnce(cfSuccess({ id: 'sw-bypass-app' }))                       // 9 SW-bypass upsert (POST, created)
        .mockResolvedValueOnce(cfSuccess([]))                                            // 10 SW-policy list (empty => POST)
        .mockResolvedValueOnce(new Response('', { status: 403 }))                        // 11 SW-policy create FAILS
        .mockResolvedValueOnce(new Response('', { status: 200 }));                       // 12 rollback DELETE

      await handleCreateAccessApp(
        'test-token', 'account-123', 'enterprise.example.com',
        ['admin@example.com', 'user@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare-enterprise', false, true,
      );

      // Best-effort: the host-wide Access setup already succeeded, so the step stays
      // success even though the bypass policy failed.
      expect(steps[0].status).toBe('success');
      // The freshly-created bypass app is rolled back via DELETE so a policy-less
      // self_hosted app never lingers (that would DENY the SW path — worse than the 302).
      const rollbackCall = mockFetch.mock.calls[12];
      expect((rollbackCall[1] as RequestInit).method).toBe('DELETE');
      expect(String(rollbackCall[0])).toContain('/access/apps/sw-bypass-app');
      // The id is NOT persisted when the policy never landed.
      expect(mockKV.put).not.toHaveBeenCalledWith('setup:access_sw_bypass_app_id', expect.anything());
    });

    it('does not persist an id, reach the policy step, or roll back when the SW-bypass app upsert fails', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList))                                   // 0 listIdP
        .mockResolvedValueOnce(cfSuccess([]))                                            // 1 listGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-enterprise-admins' })) // 2
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-user', name: 'codeflare-enterprise-users' }))   // 3
        .mockResolvedValueOnce(cfSuccess([]))                                            // 4 listApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-ent', aud: 'aud-ent' }))            // 5 upsertApp
        .mockResolvedValueOnce(cfSuccess([]))                                            // 6 listPolicies
        .mockResolvedValueOnce(new Response('', { status: 200 }))                        // 7 createPolicy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' })) // 8 org
        .mockResolvedValueOnce(cfError('mid-path wildcard scope rejected'));            // 9 SW-bypass upsert FAILS (success:false)

      await handleCreateAccessApp(
        'test-token', 'account-123', 'enterprise.example.com',
        ['admin@example.com', 'user@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare-enterprise', false, true,
      );

      // Best-effort: a rejected bypass-app upsert warns and returns without aborting setup.
      expect(steps[0].status).toBe('success');
      // No policy list/create and no rollback DELETE — exactly the 9 base fetches plus the
      // single failed bypass-app upsert (nothing was created, so nothing is torn down).
      expect(mockFetch.mock.calls).toHaveLength(10);
      expect(mockKV.put).not.toHaveBeenCalledWith('setup:access_sw_bypass_app_id', expect.anything());
    });
  });

  describe('cross-environment domain validation', () => {
    it('does not match Access app by name when domain differs (POST not PUT)', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'app-prod', name: 'codeflare', domain: 'prod.example.com/app/*' }
        ])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-new', aud: 'aud-new' })) // upsertAccessApp POST
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'integration.example.com',
        ['admin@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare'
      );

      const upsertCall = mockFetch.mock.calls[4]; // shifted +1 for IdP fetch
      expect(upsertCall[1].method).toBe('POST');
      expect(upsertCall[0]).not.toContain('app-prod');
    });

    it('does not match Access app by /app/* suffix when domain differs', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'app-prod', name: 'other-name', domain: 'prod.example.com/app/*' }
        ])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-new', aud: 'aud-new' })) // POST new
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'integration.example.com',
        ['admin@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare'
      );

      const upsertCall = mockFetch.mock.calls[4]; // shifted +1
      expect(upsertCall[1].method).toBe('POST');
    });

    it('matches Access app by name when domain also matches (PUT update)', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
        .mockResolvedValueOnce(cfSuccess([
          { id: 'app-existing', name: 'codeflare', domain: 'app.example.com/app/*' }
        ])) // listAccessApps
        .mockResolvedValueOnce(cfSuccess({ id: 'app-existing', aud: 'aud-1' })) // PUT update
        .mockResolvedValueOnce(cfSuccess([])) // list policies
        .mockResolvedValueOnce(new Response('', { status: 200 })) // create policy
        .mockResolvedValueOnce(cfSuccess({ auth_domain: 'test.cloudflareaccess.com' }));

      await handleCreateAccessApp(
        'test-token', 'account-123', 'app.example.com',
        ['admin@example.com'], ['admin@example.com'],
        steps, mockKV as unknown as KVNamespace, 'codeflare'
      );

      const upsertCall = mockFetch.mock.calls[4]; // shifted +1
      expect(upsertCall[1].method).toBe('PUT');
      expect(upsertCall[0]).toContain('app-existing');
    });
  });

  describe('null bug fixes', () => {
    it('upsertAccessApp throws SetupError when already-exists retry finds nothing', async () => {
      const steps: SetupStep[] = [];
      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
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

      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' })) // create admin group
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

      mockFetch
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
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
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
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
        .mockResolvedValueOnce(cfSuccess(mockIdpList)) // listIdentityProviders
        .mockResolvedValueOnce(cfSuccess([])) // listAccessGroups
        .mockResolvedValueOnce(cfSuccess({ id: 'grp-admin', name: 'codeflare-admins' }))
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
