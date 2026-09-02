import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { createReportDispatch, recoverReportDeliveries } from '../../lib/usage-report-scheduler';
import { latestClosedMonth, testDispatchId, type EnabledReportSettings } from '../../lib/usage-reports';

interface Variables extends AuthVariables {
  requestId: string;
}

interface StoredSettings extends EnabledReportSettings {
  settingsRevision: number;
}

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
}).strict();

interface HistoryCursor {
  v: 1;
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: HistoryCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeCursor(value: string): HistoryCursor | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return parsed?.v === 1 && typeof parsed.createdAt === 'string' && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', authMiddleware);

app.post('/usage-report-tests', requireAdmin, async (c) => {
  const settings = await c.env.KV.get<StoredSettings>('admin:usage-reports:settings', 'json');
  if (!settings?.enabled) return c.json({ error: 'Usage reports are disabled', code: 'reports_disabled' }, 409);
  const now = new Date();
  const dispatchId = testDispatchId(c.get('requestId'));
  await createReportDispatch(c.env.USAGE_DB, 'test', dispatchId, settings.settingsRevision, latestClosedMonth(now), settings.recipients, now);
  c.executionCtx.waitUntil(recoverReportDeliveries(c.env, now));
  return c.json({ dispatchId, deliveryKind: 'test', state: 'pending' }, 202);
});

app.get('/usage-report-deliveries', requireAdmin, async (c) => {
  const parsed = historyQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
  if (!parsed.success) return c.json({ error: 'Invalid delivery history query', code: 'validation_error' }, 400);
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !cursor) return c.json({ error: 'Invalid delivery history cursor', code: 'cursor_invalid' }, 400);
  const result = await c.env.USAGE_DB.prepare(`SELECT * FROM report_deliveries
    WHERE (?1 IS NULL OR created_at < ?1 OR (created_at = ?1 AND id < ?2))
    ORDER BY created_at DESC, id DESC LIMIT ?3`)
    .bind(cursor?.createdAt ?? null, cursor?.id ?? null, parsed.data.limit + 1).all<Record<string, unknown>>();
  const hasMore = result.results.length > parsed.data.limit;
  const rows = result.results.slice(0, parsed.data.limit);
  const deliveries = rows.map((row) => ({
    id: row.id,
    deliveryKind: row.delivery_kind,
    dispatchId: row.dispatch_id,
    settingsRevision: row.settings_revision,
    reportMonth: row.report_month,
    recipient: row.recipient,
    state: row.state,
    attempt: row.attempt,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  }));
  const last = rows.at(-1);
  return c.json({
    deliveries,
    nextCursor: hasMore && last ? encodeCursor({ v: 1, createdAt: String(last.created_at), id: String(last.id) }) : null,
  });
});

export default app;
