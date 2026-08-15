/**
 * Timekeeper Durable Object - per-user usage accumulation + quota enforcement.
 *
 * One Timekeeper DO per user. Container DOs ping it with monotonic totalSeconds
 * per session. Timekeeper computes deltas, accumulates pendingSeconds, and
 * periodically flushes to KV via alarm. Also serves real-time usage queries
 * in every deployment mode and performs quota checks on SaaS pings.
 *
 * KV key: timekeeper:{bucketName}
 * See UsageRecord in src/types.ts for the KV value shape.
 */
import { z } from 'zod';
import type { Env, UsageRecord } from '../types';
import { BILLING_STATUS } from '../types';
import { getTimekeeperKey, getUtcDateString, getUtcMonthString, getIsoWeekStart } from '../lib/kv-keys';
import {
  getUserTier,
  getTierConfig,
  getEffectiveTier,
  isEnterpriseMode,
  withoutBillingState,
} from '../lib/subscription';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/error-types';
import { endTrialNow } from '../lib/stripe';
import { sendWelcomeEmail } from '../lib/email';
import { parseUserRecord } from '../lib/user-record';
import { isSaasModeActive } from '../lib/onboarding';

const logger = createLogger('timekeeper');

const FLUSH_INTERVAL_MS = 300_000; // 5 minutes
const RETRY_INTERVAL_MS = 30_000;  // 30 seconds on failure

/** Persisted sessionTotals shape: sessionId -> accumulated seconds. */
const SessionTotalsSchema = z.record(z.string(), z.number());

// Module-level cache for user:{email} records (same pattern as getTierConfig).
// Quota decisions may use stale user data for up to 60s after billing changes.
// Matches the accepted staleness window of getTierConfig() (CF-007).
const USER_RECORD_CACHE_TTL_MS = 60_000;
const USER_RECORD_CACHE_MAX = 100;
const userRecordCache = new Map<string, { data: string | null; cachedAt: number }>();

async function getCachedUserRecord(email: string, kv: KVNamespace): Promise<string | null> {
  const cached = userRecordCache.get(email);
  if (cached && Date.now() - cached.cachedAt < USER_RECORD_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await kv.get(`user:${email}`);
  if (userRecordCache.size >= USER_RECORD_CACHE_MAX && !userRecordCache.has(email)) {
    const oldest = userRecordCache.keys().next().value;
    if (oldest) userRecordCache.delete(oldest);
  }
  userRecordCache.set(email, { data, cachedAt: Date.now() });
  return data;
}

export function resetUserRecordCache(): void {
  userRecordCache.clear();
}

interface PingBody {
  bucketName: string;
  sessionId: string;
  totalSeconds: number;
  email: string;
}

const WelcomeBodySchema = z.object({
  userEmail: z.string().email(),
  instanceUrl: z.string().url().optional(),
});

const BillingSyncStartBodySchema = z.object({
  userEmail: z.string().email(),
}).strict();

const BillingSyncPatchSchema = z.union([
  z.object({
    stripeSubscriptionId: z.string().min(1),
    stripeCustomerId: z.string().min(1),
    billingStatus: z.string().min(1),
    cancelAtPeriodEnd: z.boolean(),
    lastSyncedAt: z.string().datetime(),
    subscriptionTier: z.string().min(1).optional(),
    accessTier: z.string().min(1).optional(),
    subscribedMode: z.enum(['default', 'advanced']).optional(),
    stripePriceId: z.string().min(1).optional(),
    billingPeriodEnd: z.string().datetime().optional(),
    trialUsed: z.literal(true).optional(),
  }).strict(),
  z.object({
    cleanupBillingState: z.literal(true),
    billingStatus: z.literal(BILLING_STATUS.CANCELED),
    subscriptionTier: z.literal('free'),
    accessTier: z.literal('free'),
    subscribedMode: z.literal('default'),
  }).strict(),
]);

const BillingSyncApplyBodySchema = z.object({
  userEmail: z.string().email(),
  token: z.number().int().positive().safe(),
  patch: BillingSyncPatchSchema,
}).strict();

async function getWelcomeIdempotencyKey(userEmail: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(userEmail.trim().toLowerCase()),
  ));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `codeflare-welcome-v1-${hex}`;
}

export class Timekeeper {
  private ctx: DurableObjectState;
  private env: Env;
  private pendingSeconds = 0;
  private sessionTotals: Record<string, number> = {};
  private bucketName: string | null = null;
  private email: string | null = null;
  private lastFlushedMonthlyTotal = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;

    // Restore state from DO storage (crash resilience)
    ctx.blockConcurrencyWhile(async () => {
      const [pending, totals, bucket, email, flushedMonthly] = await Promise.all([
        ctx.storage.get<number>('pendingSeconds'),
        ctx.storage.get<string>('sessionTotals'),
        ctx.storage.get<string>('bucketName'),
        ctx.storage.get<string>('email'),
        ctx.storage.get<number>('lastFlushedMonthlyTotal'),
      ]);
      this.pendingSeconds = pending ?? 0;
      this.bucketName = bucket ?? null;
      this.email = email ?? null;
      this.lastFlushedMonthlyTotal = flushedMonthly ?? 0;
      if (totals) {
        try {
          const parsed = SessionTotalsSchema.safeParse(JSON.parse(totals));
          if (parsed.success) this.sessionTotals = parsed.data;
        } catch { /* ignore corrupt data */ }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/welcome') {
      return this.handleWelcome(request);
    }
    if (request.method === 'POST' && path === '/ping') {
      return this.handlePing(request);
    }
    if (request.method === 'POST' && path === '/billing-sync/start') {
      return this.handleBillingSyncStart(request);
    }
    if (request.method === 'POST' && path === '/billing-sync/apply') {
      return this.handleBillingSyncApply(request);
    }
    if (request.method === 'GET' && path === '/usage') {
      return this.handleGetUsage();
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (this.pendingSeconds === 0 || !this.bucketName) return;

    const kvKey = getTimekeeperKey(this.bucketName);
    const secondsToFlush = this.pendingSeconds;

    try {
      const existing = await this.env.KV.get<UsageRecord>(kvKey, 'json');
      const now = new Date();
      const record = this.buildUpdatedRecord(existing, secondsToFlush, now);

      await this.env.KV.put(kvKey, JSON.stringify(record));

      // Only reset after successful write
      this.pendingSeconds -= secondsToFlush;
      if (this.pendingSeconds < 0) this.pendingSeconds = 0;
      this.lastFlushedMonthlyTotal = record.thisMonth.seconds;
      await Promise.all([
        this.ctx.storage.put('pendingSeconds', this.pendingSeconds),
        this.ctx.storage.put('lastFlushedMonthlyTotal', this.lastFlushedMonthlyTotal),
      ]);
    } catch (err) {
      logger.error('Flush failed, will retry', toError(err));
      // Re-arm for retry
      await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
      return;
    }

    // Re-arm if more pending accumulated during flush
    if (this.pendingSeconds > 0) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  private async handleWelcome(request: Request): Promise<Response> {
    const parsed = WelcomeBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response('Invalid welcome body', { status: 400 });

    const userEmail = parsed.data.userEmail.trim().toLowerCase();
    let response = new Response(null, { status: 503 });

    // The per-user Timekeeper is the single ownership boundary. Blocking
    // concurrency around the provider call ensures only one claim can advance,
    // while the provider key makes an ambiguous retry deterministic.
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.email && this.email !== userEmail) {
        response = new Response('Email mismatch', { status: 403 });
        return;
      }
      if (!this.email) {
        this.email = userEmail;
        await this.ctx.storage.put('email', userEmail);
      }
      if (await this.ctx.storage.get<boolean>('welcomeEmailAccepted')) {
        response = new Response(null, { status: 204 });
        return;
      }

      const accepted = await sendWelcomeEmail({
        userEmail,
        instanceUrl: parsed.data.instanceUrl,
        idempotencyKey: await getWelcomeIdempotencyKey(userEmail),
        env: this.env,
      });
      if (!accepted) return;

      await this.ctx.storage.put('welcomeEmailAccepted', true);
      response = new Response(null, { status: 202 });
    });

    return response;
  }

  private async handleBillingSyncStart(request: Request): Promise<Response> {
    const parsed = BillingSyncStartBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response('Invalid billing sync start body', { status: 400 });

    const userEmail = parsed.data.userEmail.trim().toLowerCase();
    let response = new Response(null, { status: 503 });
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.email && this.email.trim().toLowerCase() !== userEmail) {
        response = new Response('Email mismatch', { status: 403 });
        return;
      }
      if (!this.email) {
        this.email = userEmail;
        await this.ctx.storage.put('email', userEmail);
      }
      const current = await this.ctx.storage.get<number>('billingSyncVersion') ?? 0;
      const token = current + 1;
      await this.ctx.storage.put('billingSyncVersion', token);
      response = Response.json({ token });
    });
    return response;
  }

  private async handleBillingSyncApply(request: Request): Promise<Response> {
    const parsed = BillingSyncApplyBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response('Invalid billing sync apply body', { status: 400 });

    const { token, patch } = parsed.data;
    const userEmail = parsed.data.userEmail.trim().toLowerCase();
    let response = new Response(null, { status: 503 });
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.email?.trim().toLowerCase() !== userEmail) {
        response = new Response('Email mismatch', { status: 403 });
        return;
      }
      const current = await this.ctx.storage.get<number>('billingSyncVersion') ?? 0;
      if (token !== current) {
        response = Response.json({ applied: false });
        return;
      }

      const existing = parseUserRecord(await this.env.KV.get(`user:${userEmail}`, 'json'));
      const updated = 'cleanupBillingState' in patch
        ? {
            ...withoutBillingState(existing ?? {}),
            billingStatus: patch.billingStatus,
            subscriptionTier: patch.subscriptionTier,
            accessTier: patch.accessTier,
            subscribedMode: patch.subscribedMode,
          }
        : { ...existing, ...patch };
      await this.env.KV.put(`user:${userEmail}`, JSON.stringify(updated));
      response = Response.json({
        applied: true,
        previous: {
          ...(existing?.subscribedMode ? { subscribedMode: existing.subscribedMode } : {}),
          ...(existing?.subscriptionTier ? { subscriptionTier: existing.subscriptionTier } : {}),
          ...(existing?.accessTier ? { accessTier: existing.accessTier } : {}),
        },
      });
    });
    return response;
  }

  private async handlePing(request: Request): Promise<Response> {
    let body: PingBody;
    try {
      body = await request.json() as PingBody;
      if (!body.bucketName || !body.sessionId || typeof body.totalSeconds !== 'number' || !body.email) {
        return new Response('Invalid ping body', { status: 400 });
      }
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Store identity on first ping; reject mismatches on subsequent pings
    if (!this.bucketName) {
      this.bucketName = body.bucketName;
      await this.ctx.storage.put('bucketName', body.bucketName);
    } else if (body.bucketName !== this.bucketName) {
      return new Response('Bucket name mismatch', { status: 403 });
    }
    if (!this.email) {
      this.email = body.email;
      await this.ctx.storage.put('email', body.email);
    } else if (body.email !== this.email) {
      return new Response('Email mismatch', { status: 403 });
    }

    // Compute delta from per-session monotonic total.
    // Clamp to MAX_DELTA_PER_PING to prevent huge spikes from corrupt sessionTotals.
    const MAX_DELTA_PER_PING = 300; // 5 minutes max per ping cycle
    const previousTotal = this.sessionTotals[body.sessionId] ?? 0;
    let delta: number;
    if (body.totalSeconds < previousTotal) {
      // Session restarted - treat totalSeconds as fresh
      delta = Math.min(body.totalSeconds, MAX_DELTA_PER_PING);
    } else {
      delta = Math.min(body.totalSeconds - previousTotal, MAX_DELTA_PER_PING);
    }
    this.sessionTotals[body.sessionId] = body.totalSeconds;

    // Evict stale session entries to prevent unbounded growth (keep max 30)
    const MAX_SESSION_ENTRIES = 30;
    const keys = Object.keys(this.sessionTotals);
    if (keys.length > MAX_SESSION_ENTRIES) {
      const toRemove = keys.slice(0, keys.length - MAX_SESSION_ENTRIES);
      for (const k of toRemove) delete this.sessionTotals[k];
    }

    this.pendingSeconds += delta;

    // Only persist to DO storage when state actually changed
    if (delta > 0) {
      await Promise.all([
        this.ctx.storage.put('pendingSeconds', this.pendingSeconds),
        this.ctx.storage.put('sessionTotals', JSON.stringify(this.sessionTotals)),
      ]);

      // Arm alarm if none pending
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
      }
    }

    // Usage accumulates in every mode. Read the durable monthly baseline before
    // deciding whether this deployment also owns SaaS quota/trial enforcement.
    let quotaExceeded = false;
    let totalMonthlySeconds = this.lastFlushedMonthlyTotal + this.pendingSeconds;
    let usageReadSucceeded = false;
    try {
      const kvRecord = await this.env.KV.get<UsageRecord>(getTimekeeperKey(this.bucketName), 'json');
      const currentMonth = getUtcMonthString(new Date());
      const kvMonthly = (kvRecord && kvRecord.thisMonth.month === currentMonth)
        ? kvRecord.thisMonth.seconds
        : 0;
      totalMonthlySeconds = kvMonthly + this.pendingSeconds;
      this.lastFlushedMonthlyTotal = kvMonthly;
      usageReadSucceeded = true;
      void this.ctx.storage.put('lastFlushedMonthlyTotal', kvMonthly);
    } catch {
      // Keep the last durable baseline already restored into DO storage.
    }

    if (isSaasModeActive(this.env.SAAS_MODE) && usageReadSucceeded) {
      try {
        const [tiers, userRaw] = await Promise.all([
          getTierConfig(this.env.KV),
          getCachedUserRecord(this.email!, this.env.KV),
        ]);
        const userData = userRaw ? JSON.parse(userRaw) : {};
        const effectiveTierValue = getEffectiveTier(
          userData.subscriptionTier, userData.accessTier, userData.billingStatus,
          userData.billingPeriodEnd, this.env,
        );
        const tier = getUserTier(effectiveTierValue, tiers);

        // Trial enforcement: if subscription is trialing, use trialQuotaHours as the cap.
        // When trial quota is hit, end the Stripe trial early to trigger first charge.
        const isTrialing = userData.billingStatus === BILLING_STATUS.TRIALING;
        const trialQuotaSeconds = (tier.trialQuotaHours ?? 0) * 3600;

        if (isTrialing && trialQuotaSeconds > 0 && totalMonthlySeconds >= trialQuotaSeconds) {
          quotaExceeded = true;
          // End Stripe trial → triggers first charge. Guard against repeated calls
          // (this fires every 60s per container - only call Stripe once).
          const trialEnded = await this.ctx.storage.get<boolean>('trialEnded');
          if (!trialEnded && this.env.STRIPE_SECRET_KEY && userData.stripeSubscriptionId) {
            try {
              await endTrialNow(userData.stripeSubscriptionId, this.env.STRIPE_SECRET_KEY);
              await this.ctx.storage.put('trialEnded', true);
              logger.info('Trial ended early - quota consumed', {
                email: this.email, seconds: totalMonthlySeconds, quota: trialQuotaSeconds,
              });
            } catch (err) {
              logger.error('Failed to end Stripe trial', toError(err));
            }
          }
        } else if (tier.monthlySeconds !== null && totalMonthlySeconds >= tier.monthlySeconds && !isEnterpriseMode(this.env)) {
          // Enterprise users are unlimited with no time limit — the monthly compute
          // quota is never enforced for them (backstops the unlimited-tier resolution
          // above). No-op when ENTERPRISE_MODE is unset.
          quotaExceeded = true;
        }
      } catch {
        // Fail open - don't block on tier or billing-state errors.
      }
    }

    return Response.json({ quotaExceeded, totalMonthlySeconds });
  }

  private async handleGetUsage(): Promise<Response> {
    const kvKey = this.bucketName ? getTimekeeperKey(this.bucketName) : null;
    let kvRecord: UsageRecord | null = null;
    if (kvKey) {
      try {
        kvRecord = await this.env.KV.get<UsageRecord>(kvKey, 'json');
      } catch { /* ignore */ }
    }

    const now = new Date();
    const currentMonth = getUtcMonthString(now);
    const currentDate = getUtcDateString(now);

    const kvMonthly = (kvRecord && kvRecord.thisMonth.month === currentMonth)
      ? kvRecord.thisMonth.seconds : 0;
    const kvDaily = (kvRecord && kvRecord.today.date === currentDate)
      ? kvRecord.today.seconds : 0;

    return Response.json({
      dailySeconds: kvDaily + this.pendingSeconds,
      monthlySeconds: kvMonthly + this.pendingSeconds,
    });
  }

  private buildUpdatedRecord(
    existing: UsageRecord | null,
    seconds: number,
    now: Date
  ): UsageRecord {
    const currentDate = getUtcDateString(now);
    const currentMonth = getUtcMonthString(now);
    const currentYear = String(now.getUTCFullYear());
    const currentWeekStart = getIsoWeekStart(now);

    if (!existing) {
      return {
        today: { date: currentDate, seconds },
        thisWeek: { weekStart: currentWeekStart, seconds },
        thisMonth: { month: currentMonth, seconds },
        thisYear: { year: currentYear, seconds },
        allTime: { seconds },
        lastUpdatedAt: now.toISOString(),
      };
    }

    // Handle rollovers - reset counters when period changes
    const todaySeconds = existing.today.date === currentDate
      ? existing.today.seconds + seconds : seconds;
    const weekSeconds = existing.thisWeek.weekStart === currentWeekStart
      ? existing.thisWeek.seconds + seconds : seconds;
    const monthSeconds = existing.thisMonth.month === currentMonth
      ? existing.thisMonth.seconds + seconds : seconds;
    const yearSeconds = existing.thisYear.year === currentYear
      ? existing.thisYear.seconds + seconds : seconds;

    return {
      today: { date: currentDate, seconds: todaySeconds },
      thisWeek: { weekStart: currentWeekStart, seconds: weekSeconds },
      thisMonth: { month: currentMonth, seconds: monthSeconds },
      thisYear: { year: currentYear, seconds: yearSeconds },
      allTime: { seconds: existing.allTime.seconds + seconds },
      lastUpdatedAt: now.toISOString(),
    };
  }
}
