import { describe, it, expect } from 'vitest';
import { resolveSessionMode, clampSessionModeToTier } from '../../lib/session-mode';
import { getAllowedSessionModes } from '../../lib/subscription';
import type { SubscriptionTierConfig } from '../../types';

describe('resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)', () => {
  it('returns "default" when prefs is null', () => {
    expect(resolveSessionMode(null)).toBe('default');
  });

  it('returns "default" when prefs is empty object', () => {
    expect(resolveSessionMode({})).toBe('default');
  });

  it('returns "advanced" when sessionMode is "advanced"', () => {
    expect(resolveSessionMode({ sessionMode: 'advanced' })).toBe('advanced');
  });

  it('returns "default" when sessionMode is "default"', () => {
    expect(resolveSessionMode({ sessionMode: 'default' })).toBe('default');
  });
});

describe('clampSessionModeToTier / REQ-SEC-015 (AC2 clamp at container start + AC3 canceled-user stale advanced => default)', () => {
  // Realistic tier configs: free-only tiers allow only ['default'], pro tiers
  // include 'advanced'. Mirrors the structure returned by getTierConfig().
  const tiers: SubscriptionTierConfig[] = [
    { id: 'blocked', name: 'Blocked', monthlySeconds: 0, maxSessions: 0, canLogin: false, sessionModes: ['default'] } as unknown as SubscriptionTierConfig,
    { id: 'pending', name: 'Pending', monthlySeconds: 0, maxSessions: 0, canLogin: true, sessionModes: ['default'] } as unknown as SubscriptionTierConfig,
    { id: 'free', name: 'Free', monthlySeconds: 3600, maxSessions: 1, canLogin: true, sessionModes: ['default'] } as unknown as SubscriptionTierConfig,
    { id: 'standard', name: 'Standard', monthlySeconds: 36000, maxSessions: 2, canLogin: true, sessionModes: ['default'] } as unknown as SubscriptionTierConfig,
    { id: 'advanced', name: 'Advanced', monthlySeconds: 72000, maxSessions: 3, canLogin: true, sessionModes: ['default', 'advanced'] } as unknown as SubscriptionTierConfig,
    { id: 'unlimited', name: 'Custom', monthlySeconds: -1, maxSessions: 10, canLogin: true, sessionModes: ['default', 'advanced'] } as unknown as SubscriptionTierConfig,
  ];

  // AC3: a canceled standard user (getEffectiveTier => 'free') with a stale
  // `sessionMode: 'advanced'` preference must be clamped back to 'default'.
  it('AC3: canceled user with stale sessionMode=advanced is clamped to default (free tier only allows [default])', () => {
    expect(clampSessionModeToTier('advanced', 'free', tiers)).toBe('default');
  });

  // AC2: blocked user is also clamped (defense in depth even though REQ-SEC-015
  // AC1 short-circuits the subscribe path).
  it('AC2: blocked tier strips advanced (tier allows only [default])', () => {
    expect(clampSessionModeToTier('advanced', 'blocked', tiers)).toBe('default');
  });

  it('AC2: pending tier strips advanced', () => {
    expect(clampSessionModeToTier('advanced', 'pending', tiers)).toBe('default');
  });

  it('AC2: standard tier strips advanced (Pro requires advanced+ purchase)', () => {
    expect(clampSessionModeToTier('advanced', 'standard', tiers)).toBe('default');
  });

  it('AC2: advanced tier preserves advanced (user paid for Pro mode)', () => {
    expect(clampSessionModeToTier('advanced', 'advanced', tiers)).toBe('advanced');
  });

  it('AC2: unlimited (Custom) tier preserves advanced', () => {
    expect(clampSessionModeToTier('advanced', 'unlimited', tiers)).toBe('advanced');
  });

  it('returns default unchanged regardless of tier (no upgrade path)', () => {
    expect(clampSessionModeToTier('default', 'unlimited', tiers)).toBe('default');
    expect(clampSessionModeToTier('default', 'free', tiers)).toBe('default');
  });

  it('returns default when effective tier is unknown to the config (defensive)', () => {
    expect(clampSessionModeToTier('advanced', 'made-up-tier', tiers)).toBe('default');
  });

  // REQ-SEC-015 AC2 contract guard: lifecycle.ts wraps the clamp in a
  // try {} catch {} that silently swallows any error. If getAllowedSessionModes
  // is ever refactored to THROW on an unknown tier (instead of returning []),
  // the lifecycle catch will absorb it and leave sessionMode = 'advanced'
  // unclamped at container start — a silent AC2 regression. This test locks
  // the contract so the refactor is caught here, not in production.
  it('REQ-SEC-015 AC2 contract: getAllowedSessionModes must NOT throw on an unknown tier (returns [] so clamp downgrades)', () => {
    expect(() => getAllowedSessionModes('made-up-tier', tiers)).not.toThrow();
    expect(getAllowedSessionModes('made-up-tier', tiers)).toEqual([]);
  });
});
