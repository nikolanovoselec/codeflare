/**
 * Admin tier management API.
 * GET /api/admin/tiers — returns current tier config (or defaults).
 * PUT /api/admin/tiers — writes custom tier config to KV.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, SubscriptionTierConfig } from '../../types';
import { SessionModeSchema } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { getTiersConfigKey } from '../../lib/kv-keys';
import { getDefaultTiers, getTierConfig } from '../../lib/subscription';
import { ValidationError } from '../../lib/error-types';

const TierConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  monthlySeconds: z.number().min(0).nullable(),
  maxSessions: z.number().min(0),
  sessionModes: z.array(SessionModeSchema),
  canLogin: z.boolean(),
  order: z.number().min(0),
  isDefault: z.boolean(),
  priceMonthly: z.number().min(0).nullable(),
});

const PutTiersBodySchema = z.array(TierConfigSchema).length(8);

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/', requireAdmin, async (c) => {
  const config = await getTierConfig(c.env.KV);
  return c.json({ tiers: config });
});

app.put('/', requireAdmin, async (c) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ValidationError('Invalid JSON body'); }

  const parsed = PutTiersBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  // Validate tier IDs match defaults (cannot add/remove/rename tiers)
  const defaultIds = getDefaultTiers().map((t) => t.id);
  const inputIds = parsed.data.map((t) => t.id);
  if (JSON.stringify(defaultIds) !== JSON.stringify(inputIds)) {
    throw new ValidationError('Tier IDs must match defaults and be in the same order');
  }

  await c.env.KV.put(getTiersConfigKey(), JSON.stringify(parsed.data));
  return c.json({ success: true });
});

export default app;
