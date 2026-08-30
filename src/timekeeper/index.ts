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
import {
  applyPositiveDelta,
  createAccountingState,
  hashSessionId,
  markerKeysFor,
  outboxKey,
  type AccountingStateV2,
} from './accounting';

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
  private accountingState!: AccountingStateV2;
  private pendingSeconds = 0;
  private sessionTotals: Record<string, number> = {};
  private bucketName: string | null = null;
  private email: string | null = null;
  private lastFlushedMonthlyTotal = 0;
  private markerCache = new Set<string>();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;

    // Restore or atomically migrate the one accounting state value.
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const transact = async (callback: (storage: DurableObjectStorage) => Promise<void>) => {
        if (typeof ctx.storage.transaction === 'function') await ctx.storage.transaction(callback);
        else await callback(ctx.storage);
      };
      await transact(async (storage) => {
        const existing = await storage.get<AccountingStateV2>('accountingState:v2');
        if (existing?.version === 2) {
          this.accountingState = existing;
          return;
        }
        const [pending, totals, flushedMonthly] = await Promise.all([
          storage.get<number>('pendingSeconds'),
          storage.get<string>('sessionTotals'),
          storage.get<number>('lastFlushedMonthlyTotal'),
        ]);
        let parsedTotals: Record<string, number> = {};
        if (totals) {
          try {
            const parsed = SessionTotalsSchema.safeParse(JSON.parse(totals));
            if (parsed.success) parsedTotals = parsed.data;
          } catch { /* corrupt legacy totals become empty */ }
        }
        this.accountingState = await createAccountingState(new Date(), {
          pendingSeconds: pending ?? 0,
          sessionTotals: parsedTotals,
          lastFlushedMonthlyTotal: flushedMonthly ?? 0,
        });
        await storage.put('accountingState:v2', this.accountingState);
        if (typeof storage.delete === 'function') {
          await storage.delete(['pendingSeconds', 'sessionTotals', 'lastFlushedMonthlyTotal']);
        }
      });
      [this.bucketName, this.email] = await Promise.all([
        ctx.storage.get<string>('bucketName').then((value) => value ?? null),
        ctx.storage.get<string>('email').then((value) => value ?? null),
      ]);
      this.pendingSeconds = this.accountingState.pendingSeconds;
      this.sessionTotals = this.accountingState.sessionTotals;
      this.lastFlushedMonthlyTotal = this.accountingState.lastFlushedMonthlyTotal;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
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
    await this.ready;
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
      this.accountingState = {
        ...this.accountingState,
        pendingSeconds: this.pendingSeconds,
        lastFlushedMonthlyTotal: this.lastFlushedMonthlyTotal,
      };
      await this.ctx.storage.put('accountingState:v2', this.accountingState);
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
    const sessionHash = await hashSessionId(body.sessionId);
    const previousTotal = this.sessionTotals[sessionHash] ?? 0;
    const delta = body.totalSeconds < previousTotal
      ? Math.min(body.totalSeconds, MAX_DELTA_PER_PING)
      : Math.min(body.totalSeconds - previousTotal, MAX_DELTA_PER_PING);

    if (delta > 0) {
      const now = new Date();
      const candidateMarkers = markerKeysFor(now, sessionHash);
      const persist = async (storage: DurableObjectStorage) => {
        const unknownMarkers = candidateMarkers.filter((key) => !this.markerCache.has(key));
        if (unknownMarkers.length > 0) {
          const stored = await storage.get<boolean>(unknownMarkers);
          for (const key of unknownMarkers) {
            if (stored instanceof Map && stored.has(key)) this.markerCache.add(key);
          }
        }
        const applied = applyPositiveDelta(this.accountingState, sessionHash, delta, now, this.markerCache);
        const totals = { ...applied.state.sessionTotals, [sessionHash]: body.totalSeconds };
        const keys = Object.keys(totals);
        for (const key of keys.slice(0, Math.max(0, keys.length - 30))) delete totals[key];
        this.accountingState = { ...applied.state, sessionTotals: totals };
        for (const key of applied.markerKeys) {
          await storage.put(key, true);
          this.markerCache.add(key);
        }
        for (const entry of applied.outbox) await storage.put(outboxKey(entry), entry);
        await storage.put('accountingState:v2', this.accountingState);
      };
      if (typeof this.ctx.storage.transaction === 'function') await this.ctx.storage.transaction(persist);
      else await persist(this.ctx.storage);
      this.pendingSeconds = this.accountingState.pendingSeconds;
      this.sessionTotals = this.accountingState.sessionTotals;
      this.lastFlushedMonthlyTotal = this.accountingState.lastFlushedMonthlyTotal;

      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm) await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }

    // Usage accumulates in every mode. Read the durable monthly baseline before
    // deciding whether this deployment also owns SaaS quota/trial enforcement.
    let quotaExceeded = false;
    let totalMonthlySeconds = this.lastFlushedMonthlyTotal + this.pendingSeconds;
    const saasMode = isSaasModeActive(this.env.SAAS_MODE);
    let usageReadSucceeded = !saasMode;
    if (saasMode) {
      try {
        const kvRecord = await this.env.KV.get<UsageRecord>(getTimekeeperKey(this.bucketName), 'json');
        const currentMonth = getUtcMonthString(new Date());
        const kvMonthly = (kvRecord && kvRecord.thisMonth.month === currentMonth)
          ? kvRecord.thisMonth.seconds
          : 0;
        totalMonthlySeconds = kvMonthly + this.pendingSeconds;
        this.lastFlushedMonthlyTotal = kvMonthly;
        this.accountingState = { ...this.accountingState, lastFlushedMonthlyTotal: kvMonthly };
        usageReadSucceeded = true;
      } catch {
        // Keep the last durable baseline already restored into DO storage.
      }
    }

    if (saasMode && usageReadSucceeded) {
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
