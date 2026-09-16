import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { requireOperatorHumanContext } from '../../lib/access';
import { isEnterpriseMode } from '../../lib/subscription';
import { AppError, ValidationError } from '../../lib/error-types';
import { parseJsonBody } from '../../lib/request-helpers';
import type { OperatorRegistry, OperatorRegistryResult } from '../../operators/registry';
import { registerDiscoveredOperator, approveRegisteredOperator } from '../../operators/administration';
import { parseOperatorPolicy } from '../../operators/policy';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const endpoint = z.string().min(1).max(2048);
const secret = z.string().min(1).max(16384).refine(value => !!value.trim() && !/[\r\n\0]/.test(value));
const registrationBody = z.strictObject({ endpoint, connectionSecret: secret, policy: z.unknown() });
const distributionBody = z.strictObject({ endpoint, connectionSecret: secret, expectedRevision: revision });
const revisionBody = z.strictObject({ expectedRevision: revision });
const enableBody = z.strictObject({ expectedRevision: revision, enabled: z.boolean() });
const policyBody = z.strictObject({ expectedRevision: revision, policy: z.unknown() });
const approvalBody = z.strictObject({ expectedRevision: revision, artifactDigest: z.string().regex(/^[0-9a-f]{64}$/) });
type HumanContext = Awaited<ReturnType<typeof requireOperatorHumanContext>>;
type Variables = AuthVariables & { operatorHuman: HumanContext; operatorRegistry: DurableObjectStub<OperatorRegistry> };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Enterprise gating precedes authentication or protected registry access. Existing
// authentication/admin-group behavior is reused; operator eligibility adds human
// provenance and identity matching instead of accepting another auth mode.
app.use('*', async (c, next) => {
  if (!isEnterpriseMode(c.env)) return c.notFound();
  return next();
});
app.use('*', authMiddleware, requireAdmin);
app.use('*', async (c, next) => {
  c.set('operatorHuman', await requireOperatorHumanContext(c.req.raw, c.env, c.get('user').email));
  if (!c.env.OPERATOR_REGISTRY) throw new AppError('UNAVAILABLE', 503, 'Operator registry unavailable');
  c.set('operatorRegistry', c.env.OPERATOR_REGISTRY.getByName('registry'));
  return next();
});
app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
app.use('/:operatorId/*', async (c, next) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(c.req.param('operatorId') ?? '')) throw new ValidationError('Invalid operator ID');
  return next();
});

/** Map safe transactional outcomes without reflecting protected record contents. */
function value<T>(result: OperatorRegistryResult<T>): T {
  if (result.ok) return result.value;
  throw new AppError(result.reason === 'not-found' ? 'NOT_FOUND' : 'CONFLICT', result.reason === 'not-found' ? 404 : 409, result.reason);
}

app.get('/', async c => c.json({ operators: await c.get('operatorRegistry').listRegistrations() }));
app.post('/', async c => {
  const input = await parseJsonBody(c, registrationBody);
  const result = await registerDiscoveredOperator({ registry: c.get('operatorRegistry'),
    ...c.get('operatorHuman'), encryption: c.env }, { endpoint: input.endpoint,
    connectionSecret: input.connectionSecret, policy: input.policy });
  return c.json(value(result), 201);
});
app.post('/:operatorId/approve', async c => {
  const input = await parseJsonBody(c, approvalBody);
  const result = await approveRegisteredOperator({ registry: c.get('operatorRegistry'),
    ...c.get('operatorHuman'), encryption: c.env }, { ...input, operatorId: c.req.param('operatorId') });
  return c.json(value(result));
});
app.post('/:operatorId/distribution', async c => {
  const input = await parseJsonBody(c, distributionBody);
  return c.json(value(await c.get('operatorRegistry').setDistribution(c.req.param('operatorId'), input.endpoint,
    input.connectionSecret, input.expectedRevision)));
});
app.post('/:operatorId/policy', async c => {
  const input = await parseJsonBody(c, policyBody);
  const policy = parseOperatorPolicy(input.policy);
  return c.json(value(await c.get('operatorRegistry').setPolicy(c.req.param('operatorId'), JSON.stringify(policy), input.expectedRevision)));
});
app.post('/:operatorId/enable', async c => {
  const input = await parseJsonBody(c, enableBody);
  return c.json(value(await c.get('operatorRegistry').setEnabled(c.req.param('operatorId'), input.enabled, input.expectedRevision)));
});
app.post('/:operatorId/webhook-key', async c => {
  const input = await parseJsonBody(c, revisionBody);
  return c.json(value(await c.get('operatorRegistry').rotateWebhookKey(c.req.param('operatorId'), input.expectedRevision)));
});
export default app;
