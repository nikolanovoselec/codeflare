/**
 * User preferences routes
 * Handles GET/PATCH for user preferences (last agent type, last preset)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentTypeSchema, SessionModeSchema, type Env, type UserPreferences } from '../types';
import { getPreferencesKey } from '../lib/kv-keys';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { ValidationError } from '../lib/error-types';
import { createRateLimiter } from '../middleware/rate-limit';

const UpdatePreferencesBody = z.object({
  lastAgentType: AgentTypeSchema.optional(),
  lastPresetId: z.string().max(100).optional(),
  workspaceSyncEnabled: z.boolean().optional(),
  fastStartEnabled: z.boolean().optional(),
  sessionMode: SessionModeSchema.optional(),
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

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const parsed = UpdatePreferencesBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const key = getPreferencesKey(bucketName);
  const existing = await c.env.KV.get<UserPreferences>(key, 'json') || {};
  const updated: UserPreferences = { ...existing, ...parsed.data };

  await c.env.KV.put(key, JSON.stringify(updated));

  return c.json(updated);
});

export default app;
