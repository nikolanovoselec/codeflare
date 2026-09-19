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
import { getTierConfig, getUserTier, getEffectiveTier, isEnterpriseMode } from '../../lib/subscription';
import { isSaasModeActive } from '../../lib/onboarding';
import { getTimekeeperKey, getUtcMonthString } from '../../lib/kv-keys';
import { D1SessionRepository } from '../../lib/session-repository';

/** Running and in-flight starts both consume a concurrent-session slot. */
export function countsTowardSessionLimit(status: string | undefined): boolean {
  return status === 'starting' || status === 'running' || status === 'unreachable' || status === 'stopping'
    || status === 'initializing' || status === 'r' || status === 'i';
}

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
  env?: Pick<Env, 'ENTERPRISE_MODE'>,
): string {
  // Enterprise deploys: honor the stored preference (or 30m default), never the
  // free-tier 15m lock. No-op when the flag is unset, leaving the path below
  // unchanged.
  if (isEnterpriseMode(env)) return storedSleepAfter || '30m';
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

  const repository = new D1SessionRepository(env.USAGE_DB);
  const d1Session = await repository.getSession(bucketName, sessionId);
  if (!d1Session) throw new NotFoundError('Session', sessionId);
  const sessionData: Session = {
    id: d1Session.sessionId, name: d1Session.name, userId: d1Session.ownerKey,
    createdAt: d1Session.createdAt, lastAccessedAt: d1Session.lastAccessedAt,
    status: d1Session.lifecycleState === 'running' ? 'running' : 'stopped',
    agentType: d1Session.agentType, workspace: d1Session.workspace,
    terminalMode: d1Session.terminalMode, tabConfig: d1Session.tabConfig, clone: d1Session.clone, clones: d1Session.clones,
  };

  // Session limit + quota checks. Bypass when stress testing.
  if (env.STRESS_TEST_MODE !== 'active') {
    // Resolve tier once for both session limit and quota checks (cached 60s)
    const isSaas = isSaasModeActive(env.SAAS_MODE);
    let resolvedTier: ReturnType<typeof getUserTier> | null = null;
    if (isSaas) {
      try {
        const tiers = await getTierConfig(env.KV);
        resolvedTier = getUserTier(getEffectiveTier(subscriptionTier, accessTier, billingStatus, billingPeriodEnd, env), tiers);
      } catch { /* fall back to role-based */ }
    }

    // Session limit: one owner-scoped D1 query; workload-owning transitional
    // states reserve capacity under the existing best-effort semantics.
    const effectiveMaxSessions = resolvedTier?.maxSessions ?? maxSessions;
    const runningCount = (await repository.listSessions(bucketName))
      .filter((session) => session.sessionId !== sessionId && countsTowardSessionLimit(session.lifecycleState)).length;

    if (runningCount >= effectiveMaxSessions) {
      throw new QuotaExceededError(
        `Session limit reached (${runningCount}/${effectiveMaxSessions}). Stop an existing session to start a new one.`
      );
    }

    // Usage quota check (SaaS mode only). Enterprise users are unlimited with no
    // time limit, so the monthly compute quota is never enforced for them — this
    // guard backstops the unlimited-tier resolution above against a misconfigured
    // tier table. No-op when ENTERPRISE_MODE is unset.
    if (isSaas && resolvedTier && resolvedTier.monthlySeconds !== null && !isEnterpriseMode(env)) {
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
