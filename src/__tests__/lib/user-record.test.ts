/**
 * CF-039: dedicated tests for updateUserRecord (src/lib/user-record.ts).
 *
 * updateUserRecord is the atomic read-merge-write helper every billing /
 * webhook path routes through. Without dedicated coverage, a regression that
 * dropped existing fields on a partial patch (e.g. replacing instead of
 * merging) would silently lose identity data. These tests assert field-level
 * merge and that no required/pre-existing field is dropped on a partial patch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { updateUserRecord, parseUserRecord } from '../../lib/user-record';

let mockKV: ReturnType<typeof createMockKV>;

beforeEach(() => {
  mockKV = createMockKV();
});

function readUser(email: string): Record<string, unknown> {
  return JSON.parse(mockKV._store.get(`user:${email}`)!);
}

describe('updateUserRecord / CF-039', () => {
  it('merges a partial patch into an existing record at field level', async () => {
    mockKV._set('user:merge@example.com', {
      addedBy: 'admin',
      addedAt: '2026-01-01T00:00:00Z',
      role: 'user',
      subscriptionTier: 'standard',
      accessTier: 'standard',
      billingStatus: 'active',
    });

    // Patch touches only billingStatus + subscriptionTier.
    await updateUserRecord(mockKV as unknown as KVNamespace, 'merge@example.com', {
      billingStatus: 'past_due',
      subscriptionTier: 'advanced',
    });

    const user = readUser('merge@example.com');
    // Patched fields take the new value.
    expect(user.billingStatus).toBe('past_due');
    expect(user.subscriptionTier).toBe('advanced');
    // Every untouched field survives the merge.
    expect(user.addedBy).toBe('admin');
    expect(user.addedAt).toBe('2026-01-01T00:00:00Z');
    expect(user.role).toBe('user');
    expect(user.accessTier).toBe('standard');
  });

  it('does not drop pre-existing identity fields on a single-field patch', async () => {
    mockKV._set('user:identity@example.com', {
      addedBy: 'setup',
      addedAt: '2026-02-02T00:00:00Z',
      role: 'admin',
      onboardingComplete: true,
      stripeCustomerId: 'cus_keep',
      stripeSubscriptionId: 'sub_keep',
    });

    await updateUserRecord(mockKV as unknown as KVNamespace, 'identity@example.com', {
      lastSyncedAt: '2026-03-03T00:00:00Z',
    });

    const user = readUser('identity@example.com');
    expect(user.lastSyncedAt).toBe('2026-03-03T00:00:00Z');
    // None of the prior fields were dropped.
    expect(user.addedBy).toBe('setup');
    expect(user.addedAt).toBe('2026-02-02T00:00:00Z');
    expect(user.role).toBe('admin');
    expect(user.onboardingComplete).toBe(true);
    expect(user.stripeCustomerId).toBe('cus_keep');
    expect(user.stripeSubscriptionId).toBe('sub_keep');
  });

  it('preserves passthrough (unknown) fields from older record versions', async () => {
    // .passthrough() keeps fields the schema does not name. A patch must not
    // strip them.
    mockKV._set('user:legacy@example.com', {
      addedBy: 'self',
      addedAt: '2026-01-01T00:00:00Z',
      role: 'user',
      legacyFlag: 'keep-me',
      futureField: 42,
    });

    await updateUserRecord(mockKV as unknown as KVNamespace, 'legacy@example.com', {
      billingStatus: 'active',
    });

    const user = readUser('legacy@example.com');
    expect(user.billingStatus).toBe('active');
    expect(user.legacyFlag).toBe('keep-me');
    expect(user.futureField).toBe(42);
  });

  it('creates a record from the patch when none exists yet', async () => {
    // No prior user: → existing defaults to {} and the patch is the whole record.
    await updateUserRecord(mockKV as unknown as KVNamespace, 'new@example.com', {
      subscriptionTier: 'standard',
      accessTier: 'standard',
      billingStatus: 'active',
    });

    const user = readUser('new@example.com');
    expect(user.subscriptionTier).toBe('standard');
    expect(user.accessTier).toBe('standard');
    expect(user.billingStatus).toBe('active');
  });

  it('round-trips through parseUserRecord without losing patched fields', async () => {
    mockKV._set('user:rt@example.com', { addedBy: 'admin', addedAt: '2026-01-01T00:00:00Z', role: 'user' });

    await updateUserRecord(mockKV as unknown as KVNamespace, 'rt@example.com', {
      subscribedMode: 'advanced',
      stripePriceId: 'price_adv',
    });

    const parsed = parseUserRecord(await mockKV.get('user:rt@example.com', 'json'));
    expect(parsed).not.toBeNull();
    expect(parsed!.subscribedMode).toBe('advanced');
    expect(parsed!.stripePriceId).toBe('price_adv');
    expect(parsed!.addedBy).toBe('admin');
  });
});
