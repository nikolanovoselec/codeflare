import type { Env } from '../types';
import { createLogger } from './logger';
import { sendUsageReportEmail } from './email';
import { getUsageReportNextKey } from './kv-keys';
import {
  buildReportArtifacts,
  latestClosedMonth,
  nextReportDelivery,
  reportIdempotencyKey,
  scheduledDispatchId,
  type EnabledReportSettings,
} from './usage-reports';

export interface ReportDeliveryRow {
  id: string;
  delivery_kind: 'scheduled' | 'test';
  dispatch_id: string;
  settings_revision: number;
  report_month: string;
  recipient: string;
  state: 'pending' | 'sending' | 'accepted' | 'failed';
  attempt: number;
  claim_token: string | null;
}

export async function claimReportDelivery(
  db: D1Database,
  id: string,
  now: Date,
  claimToken: string,
): Promise<ReportDeliveryRow | null> {
  const lease = new Date(now.getTime() + 5 * 60_000).toISOString();
  return db.prepare(`UPDATE report_deliveries
    SET state = 'sending', attempt = attempt + 1, claim_token = ?2, lease_expires_at = ?3, updated_at = ?4
    WHERE id = ?1 AND attempt < 3 AND (
      state = 'pending' OR state = 'failed' OR (state = 'sending' AND lease_expires_at <= ?4)
    ) RETURNING *`).bind(id, claimToken, lease, now.toISOString()).first<ReportDeliveryRow>();
}

export async function completeReportDelivery(
  db: D1Database,
  id: string,
  claimToken: string,
  result: 'accepted' | 'attachment_too_large' | 'provider_unavailable',
  now: Date,
): Promise<boolean> {
  const state = result === 'accepted' ? 'accepted' : 'failed';
  const reason = result === 'accepted' ? null : result;
  const completed = await db.prepare(`UPDATE report_deliveries
    SET state = ?3, reason = ?4, updated_at = ?5, accepted_at = CASE WHEN ?3 = 'accepted' THEN ?5 ELSE accepted_at END,
      claim_token = NULL, lease_expires_at = NULL
    WHERE id = ?1 AND claim_token = ?2 AND state = 'sending'`).bind(id, claimToken, state, reason, now.toISOString()).run();
  return (completed.meta.changes ?? 0) > 0;
}

function isoWeekStart(now: Date): Date {
  const day = now.getUTCDay() || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 1));
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStartOffset(now: Date, months: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));
}

export function retentionCutoffs(now: Date): {
  day: string;
  week: string;
  month: string;
  year: string;
  deleted: string;
  deliveries: string;
  claims: string;
} {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 399));
  const week = isoWeekStart(now);
  week.setUTCDate(week.getUTCDate() - 59 * 7);
  const month = monthStartOffset(now, -59);
  const sixtyMonths = monthStartOffset(now, -60).toISOString();
  const claims = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 35));
  return {
    day: dateOnly(day),
    week: dateOnly(week),
    month: month.toISOString().slice(0, 7),
    year: String(now.getUTCFullYear() - 4),
    deleted: sixtyMonths,
    deliveries: sixtyMonths,
    claims: dateOnly(claims),
  };
}

const CLAIM_EXISTS = `EXISTS (
  SELECT 1 FROM maintenance_claims
  WHERE task = ?1 AND utc_date = ?2 AND claim_token = ?3
)`;

const logger = createLogger('usage-reports');

export async function runUsageRetention(db: D1Database, now: Date, claimToken: string): Promise<void> {
  const task = 'usage-retention';
  const utcDate = dateOnly(now);
  const claimedAt = now.toISOString();
  const cutoffs = retentionCutoffs(now);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO maintenance_claims(task, utc_date, claim_token, claimed_at)
      VALUES (?1, ?2, ?3, ?4)`).bind(task, utcDate, claimToken, claimedAt),
  ];
  for (const [kind, cutoff] of Object.entries({ day: cutoffs.day, week: cutoffs.week, month: cutoffs.month, year: cutoffs.year })) {
    statements.push(db.prepare(`DELETE FROM usage_periods
      WHERE period_kind = ?4 AND period_start < ?5
        AND EXISTS (SELECT 1 FROM usage_users WHERE usage_users.user_key = usage_periods.user_key AND account_status = 'active')
        AND ${CLAIM_EXISTS}`).bind(task, utcDate, claimToken, kind, cutoff));
  }
  statements.push(
    db.prepare(`DELETE FROM usage_users WHERE account_status = 'deleted' AND deleted_at < ?4 AND ${CLAIM_EXISTS}`)
      .bind(task, utcDate, claimToken, cutoffs.deleted),
    db.prepare(`DELETE FROM report_deliveries WHERE created_at < ?4 AND ${CLAIM_EXISTS}`)
      .bind(task, utcDate, claimToken, cutoffs.deliveries),
    db.prepare(`DELETE FROM maintenance_claims WHERE utc_date < ?4 AND ${CLAIM_EXISTS}`)
      .bind(task, utcDate, claimToken, cutoffs.claims),
  );
  await db.batch(statements);
}

interface StoredReportSettings extends EnabledReportSettings {
  settingsRevision: number;
}

interface ReportCursor {
  settingsRevision: number;
  nextDeliveryAt: string;
}

export async function createReportDispatch(
  db: D1Database,
  kind: 'scheduled' | 'test',
  dispatchId: string,
  settingsRevision: number,
  reportMonth: string,
  recipients: string[],
  now: Date,
): Promise<void> {
  if (recipients.length === 0) return;
  const timestamp = now.toISOString();
  await db.batch(recipients.map((recipient) => db.prepare(`INSERT OR IGNORE INTO report_deliveries
    (id, delivery_kind, dispatch_id, settings_revision, report_month, recipient, state, attempt, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?7)`)
    .bind(crypto.randomUUID(), kind, dispatchId, settingsRevision, reportMonth, recipient, timestamp)));
}

async function reportRows(db: D1Database, reportMonth: string): Promise<Array<{ email: string; runtimeSeconds: number; sessionCount: number }>> {
  const result = await db.prepare(`SELECT u.email, p.runtime_seconds AS runtimeSeconds, p.session_count AS sessionCount
    FROM usage_periods p JOIN usage_users u ON u.user_key = p.user_key
    WHERE p.period_kind = 'month' AND p.period_start = ?1
    ORDER BY p.runtime_seconds DESC, u.user_key ASC`).bind(reportMonth).all<{ email: string; runtimeSeconds: number; sessionCount: number }>();
  return result.results;
}

export async function recoverReportDeliveries(env: Env, now: Date): Promise<void> {
  const candidates = await env.USAGE_DB.prepare(`SELECT * FROM report_deliveries
    WHERE attempt < 3 AND (state IN ('pending', 'failed') OR (state = 'sending' AND lease_expires_at <= ?1))
    ORDER BY created_at ASC, id ASC LIMIT 25`).bind(now.toISOString()).all<ReportDeliveryRow>();
  const artifacts = new Map<string, { html: string; csv: string }>();
  for (const candidate of candidates.results) {
    const claimToken = crypto.randomUUID();
    const claimed = await claimReportDelivery(env.USAGE_DB, candidate.id, now, claimToken);
    if (!claimed) continue;
    let report = artifacts.get(claimed.report_month);
    if (!report) {
      report = buildReportArtifacts(claimed.report_month, await reportRows(env.USAGE_DB, claimed.report_month));
      artifacts.set(claimed.report_month, report);
    }
    const result = await sendUsageReportEmail({
      recipient: claimed.recipient,
      reportMonth: claimed.report_month,
      html: report.html,
      csv: report.csv,
      idempotencyKey: claimed.delivery_kind === 'scheduled'
        ? reportIdempotencyKey(claimed.settings_revision, claimed.report_month, claimed.recipient)
        : `usage-report-test:${claimed.dispatch_id}:${claimed.recipient.trim().toLowerCase()}`,
      env,
    });
    await completeReportDelivery(env.USAGE_DB, claimed.id, claimToken, result, new Date());
  }
}

export async function createDueScheduledDispatch(env: Env, now: Date): Promise<void> {
  const settings = await env.KV.get<StoredReportSettings>('admin:usage-reports:settings', 'json');
  if (!settings?.enabled) return;
  const cursorKey = getUsageReportNextKey(settings.settingsRevision);
  const cursor = await env.KV.get<ReportCursor>(cursorKey, 'json');
  if (!cursor || cursor.settingsRevision !== settings.settingsRevision) {
    await env.KV.put(cursorKey, JSON.stringify({
      settingsRevision: settings.settingsRevision,
      nextDeliveryAt: nextReportDelivery(settings, now).toISOString(),
      updatedAt: now.toISOString(),
    }), { expirationTtl: 90 * 24 * 60 * 60 });
    return;
  }
  if (cursor.nextDeliveryAt > now.toISOString()) return;
  const reportMonth = latestClosedMonth(now);
  await createReportDispatch(
    env.USAGE_DB,
    'scheduled',
    scheduledDispatchId(settings.settingsRevision, reportMonth),
    settings.settingsRevision,
    reportMonth,
    settings.recipients,
    now,
  );
  await env.KV.put(cursorKey, JSON.stringify({
    settingsRevision: settings.settingsRevision,
    nextDeliveryAt: nextReportDelivery(settings, now).toISOString(),
    updatedAt: now.toISOString(),
  }), { expirationTtl: 90 * 24 * 60 * 60 });
}

export async function runUsageReportScheduler(env: Env, now = new Date()): Promise<void> {
  try {
    await runUsageRetention(env.USAGE_DB, now, crypto.randomUUID());
  } catch (error) {
    logger.error('Usage retention failed', error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await createDueScheduledDispatch(env, now);
  } catch (error) {
    logger.error('Usage report scheduling failed', error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await recoverReportDeliveries(env, now);
  } catch (error) {
    logger.error('Usage report recovery failed', error instanceof Error ? error : new Error(String(error)));
  }
}
