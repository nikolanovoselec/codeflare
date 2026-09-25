import { expect, it, vi } from 'vitest';
import { createConductorProductionCapability } from '../../operators/conductor-production';

const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], expiresAt: Math.floor(Date.now() / 1000) + 300 };
const piTransport = vi.hoisted(() => ({ task: null as unknown }));
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ fetch: async (request: Request) => {
  if (new URL(request.url).pathname === '/internal/operator/pi/tasks') {
    piTransport.task = await request.json();
    return Response.json({ taskId: 'approved-round', status: 'completed' });
  }
  return Response.json({});
} }) }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: async () => 'owner-bucket',
  resolveOperatorGroupIdentity: async () => human,
  canInvokeOperator: () => true,
  resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: '', routeContextWindows: {},
    routeReasoningLevels: {}, modelDisplayNames: {} }),
}));
vi.mock('../../operators/execution-context', () => ({
  openOperatorExecutionAccess: async () => ({ human, accessJwt: 'sealed-access' }),
}));
vi.mock('../../operators/session-bootstrap', () => ({ bootstrapOperatorSession: async () => ({ bootstrap: {} }) }));
vi.mock('../../operators/owned-session-runtime', () => ({ ContainerOwnedSessionRuntime: class {} }));
vi.mock('../../operators/owned-session', () => ({ OwnedOperatorSessionService: class {
  ensure = async () => ({ status: 'ready' });
  stop = async () => ({ status: 'stopped' });
} }));
vi.mock('../../operators/owned-session-production', () => ({
  operatorActivitySessionStore: () => ({}), createOperatorSyncReader: async () => async () => null,
}));

const activityId = 'review-activity';
const selection = { installation: { id: 'review-install', revision: 2,
  policy: { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' } },
operator: { operatorId: 'review-operator', revision: 3, profile: 'conductor' },
release: { bundleDigest: 'd'.repeat(64) }, controlsRevision: 4 };

it('REQ-OPERATOR-053: a provider-default inference route admits a scoped Conductor session without a reasoning grade', async () => {
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId, operatorId: 'review-operator', runId: activityId,
    source: { kind: 'session', reference: 'owner/repo' },
    revision: { reference: 'a'.repeat(40), digest: 'b'.repeat(64) }, inputDigest: 'c'.repeat(64),
    input: {}, attachments: [], resources: { inference: { routeId: 'provider-default', reasoningLevel: null },
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
  const approvedFile = { name: 'packet-code.json', locator: 'approved-packet', size: 12,
    sha256: 'a'.repeat(64), mediaType: 'application/json' };
  let claimed = false;
  const initialization = { schemaVersion: 1, profileId: 'review-profile', contextPath: 'review/input.json',
    context: '{}', inputs: [
      { kind: 'attachment', reference: approvedFile.name, target: 'review/packets/code.json' },
      { kind: 'resource', reference: 'review/code.md', target: 'review/resources/code.md' },
    ], tasks: [{ id: 'code', instruction: 'review/resources/code.md',
      reads: ['review/input.json', 'review/packets/code.json', 'review/resources/code.md'],
      output: 'reports/code.json' }] };
  let checkpointInitialization: unknown = initialization;
  const activity = { operatorGenerationCurrent: async () => true,
    getPackageResources: async () => ({ schemaVersion: 1, artifactDigest: 'd'.repeat(64), files: [{
      destination: 'review/code.md', sha256: 'b'.repeat(64), size: 8, content: 'approved',
    }] }),
    getCurrentDriveCheckpoint: async (generation: number) => generation === 1
      ? { initialization: checkpointInitialization } : null,
    readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: claimed ? [approvedFile] : [] }) };
  const env = { OPERATOR_REGISTRY: { getByName: () => ({ resolveManagementExecution: async () => ({ ok: true, value: selection }) }) },
    CONTAINER: {} };
  const plan = { activityId, deadline: Date.now() + 300_000, invocationJson: JSON.stringify(invocation),
    receipt: { selection }, executionContext: { policyDigest: 'e'.repeat(64) } };
  const { capability } = await createConductorProductionCapability({ env: env as never,
    plan: plan as never, activity: activity as never, generation: 1,
    driveDeadline: Date.now() + 25_000 });
  const response = await capability.fetch(new Request('https://operator.internal/v1/session/ensure', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1 }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ready' });
  claimed = true;
  const post = (value: unknown) => capability.fetch(new Request('https://operator.internal/v1/session/ensure', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, initialization: value }),
  }));
  expect((await post({ ...initialization, profileId: 'other-profile' })).status).toBe(403);
  expect((await post({ ...initialization, context: '{"substituted":true}' })).status).toBe(403);
  expect((await post(initialization)).status).toBe(200);
  checkpointInitialization = null;
  expect((await post(initialization)).status).toBe(403);
  const task = { schemaVersion: 1, taskId: 'approved-round', digest: 'c'.repeat(64), mode: 'tool',
    toolName: 'run_approved_tasks', arguments: { initializationDigest: 'd'.repeat(64) } };
  expect((await capability.fetch(new Request('https://operator.internal/v1/pi/tasks', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) }))).status).toBe(200);
  expect(piTransport.task).toEqual({ taskId: task.taskId, digest: task.digest, mode: task.mode,
    toolName: task.toolName, arguments: task.arguments });
});
