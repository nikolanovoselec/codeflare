/**
 * Admin tier management API.
 * GET /api/admin/tiers — returns current tier config (or defaults).
 * PUT /api/admin/tiers — writes custom tier config to KV.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { SessionModeSchema } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { getTiersConfigKey } from '../../lib/kv-keys';
import { getDefaultTiers, getTierConfig } from '../../lib/subscription';
import { ValidationError } from '../../lib/error-types';
import { parseJsonBody } from '../../lib/request-helpers';

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
  trialQuotaHours: z.number().min(0),
  maxStorageBytes: z.number().min(0).nullable().optional(),
  description: z.string().max(200),
  advancedPriceMonthly: z.number().min(0).nullable().optional(),
  stripePriceId: z.string().nullable().optional(),
  stripeAdvancedPriceId: z.string().nullable().optional(),
});

const PutTiersBodySchema = z.array(TierConfigSchema).length(8);

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/', requireAdmin, async (c) => {
  const config = await getTierConfig(c.env.KV);
  return c.json({ tiers: config });
});

app.put('/', requireAdmin, async (c) => {
  const data = await parseJsonBody(c, PutTiersBodySchema);

  // Validate tier IDs match defaults (cannot add/remove/rename tiers)
  const defaultIds = getDefaultTiers().map((t) => t.id);
  const inputIds = data.map((t) => t.id);
  if (JSON.stringify(defaultIds) !== JSON.stringify(inputIds)) {
    throw new ValidationError('Tier IDs must match defaults and be in the same order');
  }

  await c.env.KV.put(getTiersConfigKey(), JSON.stringify(data));
  return c.json({ success: true });
});

export default app;
