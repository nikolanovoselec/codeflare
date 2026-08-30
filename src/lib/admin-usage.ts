import type { HistoryOutboxEntry, PeriodKind } from '../timekeeper/accounting';

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
