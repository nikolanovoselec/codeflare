/**
 * Usage API route — returns current user's usage and tier information.
 * Queries Timekeeper DO for real-time data when available, falls back to KV.
 */
import { Hono } from 'hono';
import type { Env, UsageRecord } from '../types';
import { authMiddleware, type AuthVariables } from '../middleware/auth';
import { getTimekeeperKey, getUtcMonthString, getUtcDateString } from '../lib/kv-keys';
import { getTierConfig, getUserTier, getEffectiveTier } from '../lib/subscription';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/', async (c) => {
  const user = c.get('user');
  const bucketName = c.get('bucketName');

  const tiers = await getTierConfig(c.env.KV);
  // CF-004: Use billing-aware tier resolution so canceled users see free-tier quotas
  const tierValue = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
  const tier = getUserTier(tierValue, tiers);

  // Try real-time data from Timekeeper DO (includes pending unflushed seconds)
  if (c.env.TIMEKEEPER) {
    try {
      const tkId = c.env.TIMEKEEPER.idFromName(bucketName);
      const tk = c.env.TIMEKEEPER.get(tkId);
      const res = await tk.fetch(new Request('http://timekeeper/usage'));
      if (res.ok) {
        const live = await res.json() as { dailySeconds: number; monthlySeconds: number };
        return c.json({
          dailySeconds: live.dailySeconds,
          monthlySeconds: live.monthlySeconds,
          monthlyQuotaSeconds: tier.monthlySeconds,
          tier: tier.displayName || tier.id,
          mode: user.subscribedMode ?? 'default',
        });
      }
    } catch {
      // Fall through to KV
    }
  }

  // Fallback: read from KV (stale by up to 5 minutes)
  const record = await c.env.KV.get<UsageRecord>(getTimekeeperKey(bucketName), 'json');
  const now = new Date();
  const currentMonth = getUtcMonthString(now);
  const currentDate = getUtcDateString(now);

  const monthlySeconds = (record && record.thisMonth.month === currentMonth)
    ? record.thisMonth.seconds : 0;
  const dailySeconds = (record && record.today.date === currentDate)
    ? record.today.seconds : 0;

  return c.json({
    dailySeconds,
    monthlySeconds,
    monthlyQuotaSeconds: tier.monthlySeconds,
    tier: tier.displayName || tier.id,
    mode: user.subscribedMode ?? 'default',
  });
});

export default app;
