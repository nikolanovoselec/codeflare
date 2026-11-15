import { applicationSchedule } from '../operators/application-configuration';
import { parseOperatorManifest } from '../operators/distribution';
import { SETUP_KEYS } from '../lib/kv-keys';
import { requireOwnerRawReader, type OwnerRawReadCredential, type OwnerRawReadRequest } from '../operators/raw-capture-read';
/** Authenticated browser adapter for owner-scoped operator activity projections. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { authenticateRequest, canInvokeOperator, canManageOperator, hasOperatorManagementEligibility, operatorAccessSessionCurrent,
  requireOperatorHumanContext, observeOperatorAccessIdentity, parseAccessGroups } from '../lib/access';
import { isEnterpriseMode } from '../lib/subscription';
import { AppError, ValidationError } from '../lib/error-types';
import { operatorOwnerKey, type OperatorBrowserSummary } from '../operators/browser-activity';
import type { ManagementExecutionSelection, OperatorRegistry, OperatorRegistryResult } from '../operators/registry';
import type { OperatorActivity, RetiredEffectReceipts } from '../operators/activity';
import { parseJsonBody } from '../lib/request-helpers';
import { bindOperatorRuntimeCapability, prepareOperatorActivity, runOperatorActivity } from '../operators/orchestrator';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ownerSourceBody = z.strictObject({ sessionId: z.string().regex(/^[a-z0-9]{8,24}$/),
  sessionGeneration: z.number().int().positive().safe() }).optional();
const preparationBody = z.union([
  z.strictObject({ operatorId: identifier, invocation: z.json() }),
  z.strictObject({ installationId: identifier, invocation: z.json(), sourceSession: ownerSourceBody }),
]);
type HumanAuthority = Awaited<ReturnType<typeof requireOperatorHumanContext>>;
type ActivityRouteEnv = { Bindings: Env; Variables: { ownerKey: string; operatorHuman: HumanAuthority;
  registry: DurableObjectStub<OperatorRegistry> } };
const app = new Hono<ActivityRouteEnv>();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const startBody = z.strictObject({ capability: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });
const readBody = z.strictObject({ through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const rawReadSelectors = { cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(), captureId: identifier.optional() };
const rawReadQuery = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observation'), observationId: identifier, ...rawReadSelectors }),
  z.strictObject({ kind: z.literal('activity'), activityId: identifier,
    generation: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().safe()),
    ...rawReadSelectors }),
]);
const publicationBody = z.strictObject({ sessionId: identifier,
  sessionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const applicationActivationBody = z.strictObject({ installationId: identifier, revision: z.number().int().positive().safe() });
type BrowserDetail = OperatorBrowserSummary & { checkpoint: unknown; result: unknown; effectReceipts?: RetiredEffectReceipts };
type BrowserCollection = { ok: true; detail: BrowserDetail } | { ok: false; reason: 'not-ready' | 'not-admitted' };
const jsonSummary = (summary: OperatorBrowserSummary) => structuredClone(summary);
const diagnosticsResultSchema = z.union([
  z.object({ status: z.literal(200), value: z.record(z.string(), z.unknown()) }),
  z.object({ status: z.union([z.literal(400), z.literal(404), z.literal(409), z.literal(503)]), code: z.string() }),
]);

// Set before authentication so even rejected owner/session responses are never cached.
app.use('*', async (c, next) => {
  if (/\/diagnostics\/v2(?:\/|$)/.test(new URL(c.req.url).pathname)) c.header('Cache-Control', 'no-store');
  return next();
});

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
        if (summary.operatorName && summary.context && summary.version && summary.resultSummary) return summary;
        try {
          const projection = await c.env.OPERATOR_ACTIVITY!.getByName(summary.activityId)
            .getBrowserSummary(c.get('ownerKey'));
          if (projection?.activityId !== summary.activityId || projection.operatorId !== summary.operatorId) return summary;
          if (summary.operatorName && projection.operatorName && summary.operatorName !== projection.operatorName
            || summary.context && projection.context && summary.context !== projection.context) return summary;
          if (!summary.operatorName && projection.operatorName) summary.operatorName = projection.operatorName;
          if (!summary.context && projection.context) summary.context = projection.context;
          if (!summary.version && projection.version) summary.version = projection.version;
          if (!summary.resultSummary && projection.resultSummary && projection.executionStatus === summary.executionStatus) {
            summary.resultSummary = projection.resultSummary;
          }
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
/** Package-owned input/configuration metadata; the host does not recognize use cases. */
function guidedPreview(selection: ManagementExecutionSelection) {
  const manifest = parseOperatorManifest(selection.manifestJson, 'https://operator.invalid/');
  return { name: manifest.name, description: manifest.description,
    version: selection.release.tagName ?? `GitHub release #${selection.release.githubReleaseId}`,
    guidedAssessment: false, guidedMode: null, inputSchema: manifest.inputSchema,
    application: manifest.application ?? null };
}

app.get('/installations', async c => {
  const params = new URL(c.req.url).searchParams;
  const cursor = params.get('cursor');
  if ([...params.keys()].some(key => key !== 'cursor') || params.getAll('cursor').length > 1
    || cursor !== null && !ID.test(cursor)) return c.json({ error: 'Invalid installation cursor' }, 400);
  const human = c.get('operatorHuman').human;
  const registry = c.get('registry');
  const authenticated = await authenticateRequest(c.req.raw, c.env);
  if (authenticated.user.email.toLowerCase() !== human.email.toLowerCase()) return c.notFound();
  const platformAdmin = authenticated.user.role === 'admin';
  const controls = await registry.getManagementControls();
  const canManage = (operator: ManagementExecutionSelection['operator']) => platformAdmin || canManageOperator(human, operator, controls.managers);
  if (cursor) {
    const previous = await registry.getManagementInstallation(cursor);
    if (!previous.ok) return c.notFound();
    const operator = await registry.getManagementOperator(previous.value.operatorId);
    if (!operator.ok || !canInvokeOperator(human, operator.value) && !canManage(operator.value)) return c.notFound();
  }
  const page = await registry.listManagementInstallationPage({ email: human.email, issuer: human.issuer, groups: [...(human.groups ?? [])],
    platformAdmin, cursor, managersEligible: hasOperatorManagementEligibility(human, controls.managers) });
  const items = [];
  for (const installation of page.items) {
    const current = await registry.getManagementOperator(installation.operatorId);
    if (!current.ok) continue;
    const operator = current.value;
    const invoke = canInvokeOperator(human, operator);
    const manage = canManage(operator);
    if (!invoke && !manage) continue;
    const releases = await registry.getManagementReleases(operator.id);
    const release = releases.find(value => value.id === installation.releaseId && value.operatorId === operator.id);
    const approved = release?.approved === true;
    // Advisory metadata may describe a disabled saved installation. Execution and
    // activation still require resolveManagementExecution at their own boundaries.
    const selected = approved ? await registry.resolveManagementConfiguration(installation.id) : null;
    const selection = selected?.ok && selected.value.operator.id === operator.id
      && selected.value.operator.revision === operator.revision && selected.value.controlsRevision === controls.revision
      && selected.value.installation.id === installation.id && selected.value.installation.operatorId === operator.id
      && selected.value.installation.revision === installation.revision
      && selected.value.installation.releaseId === installation.releaseId
      && selected.value.installation.configurationJson === installation.configurationJson
      && selected.value.release.id === installation.releaseId && selected.value.release.operatorId === operator.id
      && selected.value.release.bundleDigest === release?.bundleDigest && selected.value.release.approved
      ? selected.value : null;
    let preview: ReturnType<typeof guidedPreview> | null = null;
    let settings: ReturnType<typeof applicationSchedule> = null;
    try {
      preview = selection ? guidedPreview(selection) : null;
      settings = preview ? applicationSchedule(preview.application ?? undefined, JSON.parse(installation.configurationJson)) : null;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
    const supportedAutomatic = !!preview?.application?.schedule;
    const canActivateAutomaticRuns = platformAdmin && invoke && approved && supportedAutomatic
      && selection !== null && selection.operator.enabled && settings?.automaticRuns === true;
    items.push({ id: installation.id, operatorId: operator.id, profile: operator.profile,
      name: preview?.name ?? release?.name ?? operator.name ?? operator.id,
      installationName: installation.name, revision: installation.revision, enabled: installation.enabled, approved,
      version: release ? release.tagName ?? `GitHub release #${release.githubReleaseId}` : null,
      canInvoke: invoke, canManage: manage, canActivateAutomaticRuns,
      automaticRunStatus: supportedAutomatic && installation.enabled
        ? await registry.applicationScheduleStatus(installation.id, c.get('ownerKey')) : 'inactive', guidedMode: null,
      repository: null, application: preview?.application ?? null, automaticRuns: settings?.automaticRuns ?? null,
      repetitionIntervalSeconds: settings?.repetitionIntervalSeconds ?? null });
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ items, cursor: page.cursor });
});
app.get('/installations/:installationId/preview', async c => {
  const id = c.req.param('installationId');
  if (!ID.test(id)) return c.notFound();
  const selected = await c.get('registry').resolveManagementExecution(id);
  if (!selected.ok || !canInvokeOperator(c.get('operatorHuman').human, selected.value.operator)) return c.notFound();
  const preview = guidedPreview(selected.value);
  return preview ? c.json({ ...preview,
    requiresSourceHost: false,
  }) : c.notFound();
});
app.post('/', async c => {
  const body = await parseJsonBody(c, preparationBody);
  const prepared = await prepareOperatorActivity(body, c.get('operatorHuman'), c.env);
  return c.json(prepared, 201);
});

/** Explicit consent enables a generic timer, never application discovery or work admission. */
app.post('/automatic/activation', async c => {
  const command = await parseJsonBody(c, applicationActivationBody);
  const authenticated = await authenticateRequest(c.req.raw, c.env);
  const authority = c.get('operatorHuman');
  if (authenticated.user.role !== 'admin'
    || authenticated.user.email.toLowerCase() !== authority.human.email.toLowerCase()
    || !await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) {
    throw new AppError('FORBIDDEN', 403, 'Administrator session unavailable');
  }
  const selected = await c.get('registry').resolveManagementExecution(command.installationId);
  if (!selected.ok || selected.value.installation.revision !== command.revision
    || !canInvokeOperator(authority.human, selected.value.operator)) {
    throw new AppError('CONFLICT', 409, 'Installation is unavailable or changed');
  }
  const manifest = parseOperatorManifest(selected.value.manifestJson, 'https://operator.invalid/');
  const settings = applicationSchedule(manifest.application, JSON.parse(selected.value.installation.configurationJson));
  if (!settings?.automaticRuns) throw new AppError('FORBIDDEN', 403, 'Automatic runs are not configured');
  const routing = parseAccessGroups(await c.env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
  const observed = await observeOperatorAccessIdentity(authority.human, authority.accessJwt, routing);
  if (observed.status !== 'current' || !Array.isArray(observed.groups) || !Array.isArray(observed.routingGroups)
    || !await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) {
    throw new AppError('FORBIDDEN', 403, 'Administrator authority changed');
  }
  const result = await c.get('registry').activateApplicationSchedule({ ...command,
    authority: { human: { ...authority.human, groups: observed.groups }, accessJwt: authority.accessJwt,
      delegation: { version: 1, routingGroups: observed.routingGroups } } });
  if (!result.ok) throw new AppError('CONFLICT', 409, 'Automatic activation unavailable');
  return c.json({ activatedAt: result.activatedAt }, 202);
});

async function owned(registry: DurableObjectStub<OperatorRegistry>, ownerKey: string, activityId: string) {
  if (!ID.test(activityId)) return null;
  return registry.getOwnedActivity(ownerKey, activityId);
}
async function browserDetail(stub: DurableObjectStub<OperatorActivity>,
  options?: { effectReceipts: true; receiptAfter?: number }): Promise<BrowserDetail | null> {
  return await stub.getBrowserDetail(options) as BrowserDetail | null;
}

async function handleBrowserDetail(c: Context<ActivityRouteEnv>, resultOnly: boolean) {
  const activityId = c.req.param('activityId');
  if (!activityId || !await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const cursors = resultOnly ? c.req.queries('receiptAfter') : undefined;
  const invalidCursor = () => c.json({ error: 'Invalid receipt cursor' }, 400);
  if (cursors && (cursors.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(cursors[0])
    || !Number.isSafeInteger(Number(cursors[0])))) return invalidCursor();
  const receiptAfter = cursors ? Number(cursors[0]) : undefined;
  const detail = await browserDetail(c.env.OPERATOR_ACTIVITY!.getByName(activityId), resultOnly
    ? { effectReceipts: true, ...(receiptAfter === undefined ? {} : { receiptAfter }) } : undefined);
  if (receiptAfter !== undefined && (detail?.effectReceipts?.journalCount == null
    || receiptAfter >= detail.effectReceipts.journalCount)) return invalidCursor();
  return detail ? c.json({ ...detail, updatedAt: new Date(detail.updatedAt).toISOString() }) : c.notFound();
}
/** Private read-only adapter: native owner DOs authenticate again and own archive verification. */
async function handleOwnerRawRead(c: Context<ActivityRouteEnv>, view: OwnerRawReadRequest['view']) {
  const invalid = () => c.json({ code: 'INVALID_RAW_CAPTURE_REQUEST' }, 400);
  const authority = c.get('operatorHuman');
  const credential: OwnerRawReadCredential = { email: authority.human.email, accessJwt: authority.accessJwt };
  try {
    await requireOwnerRawReader(c.env, credential);
    if (c.req.raw.body !== null || ['x-operator-owner-key', 'x-operator-owner', 'x-operator-human',
      'x-operator-role', 'x-operator-installation-id', 'x-operator-release-id'].some(header => c.req.raw.headers.has(header))) return invalid();
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some(key => query.getAll(key).length !== 1)) return invalid();
    const parsed = rawReadQuery.safeParse(Object.fromEntries(query));
    if (!parsed.success || (view === 'export') !== (parsed.data.captureId !== undefined)) return invalid();
    const { cursor, captureId, ...scope } = parsed.data;
    const request: OwnerRawReadRequest = { view, scope,
      ...(cursor === undefined ? {} : { cursor }), ...(captureId === undefined ? {} : { captureId }) };
    const response = await (scope.kind === 'observation' ? c.get('registry')
      : c.env.OPERATOR_ACTIVITY!.getByName(scope.activityId)).readOwnerRawCaptures(credential, request);
    // Preserve the native body stream, including read rejection and its final verified receipt.
    const result = new Response(response.body, response);
    result.headers.set('Cache-Control', 'no-store');
    return result;
  } catch (error) {
    const status = error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403) ? error.statusCode : 503;
    return c.json({ code: 'RAW_CAPTURE_UNAVAILABLE' }, status);
  }
}
app.get('/diagnostics/v2/raw', c => handleOwnerRawRead(c, 'discover'));
app.get('/diagnostics/v2/raw/export', c => handleOwnerRawRead(c, 'export'));

app.get('/:activityId', c => handleBrowserDetail(c, false));
app.get('/:activityId/result', c => handleBrowserDetail(c, true));
app.get('/:activityId/diagnostics', async c => {
  c.header('Cache-Control', 'no-store');
  const activityId = c.req.param('activityId');
  if (!await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  if (Object.keys(c.req.query()).length) return c.json({ error: 'Invalid diagnostics request' }, 400);
  const snapshot = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).getDispatcherDiagnostics(c.get('ownerKey'));
  return snapshot?.activityId === activityId ? c.json(snapshot) : c.notFound();
});
async function handleDiagnosticsV2(c: Context<ActivityRouteEnv>, view: 'summary' | 'history' | 'detail' | 'export') {
  c.header('Cache-Control', 'no-store');
  const activityId = c.req.param('activityId');
  if (!activityId || !await owned(c.get('registry'), c.get('ownerKey'), activityId)) return c.notFound();
  const query = new URL(c.req.url).searchParams;
  const cursors = query.getAll('cursor');
  if ([...query.keys()].some(key => key !== 'cursor') || cursors.length > 1
    || cursors.length && (view !== 'history' && view !== 'export'
      || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursors[0]))) return c.json({ code: 'INVALID_DIAGNOSTICS_REQUEST' }, 400);
  const recordId = view === 'detail' ? c.req.param('recordId') : undefined;
  if (view === 'detail' && (!recordId || !/^(e-[1-9][0-9]*|o-(0|[1-9][0-9]*)-[a-f0-9]{64})$/.test(recordId)
    || recordId.length > 84)) return c.json({ code: 'INVALID_DIAGNOSTICS_REQUEST' }, 400);
  try {
    const result = diagnosticsResultSchema.parse(await c.env.OPERATOR_ACTIVITY!.getByName(activityId).getDispatcherDiagnosticsV2(c.get('ownerKey'),
      { view, ...(cursors.length ? { cursor: cursors[0] } : {}), ...(recordId ? { recordId } : {}) }));
    if (result.status !== 200) return c.json({ code: result.code }, result.status);
    return result.value.activityId === activityId ? c.json(result.value) : c.notFound();
  } catch { return c.json({ code: 'DIAGNOSTICS_UNAVAILABLE' }, 503); }
}
app.get('/:activityId/diagnostics/v2', c => handleDiagnosticsV2(c, 'summary'));
app.get('/:activityId/diagnostics/v2/history', c => handleDiagnosticsV2(c, 'history'));
app.get('/:activityId/diagnostics/v2/records/:recordId', c => handleDiagnosticsV2(c, 'detail'));
app.get('/:activityId/diagnostics/v2/export', c => handleDiagnosticsV2(c, 'export'));

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
  const summary = await c.env.OPERATOR_ACTIVITY!.getByName(activityId).getBrowserSummary(c.get('ownerKey'));
  if (!summary) return c.json({ error: 'Cancellation projection unavailable', code: 'CANCELLATION_NOT_CONFIRMED' }, 503);
  return c.json({ ...summary, updatedAt: new Date(summary.updatedAt).toISOString() });
});

export default app;
