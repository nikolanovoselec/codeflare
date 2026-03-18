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

// Module-level cache for tier config (avoids KV reads on every request/ping)
const TIER_CONFIG_CACHE_TTL_MS = 60_000; // 1 minute
let cachedTierConfig: SubscriptionTierConfig[] | null = null;
let tierConfigCachedAt = 0;

/**
 * Read tier configuration from KV with 1-minute cache, falling back to defaults.
 */
export async function getTierConfig(kv: KVNamespace): Promise<SubscriptionTierConfig[]> {
  if (cachedTierConfig && Date.now() - tierConfigCachedAt < TIER_CONFIG_CACHE_TTL_MS) {
    return cachedTierConfig;
  }
  const stored = await kv.get<SubscriptionTierConfig[]>(getTiersConfigKey(), 'json');
  cachedTierConfig = stored ?? getDefaultTiers();
  tierConfigCachedAt = Date.now();
  return cachedTierConfig;
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
 * This is a fast-path check using hardcoded defaults — use canUserLogin() with tier config
 * for authoritative enforcement that respects admin-configured canLogin overrides.
 */
export function isActiveTier(tier: SubscriptionTier | string | undefined): boolean {
  if (tier === undefined) return true;
  return ACTIVE_TIERS.has(tier);
}

/**
 * Config-aware login check that respects the canLogin field from tier config.
 * Falls back to isActiveTier() if no matching tier found in config.
 */
export function canUserLogin(
  tierValue: SubscriptionTier | string | undefined,
  tiers: SubscriptionTierConfig[]
): boolean {
  if (tierValue === undefined) return true;
  const safeTiers = tiers.length > 0 ? tiers : getDefaultTiers();
  const tier = safeTiers.find((t) => t.id === tierValue);
  if (!tier) return isActiveTier(tierValue);
  return tier.canLogin;
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
