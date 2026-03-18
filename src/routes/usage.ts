/**
 * Usage API route — returns current user's usage and tier information.
 * Reads from timekeeper:{bucketName} KV key.
 */
import { Hono } from 'hono';
import type { Env, UsageRecord } from '../types';
import { authMiddleware, type AuthVariables } from '../middleware/auth';
import { getTimekeeperKey } from '../lib/kv-keys';
import { getTierConfig, getUserTier } from '../lib/subscription';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/', async (c) => {
  const user = c.get('user');
  const bucketName = c.get('bucketName');
  const kvKey = getTimekeeperKey(bucketName);

  const [record, tiers] = await Promise.all([
    c.env.KV.get<UsageRecord>(kvKey, 'json'),
    getTierConfig(c.env.KV),
  ]);

  const tierValue = user.subscriptionTier ?? user.accessTier;
  const tier = getUserTier(tierValue, tiers);

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const currentDate = `${currentMonth}-${String(now.getUTCDate()).padStart(2, '0')}`;

  const monthlySeconds = (record && record.thisMonth.month === currentMonth)
    ? record.thisMonth.seconds : 0;
  const dailySeconds = (record && record.today.date === currentDate)
    ? record.today.seconds : 0;

  return c.json({
    dailySeconds,
    monthlySeconds,
    monthlyQuotaSeconds: tier.monthlySeconds,
    tier: tier.id,
  });
});

export default app;
