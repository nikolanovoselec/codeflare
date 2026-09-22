/** Authenticated browser adapter for owner-scoped operator activity projections. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { canInvokeOperator, requireOperatorHumanContext } from '../lib/access';
import { isEnterpriseMode } from '../lib/subscription';
import { AppError } from '../lib/error-types';
import { operatorOwnerKey, type OperatorBrowserSummary } from '../operators/browser-activity';
import type { OperatorRegistry } from '../operators/registry';
import type { OperatorActivity } from '../operators/activity';
import { parseJsonBody } from '../lib/request-helpers';
import { bindOperatorRuntimeCapability, prepareOperatorActivity, runOperatorActivity } from '../operators/orchestrator';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const preparationBody = z.union([
  z.strictObject({ operatorId: identifier, invocation: z.json() }),
  z.strictObject({ installationId: identifier, invocation: z.json() }),
]);
type HumanAuthority = Awaited<ReturnType<typeof requireOperatorHumanContext>>;
type ActivityRouteEnv = { Bindings: Env; Variables: { ownerKey: string; operatorHuman: HumanAuthority;
  registry: DurableObjectStub<OperatorRegistry> } };
const app = new Hono<ActivityRouteEnv>();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const startBody = z.strictObject({ capability: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });
type BrowserDetail = OperatorBrowserSummary & { checkpoint: unknown; result: unknown };
type BrowserCollection = { ok: true; detail: BrowserDetail } | { ok: false; reason: 'not-ready' | 'not-admitted' };
const jsonSummary = (summary: OperatorBrowserSummary) => structuredClone(summary);

app.use('*', async (c, next) => isEnterpriseMode(c.env) ? next() : c.notFound());
app.use('*', async (c, next) => {
  if (!c.env.OPERATOR_REGISTRY || !c.env.OPERATOR_ACTIVITY) throw new AppError('UNAVAILABLE', 503, 'Operator activity unavailable');
  const email = c.req.header('cf-access-authenticated-user-email')?.trim().toLowerCase();
  if (!email) throw new AppError('UNAUTHORIZED', 401, 'Authentication required');
  const human = await requireOperatorHumanContext(c.req.raw, c.env, email);
  c.set('operatorHuman', human);
  c.set('ownerKey', await operatorOwnerKey(human.human));
  c.set('registry', c.env.OPERATOR_REGISTRY.getByName('registry'));
  return next();
});
async function requireMutationCsrf(c: Context<ActivityRouteEnv>, next: () => Promise<void>) {
  if (c.req.method === 'POST' && c.req.header('x-requested-with') !== 'XMLHttpRequest') {
    throw new AppError('FORBIDDEN', 403, 'CSRF validation failed');
  }
  return next();
}
app.use('*', requireMutationCsrf);

app.get('/', async c => {
  const items = await c.get('registry').listOwnedActivities(c.get('ownerKey'));
  return c.json({ items: items.slice(0, 100).map(jsonSummary) });
});
app.post('/', async c => {
  const body = await parseJsonBody(c, preparationBody);
  const prepared = await prepareOperatorActivity(body, c.get('operatorHuman'), c.env);
  return c.json(prepared, 201);
});

async function owned(registry: DurableObjectStub<OperatorRegistry>, ownerKey: string, activityId: string) {
  if (!ID.test(activityId)) return null;
  return registry.getOwnedActivity(ownerKey, activityId);
}
async function browserDetail(stub: DurableObjectStub<OperatorActivity>): Promise<BrowserDetail | null> {
  return await stub.getBrowserDetail() as BrowserDetail | null;
}

async function handleBrowserDetail(c: Context<ActivityRouteEnv>) {
  const activityId = c.req.param('activityId');
  if (!activityId || !await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const detail = await browserDetail(c.env.OPERATOR_ACTIVITY!.getByName(activityId));
  return detail ? c.json({ ...detail, updatedAt: new Date(detail.updatedAt).toISOString() }) : c.notFound();
}
app.get('/:activityId', handleBrowserDetail);
app.get('/:activityId/result', handleBrowserDetail);
app.post('/:activityId/result', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).collectBrowserResult() as BrowserCollection;
  if (!outcome.ok) return c.json({ error: 'Result is not ready', code: 'RESULT_NOT_READY' }, 409);
  return c.json({ ...outcome.detail, updatedAt: new Date(outcome.detail.updatedAt).toISOString() });
});
app.post('/:activityId/start', async c => {
  const activityId = c.req.param('activityId');
  if (!ID.test(activityId)) return c.notFound();
  const activity = c.env.OPERATOR_ACTIVITY!.getByName(activityId);
  const indexed = await owned(c.get('registry'), c.get('ownerKey'), activityId);
  if (!indexed && !await activity.ownsPrepared(c.get('ownerKey'))) return c.notFound();
  const body = await parseJsonBody(c, startBody);
  const installationId = await activity.getPreparedInstallationId();
  if (installationId) {
    const selected = await c.get('registry').resolveManagementExecution(installationId);
    if (!selected.ok) throw new AppError('FORBIDDEN', 403, 'Operator invocation is not authorized');
    if (!canInvokeOperator(c.get('operatorHuman').human, selected.value.operator)) {
      throw new AppError('FORBIDDEN', 403, 'Operator invocation is not authorized');
    }
  }
  const bindCapability = bindOperatorRuntimeCapability(c.executionCtx);
  const outcome = await activity.start(body.capability);
  if (!outcome.ok) return c.json({ error: 'Activity start rejected', code: outcome.reason }, 409);
  c.executionCtx.waitUntil(runOperatorActivity(activityId, c.env, bindCapability).catch(() => {}));
  return c.json(outcome);
});
async function handleContinue(c: Context<ActivityRouteEnv>) {
  const activityId = c.req.param('activityId');
  if (!activityId || !await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const activity = c.env.OPERATOR_ACTIVITY!.getByName(activityId);
  const detail = await browserDetail(activity);
  if (detail?.executionStatus !== 'waiting' || detail.checkpoint === null || detail.checkpoint === undefined) {
    return c.json({ error: 'Activity continuation rejected', code: 'CONTINUATION_NOT_READY' }, 409);
  }
  const bindCapability = bindOperatorRuntimeCapability(c.executionCtx);
  c.executionCtx.waitUntil(runOperatorActivity(activityId, c.env, bindCapability).catch(() => {}));
  return c.json({ ok: true, phase: 'queued' }, 202);
}
app.post('/:activityId/continue', handleContinue);
app.post('/:activityId/cancel', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).cancelDrive();
  if (!outcome.ok) return c.json({ error: 'Activity cancel rejected', code: outcome.reason }, 409);
  const detail = await browserDetail(c.env.OPERATOR_ACTIVITY!.getByName(activityId));
  return c.json(detail ? { ...detail, updatedAt: new Date(detail.updatedAt).toISOString() } : outcome);
});

export default app;
