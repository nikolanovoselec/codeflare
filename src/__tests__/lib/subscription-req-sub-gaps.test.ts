/**
 * Coverage gaps for subscription domain — REQ-SUB-001, REQ-SUB-002, REQ-SUB-009,
 * REQ-SUB-010, REQ-SUB-011.
 *
 * Existing subscription.test.ts verifies structure (fields present, tier count,
 * getEffectiveTier logic) but does NOT assert the exact AC-table quota values
 * from REQ-SUB-002, does NOT verify maxStorageBytes, and does NOT cover the
 * 60-second cache TTL boundary (REQ-SUB-010 AC2/AC3) or Stripe-absent behaviour
 * (REQ-SUB-011 AC3).
 *
 * Each test name contains the REQ-ID and AC number so spec-reviewer can grep.
 * Deleting or renaming `getDefaultTiers`, `getTierConfig`, `resetTierConfigCache`,
 * or `getEffectiveTier` will break these tests.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getDefaultTiers,
  getTierConfig,
  resetTierConfigCache,
  getEffectiveTier,
} from '../../lib/subscription';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// REQ-SUB-001: Eight-Tier Subscription System
// ---------------------------------------------------------------------------
describe('REQ-SUB-001: Eight-Tier Subscription System', () => {
  it('REQ-SUB-001 AC1: exactly 8 tier IDs exist with the canonical names', () => {
    const ids = getDefaultTiers().map((t) => t.id);
    expect(ids).toEqual([
      'blocked', 'pending', 'free', 'trial',
      'standard', 'advanced', 'max', 'unlimited',
    ]);
  });

  it('REQ-SUB-001 AC2: every tier defines all 11 required fields', () => {
    const REQUIRED: Array<keyof ReturnType<typeof getDefaultTiers>[0]> = [
      'id', 'displayName', 'monthlySeconds', 'maxSessions', 'sessionModes',
      'canLogin', 'priceMonthly', 'trialQuotaHours', 'maxStorageBytes',
      'description', 'order',
    ];
    for (const tier of getDefaultTiers()) {
      for (const field of REQUIRED) {
        // Field must be present (not undefined) — null is acceptable for nullable fields
        expect(Object.prototype.hasOwnProperty.call(tier, field)).toBe(true);
      }
    }
  });

  it('REQ-SUB-001 AC3: getDefaultTiers returns the complete 8-tier hardcoded fallback', () => {
    const tiers = getDefaultTiers();
    expect(tiers).toHaveLength(8);
    // Calling twice returns independent arrays (no shared mutable state)
    const tiers2 = getDefaultTiers();
    expect(tiers).not.toBe(tiers2);
  });

  it('REQ-SUB-001 AC4: standard is the only isDefault=true tier (stable fallback)', () => {
    const defaults = getDefaultTiers().filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('standard');
  });

  it('REQ-SUB-001 constraint: blocked.canLogin is false', () => {
    const blocked = getDefaultTiers().find((t) => t.id === 'blocked')!;
    expect(blocked.canLogin).toBe(false);
  });

  it('REQ-SUB-001 constraint: pending.canLogin is true', () => {
    const pending = getDefaultTiers().find((t) => t.id === 'pending')!;
    expect(pending.canLogin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REQ-SUB-002: Tier Property Definitions — exact AC-table values
// ---------------------------------------------------------------------------
describe('REQ-SUB-002: Tier Property Definitions', () => {
  const tiers = getDefaultTiers();
  const get = (id: string) => tiers.find((t) => t.id === id)!;

  // monthlySeconds column (Hours/Month × 3600)
  it('REQ-SUB-002 AC: blocked monthlySeconds=0', () => {
    expect(get('blocked').monthlySeconds).toBe(0);
  });
  it('REQ-SUB-002 AC: pending monthlySeconds=0', () => {
    expect(get('pending').monthlySeconds).toBe(0);
  });
  it('REQ-SUB-002 AC: free monthlySeconds=14400 (4 hours)', () => {
    expect(get('free').monthlySeconds).toBe(14400);
  });
  it('REQ-SUB-002 AC: trial monthlySeconds=18000 (5 hours)', () => {
    expect(get('trial').monthlySeconds).toBe(18000);
  });
  it('REQ-SUB-002 AC: standard monthlySeconds=144000 (40 hours)', () => {
    expect(get('standard').monthlySeconds).toBe(144000);
  });
  it('REQ-SUB-002 AC: advanced monthlySeconds=288000 (80 hours)', () => {
    expect(get('advanced').monthlySeconds).toBe(288000);
  });
  it('REQ-SUB-002 AC: max monthlySeconds=576000 (160 hours)', () => {
    expect(get('max').monthlySeconds).toBe(576000);
  });
  it('REQ-SUB-002 AC1: unlimited monthlySeconds=null (unlimited)', () => {
    expect(get('unlimited').monthlySeconds).toBeNull();
  });

  // maxSessions column
  it('REQ-SUB-002 AC: blocked maxSessions=0', () => {
    expect(get('blocked').maxSessions).toBe(0);
  });
  it('REQ-SUB-002 AC: pending maxSessions=0', () => {
    expect(get('pending').maxSessions).toBe(0);
  });
  it('REQ-SUB-002 AC: free maxSessions=1', () => {
    expect(get('free').maxSessions).toBe(1);
  });
  it('REQ-SUB-002 AC: trial maxSessions=2', () => {
    expect(get('trial').maxSessions).toBe(2);
  });
  it('REQ-SUB-002 AC: standard maxSessions=1', () => {
    expect(get('standard').maxSessions).toBe(1);
  });
  it('REQ-SUB-002 AC: advanced maxSessions=2', () => {
    expect(get('advanced').maxSessions).toBe(2);
  });
  it('REQ-SUB-002 AC: max maxSessions=3', () => {
    expect(get('max').maxSessions).toBe(3);
  });
  it('REQ-SUB-002 AC: unlimited maxSessions=5', () => {
    expect(get('unlimited').maxSessions).toBe(5);
  });

  // sessionModes column (AC3: array of 'default' and/or 'advanced')
  it('REQ-SUB-002 AC3: blocked and pending sessionModes=[]', () => {
    expect(get('blocked').sessionModes).toEqual([]);
    expect(get('pending').sessionModes).toEqual([]);
  });
  it('REQ-SUB-002 AC3: free and trial sessionModes=[default] only', () => {
    expect(get('free').sessionModes).toEqual(['default']);
    expect(get('trial').sessionModes).toEqual(['default']);
  });
  it('REQ-SUB-002 AC3: standard/advanced/max/unlimited sessionModes=[default,advanced]', () => {
    for (const id of ['standard', 'advanced', 'max', 'unlimited']) {
      expect(get(id).sessionModes).toEqual(['default', 'advanced']);
    }
  });

  // maxStorageBytes column
  it('REQ-SUB-002 AC: blocked maxStorageBytes=0', () => {
    expect(get('blocked').maxStorageBytes).toBe(0);
  });
  it('REQ-SUB-002 AC: pending maxStorageBytes=0', () => {
    expect(get('pending').maxStorageBytes).toBe(0);
  });
  it('REQ-SUB-002 AC: free maxStorageBytes=262144000 (250 MB)', () => {
    expect(get('free').maxStorageBytes).toBe(262_144_000);
  });
  it('REQ-SUB-002 AC: trial maxStorageBytes=524288000 (500 MB)', () => {
    expect(get('trial').maxStorageBytes).toBe(524_288_000);
  });
  it('REQ-SUB-002 AC: standard maxStorageBytes=524288000 (500 MB)', () => {
    expect(get('standard').maxStorageBytes).toBe(524_288_000);
  });
  it('REQ-SUB-002 AC: advanced maxStorageBytes=1073741824 (1 GB)', () => {
    expect(get('advanced').maxStorageBytes).toBe(1_073_741_824);
  });
  it('REQ-SUB-002 AC: max maxStorageBytes=2147483648 (2 GB)', () => {
    expect(get('max').maxStorageBytes).toBe(2_147_483_648);
  });
  it('REQ-SUB-002 AC2: unlimited maxStorageBytes=null (unlimited)', () => {
    expect(get('unlimited').maxStorageBytes).toBeNull();
  });

  // canLogin column
  it('REQ-SUB-002 AC: canLogin=false only for blocked', () => {
    for (const tier of tiers) {
      const expected = tier.id !== 'blocked';
      expect(tier.canLogin).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// REQ-SUB-009: Admin-Configurable Tiers via Management Panel
// AC3+4: getTierConfig reads KV first; falls back to defaults; merges
// (AC1: PUT tested separately in admin-tiers.test.ts)
// ---------------------------------------------------------------------------
describe('REQ-SUB-009: getTierConfig KV-first with default fallback', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    resetTierConfigCache();
  });

  it('REQ-SUB-009 AC3: reads from KV when tiers:config is present', async () => {
    const custom = getDefaultTiers().map((t) =>
      t.id === 'standard' ? { ...t, monthlySeconds: 99999 } : t
    );
    mockKV._set('tiers:config', custom);

    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    expect(config.find((t) => t.id === 'standard')!.monthlySeconds).toBe(99999);
  });

  it('REQ-SUB-009 AC3: falls back to getDefaultTiers when KV is empty', async () => {
    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    expect(config).toHaveLength(8);
    expect(config[0].id).toBe('blocked');
    expect(config.find((t) => t.id === 'standard')!.monthlySeconds).toBe(144000);
  });

  it('REQ-SUB-009 AC4: admin-stored values take priority via merge (stored overrides default)', async () => {
    // Simulate stored config missing a new field (maxStorageBytes added after deploy)
    const storedWithoutStorage = getDefaultTiers().map(({ maxStorageBytes: _ms, ...rest }) => rest);
    mockKV._set('tiers:config', storedWithoutStorage);

    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    // maxStorageBytes must be backfilled from defaults
    const free = config.find((t) => t.id === 'free')!;
    expect(free.maxStorageBytes).toBe(262_144_000);
  });

  it('REQ-SUB-009 AC4: stored monthlySeconds overrides default', async () => {
    const custom = getDefaultTiers().map((t) =>
      t.id === 'advanced' ? { ...t, monthlySeconds: 500000 } : t
    );
    mockKV._set('tiers:config', custom);

    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    expect(config.find((t) => t.id === 'advanced')!.monthlySeconds).toBe(500000);
    // Other tiers unaffected
    expect(config.find((t) => t.id === 'standard')!.monthlySeconds).toBe(144000);
  });

  it('REQ-SUB-009 constraint: migrates legacy "Team" displayName to "Custom" for unlimited tier', async () => {
    const legacyTiers = getDefaultTiers().map((t) =>
      t.id === 'unlimited' ? { ...t, displayName: 'Team' } : t
    );
    mockKV._set('tiers:config', legacyTiers);

    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    expect(config.find((t) => t.id === 'unlimited')!.displayName).toBe('Custom');
  });
});

// ---------------------------------------------------------------------------
// REQ-SUB-010: Tier Config Cached with 60-Second TTL
// ---------------------------------------------------------------------------
describe('REQ-SUB-010: Tier Config 60-second cache', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    resetTierConfigCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTierConfigCache();
  });

  it('REQ-SUB-010 AC1/AC2: second call within TTL window returns cached config without KV read', async () => {
    // First call populates cache
    await getTierConfig(mockKV as unknown as KVNamespace);
    const getCallsAfterFirst = mockKV.get.mock.calls.length;

    // Second call within 59 seconds should NOT call KV.get again
    vi.advanceTimersByTime(59_000);
    await getTierConfig(mockKV as unknown as KVNamespace);

    expect(mockKV.get.mock.calls.length).toBe(getCallsAfterFirst);
  });

  it('REQ-SUB-010 AC3: call after TTL expiry reads from KV again', async () => {
    // First call
    await getTierConfig(mockKV as unknown as KVNamespace);
    const getCallsAfterFirst = mockKV.get.mock.calls.length;

    // Advance past 60s TTL
    vi.advanceTimersByTime(61_000);
    await getTierConfig(mockKV as unknown as KVNamespace);

    // KV.get must have been called again after TTL expiry
    expect(mockKV.get.mock.calls.length).toBeGreaterThan(getCallsAfterFirst);
  });

  it('REQ-SUB-010 AC4: resetTierConfigCache forces next call to read from KV', async () => {
    await getTierConfig(mockKV as unknown as KVNamespace);
    const callsAfterFirst = mockKV.get.mock.calls.length;

    resetTierConfigCache();
    await getTierConfig(mockKV as unknown as KVNamespace);

    expect(mockKV.get.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// REQ-SUB-011: Graceful Degradation Without Stripe
// AC3: getEffectiveTier does NOT downgrade paid tiers when billing fields absent
// ---------------------------------------------------------------------------
describe('REQ-SUB-011: Graceful Degradation Without Stripe', () => {
  it('REQ-SUB-011 AC3: getEffectiveTier does not downgrade paid tier when billingStatus is null', () => {
    // No Stripe: billingStatus absent/null, billingPeriodEnd absent
    expect(getEffectiveTier('standard', undefined, null)).toBe('standard');
    expect(getEffectiveTier('advanced', undefined, null)).toBe('advanced');
    expect(getEffectiveTier('max', undefined, null)).toBe('max');
  });

  it('REQ-SUB-011 AC3: getEffectiveTier does not downgrade paid tier when billingStatus is undefined', () => {
    expect(getEffectiveTier('standard', undefined, undefined)).toBe('standard');
    expect(getEffectiveTier('advanced', undefined, undefined)).toBe('advanced');
  });

  it('REQ-SUB-011 AC3: getEffectiveTier does not downgrade when both billing fields absent and no period end', () => {
    // Simulates non-SaaS deploy: user set to standard tier, no billing data in KV
    expect(getEffectiveTier('max', undefined, null, null)).toBe('max');
  });

  it('REQ-SUB-011 constraint: non-SaaS user with no tier at all defaults to pending (not advanced)', () => {
    // CF-009: both undefined → pending, not advanced (prevents free compute)
    expect(getEffectiveTier(undefined, undefined, null)).toBe('pending');
  });

  it('REQ-SUB-011 AC2: billing fields returned by getEffectiveTier are tier strings, not billing objects', () => {
    // Return type is string — no billing state leaks through
    const result = getEffectiveTier('standard', undefined, null);
    expect(typeof result).toBe('string');
  });
});
