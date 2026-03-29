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
import { parseJsonBody, firstZodError } from '../lib/request-helpers';
import { createRateLimiter } from '../middleware/rate-limit';
import { isSaasModeActive } from '../lib/onboarding';

const UpdatePreferencesBody = z.object({
  lastAgentType: AgentTypeSchema.optional(),
  lastPresetId: z.string().max(100).optional(),
  workspaceSyncEnabled: z.boolean().optional(),
  fastStartEnabled: z.boolean().optional(),
  sessionMode: SessionModeSchema.optional(),
  sleepAfter: z.enum(SleepAfterOptions as unknown as [string, ...string[]]).optional(),
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

  const raw = await parseJsonBody(c);

  const parsed = UpdatePreferencesBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }

  if (parsed.data.sessionMode && isSaasModeActive(c.env.SAAS_MODE)) {
    const user = c.get('user');
    // subscribedMode is the source of truth from Stripe — if the user paid for
    // Pro (subscribedMode: 'advanced'), allow it regardless of tier config.
    const subscribedToPro = user.subscribedMode === 'advanced';
    if (parsed.data.sessionMode === 'advanced' && !subscribedToPro && user.role !== 'admin') {
      throw new ValidationError(`Session mode '${parsed.data.sessionMode}' not available for your subscription`);
    }
  }

  const key = getPreferencesKey(bucketName);
  const existing = await c.env.KV.get<UserPreferences>(key, 'json') || {};
  const updated: UserPreferences = { ...existing, ...parsed.data } as UserPreferences;

  await c.env.KV.put(key, JSON.stringify(updated));

  return c.json(updated);
});

export default app;
