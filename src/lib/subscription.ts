/**
 * Subscription tier resolution logic.
 *
 * 8 tiers: blocked, pending, free, trial, standard, advanced, max, unlimited.
 * Replaces the old 4-value AccessTier system. Backward compatible — old
 * accessTier values map directly to matching subscription tiers.
 */
import type { SubscriptionTier, SubscriptionTierConfig, SessionMode } from '../types';
import { BILLING_STATUS } from '../types';
import { getTiersConfigKey } from './kv-keys';

const ACTIVE_TIERS: ReadonlySet<string> = new Set([
  'free', 'trial', 'standard', 'advanced', 'max', 'unlimited',
]);

/** Tier IDs available for self-service subscription (shared across routes). */
export const SUBSCRIBABLE_TIER_IDS: ReadonlySet<string> = new Set([
  'free', 'standard', 'advanced', 'max', 'unlimited',
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
      advancedPriceMonthly: null,
      trialQuotaHours: 0,
      description: '',
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
      advancedPriceMonthly: null,
      trialQuotaHours: 0,
      description: '',
    },
    {
      id: 'free',
      displayName: 'Free',
      monthlySeconds: 14400,     // 4 hours
      maxSessions: 1,
      sessionModes: ['default'],
      canLogin: true,
      order: 2,
      isDefault: false,
      priceMonthly: 0,
      advancedPriceMonthly: null,
      trialQuotaHours: 0,
      description: 'Zero commitment, zero setup',
    },
    {
      id: 'trial',
      displayName: 'Trial',
      monthlySeconds: 18000,     // 5 hours
      maxSessions: 2,
      sessionModes: ['default'],
      canLogin: true,
      order: 3,
      isDefault: false,
      priceMonthly: null,
      advancedPriceMonthly: null,
      trialQuotaHours: 0,
      description: '',
    },
    {
      id: 'standard',
      displayName: 'Starter',
      monthlySeconds: 144000,    // 40 hours
      maxSessions: 1,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 4,
      isDefault: true,
      priceMonthly: null,         // CF-027: prices come from Stripe via admin-configured stripePriceId
      advancedPriceMonthly: null,
      trialQuotaHours: 40,
      description: 'Ship side projects on your phone',
    },
    {
      id: 'advanced',
      displayName: 'Advanced',
      monthlySeconds: 288000,    // 80 hours
      maxSessions: 2,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 5,
      isDefault: false,
      priceMonthly: null,
      advancedPriceMonthly: null,
      trialQuotaHours: 80,
      description: 'For when weekends aren\'t enough',
    },
    {
      id: 'max',
      displayName: 'Max',
      monthlySeconds: 576000,    // 160 hours
      maxSessions: 3,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 6,
      isDefault: false,
      priceMonthly: null,
      advancedPriceMonthly: null,
      trialQuotaHours: 160,
      description: 'For daily users pushing AI hard',
    },
    {
      id: 'unlimited',
      displayName: 'Custom',
      monthlySeconds: null,      // no limit
      maxSessions: 5,
      sessionModes: ['default', 'advanced'],
      canLogin: true,
      order: 7,
      isDefault: false,
      priceMonthly: null,
      advancedPriceMonthly: null,
      trialQuotaHours: 0,
      description: 'Tailored to your needs.',
    },
  ];
}

// Module-level cache for tier config (avoids KV reads on every request/ping).
// CF-007: Billing enforcement decisions may use stale quotas for up to 60 seconds
// after an admin change. This is an accepted trade-off for KV read performance.
// The same TTL pattern is used in access.ts, cors-cache.ts, jwt.ts, kv-crypto.ts.
const TIER_CONFIG_CACHE_TTL_MS = 60_000; // 1 minute
let cachedTierConfig: SubscriptionTierConfig[] | null = null;
let tierConfigCachedAt = 0;

/** Reset the tier config cache. Call in tests or when config is known to have changed. */
export function resetTierConfigCache(): void {
  cachedTierConfig = null;
  tierConfigCachedAt = 0;
}

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

/** Paid tiers subject to billing enforcement. Enterprise (unlimited) and free tiers are exempt. */
const PAID_TIERS: ReadonlySet<string> = new Set(['standard', 'advanced', 'max']);

/**
 * Resolve the effective tier considering billing status and period expiry.
 *
 * Downgrade rules:
 * - billingStatus 'canceled' → free (immediate, no grace period)
 * - billingStatus 'past_due' + future billingPeriodEnd → keep paid tier (grace period)
 * - billingStatus 'past_due' + expired/missing billingPeriodEnd → free
 * - billingPeriodEnd expired and billingStatus 'active' → free (catches missed webhooks)
 *
 * CF-009: When both tiers are undefined, default to 'pending'
 * instead of 'advanced' to prevent free compute for corrupted/missing KV records.
 *
 * CF-005: billingActive parameter removed — the fallback is always 'pending'
 * regardless of billing state. Non-SaaS deployments that need 'advanced' as the
 * default should set accessTier explicitly on user records.
 */
export function getEffectiveTier(
  subscriptionTier: string | undefined,
  accessTier: string | undefined,
  billingStatus: string | null | undefined,
  billingPeriodEnd?: string | null,
): string {
  const raw = subscriptionTier ?? accessTier ?? 'pending';
  if (!PAID_TIERS.has(raw)) return raw;

  // Explicit cancellation — always downgrade, no grace period
  if (billingStatus === BILLING_STATUS.CANCELED) {
    return 'free';
  }

  // past_due: grace period while billingPeriodEnd is in the future
  if (billingStatus === BILLING_STATUS.PAST_DUE) {
    if (billingPeriodEnd) {
      const expiry = new Date(billingPeriodEnd).getTime();
      if (!isNaN(expiry) && Date.now() <= expiry) return raw; // grace period
    }
    return 'free';
  }

  // CF-015: Catch missed subscription.deleted webhooks via period expiry
  if (billingPeriodEnd && billingStatus === BILLING_STATUS.ACTIVE) {
    const expiry = new Date(billingPeriodEnd).getTime();
    if (!isNaN(expiry) && Date.now() > expiry) {
      return 'free';
    }
  }

  return raw;
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

/** Paid tier IDs that occupy a capacity slot. Free tier excluded — low resource usage. */
const SLOT_TIERS = new Set(['standard', 'advanced', 'max', 'unlimited']);

/**
 * Count users occupying a paid capacity slot: admins + active paid subscribers.
 * Free, pending, and blocked users don't count. Canceled users count until billingPeriodEnd expires.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function countPaidSlots(allUsers: any[]): number {
  const now = Date.now();
  return allUsers.filter(u => {
    const role = u.role as string | undefined;
    const tier = u.subscriptionTier as string | undefined;
    const status = u.billingStatus as string | undefined;
    const periodEnd = u.billingPeriodEnd as string | undefined;
    // Admins always count
    if (role === 'admin') return true;
    // Must have a paid tier
    if (!tier || !SLOT_TIERS.has(tier)) return false;
    // Active or trialing → counts
    if (!status || status === BILLING_STATUS.ACTIVE || status === BILLING_STATUS.TRIALING) return true;
    // Canceled → counts only if billingPeriodEnd is in the future
    if (status === BILLING_STATUS.CANCELED || status === BILLING_STATUS.PAST_DUE) {
      if (periodEnd) return new Date(periodEnd).getTime() > now;
      return false;
    }
    return false;
  }).length;
}
