import type { HistoryOutboxEntry, PeriodKind } from '../timekeeper/accounting';
import { createLogger } from './logger';

const logger = createLogger('usage-history');

const PERIOD_KINDS = new Set<PeriodKind>(['day', 'week', 'month', 'year']);
const PERIOD_START = /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{4})$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type UsageHistorySnapshot = HistoryOutboxEntry;

interface UsageHistoryWriteResult {
  userKey: string;
  acknowledged: boolean;
}

export async function userKeyForEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`codeflare-usage-user-v1\0${normalized}`),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateSnapshot(snapshot: UsageHistorySnapshot): void {
  if (!PERIOD_KINDS.has(snapshot.kind) || !PERIOD_START.test(snapshot.start)) throw new Error('Invalid history period');
  if (!Number.isSafeInteger(snapshot.runtimeSeconds) || snapshot.runtimeSeconds < 0) throw new Error('Invalid history runtime');
  if (!Number.isSafeInteger(snapshot.sessionCount) || snapshot.sessionCount < 0) throw new Error('Invalid history session count');
  if (!Number.isSafeInteger(snapshot.sourceSequence) || snapshot.sourceSequence < 0) throw new Error('Invalid history sequence');
  if (!UTC_TIMESTAMP.test(snapshot.snapshotAt)) throw new Error('Invalid history timestamp');
}

const OWNER_SQL = `
INSERT INTO usage_users (user_key, email, account_status, data_since, deleted_at)
VALUES (?1, ?2, 'active', ?3, NULL)
ON CONFLICT(user_key) DO NOTHING`;

const PERIOD_SQL = `
INSERT INTO usage_periods (
  user_key, period_kind, period_start, runtime_seconds, session_count, source_sequence, updated_at
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
FROM usage_users
WHERE user_key = ?1 AND account_status = 'active'
ON CONFLICT(user_key, period_kind, period_start) DO UPDATE SET
  runtime_seconds = excluded.runtime_seconds,
  session_count = excluded.session_count,
  source_sequence = excluded.source_sequence,
  updated_at = excluded.updated_at
WHERE excluded.source_sequence > usage_periods.source_sequence`;

interface AcknowledgementRow {
  period_kind: PeriodKind | null;
  period_start: string | null;
  source_sequence: number | null;
  account_status: 'active' | 'deleted';
}

export async function tombstoneUsageUser(db: D1Database, email: string, deletedAt: string): Promise<void> {
  if (!UTC_TIMESTAMP.test(deletedAt)) throw new Error('Invalid deletion timestamp');
  const normalizedEmail = email.trim().toLowerCase();
  const userKey = await userKeyForEmail(normalizedEmail);
  const statement = db.prepare(`
INSERT INTO usage_users (user_key, email, account_status, data_since, deleted_at)
VALUES (?1, ?2, 'deleted', ?3, ?3)
ON CONFLICT(user_key) DO UPDATE SET
  email = excluded.email,
  account_status = 'deleted',
  deleted_at = excluded.deleted_at`).bind(userKey, normalizedEmail, deletedAt);
  const [result] = await db.batch([statement]);
  if (!result?.success) throw new Error('D1 history tombstone failed');
}

export async function reactivateUsageUser(db: D1Database, email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const userKey = await userKeyForEmail(normalizedEmail);
  await db.prepare(`
UPDATE usage_users
SET account_status = 'active', deleted_at = NULL
WHERE user_key = ?1 AND email = ?2`).bind(userKey, normalizedEmail).run();
}

export type UsagePeriod = PeriodKind;
export type UsageSort = 'runtimeSeconds' | 'sessionCount' | 'email';
export type UsageDirection = 'asc' | 'desc';

export interface AdminUsageRow {
  userKey: string;
  email: string;
  accountStatus: 'active' | 'deleted';
  dataSince: string;
  deletedAt: string | null;
  runtimeSeconds: number;
  sessionCount: number;
  historyUpdatedAt: string;
}

export interface AdminUsageSeriesPoint {
  start: string;
  runtimeSeconds: number;
  sessionCount: number;
  historyUpdatedAt: string;
}

interface D1UsageRow {
  user_key: string;
  email: string;
  account_status: 'active' | 'deleted';
  data_since: string;
  deleted_at: string | null;
  runtime_seconds: number;
  session_count: number;
  updated_at: string;
}

function mapAdminUsageRow(row: D1UsageRow): AdminUsageRow {
  return {
    userKey: row.user_key,
    email: row.email,
    accountStatus: row.account_status,
    dataSince: row.data_since,
    deletedAt: row.deleted_at,
    runtimeSeconds: row.runtime_seconds,
    sessionCount: row.session_count,
    historyUpdatedAt: row.updated_at,
  };
}

const SORT_COLUMNS: Record<UsageSort, string> = {
  runtimeSeconds: 'p.runtime_seconds',
  sessionCount: 'p.session_count',
  email: 'u.email',
};

export async function queryAdminUsageSummary(db: D1Database, period: UsagePeriod, start: string) {
  const result = await db.prepare(`
SELECT
  COALESCE(SUM(p.runtime_seconds), 0) AS runtime_seconds,
  COALESCE(SUM(p.session_count), 0) AS session_count,
  COUNT(CASE WHEN p.runtime_seconds > 0 THEN 1 END) AS active_users,
  MIN(u.data_since) AS data_since,
  MAX(p.updated_at) AS history_updated_at
FROM usage_periods p
JOIN usage_users u ON u.user_key = p.user_key
WHERE p.period_kind = ?1 AND p.period_start = ?2`).bind(period, start).all<{
    runtime_seconds: number;
    session_count: number;
    active_users: number;
    data_since: string | null;
    history_updated_at: string | null;
  }>();
  if (!result.success) throw new Error('D1 usage summary query failed');
  return result.results[0] ?? { runtime_seconds: 0, session_count: 0, active_users: 0, data_since: null, history_updated_at: null };
}

export async function queryAdminUsageSeries(
  db: D1Database,
  period: UsagePeriod,
  start: string,
  limit: number,
): Promise<AdminUsageSeriesPoint[]> {
  const result = await db.prepare(`
SELECT p.period_start, SUM(p.runtime_seconds) AS runtime_seconds,
       SUM(p.session_count) AS session_count, MAX(p.updated_at) AS history_updated_at
FROM usage_periods p
WHERE p.period_kind = ?1 AND p.period_start <= ?2
GROUP BY p.period_start
ORDER BY p.period_start DESC
LIMIT ?3`).bind(period, start, limit).all<{
    period_start: string;
    runtime_seconds: number;
    session_count: number;
    history_updated_at: string;
  }>();
  if (!result.success) throw new Error('D1 usage series query failed');
  return [...result.results].reverse().map((row) => ({
    start: row.period_start,
    runtimeSeconds: row.runtime_seconds,
    sessionCount: row.session_count,
    historyUpdatedAt: row.history_updated_at,
  }));
}

interface UsageContinuation {
  lastValue: string | number;
  userKey: string;
}

export async function queryAdminUsageRows(
  db: D1Database,
  options: {
    period: UsagePeriod;
    start: string;
    sort: UsageSort;
    direction: UsageDirection;
    limit?: number;
    continuation?: UsageContinuation;
  },
): Promise<AdminUsageRow[]> {
  const column = SORT_COLUMNS[options.sort];
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
  const comparison = options.direction === 'asc' ? '>' : '<';
  const values: unknown[] = [options.period, options.start];
  let continuationSql = '';
  if (options.continuation) {
    continuationSql = ` AND (${column} ${comparison} ?3 OR (${column} = ?3 AND u.user_key > ?4))`;
    values.push(options.continuation.lastValue, options.continuation.userKey);
  }
  const limitSql = options.limit === undefined ? '' : ` LIMIT ?${values.length + 1}`;
  if (options.limit !== undefined) values.push(options.limit);
  const result = await db.prepare(`
SELECT u.user_key, u.email, u.account_status, u.data_since, u.deleted_at,
       p.runtime_seconds, p.session_count, p.updated_at
FROM usage_periods p
JOIN usage_users u ON u.user_key = p.user_key
WHERE p.period_kind = ?1 AND p.period_start = ?2${continuationSql}
ORDER BY ${column} ${direction}, u.user_key ASC${limitSql}`).bind(...values).all<D1UsageRow>();
  if (!result.success) throw new Error('D1 usage row query failed');
  return result.results.map(mapAdminUsageRow);
}

export async function queryAdminUsageUser(
  db: D1Database,
  userKey: string,
  period: UsagePeriod,
  start: string,
): Promise<AdminUsageRow | null> {
  const result = await db.prepare(`
SELECT u.user_key, u.email, u.account_status, u.data_since, u.deleted_at,
       p.runtime_seconds, p.session_count, p.updated_at
FROM usage_users u
JOIN usage_periods p ON p.user_key = u.user_key
WHERE u.user_key = ?1 AND p.period_kind = ?2 AND p.period_start = ?3`).bind(userKey, period, start).all<D1UsageRow>();
  if (!result.success) throw new Error('D1 usage detail query failed');
  return result.results[0] ? mapAdminUsageRow(result.results[0]) : null;
}

export async function writeUsageHistory(
  db: D1Database,
  email: string,
  snapshots: UsageHistorySnapshot[],
): Promise<UsageHistoryWriteResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const userKey = await userKeyForEmail(normalizedEmail);
  if (snapshots.length === 0) return { userKey, acknowledged: true };
  for (const snapshot of snapshots) validateSnapshot(snapshot);
  const dataSince = snapshots.reduce((earliest, snapshot) => snapshot.snapshotAt < earliest ? snapshot.snapshotAt : earliest, snapshots[0].snapshotAt);

  const statements: D1PreparedStatement[] = [db.prepare(OWNER_SQL).bind(userKey, normalizedEmail, dataSince)];
  for (const snapshot of snapshots) {
    statements.push(db.prepare(PERIOD_SQL).bind(
      userKey,
      snapshot.kind,
      snapshot.start,
      snapshot.runtimeSeconds,
      snapshot.sessionCount,
      snapshot.sourceSequence,
      snapshot.snapshotAt,
    ));
  }

  const comparisons = snapshots.map((_, index) => `(p.period_kind = ?${index * 2 + 2} AND p.period_start = ?${index * 2 + 3})`).join(' OR ');
  const acknowledgementSql = `
SELECT u.account_status, p.period_kind, p.period_start, p.source_sequence
FROM usage_users u
LEFT JOIN usage_periods p ON p.user_key = u.user_key AND (${comparisons})
WHERE u.user_key = ?1`;
  statements.push(db.prepare(acknowledgementSql).bind(
    userKey,
    ...snapshots.flatMap((snapshot) => [snapshot.kind, snapshot.start]),
  ));

  const results = await db.batch(statements);
  if (results.some((result) => result.success !== true)) throw new Error('D1 history batch failed');
  const metrics = results.reduce((total, result) => ({
    rowsRead: total.rowsRead + Number(result.meta?.rows_read ?? 0),
    rowsWritten: total.rowsWritten + Number(result.meta?.rows_written ?? 0),
    sqlDurationMs: total.sqlDurationMs + Number(result.meta?.duration ?? 0),
  }), { rowsRead: 0, rowsWritten: 0, sqlDurationMs: 0 });
  logger.info('D1 usage history batch', {
    ...metrics,
    backlogSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(dataSince)) / 1_000)),
    snapshotCount: snapshots.length,
  });
  const rows = (results.at(-1)?.results ?? []) as unknown as AcknowledgementRow[];
  const deleted = rows.some((row) => row.account_status === 'deleted');
  const acknowledged = deleted || snapshots.every((snapshot) => rows.some((row) =>
    row.account_status === 'active'
    && row.period_kind === snapshot.kind
    && row.period_start === snapshot.start
    && typeof row.source_sequence === 'number'
    && row.source_sequence >= snapshot.sourceSequence));
  return { userKey, acknowledged };
}
