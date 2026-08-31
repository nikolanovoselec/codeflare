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
