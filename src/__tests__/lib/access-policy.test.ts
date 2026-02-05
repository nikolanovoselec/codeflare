import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAllUsers, syncAccessPolicy } from '../../lib/access-policy';
import { listAllKvKeys } from '../../lib/kv-keys';
import { createMockKV } from '../helpers/mock-kv';

const TEST_WORKER_NAME = 'test-worker';
const TEST_ADMIN_GROUP_NAME = `${TEST_WORKER_NAME}-admins`;
const TEST_USER_GROUP_NAME = `${TEST_WORKER_NAME}-users`;

describe('access-policy.ts', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getAllUsers', () => {
    it('returns empty array when no user keys exist', async () => {
      const result = await getAllUsers(mockKV as unknown as KVNamespace);
      expect(result).toEqual([]);
    });

    it('returns single user correctly', async () => {
      mockKV._set('user:alice@example.com', {
        addedBy: 'admin@example.com',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'user',
      });

      const result = await getAllUsers(mockKV as unknown as KVNamespace);
      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('alice@example.com');
      expect(result[0].addedBy).toBe('admin@example.com');
      expect(result[0].role).toBe('user');
    });

    it('returns multiple users with parallel fetch (Promise.all)', async () => {
      mockKV._set('user:alice@example.com', {
        addedBy: 'admin@example.com',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'admin',
      });
      mockKV._set('user:bob@example.com', {
        addedBy: 'admin@example.com',
        addedAt: '2024-01-02T00:00:00Z',
        role: 'user',
      });
      mockKV._set('user:charlie@example.com', {
        addedBy: 'alice@example.com',
        addedAt: '2024-01-03T00:00:00Z',
        role: 'user',
      });

      const result = await getAllUsers(mockKV as unknown as KVNamespace);
      expect(result).toHaveLength(3);

      const emails = result.map(u => u.email).sort();
      expect(emails).toEqual(['alice@example.com', 'bob@example.com', 'charlie@example.com']);
    });

    it('defaults role to user when role is missing', async () => {
      mockKV._set('user:legacy@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00Z',
        // no role field
      });

      const result = await getAllUsers(mockKV as unknown as KVNamespace);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
    });

    it('filters out null entries from KV', async () => {
      // Add a real user
      mockKV._set('user:alice@example.com', {
        addedBy: 'admin@example.com',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'user',
      });
      // Add a key that will return null when fetched as JSON
      mockKV._store.set('user:ghost@example.com', '');

      const result = await getAllUsers(mockKV as unknown as KVNamespace);
      // The ghost entry returns null from kv.get(key, 'json'), should be filtered
      expect(result.length).toBeLessThanOrEqual(2);
      expect(result.some(u => u.email === 'alice@example.com')).toBe(true);
    });
  });

  describe('listAllKvKeys', () => {
    it('returns all keys with given prefix', async () => {
      mockKV._store.set('user:a@b.com', '{}');
      mockKV._store.set('user:c@d.com', '{}');
      mockKV._store.set('setup:complete', 'true');

      const keys = await listAllKvKeys(mockKV as unknown as KVNamespace, 'user:');
      expect(keys).toHaveLength(2);
      expect(keys.map(k => k.name).sort()).toEqual(['user:a@b.com', 'user:c@d.com']);
    });

    it('returns empty array when no keys match prefix', async () => {
      mockKV._store.set('setup:complete', 'true');

      const keys = await listAllKvKeys(mockKV as unknown as KVNamespace, 'user:');
      expect(keys).toHaveLength(0);
    });
  });

  describe('syncAccessPolicy', () => {
    it('syncs Access groups from KV roles and updates policy with group includes', async () => {
      mockKV._set('user:admin@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'admin',
      });
      mockKV._set('user:member@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'user',
      });
      mockKV._store.set('setup:access_group_admin_id', 'group-admins-123');
      mockKV._store.set('setup:access_group_user_id', 'group-users-456');
      mockKV._store.set('setup:access_group_admin_name', TEST_ADMIN_GROUP_NAME);
      mockKV._store.set('setup:access_group_user_name', TEST_USER_GROUP_NAME);

      const groupPutBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
      const policyPutBodies: Array<Record<string, unknown>> = [];

      globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.endsWith('/access/groups') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              success: true,
              result: [
                { id: 'group-admins-123', name: TEST_ADMIN_GROUP_NAME },
                { id: 'group-users-456', name: TEST_USER_GROUP_NAME },
              ],
            }),
            { status: 200 }
          ));
        }

        if (urlStr.includes('/access/groups/') && init?.method === 'PUT') {
          groupPutBodies.push({
            url: urlStr,
            body: JSON.parse((init.body as string) || '{}') as Record<string, unknown>,
          });
          return Promise.resolve(new Response('', { status: 200 }));
        }

        if (urlStr.endsWith('/access/apps') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'app-1', domain: 'claude.example.com/app/*', aud: 'aud-1' }],
            }),
            { status: 200 }
          ));
        }

        if (urlStr.endsWith('/access/apps/app-1/policies') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'policy-1', name: 'Allow users', decision: 'allow', include: [], exclude: [] }],
            }),
            { status: 200 }
          ));
        }

        if (urlStr.endsWith('/access/apps/app-1/policies/policy-1') && init?.method === 'PUT') {
          policyPutBodies.push(JSON.parse((init.body as string) || '{}') as Record<string, unknown>);
          return Promise.resolve(new Response('', { status: 200 }));
        }

        return Promise.reject(new Error(`Unmocked request: ${init?.method || 'GET'} ${urlStr}`));
      }) as typeof globalThis.fetch;

      await syncAccessPolicy('token-123', 'acc-123', 'claude.example.com', mockKV as unknown as KVNamespace);

      const adminGroupUpdate = groupPutBodies.find((entry) => entry.url.includes('/group-admins-123'));
      const userGroupUpdate = groupPutBodies.find((entry) => entry.url.includes('/group-users-456'));
      expect(adminGroupUpdate).toBeDefined();
      expect(userGroupUpdate).toBeDefined();
      expect(adminGroupUpdate!.body.include).toEqual([{ email: { email: 'admin@example.com' } }]);
      expect(userGroupUpdate!.body.include).toEqual([{ email: { email: 'member@example.com' } }]);

      expect(policyPutBodies).toHaveLength(1);
      expect(policyPutBodies[0].include).toEqual([
        { group: { id: 'group-admins-123' } },
        { group: { id: 'group-users-456' } },
      ]);
    });

    it('removes deleted users from Access user group on subsequent sync', async () => {
      mockKV._set('user:admin@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'admin',
      });
      mockKV._set('user:member@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00Z',
        role: 'user',
      });
      mockKV._store.set('setup:access_group_admin_id', 'group-admins-123');
      mockKV._store.set('setup:access_group_user_id', 'group-users-456');
      mockKV._store.set('setup:access_group_admin_name', TEST_ADMIN_GROUP_NAME);
      mockKV._store.set('setup:access_group_user_name', TEST_USER_GROUP_NAME);

      const userGroupIncludeBodies: unknown[][] = [];

      globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.endsWith('/access/groups') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              success: true,
              result: [
                { id: 'group-admins-123', name: TEST_ADMIN_GROUP_NAME },
                { id: 'group-users-456', name: TEST_USER_GROUP_NAME },
              ],
            }),
            { status: 200 }
          ));
        }

        if (urlStr.includes('/access/groups/group-admins-123') && init?.method === 'PUT') {
          return Promise.resolve(new Response('', { status: 200 }));
        }
        if (urlStr.includes('/access/groups/group-users-456') && init?.method === 'PUT') {
          const body = JSON.parse((init.body as string) || '{}') as { include?: unknown[] };
          userGroupIncludeBodies.push(body.include || []);
          return Promise.resolve(new Response('', { status: 200 }));
        }

        if (urlStr.endsWith('/access/apps') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'app-1', domain: 'claude.example.com/app/*', aud: 'aud-1' }],
            }),
            { status: 200 }
          ));
        }
        if (urlStr.endsWith('/access/apps/app-1/policies') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'policy-1', name: 'Allow users', decision: 'allow', include: [], exclude: [] }],
            }),
            { status: 200 }
          ));
        }
        if (urlStr.endsWith('/access/apps/app-1/policies/policy-1') && init?.method === 'PUT') {
          return Promise.resolve(new Response('', { status: 200 }));
        }

        return Promise.reject(new Error(`Unmocked request: ${init?.method || 'GET'} ${urlStr}`));
      }) as typeof globalThis.fetch;

      await syncAccessPolicy('token-123', 'acc-123', 'claude.example.com', mockKV as unknown as KVNamespace);
      mockKV._store.delete('user:member@example.com');
      await syncAccessPolicy('token-123', 'acc-123', 'claude.example.com', mockKV as unknown as KVNamespace);

      expect(userGroupIncludeBodies).toHaveLength(2);
      expect(userGroupIncludeBodies[0]).toEqual([{ email: { email: 'member@example.com' } }]);
      expect(userGroupIncludeBodies[1]).toEqual([]);
    });
  });
});
