/**
 * REQ-OPERATOR-006 edge capability boundary.
 *
 * Cloudflare Access bypasses only this route family. This handler therefore
 * owns enterprise, path, method and bearer-capability validation before the
 * parent activity Durable Object is selected. Capabilities are never logged or
 * reflected; the DO stores only verifier hashes and serializes consumption.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { isEnterpriseMode } from '../lib/subscription';
import { runOperatorActivity } from '../operators/orchestrator';

const app = new Hono<{ Bindings: Env }>();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43,128}$/;
const limits = new Map<string, { window: number; count: number }>();

function response(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  } });
}
function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return CAPABILITY.test(token) ? token : null;
}
function throttle(key: string): boolean {
  const now = Date.now();
  const current = limits.get(key);
  const next = !current || now - current.window >= 60_000
    ? { window: now, count: 1 }
    : { window: current.window, count: current.count + 1 };
  if (!limits.has(key) && limits.size >= 1024) limits.delete(limits.keys().next().value as string);
  limits.set(key, next);
  return next.count > 30;
}

app.all('/operator-webhook/v1/activities/:activityId/:action', async c => {
  if (!isEnterpriseMode(c.env)) return response({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  const activityId = c.req.param('activityId');
  const action = c.req.param('action');
  if (!ID.test(activityId) || !['start', 'status', 'result'].includes(action)) {
    return response({ error: 'Not found', code: 'WEBHOOK_ROUTE_NOT_FOUND' }, 404);
  }
  const expectedMethod = action === 'status' ? 'GET' : 'POST';
  if (c.req.method !== expectedMethod) return response({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
  if (c.req.raw.body !== null) return response({ error: 'Request body is not accepted', code: 'WEBHOOK_BODY_INVALID' }, 400);
  const limitKey = `${c.req.header('cf-connecting-ip') ?? 'unknown'}:${activityId}`;
  if (throttle(limitKey)) return response({ error: 'Too many requests', code: 'WEBHOOK_THROTTLED' }, 429);
  const capability = bearer(c.req.header('authorization'));
  if (!capability) return response({ error: 'Capability required', code: 'WEBHOOK_CAPABILITY_REQUIRED' }, 401);
  if (!c.env.OPERATOR_ACTIVITY) return response({ error: 'Webhook unavailable', code: 'WEBHOOK_UNAVAILABLE' }, 503);

  const activity = c.env.OPERATOR_ACTIVITY.getByName(activityId);
  try {
    const result = action === 'start'
      ? await activity.startWebhook(capability)
      : action === 'status'
        ? await activity.getWebhookStatus(capability)
        : await activity.redeemWebhookResult(capability);
    if (result.ok) {
      if (action === 'start') c.executionCtx.waitUntil(runOperatorActivity(activityId, c.env).catch(() => {}));
      return response(result, 200);
    }
    const status = result.reason === 'not-ready' ? 202
      : result.reason === 'capability-expired' ? 410
        : result.reason === 'consumed' || result.reason === 'already-started' ? 409
          : result.reason === 'not-prepared' ? 404
            : result.reason === 'admission-denied' || result.reason === 'authority-expired' ? 403
              : result.reason === 'admission-uncertain' ? 503 : 401;
    return response({ error: 'Webhook capability operation rejected', code: `WEBHOOK_${result.reason.toUpperCase().replace(/-/g, '_')}` }, status);
  } catch {
    return response({ error: 'Webhook unavailable', code: 'WEBHOOK_UNAVAILABLE' }, 503);
  }
});

export default app;
