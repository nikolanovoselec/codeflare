/** Authenticated browser adapter for owner-scoped operator activity projections. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { authenticateRequest, canInvokeOperator, operatorAccessSessionCurrent,
  requireOperatorHumanContext } from '../lib/access';
import { getContainer } from '@cloudflare/containers';
import type { container as SessionContainer } from '../container/index';
import { D1SessionRepository } from '../lib/session-repository';
import { getContainerId } from '../lib/container-helpers';
import { isEnterpriseMode } from '../lib/subscription';
import { AppError } from '../lib/error-types';
import { operatorOwnerKey, type OperatorBrowserSummary } from '../operators/browser-activity';
import type { ManagementExecutionSelection, OperatorRegistry, OperatorRegistryResult } from '../operators/registry';
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
const readBody = z.strictObject({ through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const publicationBody = z.strictObject({ sessionId: identifier,
  sessionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const prospectiveBody = z.strictObject({ installationId: identifier,
  sessionId: z.string().regex(/^[a-z0-9]{8,24}$/),
  sessionGeneration: z.number().int().positive().safe() });
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
  const limit = c.req.query('limit');
  const after = c.req.query('after');
  if (limit === '5') {
    if (after !== undefined && !ID.test(after)) return c.json({ error: 'Invalid activity cursor' }, 400);
    try {
      const page = await c.get('registry').listOwnedActivityPage(c.get('ownerKey'), after ?? null);
      const items = await Promise.all(page.items.map(async indexed => {
        const summary = jsonSummary(indexed);
        if (summary.operatorName && summary.context) return summary;
        try {
          const projection = await c.env.OPERATOR_ACTIVITY!.getByName(summary.activityId)
            .getBrowserSummary(c.get('ownerKey'));
          if (projection?.activityId !== summary.activityId || projection.operatorId !== summary.operatorId) return summary;
          if (!summary.operatorName && projection.operatorName) summary.operatorName = projection.operatorName;
          if (!summary.context && projection.context) summary.context = projection.context;
        } catch { /* Historical display metadata is unavailable; keep the owner index unchanged. */ }
        return summary;
      }));
      return c.json({ ...page, items });
    } catch (error) {
      if (error instanceof Error && error.message === 'Activity history changed') {
        return c.json({ error: 'Activity history changed', code: 'HISTORY_CHANGED' }, 409);
      }
      throw error;
    }
  }
  if (limit !== undefined || after !== undefined) return c.json({ error: 'Invalid activity page' }, 400);
  const items = await c.get('registry').listOwnedActivities(c.get('ownerKey'));
  return c.json({ items: items.slice(0, 100).map(jsonSummary) });
});
app.post('/read', async c => {
  const { through } = await parseJsonBody(c, readBody);
  return c.json(await c.get('registry').acknowledgeOwnedActivities(c.get('ownerKey'), through));
});
app.get('/installations/:installationId/preview', async c => {
  const id = c.req.param('installationId');
  if (!ID.test(id)) return c.notFound();
  const selected = await c.get('registry').resolveManagementExecution(id);
  if (!selected.ok || !canInvokeOperator(c.get('operatorHuman').human, selected.value.operator)) return c.notFound();
  const { operator, release, manifestJson } = selected.value;
  let name: unknown;
  let inputSchema: unknown;
  try { ({ name, inputSchema } = JSON.parse(manifestJson)); } catch { return c.notFound(); }
  if (typeof name !== 'string' || !name.trim()) return c.notFound();
  // Recognize only the two approved input contracts; extra constraints fail closed.
  const repositoryOnly = z.strictObject({ type: z.literal('object'), additionalProperties: z.literal(false),
    required: z.array(z.literal('repository')).length(1), properties: z.strictObject({
      repository: z.strictObject({ type: z.literal('string'), maxLength: z.literal(201),
        pattern: z.literal('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') }),
    }) });
  const legacy = z.strictObject({ type: z.literal('object'), additionalProperties: z.literal(false),
    required: z.array(z.enum(['repository', 'pullRequest'])).length(2)
      .refine(fields => new Set(fields).size === 2), properties: z.strictObject({
      repository: z.strictObject({ type: z.literal('string') }),
      pullRequest: z.strictObject({ type: z.literal('integer'), minimum: z.literal(1) }),
    }) });
  const official = operator.profile === 'dispatcher' && name === 'Renovate Dispatcher'
    && operator.repositoryUrl.replace(/\.git$/i, '').toLowerCase() === 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher';
  const guidedMode = !official ? null : repositoryOnly.safeParse(inputSchema).success ? 'repository'
    : legacy.safeParse(inputSchema).success ? 'legacy-pull-request' : null;
  return c.json({ name, version: release.tagName ?? `GitHub release #${release.githubReleaseId}`,
    guidedAssessment: guidedMode !== null, guidedMode });
});
app.post('/', async c => {
  const body = await parseJsonBody(c, preparationBody);
  const prepared = await prepareOperatorActivity(body, c.get('operatorHuman'), c.env);
  return c.json(prepared, 201);
});

/** Explicit prospective activation is a user-authorized command, never a scheduler side effect. */
app.post('/renovate/activation', async c => {
  const command = await parseJsonBody(c, prospectiveBody);
  const authenticated = await authenticateRequest(c.req.raw, c.env);
  const authority = c.get('operatorHuman');
  if (authenticated.user.role !== 'admin'
    || authenticated.user.email.toLowerCase() !== authority.human.email.toLowerCase()
    || !await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) {
    throw new AppError('FORBIDDEN', 403, 'Administrator session unavailable');
  }
  const session = await new D1SessionRepository(c.env.USAGE_DB).getSession(authenticated.bucketName, command.sessionId);
  if (session?.lifecycleState !== 'running' || session.lifecycleGeneration !== command.sessionGeneration) {
    throw new AppError('FORBIDDEN', 403, 'Administrator session unavailable');
  }
  const selected = await c.get('registry').resolveManagementExecution(command.installationId);
  if (!selected.ok || selected.value.operator.profile !== 'dispatcher'
    || !canInvokeOperator(authority.human, selected.value.operator)) {
    throw new AppError('FORBIDDEN', 403, 'Dispatcher installation unavailable');
  }
  const registration = await c.get('registry').activateProspectiveRenovate({ ...command,
    bucket: authenticated.bucketName, ...authority });
  if (!registration.ok) throw new AppError('FORBIDDEN', 403, 'Prospective activation unavailable');
  if (!c.env.CONTAINER) throw new AppError('UNAVAILABLE', 503, 'Admin session container unavailable');
  const container = getContainer(c.env.CONTAINER,
    getContainerId(authenticated.bucketName, command.sessionId)) as unknown as SessionContainer;
  const armed = await container.armRenovateScan({ ...command, registrationId: registration.registrationId,
    bucket: authenticated.bucketName });
  if (!armed.ok) throw new AppError('UNAVAILABLE', 503, 'Prospective scan schedule unavailable');
  return c.json({ activatedAt: registration.activatedAt, repositoryId: 973175879 }, 202);
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
    const selected: OperatorRegistryResult<ManagementExecutionSelection> =
      await c.get('registry').resolveManagementExecution(installationId);
    if (selected.ok !== true) {
      throw new AppError('FORBIDDEN', 403, 'Operator invocation is not authorized');
    }
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
/** Explicit parent-side command; result reads and Dispatcher children cannot reach this path. */
app.post('/:activityId/publish', async c => {
  const activityId = c.req.param('activityId');
  if (!ID.test(activityId) || !await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const current = await authenticateRequest(c.req.raw, c.env);
  const human = c.get('operatorHuman');
  if (current.user.role !== 'admin' || current.user.email.toLowerCase() !== human.human.email.toLowerCase()) {
    throw new AppError('FORBIDDEN', 403, 'Administrator access required');
  }
  const command = await parseJsonBody(c, publicationBody);
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).publishRenovateAssessment({
    ...command, bucket: current.bucketName, operationId: crypto.randomUUID(),
  }, { ...human, platformAdmin: true });
  return c.json(outcome, outcome.ok ? 200 : 409);
});
app.post('/:activityId/cancel', async c => {
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const outcome = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).cancelDrive();
  if (!outcome.ok) return c.json({ error: 'Activity cancel rejected', code: outcome.reason }, 409);
  const detail = await browserDetail(c.env.OPERATOR_ACTIVITY!.getByName(activityId));
  return c.json(detail ? { ...detail, updatedAt: new Date(detail.updatedAt).toISOString() } : outcome);
});

export default app;
