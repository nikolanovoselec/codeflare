/** Authenticated browser adapter for owner-scoped operator activity projections. */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { authMiddleware, type AuthVariables } from '../middleware/auth';
import { requireOperatorHumanContext } from '../lib/access';
import { isEnterpriseMode } from '../lib/subscription';
import { AppError } from '../lib/error-types';
import { operatorOwnerKey, type OperatorBrowserSummary } from '../operators/browser-activity';
import type { OperatorRegistry } from '../operators/registry';
import { parseJsonBody } from '../lib/request-helpers';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables & { ownerKey: string;
  registry: DurableObjectStub<OperatorRegistry> } }>();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const startBody = z.strictObject({ capability: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });
const jsonSummary = (summary: OperatorBrowserSummary) => structuredClone(summary);

app.use('*', async (c, next) => isEnterpriseMode(c.env) ? next() : c.notFound());
app.use('*', authMiddleware);
app.use('*', async (c, next) => {
  if (!c.env.OPERATOR_REGISTRY || !c.env.OPERATOR_ACTIVITY) throw new AppError('UNAVAILABLE', 503, 'Operator activity unavailable');
  const human = await requireOperatorHumanContext(c.req.raw, c.env, c.get('user').email);
  c.set('ownerKey', await operatorOwnerKey(human.human));
  c.set('registry', c.env.OPERATOR_REGISTRY.getByName('registry'));
  if (c.req.method === 'POST' && c.req.header('x-requested-with') !== 'XMLHttpRequest') {
    throw new AppError('FORBIDDEN', 403, 'CSRF validation failed');
  }
  return next();
});

app.get('/', async c => {
  const items = await c.get('registry').listOwnedActivities(c.get('ownerKey'));
  return c.json({ items: items.slice(0, 100).map(jsonSummary) });
});

async function owned(registry: DurableObjectStub<OperatorRegistry>, ownerKey: string, activityId: string) {
  if (!ID.test(activityId)) return null;
  return registry.getOwnedActivity(ownerKey, activityId);
}

app.get('/:activityId', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const detail = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).getBrowserDetail();
  return detail ? c.json({ ...detail, updatedAt: new Date(detail.updatedAt).toISOString() }) : c.notFound();
});
app.get('/:activityId/result', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const detail = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).getBrowserDetail();
  return detail ? c.json({ ...detail, updatedAt: new Date(detail.updatedAt).toISOString() }) : c.notFound();
});
app.post('/:activityId/result', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).collectBrowserResult();
  if (!outcome.ok) return c.json({ error: 'Result is not ready', code: 'RESULT_NOT_READY' }, 409);
  return c.json({ ...outcome.detail, updatedAt: new Date(outcome.detail.updatedAt).toISOString() });
});
app.post('/:activityId/start', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const body = await parseJsonBody(c, startBody);
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).start(body.capability);
  if (!outcome.ok) return c.json({ error: 'Activity start rejected', code: outcome.reason }, 409);
  return c.json(outcome);
});
app.post('/:activityId/cancel', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).cancelDrive();
  if (!outcome.ok) return c.json({ error: 'Activity cancel rejected', code: outcome.reason }, 409);
  const detail = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).getBrowserDetail();
  return c.json(detail ? { ...detail, updatedAt: new Date(detail.updatedAt).toISOString() } : outcome);
});

export default app;
