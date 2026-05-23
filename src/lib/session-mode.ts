import type { UserPreferences, SessionMode, SubscriptionTierConfig } from '../types';
import { getAllowedSessionModes } from './subscription';

export function resolveSessionMode(prefs: UserPreferences | null): SessionMode {
  return prefs?.sessionMode ?? 'default';
}

// REQ-SEC-015 AC2/AC3: clamp a stored sessionMode against the billing-resolved
// effective tier. A canceled/blocked user with a stale `sessionMode: 'advanced'`
// preference is downgraded to 'default' because the free/blocked tier only
// allows ['default']. Anything that isn't 'advanced' (already 'default' or
// missing) is returned unchanged.
export function clampSessionModeToTier(
  sessionMode: SessionMode,
  effectiveTier: string,
  tiers: SubscriptionTierConfig[],
): SessionMode {
  if (sessionMode !== 'advanced') return sessionMode;
  if (!getAllowedSessionModes(effectiveTier, tiers).includes('advanced')) {
    return 'default';
  }
  return sessionMode;
}
