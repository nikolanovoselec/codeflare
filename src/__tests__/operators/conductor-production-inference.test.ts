import { expect, it, vi } from 'vitest';
import { createConductorProductionCapability } from '../../operators/conductor-production';

const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], expiresAt: Math.floor(Date.now() / 1000) + 300 };
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ fetch: async () => Response.json({}) }) }));
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
  const activity = { operatorGenerationCurrent: async () => true, getPackageResources: async () => [],
    readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: [] }) };
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
});
