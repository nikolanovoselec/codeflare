import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import {
  queryAdminUsageRows,
  queryAdminUsageSummary,
  queryAdminUsageUser,
  type AdminUsageRow,
  type UsagePeriod,
  type UsageSort,
} from '../../lib/admin-usage';

const periods = ['day', 'week', 'month', 'year'] as const;
const sorts = ['runtimeSeconds', 'sessionCount', 'email'] as const;
const directions = ['asc', 'desc'] as const;

const querySchema = z.object({
  period: z.enum(periods),
  start: z.string(),
  sort: z.enum(sorts).default('runtimeSeconds'),
  direction: z.enum(directions).default('desc'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  format: z.enum(['json', 'csv']).default('json'),
}).strict();

const cursorSchema = z.object({
  v: z.literal(1),
  period: z.enum(periods),
  start: z.string(),
  sort: z.enum(sorts),
  direction: z.enum(directions),
  lastValue: z.union([z.string(), z.number()]),
  userKey: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

type UsageCursor = z.infer<typeof cursorSchema>;

function validStart(period: UsagePeriod, start: string): boolean {
  if (period === 'day' || period === 'week') return /^\d{4}-\d{2}-\d{2}$/.test(start);
  if (period === 'month') return /^\d{4}-\d{2}$/.test(start);
  return /^\d{4}$/.test(start);
}

function decodeCursor(raw: string): UsageCursor | null {
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    return null;
  }
}

function encodeCursor(cursor: UsageCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function cursorValue(row: AdminUsageRow, sort: UsageSort): string | number {
  if (sort === 'email') return row.email;
  return sort === 'sessionCount' ? row.sessionCount : row.runtimeSeconds;
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function usageCsv(rows: AdminUsageRow[]): string {
  const header = ['userKey', 'email', 'accountStatus', 'dataSince', 'deletedAt', 'runtimeSeconds', 'sessionCount', 'historyUpdatedAt'];
  return `${header.join(',')}\r\n${rows.map((row) => [
    row.userKey, row.email, row.accountStatus, row.dataSince, row.deletedAt,
    row.runtimeSeconds, row.sessionCount, row.historyUpdatedAt,
  ].map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function parseQuery(url: string) {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success || !validStart(parsed.data.period, parsed.data.start)) return null;
  return parsed.data;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/', requireAdmin, async (c) => {
  const query = parseQuery(c.req.url);
  if (!query) return c.json({ error: 'Invalid usage query', code: 'validation_error' }, 400);
  let cursor: UsageCursor | undefined;
  if (query.cursor && query.format === 'json') {
    cursor = decodeCursor(query.cursor) ?? undefined;
    if (!cursor
      || cursor.period !== query.period
      || cursor.start !== query.start
      || cursor.sort !== query.sort
      || cursor.direction !== query.direction) {
      return c.json({ error: 'Usage cursor does not match this query', code: 'usage_cursor_mismatch' }, 400);
    }
  }

  const rows = await queryAdminUsageRows(c.env.USAGE_DB, {
    period: query.period,
    start: query.start,
    sort: query.sort,
    direction: query.direction,
    ...(query.format === 'json' && { limit: query.limit + 1 }),
    ...(cursor && { continuation: { lastValue: cursor.lastValue, userKey: cursor.userKey } }),
  });
  if (query.format === 'csv') {
    return new Response(usageCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="codeflare-usage-${query.period}-${query.start}.csv"`,
      },
    });
  }

  const hasMore = rows.length > query.limit;
  const users = rows.slice(0, query.limit);
  const last = users.at(-1);
  const summary = await queryAdminUsageSummary(c.env.USAGE_DB, query.period, query.start);
  return c.json({
    period: query.period,
    start: query.start,
    timezone: 'UTC',
    sort: query.sort,
    direction: query.direction,
    summary: {
      runtimeSeconds: summary.runtime_seconds,
      sessionCount: summary.session_count,
      activeUsers: summary.active_users,
    },
    dataSince: summary.data_since,
    historyUpdatedAt: summary.history_updated_at,
    users,
    nextCursor: hasMore && last ? encodeCursor({
      v: 1,
      period: query.period,
      start: query.start,
      sort: query.sort,
      direction: query.direction,
      lastValue: cursorValue(last, query.sort),
      userKey: last.userKey,
    }) : null,
  });
});

app.get('/users/:userKey', requireAdmin, async (c) => {
  const query = parseQuery(c.req.url);
  const userKey = c.req.param('userKey');
  if (!query || !userKey || !/^[0-9a-f]{64}$/.test(userKey)) {
    return c.json({ error: 'Invalid usage detail query', code: 'validation_error' }, 400);
  }
  const user = await queryAdminUsageUser(c.env.USAGE_DB, userKey, query.period, query.start);
  if (!user) return c.json({ error: 'Usage user not found', code: 'not_found' }, 404);
  return c.json({ period: query.period, start: query.start, timezone: 'UTC', ...user });
});

export default app;
