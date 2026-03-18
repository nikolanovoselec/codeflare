/**
 * Access tier utilities — backward compatible bridge.
 *
 * isActiveUser now recognizes all 8 subscription tiers (plus the old 4 AccessTier values).
 * canUseSessionMode delegates to the subscription module for new tiers.
 */
import type { AccessTier, SessionMode, SubscriptionTier } from '../types';
import { isActiveTier } from './subscription';

export function isActiveUser(tier: AccessTier | SubscriptionTier | string | undefined): boolean {
  return isActiveTier(tier);
}

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
