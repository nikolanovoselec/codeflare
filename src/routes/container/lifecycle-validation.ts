/**
 * Container lifecycle - validation helpers.
 *
 * Pre-start checks extracted from lifecycle.ts (CF-024b): effective idle-timeout
 * resolution and session existence / concurrent-session / usage-quota
 * validation. lifecycle.ts re-exports these so existing importers (and the
 * spec-anchored unit tests) keep resolving them from './lifecycle'.
 */
import type { Env, Session } from '../../types';
import { NotFoundError, QuotaExceededError } from '../../lib/error-types';
import { getTierConfig, getUserTier, getEffectiveTier } from '../../lib/subscription';
import { isSaasModeActive } from '../../lib/onboarding';
import { getSessionKey, listAllKvKeys, getSessionPrefix, getTimekeeperKey, getUtcMonthString, type SessionListMetadata } from '../../lib/kv-keys';

/**
 * Resolve the effective per-session idle-timeout value from the user's tier
 * and stored preference.
 *
 * REQ-SESSION-014 AC2: the "free" tier is locked to 15m regardless of any
 * stored preference; all other tiers honor the stored sleepAfter (or default
 * to 30m when no preference was ever set).
 *
 * Exported so the spec-anchored unit test in
 * src/__tests__/routes/session-sleep-timeout.test.ts can call it directly
 * without spinning up the full /api/container/start integration harness.
 */
export function resolveEffectiveSleepAfter(
  effectiveTier: string,
  storedSleepAfter: string | undefined,
): string {
  if (effectiveTier === 'free') return '15m';
  return storedSleepAfter || '30m';
}

/**
 * Validate that the session exists and check concurrent session limits.
 * Returns the session data if valid.
 *
 * @throws NotFoundError if session doesn't exist
 * @throws QuotaExceededError if session limit exceeded
 */
export async function validateSessionAndCheckLimits(params: {
  env: Env;
  bucketName: string;
  sessionId: string;
  maxSessions: number;
  subscriptionTier?: string;
  accessTier?: string;
  billingStatus?: string;
  billingPeriodEnd?: string;
}): Promise<Session> {
  const { env, bucketName, sessionId, maxSessions, subscriptionTier, accessTier, billingStatus, billingPeriodEnd } = params;

  const sessionKey = getSessionKey(bucketName, sessionId);
  const sessionData = await env.KV.get<Session>(sessionKey, 'json');
  if (!sessionData) {
    throw new NotFoundError('Session', sessionId);
  }

  // Session limit + quota checks. Bypass when stress testing.
  if (env.STRESS_TEST_MODE !== 'active') {
    // Resolve tier once for both session limit and quota checks (cached 60s)
    const isSaas = isSaasModeActive(env.SAAS_MODE);
    let resolvedTier: ReturnType<typeof getUserTier> | null = null;
    if (isSaas) {
      try {
        const tiers = await getTierConfig(env.KV);
        resolvedTier = getUserTier(getEffectiveTier(subscriptionTier, accessTier, billingStatus, billingPeriodEnd), tiers);
      } catch { /* fall back to role-based */ }
    }

    // Session limit: tier-based in SaaS mode, role-based otherwise.
    // Uses list metadata to count running sessions (zero individual KV.get calls).
    const effectiveMaxSessions = resolvedTier?.maxSessions ?? maxSessions;
    const sessionKeys = await listAllKvKeys(env.KV, getSessionPrefix(bucketName));
    // Count running sessions from authoritative KV status (the container
    // writes 'stopped' on exit, so no read-side staleness reconciliation).
    let runningCount = 0;
    for (const key of sessionKeys) {
      const rawMeta = key.metadata as SessionListMetadata | null;
      if (rawMeta && rawMeta.s) {
        // Fast path: read status from list metadata
        const keySessionId = key.name.split(':').pop();
        if (rawMeta.s === 'r' && keySessionId !== sessionId) runningCount++;
      } else {
        // Fallback: pre-migration key without metadata
        const s = await env.KV.get<Session>(key.name, 'json');
        if (!s || s.id === sessionId) continue;
        if (s.status === 'running') runningCount++;
      }
    }

    if (runningCount >= effectiveMaxSessions) {
      throw new QuotaExceededError(
        `Session limit reached (${runningCount}/${effectiveMaxSessions}). Stop an existing session to start a new one.`
      );
    }

    // Usage quota check (SaaS mode only)
    if (isSaas && resolvedTier && resolvedTier.monthlySeconds !== null) {
      try {
        const usageRecord = await env.KV.get(getTimekeeperKey(bucketName), 'json') as { thisMonth?: { month: string; seconds: number } } | null;
        const now = new Date();
        const currentMonth = getUtcMonthString(now);
        const monthlySeconds = (usageRecord?.thisMonth?.month === currentMonth)
          ? usageRecord.thisMonth.seconds : 0;

        if (monthlySeconds >= resolvedTier.monthlySeconds) {
          const usedHours = Math.round(monthlySeconds / 3600);
          const quotaHours = Math.round(resolvedTier.monthlySeconds / 3600);
          throw new QuotaExceededError(
            `Monthly compute quota reached (${usedHours}h / ${quotaHours}h). Upgrade your plan.`
          );
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) throw err;
      }
    }
  }

  return sessionData;
}
