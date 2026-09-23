import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Env } from '../types';
import { authMiddleware, type AuthVariables } from '../middleware/auth';
import { authenticateRequest, requireOperatorHumanContext, canManageOperator, hasOperatorManagementEligibility } from '../lib/access';
import { isEnterpriseMode } from '../lib/subscription';
import { AppError, ValidationError } from '../lib/error-types';
import { parseJsonBody } from '../lib/request-helpers';
import { createLogger } from '../lib/logger';
import type { OperatorRegistry, ManagementOperatorProjection, ManagementPolicy, ManagementAuthority, ManagementControls,
  ManagementInstallation } from '../operators/registry';
import { registerGithubOperator, refreshGithubReleases, updateGithubOperatorSource } from '../operators/github-release-management';

const logger = createLogger('operator-management');
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const grant = z.strictObject({
  users: z.array(z.string().trim().email().max(320).transform(value => value.toLowerCase())).max(128)
    .refine(values => new Set(values).size === values.length),
  groups: z.array(z.strictObject({ issuer: z.string().url().max(2048), id: z.string().trim().min(1).max(256) })).max(128)
    .refine(values => new Set(values.map(value => JSON.stringify([value.issuer, value.id]))).size === values.length),
});
const policy = z.strictObject({
  capabilities: z.array(z.string().trim().min(1).max(128)).max(32).refine(values => new Set(values).size === values.length),
  resourceProfileId: z.string().regex(ID).nullable(),
});
const githubPat = z.string().min(1).max(16384).refine(value => !!value.trim() && !/[\r\n\0]/.test(value));
const repositoryUrl = z.string().min(1).max(2048);
const registrationBody = z.strictObject({ repositoryUrl, githubPat, profile: z.enum(['conductor', 'dispatcher']), realm: z.enum(['internal', 'external']), managers: grant, invokers: grant, policy });
const configuration = z.record(z.string().max(256), z.json());
const installationBody = z.strictObject({ name: z.string().trim().min(1).max(256), policy, revision, configuration: configuration.default({}) });
const revisionBody = z.strictObject({ revision });
const sourceBody = z.strictObject({ repositoryUrl, githubPat, revision });
const promoteBody = z.strictObject({ releaseId: z.string().regex(ID), revision });
const enableBody = z.strictObject({ revision, enabled: z.boolean() });
const grantsBody = z.strictObject({ managers: grant, invokers: grant, revision });
const configureBody = z.strictObject({ policy, configuration, revision });
const controlsBody = z.strictObject({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), managers: grant,
  ceiling: z.strictObject({ capabilities: policy.shape.capabilities, resourceProfileIds: z.array(z.string().regex(ID)).max(128)
    .refine(values => new Set(values).size === values.length) }) });

type HumanContext = Awaited<ReturnType<typeof requireOperatorHumanContext>> & { controls: ManagementControls; platformAdmin: boolean };
type Variables = AuthVariables & { operatorHuman: HumanContext; registry: DurableObjectStub<OperatorRegistry> };
type RouteEnv = { Bindings: Env; Variables: Variables };
const app = new Hono<RouteEnv>();

app.use('*', async (c, next) => isEnterpriseMode(c.env) ? next() : c.notFound());
app.use('*', authMiddleware);
app.use('*', async (c, next) => {
  if (!c.env.OPERATOR_REGISTRY) throw new AppError('UNAVAILABLE', 503, 'Operator management unavailable');
  c.set('registry', c.env.OPERATOR_REGISTRY.getByName('registry'));
  return next();
});
function requireMutationCsrf(c: Context<RouteEnv>): void {
  if (c.req.header('x-requested-with') !== 'XMLHttpRequest') {
    throw new AppError('FORBIDDEN', 403, 'CSRF validation failed');
  }
}
app.use('*', async (c, next) => {
  // Grant mutations authorize the target before exposing CSRF rejection, so an
  // unauthorized caller cannot enumerate the operator through this endpoint.
  if (c.req.method === 'POST' && !/\/operators\/[A-Za-z0-9_-]{1,128}\/grants$/.test(new URL(c.req.raw.url).pathname)) {
    requireMutationCsrf(c);
  }
  return next();
});
app.use('*', async (c, next) => {
  c.set('operatorHuman', await managementContext(c));
  return next();
});
app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

function denied(): never { throw new AppError('NOT_FOUND', 404, 'Operator not found'); }
function result<T>(value: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (value.ok) return value.value;
  const hidden = value.reason === 'not-found' || value.reason === 'authority-expired';
  throw new AppError(hidden ? 'NOT_FOUND' : 'CONFLICT', hidden ? 404 : 409, hidden ? 'Operator not found' : 'Operator management conflict');
}
function presentInstallation(installation: ManagementInstallation): Record<string, unknown> {
  let configurationValue: unknown;
  try { configurationValue = JSON.parse(installation.configurationJson); }
  catch { throw new AppError('UNAVAILABLE', 503, 'Operator installation configuration unavailable'); }
  const configurationValueResult = configuration.safeParse(configurationValue);
  if (!configurationValueResult.success) throw new AppError('UNAVAILABLE', 503, 'Operator installation configuration unavailable');
  const { configurationJson: _, ...publicInstallation } = installation;
  return { ...publicInstallation, configuration: configurationValueResult.data };
}
async function managementContext(c: Context<RouteEnv>, fresh = false): Promise<HumanContext> {
  // New management authority uses the authenticated platform role or stable,
  // issuer-bound management grants. Legacy display-name admin groups do not
  // confer authority on this surface.
  const user = fresh ? (await authenticateRequest(c.req.raw, c.env)).user : c.get('user');
  const context = await requireOperatorHumanContext(c.req.raw, c.env, user.email);
  const platformAdmin = user.role === 'admin';
  const controls = await c.get('registry').getManagementControls();
  if (!platformAdmin && !hasOperatorManagementEligibility(context.human, controls.managers)) denied();
  return { ...context, controls, platformAdmin };
}
function scopedManager(context: HumanContext, operator: Pick<ManagementOperatorProjection, 'managers' | 'invokers'>): boolean {
  return context.platformAdmin || canManageOperator(context.human, operator, context.controls.managers);
}
function withinCeiling(context: HumanContext, policy: ManagementPolicy): void {
  if (context.controls.revision === 0 || !policy.capabilities.every(capability => context.controls.ceiling.capabilities.includes(capability))
    || (policy.resourceProfileId !== null && !context.controls.ceiling.resourceProfileIds.includes(policy.resourceProfileId))) denied();
}
function authority(c: Context<RouteEnv>, operator: ManagementOperatorProjection, expectedRevision = operator.revision): ManagementAuthority {
  return { operatorRevision: expectedRevision, controlsRevision: c.get('operatorHuman').controls.revision, expiresAt: c.get('operatorHuman').human.expiresAt * 1000 };
}
async function managed(c: Context<RouteEnv>, operatorId: string): Promise<ManagementOperatorProjection> {
  if (!ID.test(operatorId)) denied();
  const operator = result(await c.get('registry').getManagementOperator(operatorId));
  if (!scopedManager(c.get('operatorHuman'), operator)) denied();
  return operator;
}
function acquisitionContext(c: Context<RouteEnv>, operator?: ManagementOperatorProjection, registrationPolicy?: ManagementPolicy) {
  const original = c.get('operatorHuman').human;
  const controlsRevision = c.get('operatorHuman').controls.revision;
  return { registry: c.get('registry'), human: original, controlsRevision, encryption: c.env, reauthorize: async () => {
    const current = await managementContext(c, true);
    if (current.controls.revision !== controlsRevision) throw new AppError('CONFLICT', 409, 'Operator management conflict');
    if (current.human.subject !== original.subject || current.human.issuer !== original.issuer || current.human.email !== original.email) denied();
    c.set('operatorHuman', current);
    if (operator) {
      const fresh = await managed(c, operator.id);
      if (fresh.revision !== operator.revision) throw new AppError('CONFLICT', 409, 'Operator management conflict');
      withinCeiling(current, fresh.policy);
    }
    if (registrationPolicy) withinCeiling(current, registrationPolicy);
    return current.human;
  } };
}
function query(c: Context<RouteEnv>) {
  const url = new URL(c.req.raw.url);
  const allowed = new Set(['cursor', 'limit', 'query', 'profile', 'realm', 'state']);
  for (const [name] of url.searchParams) if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) throw new ValidationError('Invalid operator catalog query');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw === undefined ? 50 : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Invalid operator catalog query');
  const cursor = c.req.query('cursor') ?? null;
  if (cursor !== null && !ID.test(cursor)) throw new ValidationError('Invalid operator catalog query');
  const profile = c.req.query('profile'); const realm = c.req.query('realm'); const state = c.req.query('state'); const search = c.req.query('query');
  if ((profile !== undefined && profile !== 'conductor' && profile !== 'dispatcher') || (realm !== undefined && realm !== 'internal' && realm !== 'external')
    || (state !== undefined && state !== 'enabled' && state !== 'disabled') || (search !== undefined && (search.length > 256 || !search.trim()))) throw new ValidationError('Invalid operator catalog query');
  return { limit, cursor, profile, realm, state, search: search?.trim().toLowerCase() };
}

app.get('/access', c => {
  const context = c.get('operatorHuman');
  if (!context.platformAdmin) denied();
  return c.json(context.controls);
});

app.post('/access', async c => {
  if (!c.get('operatorHuman').platformAdmin) denied();
  const input = await parseJsonBody(c, controlsBody);
  const human = c.get('operatorHuman').human;
  return c.json(result(await c.get('registry').setManagementControls(input, { email: human.email, expiresAt: human.expiresAt * 1000 })));
});

app.get('/operators', async c => {
  const human = c.get('operatorHuman').human;
  return c.json(await c.get('registry').listManagementOperators({ ...query(c), email: human.email, issuer: human.issuer, groups: [...(human.groups ?? [])], platformAdmin: c.get('operatorHuman').platformAdmin }));
});

app.post('/operators', async c => {
  const input = await parseJsonBody(c, registrationBody);
  if (!scopedManager(c.get('operatorHuman'), input)) denied();
  withinCeiling(c.get('operatorHuman'), input.policy);
  const context = acquisitionContext(c, undefined, input.policy);
  const reauthorize = context.reauthorize;
  const created = result(await registerGithubOperator({ ...context, reauthorize: async () => {
    const human = await reauthorize();
    if (!scopedManager(c.get('operatorHuman'), input)) denied();
    return human;
  } }, input));
  logger.info('Operator registered', { actor: c.get('operatorHuman').human.email, operatorId: created.id, revision: created.revision });
  return c.json(created, 201);
});

app.get('/operators/:operatorId', async c => {
  const operator = await managed(c, c.req.param('operatorId'));
  const [releases, installations] = await Promise.all([
    c.get('registry').getManagementReleases(operator.id), c.get('registry').getManagementInstallations(operator.id),
  ]);
  // A concurrent ACL change must not make the earlier authorization a data grant.
  const current = await managed(c, operator.id);
  if (current.revision !== operator.revision) throw new AppError('CONFLICT', 409, 'Operator management conflict');
  return c.json({ operator: current, releases, installations: installations.map(presentInstallation), grants: { managers: current.managers, invokers: current.invokers } });
});

app.post('/operators/:operatorId/releases/refresh', async c => {
  const input = await parseJsonBody(c, revisionBody);
  const operator = await managed(c, c.req.param('operatorId'));
  withinCeiling(c.get('operatorHuman'), operator.policy);
  const items = await refreshGithubReleases(acquisitionContext(c, operator), operator.id, input.revision);
  return c.json({ items });
});

app.post('/operators/:operatorId/source', async c => {
  const input = await parseJsonBody(c, sourceBody);
  const operator = await managed(c, c.req.param('operatorId'));
  withinCeiling(c.get('operatorHuman'), operator.policy);
  return c.json(result(await updateGithubOperatorSource(acquisitionContext(c, operator), operator.id, input.revision, input)));
});

app.post('/operators/:operatorId/installations', async c => {
  const input = await parseJsonBody(c, installationBody);
  const operator = await managed(c, c.req.param('operatorId'));
  withinCeiling(c.get('operatorHuman'), input.policy);
  return c.json(presentInstallation(result(await c.get('registry').createManagementInstallation(operator.id, input.name, input.policy, authority(c, operator, input.revision), JSON.stringify(input.configuration)))), 201);
});

app.post('/operators/:operatorId/grants', async c => {
  const operator = await managed(c, c.req.param('operatorId'));
  requireMutationCsrf(c);
  const input = await parseJsonBody(c, grantsBody);
  const updated = result(await c.get('registry').setManagementGrants(operator.id, input.managers, input.invokers, authority(c, operator, input.revision)));
  logger.info('Operator grants changed', { actor: c.get('operatorHuman').human.email, operatorId: operator.id, revision: updated.revision });
  return c.json(updated);
});

async function managedInstallation(c: Context<RouteEnv>) {
  const id = c.req.param('installationId');
  if (!id || !ID.test(id)) denied();
  const installation = result(await c.get('registry').getManagementInstallation(id)) as ManagementInstallation;
  const operator = await managed(c, installation.operatorId);
  return { installation, operator };
}

app.post('/installations/:installationId/promote', async c => {
  const input = await parseJsonBody(c, promoteBody);
  const { installation, operator } = await managedInstallation(c);
  withinCeiling(c.get('operatorHuman'), installation.policy);
  const promoted = result(await c.get('registry').promoteManagementInstallation(installation.id, input.releaseId, input.revision, authority(c, operator)));
  return c.json(presentInstallation(promoted));
});

app.post('/installations/:installationId/enable', async c => {
  const input = await parseJsonBody(c, enableBody);
  const { installation, operator } = await managedInstallation(c);
  if (input.enabled) withinCeiling(c.get('operatorHuman'), installation.policy);
  const enabled = result(await c.get('registry').setManagementInstallationEnabled(installation.id, input.enabled, input.revision, authority(c, operator)));
  return c.json(presentInstallation(enabled));
});

app.post('/installations/:installationId/configure', async c => {
  const input = await parseJsonBody(c, configureBody);
  const { installation, operator } = await managedInstallation(c);
  withinCeiling(c.get('operatorHuman'), input.policy);
  const configured = result(await c.get('registry').configureManagementInstallation(installation.id, {
    policy: input.policy, configurationJson: JSON.stringify(input.configuration), revision: input.revision,
  }, authority(c, operator)));
  return c.json(presentInstallation(configured));
});

export default app;
