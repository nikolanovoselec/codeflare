/**
 * REQ-ENTERPRISE-001: ENTERPRISE_MODE flag + tier/mode override.
 *
 * When ENTERPRISE_MODE === 'active', every user resolves to the unlimited tier
 * and advanced session mode, and the free-tier idle-timeout lock is lifted.
 * When the flag is unset (or any other value) every helper behaves byte-identically
 * to today — the non-disruption gate.
 *
 * AC1. isEnterpriseMode() is true only for the exact string 'active'.
 * AC2. getEffectiveTier() returns 'unlimited' under enterprise, before any
 *      billing/downgrade logic; unchanged otherwise.
 * AC3. clampSessionModeToTier() returns 'advanced' under enterprise; unchanged
 *      otherwise.
 * AC4. resolveEffectiveSleepAfter() honors the stored preference under enterprise
 *      (no 15m free lock); stays free-locked otherwise.
 */
import { describe, it, expect } from 'vitest';
import { isEnterpriseMode, getEffectiveTier } from '../../lib/subscription';
import { clampSessionModeToTier } from '../../lib/session-mode';
import { resolveEffectiveSleepAfter } from '../../routes/container/lifecycle-validation';
import type { Env, SubscriptionTierConfig } from '../../types';

const enterpriseEnv = { ENTERPRISE_MODE: 'active' } as Pick<Env, 'ENTERPRISE_MODE'>;
const plainEnv = { ENTERPRISE_MODE: undefined } as Pick<Env, 'ENTERPRISE_MODE'>;

// Realistic tier configs mirroring getTierConfig() — free allows only ['default'].
const tiers: SubscriptionTierConfig[] = [
  { id: 'free', sessionModes: ['default'] } as unknown as SubscriptionTierConfig,
  { id: 'standard', sessionModes: ['default'] } as unknown as SubscriptionTierConfig,
  { id: 'advanced', sessionModes: ['default', 'advanced'] } as unknown as SubscriptionTierConfig,
  { id: 'unlimited', sessionModes: ['default', 'advanced'] } as unknown as SubscriptionTierConfig,
];

describe('REQ-ENTERPRISE-001 AC1: isEnterpriseMode', () => {
  it("is true only for ENTERPRISE_MODE === 'active'", () => {
    expect(isEnterpriseMode({ ENTERPRISE_MODE: 'active' })).toBe(true);
  });

  it('is false when ENTERPRISE_MODE is undefined', () => {
    expect(isEnterpriseMode({ ENTERPRISE_MODE: undefined })).toBe(false);
  });

  it('is false when env is undefined', () => {
    expect(isEnterpriseMode(undefined)).toBe(false);
  });

  it("is false for non-'active' values ('true', 'enabled', '')", () => {
    expect(isEnterpriseMode({ ENTERPRISE_MODE: 'true' })).toBe(false);
    expect(isEnterpriseMode({ ENTERPRISE_MODE: 'enabled' })).toBe(false);
    expect(isEnterpriseMode({ ENTERPRISE_MODE: '' })).toBe(false);
  });
});

describe('REQ-ENTERPRISE-001 AC2: getEffectiveTier enterprise override', () => {
  it("returns 'unlimited' for a pending user when enterprise", () => {
    expect(getEffectiveTier('pending', 'pending', undefined, undefined, enterpriseEnv)).toBe('unlimited');
  });

  it("returns 'unlimited' for a blocked user when enterprise", () => {
    expect(getEffectiveTier('blocked', 'blocked', undefined, undefined, enterpriseEnv)).toBe('unlimited');
  });

  it("returns 'unlimited' even when billing is canceled (override precedes billing logic)", () => {
    // A canceled paid user normally downgrades to 'free'; enterprise wins first.
    expect(getEffectiveTier('standard', undefined, 'canceled', undefined, enterpriseEnv)).toBe('unlimited');
  });

  it("returns 'unlimited' when both tiers are undefined under enterprise", () => {
    expect(getEffectiveTier(undefined, undefined, undefined, undefined, enterpriseEnv)).toBe('unlimited');
  });

  // ── flag-off regression: behavior byte-identical to today ──
  it('flag-off: undefined tiers still resolve to "pending" (CF-009 unchanged)', () => {
    expect(getEffectiveTier(undefined, undefined, undefined, undefined, plainEnv)).toBe('pending');
  });

  it('flag-off: canceled paid user still downgrades to "free"', () => {
    expect(getEffectiveTier('standard', undefined, 'canceled', undefined, plainEnv)).toBe('free');
  });

  it('flag-off: standard active user stays "standard"', () => {
    expect(getEffectiveTier('standard', undefined, 'active', undefined, plainEnv)).toBe('standard');
  });

  it('flag-off (no env arg at all): existing 4-arg call is unchanged', () => {
    // Every existing call site omits the env arg — must be identical to today.
    expect(getEffectiveTier('standard', undefined, 'canceled', undefined)).toBe('free');
    expect(getEffectiveTier(undefined, undefined, undefined, undefined)).toBe('pending');
    expect(getEffectiveTier('advanced', undefined, 'active', undefined)).toBe('advanced');
  });
});

describe('REQ-ENTERPRISE-001 AC3: clampSessionModeToTier enterprise override', () => {
  it("returns 'advanced' for a free-tier user when enterprise (no clamp)", () => {
    expect(clampSessionModeToTier('advanced', 'free', tiers, enterpriseEnv)).toBe('advanced');
  });

  it("returns 'advanced' even for a blocked tier when enterprise", () => {
    expect(clampSessionModeToTier('advanced', 'blocked', tiers, enterpriseEnv)).toBe('advanced');
  });

  // ── flag-off regression ──
  it('flag-off: free-tier advanced is still clamped to default', () => {
    expect(clampSessionModeToTier('advanced', 'free', tiers, plainEnv)).toBe('default');
  });

  it('flag-off (no env arg): existing 3-arg call is unchanged', () => {
    expect(clampSessionModeToTier('advanced', 'free', tiers)).toBe('default');
    expect(clampSessionModeToTier('advanced', 'advanced', tiers)).toBe('advanced');
    expect(clampSessionModeToTier('default', 'unlimited', tiers)).toBe('default');
  });
});

describe('REQ-ENTERPRISE-001 AC4: resolveEffectiveSleepAfter enterprise override', () => {
  it('honors the stored preference for a free-tier user when enterprise', () => {
    expect(resolveEffectiveSleepAfter('free', '2h', enterpriseEnv)).toBe('2h');
  });

  it("defaults to '30m' when no preference and enterprise (no 15m lock)", () => {
    expect(resolveEffectiveSleepAfter('free', undefined, enterpriseEnv)).toBe('30m');
  });

  // ── flag-off regression: free tier stays locked to 15m ──
  it('flag-off: free tier is locked to 15m regardless of stored preference', () => {
    expect(resolveEffectiveSleepAfter('free', '2h', plainEnv)).toBe('15m');
  });

  it('flag-off (no env arg): existing 2-arg call is unchanged', () => {
    expect(resolveEffectiveSleepAfter('free', '2h')).toBe('15m');
    expect(resolveEffectiveSleepAfter('free', undefined)).toBe('15m');
    expect(resolveEffectiveSleepAfter('standard', '1h')).toBe('1h');
    expect(resolveEffectiveSleepAfter('standard', undefined)).toBe('30m');
  });
});
