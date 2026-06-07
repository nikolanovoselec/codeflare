/**
 * REQ-ENTERPRISE-010: Access-gated JIT user provisioning.
 *
 * In enterprise mode, an Access-authenticated user with no KV record is
 * auto-provisioned a custom `unlimited` account, optionally gated on membership
 * in a customer-managed Access group (resolved via the Access get-identity
 * endpoint). The non-enterprise auth path is byte-identical to today.
 *
 * AC1. Unknown email + valid JWT -> unlimited `enterprise-jit` record.
 * AC2. ENTERPRISE_ACCESS_GROUP set: member -> provision; non-member -> ForbiddenError, no record.
 * AC3. ENTERPRISE_ACCESS_GROUP unset: provision on a valid JWT alone (no get-identity call).
 * AC4. Existing admin/user record returned unchanged; provisioning is idempotent.
 * AC5. No welcome email on enterprise JIT.
 * AC6. ENTERPRISE_MODE unset: an unknown non-SaaS user is still 403, never provisioned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: mockLoggerWarn })),
}));

const { mockSendWelcomeEmail } = vi.hoisted(() => ({ mockSendWelcomeEmail: vi.fn(async () => true) }));
vi.mock('../../lib/email', () => ({ sendWelcomeEmail: mockSendWelcomeEmail }));

import { resolveOrProvisionEnterpriseUser, authenticateRequest, resetAuthConfigCache } from '../../lib/access';
import { ForbiddenError } from '../../lib/error-types';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';

const AUTH_DOMAIN = 'team.cloudflareaccess.com';
const TOKEN = 'cf-auth-token';

function identityOk(groups: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ groups }) } as unknown as Response;
}

describe('REQ-ENTERPRISE-010: Access-gated JIT provisioning', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
    vi.unstubAllGlobals();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  describe('resolveOrProvisionEnterpriseUser', () => {
    it('AC1: provisions an unlimited enterprise-jit user for an unknown email (no group configured)', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'New@Example.com', TOKEN, AUTH_DOMAIN);

      expect(result).toMatchObject({ role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' });
      const stored = JSON.parse(mockKV._store.get('user:new@example.com') as string);
      expect(stored).toMatchObject({ addedBy: 'enterprise-jit', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' });
      expect(fetchSpy).not.toHaveBeenCalled();              // no group -> no get-identity
      expect(mockSendWelcomeEmail).not.toHaveBeenCalled();  // AC5: no welcome email
    });

    it('AC2: with ENTERPRISE_ACCESS_GROUP set, provisions a user who IS in the group', async () => {
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
      vi.stubGlobal('fetch', vi.fn(async () => identityOk([{ id: 'g1', name: 'engineers' }])));

      const result = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'eng@example.com', TOKEN, AUTH_DOMAIN);

      expect(result.subscriptionTier).toBe('unlimited');
      expect(mockKV._store.get('user:eng@example.com')).toBeDefined();
    });

    it('AC2: with ENTERPRISE_ACCESS_GROUP set, denies a non-member (ForbiddenError) and writes no record', async () => {
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
      vi.stubGlobal('fetch', vi.fn(async () => identityOk([{ id: 'g2', name: 'sales' }])));

      await expect(
        resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'outsider@example.com', TOKEN, AUTH_DOMAIN),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockKV._store.get('user:outsider@example.com')).toBeUndefined();
    });

    it('AC2 (any-of): admits a user who is in ANY one of several configured groups', async () => {
      // Two groups configured; the user is in only the SECOND. A first-match-only
      // gate would deny here, so this fails if the any-of intersection regresses.
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'codeflare_admins, codeflare_developers');
      vi.stubGlobal('fetch', vi.fn(async () => identityOk([{ id: 'g9', name: 'codeflare_developers' }])));

      const result = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'dev@example.com', TOKEN, AUTH_DOMAIN);

      expect(result.subscriptionTier).toBe('unlimited');
      expect(mockKV._store.get('user:dev@example.com')).toBeDefined();
    });

    it('AC2 (any-of): denies a user who is in NONE of several configured groups', async () => {
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'codeflare_admins, codeflare_developers');
      vi.stubGlobal('fetch', vi.fn(async () => identityOk([{ name: 'random_group' }])));

      await expect(
        resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'outsider@example.com', TOKEN, AUTH_DOMAIN),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockKV._store.get('user:outsider@example.com')).toBeUndefined();
    });

    it('AC3: with no group configured, provisions on a valid token alone (get-identity not called)', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'anyone@example.com', TOKEN, AUTH_DOMAIN);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockKV._store.get('user:anyone@example.com')).toBeDefined();
    });

    it('AC4: returns an existing admin record unchanged and writes nothing new', async () => {
      mockKV._store.set('user:admin@example.com', JSON.stringify({
        addedBy: 'setup', addedAt: 't', role: 'admin', accessTier: 'advanced', subscriptionTier: 'unlimited',
      }));
      const putsBefore = mockKV.put.mock.calls.length;

      const result = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'admin@example.com', TOKEN, AUTH_DOMAIN);

      expect(result.role).toBe('admin');
      expect(mockKV.put.mock.calls.length).toBe(putsBefore); // no overwrite/downgrade
    });

    it('AC4: idempotent — provisioning twice keeps one enterprise-jit record', async () => {
      await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'dup@example.com', TOKEN, AUTH_DOMAIN);
      const first = mockKV._store.get('user:dup@example.com');
      await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'dup@example.com', TOKEN, AUTH_DOMAIN);
      const second = mockKV._store.get('user:dup@example.com');

      expect(first).toBeDefined();
      expect(JSON.parse(second as string).addedBy).toBe('enterprise-jit');
    });

    // REQ-ENTERPRISE-008 AC3: every enterprise user is implicitly Pro/advanced. A freshly
    // provisioned user must PERSIST subscribedMode so the returning-user (existing-record)
    // branch reads 'advanced' back instead of undefined -> 'default' downstream.
    it('AC3 regression: a freshly provisioned enterprise-jit user persists subscribedMode=advanced and a returning login keeps it', async () => {
      const first = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'returning@example.com', TOKEN, AUTH_DOMAIN);
      expect(first.subscribedMode).toBe('advanced');
      // The persisted record carries the field (so the next login does not degrade to default).
      expect(JSON.parse(mockKV._store.get('user:returning@example.com') as string).subscribedMode).toBe('advanced');
      // Second login goes through the existing-record branch.
      const second = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'returning@example.com', TOKEN, AUTH_DOMAIN);
      expect(second.subscribedMode).toBe('advanced');
    });

    it('AC3 regression: a pre-existing record without subscribedMode still resolves advanced (admin / pre-fix JIT record)', async () => {
      mockKV._store.set('user:legacy@example.com', JSON.stringify({
        addedBy: 'enterprise-jit', addedAt: 't', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited',
      }));
      const result = await resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'legacy@example.com', TOKEN, AUTH_DOMAIN);
      expect(result.subscribedMode).toBe('advanced');
    });

    it('fails closed (ForbiddenError) when get-identity errors while a group is required', async () => {
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));

      await expect(
        resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'err@example.com', TOKEN, AUTH_DOMAIN),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockKV._store.get('user:err@example.com')).toBeUndefined();
    });

    it('fails closed when get-identity returns non-OK while a group is required', async () => {
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) } as unknown as Response)));

      await expect(
        resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'nope@example.com', TOKEN, AUTH_DOMAIN),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('fails closed when a group is required but the token/domain is missing (no get-identity call)', async () => {
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'notoken@example.com', null, AUTH_DOMAIN),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed when authDomain is not a *.cloudflareaccess.com host (no get-identity call)', async () => {
      // Defense-in-depth: a corrupted/misconfigured AUTH_DOMAIN must never redirect the
      // get-identity call to an arbitrary host — the domain is rejected before fetch.
      mockKV._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        resolveOrProvisionEnterpriseUser(mockKV as unknown as KVNamespace, 'spoof@example.com', TOKEN, 'evil.example.com'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockKV._store.get('user:spoof@example.com')).toBeUndefined();
    });
  });

  describe('authenticateRequest enterprise integration', () => {
    function enterpriseEnv(overrides: Partial<Env> = {}): Env {
      return { KV: mockKV as unknown as KVNamespace, ENTERPRISE_MODE: 'active', CLOUDFLARE_WORKER_NAME: 'codeflare', ...overrides } as Env;
    }

    it('AC1 e2e: a fresh Access user (pre-setup header trust) is auto-provisioned unlimited', async () => {
      // Empty KV => no auth config => pre-setup header trust => authenticated without a JWT.
      const req = new Request('https://app.example.com/api/user', {
        method: 'GET',
        headers: { 'cf-access-authenticated-user-email': 'fresh@example.com' },
      });

      const { user, bucketName } = await authenticateRequest(req, enterpriseEnv());

      expect(user.email).toBe('fresh@example.com');
      expect(user.role).toBe('user');
      expect(user.subscriptionTier).toBe('unlimited');
      expect(bucketName).toContain('fresh');
      expect(JSON.parse(mockKV._store.get('user:fresh@example.com') as string).addedBy).toBe('enterprise-jit');
    });

    it('AC6 flag-off: with ENTERPRISE_MODE unset, an unknown non-SaaS user is rejected and never provisioned', async () => {
      const req = new Request('https://app.example.com/api/user', {
        method: 'GET',
        headers: { 'cf-access-authenticated-user-email': 'unknown@example.com' },
      });

      await expect(
        authenticateRequest(req, { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_WORKER_NAME: 'codeflare' } as Env),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockKV._store.get('user:unknown@example.com')).toBeUndefined();
    });
  });
});
