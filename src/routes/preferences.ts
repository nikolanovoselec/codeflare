/**
 * User preferences routes
 * Handles GET/PATCH for user preferences (last agent type, last preset)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentTypeSchema, SessionModeSchema, SleepAfterOptions, type Env, type UserPreferences } from '../types';
import { getPreferencesKey } from '../lib/kv-keys';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { ValidationError } from '../lib/error-types';
import { parseJsonBody } from '../lib/request-helpers';
import { createRateLimiter } from '../middleware/rate-limit';
import { isSaasModeActive } from '../lib/onboarding';
import { reconcileAgentConfigs } from '../lib/r2-seed';
import { getR2Config } from '../lib/r2-config';
import { getEffectiveTier, getTierConfig, getEffectiveTierForUser, isEnterpriseMode } from '../lib/subscription';
import { allowedAgents } from '../lib/agent-allowlist';
import { createLogger } from '../lib/logger';

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
  lastPresetId: z.string().max(100).optional(),
  workspaceSyncEnabled: z.boolean().optional(),
  fastStartEnabled: z.boolean().optional(),
  sessionMode: SessionModeSchema.optional(),
  sleepAfter: z.enum(SleepAfterOptions as unknown as [string, ...string[]]).optional(),
  userTimezone: z.string().min(1).max(64).refine(isValidIanaTz, {
    message: 'Invalid IANA timezone',
  }).optional(),
}).strict();

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
  const prefs = await c.env.KV.get<UserPreferences>(key, 'json') || {};
  return c.json(prefs);
});

/**
 * PATCH /api/preferences
 * Update user preferences (merge)
 */
app.patch('/', preferencesPatchRateLimiter, async (c) => {
  const bucketName = c.get('bucketName');

  const body = await parseJsonBody(c, UpdatePreferencesBody);

  // Enterprise deploys restrict the selectable agent set (REQ-ENTERPRISE-003).
  // Outside enterprise mode allowedAgents() returns all 7, so this never rejects.
  if (body.lastAgentType && !allowedAgents(c.env).includes(body.lastAgentType)) {
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
  const existing = await c.env.KV.get<UserPreferences>(key, 'json') || {};
  const updated: UserPreferences = { ...existing, ...body } as UserPreferences;

  await c.env.KV.put(key, JSON.stringify(updated));

  // Auto-reconcile preseed when sessionMode changes so the next session
  // picks up the correct skills/agents/rules without manual Recreate click.
  if (body.sessionMode && body.sessionMode !== existing.sessionMode) {
    try {
      const user = c.get('user');
      const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
      const contextModeEnabled = effectiveTier === 'unlimited' && body.sessionMode === 'advanced';
      const { endpoint } = await getR2Config(c.env);
      const result = await reconcileAgentConfigs(c.env, bucketName, endpoint, body.sessionMode, {
        overwrite: true,
        cleanup: true,
        contextModeEnabled,
      });
      logger.info('Auto-reconciled agent configs on preferences change', {
        bucketName,
        previousMode: existing.sessionMode ?? 'default',
        newMode: body.sessionMode,
        contextModeEnabled,
        written: result.written.length,
        deleted: result.deleted.length,
      });
    } catch (err) {
      logger.warn('Auto-reconcile on preferences change failed (non-fatal)', { error: String(err) });
    }
  }

  return c.json(updated);
});

export default app;
