import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  SubscriptionTierSchema,
  UsageRecordSchema,
  type SubscriptionTierConfig,
  type SubscriptionTier,
} from '../../types';
import {
  getDefaultTiers,
  getTierConfig,
  getUserTier,
  isActiveTier,
  getMaxSessionsForTier,
  getAllowedSessionModes,
} from '../../lib/subscription';
import { createMockKV } from '../helpers/mock-kv';

describe('SubscriptionTierSchema', () => {
  const validTiers = ['blocked', 'pending', 'free', 'trial', 'standard', 'advanced', 'max', 'unlimited'];

  it('accepts all 8 valid tier values', () => {
    for (const tier of validTiers) {
      expect(SubscriptionTierSchema.parse(tier)).toBe(tier);
    }
  });

  it('rejects invalid tier values', () => {
    expect(() => SubscriptionTierSchema.parse('invalid')).toThrow();
    expect(() => SubscriptionTierSchema.parse('')).toThrow();
    expect(() => SubscriptionTierSchema.parse(123)).toThrow();
  });

  it('has exactly 8 values', () => {
    // Zod v4 enum has .options array
    const options = SubscriptionTierSchema.options;
    expect(options).toHaveLength(8);
    expect(options).toEqual(validTiers);
  });
});

describe('UsageRecordSchema', () => {
  const validRecord = {
    today: { date: '2026-03-18', seconds: 3600 },
    thisWeek: { weekStart: '2026-03-16', seconds: 10800 },
    thisMonth: { month: '2026-03', seconds: 36000 },
    thisYear: { year: '2026', seconds: 180000 },
    allTime: { seconds: 720000 },
    lastUpdatedAt: '2026-03-18T12:00:00Z',
  };

  it('validates a correct usage record', () => {
    const result = UsageRecordSchema.parse(validRecord);
    expect(result).toEqual(validRecord);
  });

  it('rejects record with missing fields', () => {
    const { today, ...partial } = validRecord;
    expect(() => UsageRecordSchema.parse(partial)).toThrow();
  });

  it('rejects record with negative seconds', () => {
    const bad = {
      ...validRecord,
      today: { date: '2026-03-18', seconds: -1 },
    };
    expect(() => UsageRecordSchema.parse(bad)).toThrow();
  });

  it('accepts zero seconds', () => {
    const zero = {
      ...validRecord,
      today: { date: '2026-03-18', seconds: 0 },
    };
    expect(UsageRecordSchema.parse(zero).today.seconds).toBe(0);
  });
});

describe('SubscriptionTierConfig interface', () => {
  it('type-checks a valid tier config object', () => {
    const config: SubscriptionTierConfig = {
      id: 'standard',
      displayName: 'Standard',
      monthlySeconds: 36000,
      maxSessions: 3,
      sessionModes: ['default'],
      canLogin: true,
      order: 4,
      isDefault: false,
      priceMonthly: 2900,
    };
    expect(config.id).toBe('standard');
    expect(config.monthlySeconds).toBe(36000);
  });

  it('allows null monthlySeconds for unlimited', () => {
    const config: SubscriptionTierConfig = {
      id: 'unlimited',
      displayName: 'Unlimited',
      monthlySeconds: null,
      maxSessions: 10,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 7,
      isDefault: false,
      priceMonthly: null,
    };
    expect(config.monthlySeconds).toBeNull();
  });

  it('allows null priceMonthly for non-purchasable tiers', () => {
    const config: SubscriptionTierConfig = {
      id: 'blocked',
      displayName: 'Blocked',
      monthlySeconds: 0,
      maxSessions: 0,
      sessionModes: [],
      canLogin: false,
      order: 0,
      isDefault: false,
      priceMonthly: null,
    };
    expect(config.priceMonthly).toBeNull();
  });
});

describe('getDefaultTiers', () => {
  it('returns 8 tiers', () => {
    const tiers = getDefaultTiers();
    expect(tiers).toHaveLength(8);
  });

  it('returns tiers with all required fields', () => {
    const tiers = getDefaultTiers();
    for (const tier of tiers) {
      expect(tier).toHaveProperty('id');
      expect(tier).toHaveProperty('displayName');
      expect(tier).toHaveProperty('monthlySeconds');
      expect(tier).toHaveProperty('maxSessions');
      expect(tier).toHaveProperty('sessionModes');
      expect(tier).toHaveProperty('canLogin');
      expect(tier).toHaveProperty('order');
      expect(tier).toHaveProperty('isDefault');
      expect(tier).toHaveProperty('priceMonthly');
    }
  });

  it('returns tiers in correct order', () => {
    const tiers = getDefaultTiers();
    const ids = tiers.map((t) => t.id);
    expect(ids).toEqual(['blocked', 'pending', 'free', 'trial', 'standard', 'advanced', 'max', 'unlimited']);
  });

  it('blocked and pending have 0 seconds and 0 sessions', () => {
    const tiers = getDefaultTiers();
    const blocked = tiers.find((t) => t.id === 'blocked')!;
    const pending = tiers.find((t) => t.id === 'pending')!;
    expect(blocked.monthlySeconds).toBe(0);
    expect(blocked.maxSessions).toBe(0);
    expect(pending.monthlySeconds).toBe(0);
    expect(pending.maxSessions).toBe(0);
  });

  it('blocked canLogin is false, pending canLogin is true', () => {
    const tiers = getDefaultTiers();
    expect(tiers.find((t) => t.id === 'blocked')!.canLogin).toBe(false);
    expect(tiers.find((t) => t.id === 'pending')!.canLogin).toBe(true);
  });

  it('unlimited has null monthlySeconds', () => {
    const tiers = getDefaultTiers();
    expect(tiers.find((t) => t.id === 'unlimited')!.monthlySeconds).toBeNull();
  });

  it('exactly one tier has isDefault=true', () => {
    const tiers = getDefaultTiers();
    const defaults = tiers.filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
  });
});

describe('getUserTier', () => {
  it('returns matching tier for subscriptionTier=standard', () => {
    const tier = getUserTier('standard', getDefaultTiers());
    expect(tier.id).toBe('standard');
  });

  it('returns matching tier for subscriptionTier=unlimited', () => {
    const tier = getUserTier('unlimited', getDefaultTiers());
    expect(tier.id).toBe('unlimited');
  });

  it('returns matching tier for each valid value', () => {
    const tiers = getDefaultTiers();
    for (const t of tiers) {
      const found = getUserTier(t.id as SubscriptionTier, tiers);
      expect(found.id).toBe(t.id);
    }
  });

  it('returns default tier when subscriptionTier is undefined', () => {
    const tiers = getDefaultTiers();
    const tier = getUserTier(undefined, tiers);
    const defaultTier = tiers.find((t) => t.isDefault)!;
    expect(tier.id).toBe(defaultTier.id);
  });

  it('backward compat: maps old accessTier=standard to standard', () => {
    const tier = getUserTier('standard', getDefaultTiers());
    expect(tier.id).toBe('standard');
  });

  it('backward compat: maps old accessTier=advanced to advanced', () => {
    const tier = getUserTier('advanced', getDefaultTiers());
    expect(tier.id).toBe('advanced');
  });

  it('backward compat: maps old accessTier=pending to pending', () => {
    const tier = getUserTier('pending', getDefaultTiers());
    expect(tier.id).toBe('pending');
  });

  it('backward compat: maps old accessTier=blocked to blocked', () => {
    const tier = getUserTier('blocked', getDefaultTiers());
    expect(tier.id).toBe('blocked');
  });
});

describe('isActiveTier', () => {
  it('returns true for free', () => expect(isActiveTier('free')).toBe(true));
  it('returns true for trial', () => expect(isActiveTier('trial')).toBe(true));
  it('returns true for standard', () => expect(isActiveTier('standard')).toBe(true));
  it('returns true for advanced', () => expect(isActiveTier('advanced')).toBe(true));
  it('returns true for max', () => expect(isActiveTier('max')).toBe(true));
  it('returns true for unlimited', () => expect(isActiveTier('unlimited')).toBe(true));
  it('returns false for blocked', () => expect(isActiveTier('blocked')).toBe(false));
  it('returns false for pending', () => expect(isActiveTier('pending')).toBe(false));
  it('returns true for undefined (backward compat)', () => expect(isActiveTier(undefined)).toBe(true));
});

describe('getMaxSessionsForTier', () => {
  const tiers = getDefaultTiers();

  it('returns 0 for blocked', () => {
    expect(getMaxSessionsForTier('blocked', tiers)).toBe(0);
  });

  it('returns 0 for pending', () => {
    expect(getMaxSessionsForTier('pending', tiers)).toBe(0);
  });

  it('returns 1 for free', () => {
    expect(getMaxSessionsForTier('free', tiers)).toBe(1);
  });

  it('returns 2 for trial', () => {
    expect(getMaxSessionsForTier('trial', tiers)).toBe(2);
  });

  it('returns 3 for standard', () => {
    expect(getMaxSessionsForTier('standard', tiers)).toBe(3);
  });

  it('returns 5 for advanced', () => {
    expect(getMaxSessionsForTier('advanced', tiers)).toBe(5);
  });

  it('returns 10 for max', () => {
    expect(getMaxSessionsForTier('max', tiers)).toBe(10);
  });

  it('returns 10 for unlimited', () => {
    expect(getMaxSessionsForTier('unlimited', tiers)).toBe(10);
  });
});

describe('getAllowedSessionModes', () => {
  const tiers = getDefaultTiers();

  it('returns empty for blocked', () => {
    expect(getAllowedSessionModes('blocked', tiers)).toEqual([]);
  });

  it('returns empty for pending', () => {
    expect(getAllowedSessionModes('pending', tiers)).toEqual([]);
  });

  it('returns [default] for free', () => {
    expect(getAllowedSessionModes('free', tiers)).toEqual(['default']);
  });

  it('returns [default] for trial', () => {
    expect(getAllowedSessionModes('trial', tiers)).toEqual(['default']);
  });

  it('returns [default] for standard', () => {
    expect(getAllowedSessionModes('standard', tiers)).toEqual(['default']);
  });

  it('returns [default, advanced] for advanced', () => {
    expect(getAllowedSessionModes('advanced', tiers)).toEqual(['default', 'advanced']);
  });

  it('returns [default, advanced] for max', () => {
    expect(getAllowedSessionModes('max', tiers)).toEqual(['default', 'advanced']);
  });

  it('returns [default, advanced] for unlimited', () => {
    expect(getAllowedSessionModes('unlimited', tiers)).toEqual(['default', 'advanced']);
  });
});

describe('getTierConfig', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  it('returns defaults when no config in KV', async () => {
    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    expect(config).toHaveLength(8);
    expect(config[0].id).toBe('blocked');
  });

  it('returns custom config from KV when present', async () => {
    const custom = getDefaultTiers().map((t) =>
      t.id === 'free' ? { ...t, monthlySeconds: 14400 } : t
    );
    mockKV._set('tiers:config', custom);

    const config = await getTierConfig(mockKV as unknown as KVNamespace);
    const free = config.find((t) => t.id === 'free')!;
    expect(free.monthlySeconds).toBe(14400);
  });
});
