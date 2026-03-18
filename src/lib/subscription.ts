/**
 * Subscription tier resolution logic.
 *
 * 8 tiers: blocked, pending, free, trial, standard, advanced, max, unlimited.
 * Replaces the old 4-value AccessTier system. Backward compatible — old
 * accessTier values map directly to matching subscription tiers.
 */
import type { SubscriptionTier, SubscriptionTierConfig, SessionMode } from '../types';
import { getTiersConfigKey } from './kv-keys';

const ACTIVE_TIERS: ReadonlySet<string> = new Set([
  'free', 'trial', 'standard', 'advanced', 'max', 'unlimited',
]);

/**
 * Returns the hardcoded default tier configuration (8 tiers).
 * Used as fallback when tiers:config is not in KV.
 */
export function getDefaultTiers(): SubscriptionTierConfig[] {
  return [
    {
      id: 'blocked',
      displayName: 'Blocked',
      monthlySeconds: 0,
      maxSessions: 0,
      sessionModes: [],
      canLogin: false,
      order: 0,
      isDefault: false,
      priceMonthly: null,
    },
    {
      id: 'pending',
      displayName: 'Pending',
      monthlySeconds: 0,
      maxSessions: 0,
      sessionModes: [],
      canLogin: true,
      order: 1,
      isDefault: false,
      priceMonthly: null,
    },
    {
      id: 'free',
      displayName: 'Free',
      monthlySeconds: 7200,     // 2 hours
      maxSessions: 1,
      sessionModes: ['default'],
      canLogin: true,
      order: 2,
      isDefault: false,
      priceMonthly: null,
    },
    {
      id: 'trial',
      displayName: 'Trial',
      monthlySeconds: 18000,    // 5 hours
      maxSessions: 2,
      sessionModes: ['default'],
      canLogin: true,
      order: 3,
      isDefault: false,
      priceMonthly: null,
    },
    {
      id: 'standard',
      displayName: 'Standard',
      monthlySeconds: 36000,    // 10 hours
      maxSessions: 3,
      sessionModes: ['default'],
      canLogin: true,
      order: 4,
      isDefault: true,
      priceMonthly: 2900,
    },
    {
      id: 'advanced',
      displayName: 'Advanced',
      monthlySeconds: 180000,   // 50 hours
      maxSessions: 5,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 5,
      isDefault: false,
      priceMonthly: 7900,
    },
    {
      id: 'max',
      displayName: 'Max',
      monthlySeconds: 720000,   // 200 hours
      maxSessions: 10,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 6,
      isDefault: false,
      priceMonthly: 19900,
    },
    {
      id: 'unlimited',
      displayName: 'Unlimited',
      monthlySeconds: null,     // no limit
      maxSessions: 10,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 7,
      isDefault: false,
      priceMonthly: null,
    },
  ];
}

/**
 * Read tier configuration from KV, falling back to defaults.
 */
export async function getTierConfig(kv: KVNamespace): Promise<SubscriptionTierConfig[]> {
  const stored = await kv.get<SubscriptionTierConfig[]>(getTiersConfigKey(), 'json');
  return stored ?? getDefaultTiers();
}

/**
 * Resolve a user's tier config from their subscriptionTier value.
 * Returns the matching tier from the config, or the default tier if undefined.
 */
export function getUserTier(
  tierValue: SubscriptionTier | string | undefined,
  tiers: SubscriptionTierConfig[]
): SubscriptionTierConfig {
  // Guard against empty or corrupted tier config — fall back to hardcoded defaults
  const safeTiers = tiers.length > 0 ? tiers : getDefaultTiers();
  if (tierValue !== undefined) {
    const found = safeTiers.find((t) => t.id === tierValue);
    if (found) return found;
  }
  // Fall back to the default tier (isDefault=true)
  const defaultTier = safeTiers.find((t) => t.isDefault);
  return defaultTier ?? safeTiers[safeTiers.length - 1];
}

/**
 * Check if a tier value represents an active (non-blocked, non-pending) user.
 * undefined is treated as active for backward compatibility with pre-subscription users.
 */
export function isActiveTier(tier: SubscriptionTier | string | undefined): boolean {
  if (tier === undefined) return true;
  return ACTIVE_TIERS.has(tier);
}

/**
 * Get the max concurrent sessions allowed for a tier.
 */
export function getMaxSessionsForTier(
  tierValue: SubscriptionTier | string,
  tiers: SubscriptionTierConfig[]
): number {
  const tier = tiers.find((t) => t.id === tierValue);
  return tier?.maxSessions ?? 0;
}

/**
 * Get the allowed session modes for a tier.
 */
export function getAllowedSessionModes(
  tierValue: SubscriptionTier | string,
  tiers: SubscriptionTierConfig[]
): SessionMode[] {
  const tier = tiers.find((t) => t.id === tierValue);
  return tier?.sessionModes ?? [];
}
