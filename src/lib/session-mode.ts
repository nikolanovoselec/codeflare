import type { Env, UserPreferences, SessionMode, SubscriptionTierConfig } from '../types';
import { getAllowedSessionModes, isEnterpriseMode } from './subscription';

export function resolveSessionMode(prefs: UserPreferences | null, env?: Pick<Env, 'ENTERPRISE_MODE'>): SessionMode {
  // REQ-ENTERPRISE-001 AC2: enterprise deploys run Pro (advanced) for every
  // user regardless of the stored preference (JIT-provisioned users never
  // store one). No-op when the flag is unset, preserving stored resolution.
  if (isEnterpriseMode(env)) return 'advanced';
  return prefs?.sessionMode ?? 'default';
}

// REQ-ENTERPRISE-001 AC2: surface the enterprise-forced Pro mode on API
// responses without rewriting the stored preference (computed, not stored),
// so advanced-gated dashboard surfaces render for users who never wrote one.
export function withEffectiveSessionMode<T extends UserPreferences>(prefs: T, env: Pick<Env, 'ENTERPRISE_MODE'>): T {
  return isEnterpriseMode(env) ? { ...prefs, sessionMode: 'advanced' } : prefs;
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
  env?: Pick<Env, 'ENTERPRISE_MODE'>,
): SessionMode {
  // Enterprise deploys: advanced mode is always permitted, never clamped.
  // No-op when the flag is unset, leaving the tier-based clamp below unchanged.
  if (isEnterpriseMode(env)) return 'advanced';
  if (sessionMode !== 'advanced') return sessionMode;
  if (!getAllowedSessionModes(effectiveTier, tiers).includes('advanced')) {
    return 'default';
  }
  return sessionMode;
}
