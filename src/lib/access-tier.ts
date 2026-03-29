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
 */
import type { AccessTier, SubscriptionTier } from '../types';
import { isActiveTier } from './subscription';

export function isActiveUser(tier: AccessTier | SubscriptionTier | string | undefined): boolean {
  return isActiveTier(tier);
}
