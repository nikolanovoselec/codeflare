/**
 * User preferences routes
 * Handles GET/PATCH for current user preferences.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentTypeSchema, SessionModeSchema, SleepAfterOptions, type Env, type UserPreferences } from '../types';
import { getPreferencesKey, getSessionPrefix, listAllKvKeys, type SessionListMetadata } from '../lib/kv-keys';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { ValidationError, BucketMigratingError, ManagedEnvironmentUpdatePendingError } from '../lib/error-types';
import { parseJsonBody } from '../lib/request-helpers';
import { createRateLimiter } from '../middleware/rate-limit';
import { isSaasModeActive } from '../lib/onboarding';
import { reconcileAgentConfigs, reseedContextModePlugin, type PriorManagedReleaseSelection } from '../lib/r2-seed';
import { isR2SseDisabledForBucket, isBucketMigrating } from '../lib/r2-migration';
import { getR2Config } from '../lib/r2-config';
import { getEffectiveTier, getTierConfig, getEffectiveTierForUser, isEnterpriseMode } from '../lib/subscription';
import { withEffectiveSessionMode } from '../lib/session-mode';
import { allowedAgents } from '../lib/agent-allowlist';
import { createLogger } from '../lib/logger';
import { countsTowardSessionLimit } from './container/lifecycle-validation';
import { getActiveManagedRelease, getActiveVerifiedManagedRelease, getCachedManagedReleaseByDigest } from '../lib/managed-release-active';
import { PRESEED_CONTENT_HASH } from '../lib/agent-seed.generated';

const logger = createLogger('preferences');

/**
 * REQ-MEM-010 AC4: validate an IANA timezone string for the
 * `PATCH /api/preferences` `userTimezone` field. (REQ-MEM-001 AC4
 * covers how the capture agent uses `$USER_TIMEZONE` at capture time;
 * REQ-MEM-010 AC4 is the
 * preference-endpoint contract that gets the value there.) Browsers
 * throw RangeError on unsupported zones; valid zones round-trip
 * cleanly. This avoids shipping a 400+ entry static zone list while
 * still catching typos and non-existent zones like "Mars/Olympus".
 */
function isValidIanaTz(tz: string): boolean {
  if (!tz) return false;
  try {
    // V8's Intl is case-insensitive (`europe/zurich` resolves), but the
    // container's downstream `TZ="$USER_TIMEZONE" date` on musl is case-
    // sensitive and silently falls back to UTC for non-canonical casing.
    // Round-trip via resolvedOptions().timeZone to require the canonical
    // IANA form so the validator and the consumer agree (code-reviewer M3).
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    return resolved === tz;
  } catch {
    return false;
  }
}

const UpdatePreferencesBody = z.object({
  lastAgentType: AgentTypeSchema.optional(),
  workspaceSyncEnabled: z.boolean().optional(),
  fastStartEnabled: z.boolean().optional(),
  sessionMode: SessionModeSchema.optional(),
  sleepAfter: z.enum(SleepAfterOptions as unknown as [string, ...string[]]).optional(),
  userTimezone: z.string().min(1).max(64).refine(isValidIanaTz, {
    message: 'Invalid IANA timezone',
  }).optional(),
}).strict();

function withoutLegacyPresetId(preferences: UserPreferences & { lastPresetId?: unknown }): UserPreferences {
  return Object.fromEntries(
    Object.entries(preferences).filter(([key]) => key !== 'lastPresetId'),
  ) as UserPreferences;
}

const preferencesPatchRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: 'preferences-patch',
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

/**
 * GET /api/preferences
 * Get user preferences
 */
app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const key = getPreferencesKey(bucketName);
  const stored = await c.env.KV.get<UserPreferences & { lastPresetId?: unknown }>(key, 'json') || {};
  // REQ-ENTERPRISE-001 AC2: surface the enterprise-forced Pro mode to the client
  // (computed, not stored) so advanced-gated dashboard surfaces render for JIT
  // users who never wrote a preference. Byte-identical when the flag is unset.
  return c.json(withEffectiveSessionMode(withoutLegacyPresetId(stored), c.env));
});

/**
 * PATCH /api/preferences
 * Update user preferences (merge)
 */
app.patch('/', preferencesPatchRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');

  const parsedBody = await parseJsonBody(c, UpdatePreferencesBody);

  // REQ-ENTERPRISE-001 AC2: enterprise never honors a client-supplied session-mode
  // downgrade — the write path is coerced to Pro so a stale client cannot regress
  // the stored value or trigger a default-mode reconcile of a live bucket.
  const body = parsedBody.sessionMode && isEnterpriseMode(c.env)
    ? { ...parsedBody, sessionMode: 'advanced' as const }
    : parsedBody;

  // Enterprise deploys restrict the selectable agent set to the wizard-chosen
  // active agents (REQ-ENTERPRISE-003). Outside enterprise mode allowedAgents()
  // returns all 7, so this never rejects.
  if (body.lastAgentType && !(await allowedAgents(c.env)).includes(body.lastAgentType)) {
    throw new ValidationError(`Agent type '${body.lastAgentType}' is not available in this deployment`);
  }

  // Enterprise deploys grant advanced mode to every user, so the SaaS
  // advanced-mode availability gate is bypassed. No-op when the flag is unset.
  if (body.sessionMode && isSaasModeActive(c.env.SAAS_MODE) && !isEnterpriseMode(c.env)) {
    const user = c.get('user');
    // Gate on the billing-derived effective tier's allowed modes, so a user
    // whose subscription lapsed (canceled/past_due/expired) loses advanced mode
    // even if a stale subscribedMode still reads 'advanced'.
    const tiers = await getTierConfig(c.env.KV);
    const entitlements = getEffectiveTierForUser(user, tiers, c.env);
    if (body.sessionMode === 'advanced' && !entitlements.allowedModes.includes('advanced') && user.role !== 'admin') {
      throw new ValidationError(`Session mode '${body.sessionMode}' not available for your subscription`);
    }
  }

  const key = getPreferencesKey(bucketName);
  const stored = await c.env.KV.get<UserPreferences & { lastPresetId?: unknown }>(key, 'json') || {};
  const existing = withoutLegacyPresetId(stored);

  // REQ-ENTERPRISE-020: a sessionMode change triggers an R2 agent-config reconcile below;
  // refuse it while the bucket's encryption regime is migrating so configs are never written
  // in the wrong (pre-flip) regime. Non-R2 preference changes are unaffected.
  if (body.sessionMode && body.sessionMode !== existing.sessionMode) {
    // The no-hot-mutation gate applies only while curation is active or while a prior
    // curated state must converge back to baked content. An unconfigured deployment
    // keeps byte-identical baked behavior (REQ-STOR-022) and never sees this error.
    if (existing.managedEnvironmentApplied || await getActiveManagedRelease(c.env)) {
      const sessionKeys = await listAllKvKeys(c.env.KV, getSessionPrefix(bucketName));
      for (const sessionKey of sessionKeys) {
        const metadata = sessionKey.metadata as SessionListMetadata | null;
        if (metadata?.s && countsTowardSessionLimit(metadata.s)) throw new ManagedEnvironmentUpdatePendingError();
        if (!metadata?.s) {
          const session = await c.env.KV.get<{ status?: string }>(sessionKey.name, 'json');
          if (countsTowardSessionLimit(session?.status)) throw new ManagedEnvironmentUpdatePendingError();
        }
      }
    }
    if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
  }

  const updated: UserPreferences = { ...existing, ...body } as UserPreferences;

  await c.env.KV.put(key, JSON.stringify(updated));

  // Auto-reconcile preseed when sessionMode changes so the next session
  // picks up the correct skills/agents/rules without manual Recreate click.
  if (body.sessionMode && body.sessionMode !== existing.sessionMode) {
    let managedInvolved = Boolean(existing.managedEnvironmentApplied);
    try {
      const user = c.get('user');
      const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
      const contextModeEnabled = effectiveTier === 'unlimited' && body.sessionMode === 'advanced';
      const { endpoint } = await getR2Config(c.env);
      // REQ-ENTERPRISE-020: reconcile in the bucket's current regime so a Governed Mode
      // (plain) bucket gets plaintext configs, not unreadable SSE-C ones.
      const r2SseDisabled = await isR2SseDisabledForBucket(c.env, bucketName);
      const activeManagedRelease = await getActiveVerifiedManagedRelease(c.env);
      if (activeManagedRelease) managedInvolved = true;
      let priorManagedRelease: PriorManagedReleaseSelection | undefined;
      if (existing.managedEnvironmentApplied) {
        const priorRelease = activeManagedRelease?.digest === existing.managedEnvironmentApplied.digest
          ? { compressed: activeManagedRelease.compressed, release: activeManagedRelease.release }
          : await getCachedManagedReleaseByDigest(c.env, existing.managedEnvironmentApplied.digest);
        if (!priorRelease) throw new Error('Previously applied managed release is missing from the verified deployment cache');
        priorManagedRelease = {
          digest: existing.managedEnvironmentApplied.digest,
          mode: existing.managedEnvironmentApplied.mode,
          ...priorRelease,
        };
      }
      const managedOptions = activeManagedRelease
        ? { managedRelease: { digest: activeManagedRelease.digest, compressed: activeManagedRelease.compressed, release: activeManagedRelease.release }, ...(priorManagedRelease && { priorManagedRelease }) }
        : priorManagedRelease
          ? { managedRelease: null, priorManagedRelease }
          : {};
      const result = await reconcileAgentConfigs(c.env, bucketName, endpoint, body.sessionMode, {
        overwrite: true,
        cleanup: true,
        contextModeEnabled,
        r2SseDisabled,
        ...managedOptions,
      });
      if ((activeManagedRelease || priorManagedRelease) && result.warnings.length > 0) {
        throw new Error(`Managed reconciliation did not complete: ${result.warnings[0]}`);
      }
      if (activeManagedRelease) {
        await reseedContextModePlugin(c.env, bucketName, endpoint, contextModeEnabled, r2SseDisabled);
      }

      const latest = await c.env.KV.get<UserPreferences>(key, 'json') ?? updated;
      const withoutApplied = Object.fromEntries(
        Object.entries(latest).filter(([preferenceKey]) => preferenceKey !== 'managedEnvironmentApplied'),
      ) as UserPreferences;
      const applied: UserPreferences = activeManagedRelease
        ? {
            ...latest,
            managedEnvironmentApplied: {
              digest: activeManagedRelease.digest,
              sequence: activeManagedRelease.release.sequence,
              mode: body.sessionMode,
              appliedAt: new Date().toISOString(),
            },
          }
        : { ...withoutApplied, lastPreseedHash: PRESEED_CONTENT_HASH };
      await c.env.KV.put(key, JSON.stringify(applied));

      logger.info('Auto-reconciled agent configs on preferences change', {
        bucketName,
        previousMode: existing.sessionMode ?? 'default',
        newMode: body.sessionMode,
        contextModeEnabled,
        managedReleaseDigest: activeManagedRelease?.digest,
        written: result.written.length,
        deleted: result.deleted.length,
      });
    } catch (err) {
      // Managed reconciliation is not best-effort: reporting success here would hide a
      // partially reconciled bucket and a skipped applied stamp, and the next container
      // start would then reject with MANAGED_ENVIRONMENT_UPDATE_PENDING and no cause.
      if (managedInvolved) throw err;
      logger.warn('Auto-reconcile on preferences change failed (non-fatal)', { error: String(err) });
    }
  }

  // REQ-ENTERPRISE-001 AC2: the response reports the enterprise-forced Pro mode.
  // Non-sessionMode fields keep the raw client value; sessionMode itself is
  // coerced to Pro at the top of this handler under enterprise.
  const current = await c.env.KV.get<UserPreferences>(key, 'json') ?? updated;
  return c.json(withEffectiveSessionMode(current, c.env));
});

export default app;
