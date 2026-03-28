/**
 * Access tier utilities — backward-compatible bridge from the legacy 4-value
 * `AccessTier` system (`pending | standard | advanced | blocked`) to the
 * current 8-value `SubscriptionTier` system in `subscription.ts`.
 *
 * This module exists so that call sites written against the old AccessTier
 * API continue to compile and behave correctly without migration. New code
 * should import directly from `subscription.ts` instead.
 *
 * - {@link isActiveUser} — thin wrapper around `isActiveTier` from
 *   `subscription.ts`. Accepts both `AccessTier` and `SubscriptionTier`
 *   values so legacy callers don't need type changes.
 *
 * - {@link canUseSessionModeWithConfig} — config-aware session mode check.
 *   Delegates to `getAllowedSessionModes` from `subscription.ts` and requires
 *   a `SubscriptionTierConfig[]` array. Replaces the old hardcoded
 *   `canUseSessionMode` logic that was removed during the tier migration.
 *
 * For config-aware enforcement (respecting admin overrides), always pass tier
 * config from KV via `getTierConfig()` rather than relying on hardcoded
 * defaults.
 */
import type { AccessTier, SessionMode, SubscriptionTier } from '../types';
import { isActiveTier, getAllowedSessionModes as getConfigSessionModes } from './subscription';
import type { SubscriptionTierConfig } from '../types';

export function isActiveUser(tier: AccessTier | SubscriptionTier | string | undefined): boolean {
  return isActiveTier(tier);
}

/**
 * Config-aware session mode check. Pass tier config from KV for
 * authoritative enforcement that respects admin overrides.
 */
export function canUseSessionModeWithConfig(
  tier: AccessTier | SubscriptionTier | string | undefined,
  mode: SessionMode,
  tiers: SubscriptionTierConfig[]
): boolean {
  return getConfigSessionModes(tier ?? 'standard', tiers).includes(mode);
}
