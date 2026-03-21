/**
 * Access tier utilities — backward compatible bridge.
 *
 * isActiveUser delegates to isActiveTier from subscription.ts.
 * allowedSessionModes and canUseSessionMode use hardcoded defaults that match
 * the default tier config. For config-aware enforcement (respecting admin
 * overrides), use getAllowedSessionModes() from subscription.ts with tier config.
 */
import type { AccessTier, SessionMode, SubscriptionTier } from '../types';
import { isActiveTier, getAllowedSessionModes as getConfigSessionModes } from './subscription';
import type { SubscriptionTierConfig } from '../types';

export function isActiveUser(tier: AccessTier | SubscriptionTier | string | undefined): boolean {
  return isActiveTier(tier);
}

/**
 * Hardcoded session mode defaults (conservative subset of getDefaultTiers() config).
 * Note: standard tier returns ['default'] here but ['default', 'advanced'] in config.
 * Use getAllowedSessionModesWithConfig() for config-aware enforcement.
 */
export function allowedSessionModes(tier: AccessTier | SubscriptionTier | string | undefined): SessionMode[] {
  if (tier === 'advanced' || tier === 'max' || tier === 'unlimited' || tier === undefined) {
    return ['default', 'advanced'];
  }
  if (tier === 'standard' || tier === 'free' || tier === 'trial') return ['default'];
  return [];
}

export function canUseSessionMode(tier: AccessTier | SubscriptionTier | string | undefined, mode: SessionMode): boolean {
  return allowedSessionModes(tier).includes(mode);
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
