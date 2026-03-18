import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}));

import { resolveOrProvisionUser, resetAuthConfigCache } from '../../lib/access';
import { ForbiddenError } from '../../lib/error-types';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

describe('resolveOrProvisionUser()', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      ...overrides,
    } as Env;
  }

  it('creates user with pending tier when SAAS_MODE=active and user not in KV', async () => {
    const env = makeEnv({ SAAS_MODE: 'active' });

    const result = await resolveOrProvisionUser(
      mockKV as unknown as KVNamespace,
      'newuser@example.com',
      env
    );

    expect(result.role).toBe('user');
    expect(result.accessTier).toBe('pending');
    expect(result.subscriptionTier).toBe('pending');

    // Verify the user was written to KV with both tier fields
    expect(mockKV.put).toHaveBeenCalledWith(
      'user:newuser@example.com',
      expect.stringContaining('"subscriptionTier":"pending"')
    );
  });

  it('returns existing user data without modification when user exists', async () => {
    mockKV._set('user:existing@example.com', {
      addedBy: 'setup',
      addedAt: '2024-01-01',
      role: 'admin',
      accessTier: 'advanced',
    });

    const env = makeEnv({ SAAS_MODE: 'active' });

    const result = await resolveOrProvisionUser(
      mockKV as unknown as KVNamespace,
      'existing@example.com',
      env
    );

    expect(result.role).toBe('admin');
    expect(result.accessTier).toBe('advanced');
    expect(mockKV.put).not.toHaveBeenCalled();
  });

  it('returns blocked existing user as-is (not overwritten)', async () => {
    mockKV._set('user:blocked@example.com', {
      addedBy: 'admin',
      addedAt: '2024-06-01',
      role: 'user',
      accessTier: 'blocked',
    });

    const env = makeEnv({ SAAS_MODE: 'active' });

    const result = await resolveOrProvisionUser(
      mockKV as unknown as KVNamespace,
      'blocked@example.com',
      env
    );

    expect(result.role).toBe('user');
    expect(result.accessTier).toBe('blocked');
    expect(mockKV.put).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError when SAAS_MODE is not active and user not in KV', async () => {
    const env = makeEnv({ SAAS_MODE: undefined });

    await expect(
      resolveOrProvisionUser(mockKV as unknown as KVNamespace, 'nobody@example.com', env)
    ).rejects.toThrow(ForbiddenError);
  });

  it('existing users without accessTier default to advanced', async () => {
    mockKV._set('user:legacy@example.com', {
      addedBy: 'setup',
      addedAt: '2024-01-01',
      role: 'user',
    });

    const env = makeEnv({ SAAS_MODE: 'active' });

    const result = await resolveOrProvisionUser(
      mockKV as unknown as KVNamespace,
      'legacy@example.com',
      env
    );

    expect(result.role).toBe('user');
    expect(result.accessTier).toBe('advanced');
  });

  it('normalizes email before KV lookup', async () => {
    mockKV._set('user:upper@example.com', {
      addedBy: 'setup',
      addedAt: '2024-01-01',
      role: 'user',
      accessTier: 'standard',
    });

    const env = makeEnv({ SAAS_MODE: 'active' });

    const result = await resolveOrProvisionUser(
      mockKV as unknown as KVNamespace,
      '  Upper@Example.Com  ',
      env
    );

    expect(result.role).toBe('user');
    expect(result.accessTier).toBe('standard');
  });
});
