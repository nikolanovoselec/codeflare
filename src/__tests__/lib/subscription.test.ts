import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SubscriptionTierSchema,
  UsageRecordSchema,
  type SubscriptionTierConfig,
} from '../../types';

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
