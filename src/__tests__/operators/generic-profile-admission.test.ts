import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import routes from '../../routes/operator-activities';
import type { ManagementExecutionSelection } from '../../operators/registry';
import type { NativeOperatorInference } from '../../operators/inference-selection';

const piStorage = vi.hoisted(() => ({ objects: new Map<string, unknown>(), nativeSource: false }));

const claims = {
  subject: 'human-subject', email: 'human@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({ human: claims, accessJwt: 'private.access.jwt' }),
  resolveOperatorGroupIdentity: async () => claims,
  operatorAccessSessionCurrent: async () => true,
  resolveBucketName: async () => 'owner-bucket',
  resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: 'high', routeContextWindows: {},
    routeReasoningLevels: {}, modelDisplayNames: {}, allowPersonalPiProviders: true,
    piDefaultSource: piStorage.nativeSource ? 'pi-native' : 'managed' }),
}));
vi.mock('../../lib/r2-regime-state', () => ({
  isBucketMigrating: async () => false, isR2SseDisabledForBucket: async () => true,
}));
vi.mock('../../lib/r2-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/r2-client')>(),
  createR2Client: () => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'PUT') {
      piStorage.objects.set(path, await request.json());
      return new Response(null, { status: 200 });
    }
    if (request.method === 'DELETE') {
      piStorage.objects.delete(path);
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET') throw new Error('Unexpected R2 method');
    const value = piStorage.objects.get(path);
    return value === undefined ? new Response(null, { status: 404 }) : Response.json(value);
  } }),
}));

type PreparedActivity = { intent: unknown; context: unknown; invocationJson: string };

function fixture(selection?: ManagementExecutionSelection) {
  let prepared: PreparedActivity | undefined;
  const activity = {
    prepareAuthorized: async (intent: unknown, context: unknown, invocationJson: string) => {
      prepared = { intent, context, invocationJson };
      return { ok: true as const, phase: 'prepared' as const };
    },
  };
  const registry = {
    resolveManagementExecution: async () => selection
      ? { ok: true as const, value: structuredClone(selection) }
      : { ok: false as const, reason: 'not-found' as const },
    resolveForExecution: async () => ({ ok: true as const, value: {
      operatorId: 'example-dispatcher', revision: 3, artifactDigest: 'a'.repeat(64),
      manifestJson: '{}', policyJson: '{"schemaVersion":1}', profile: 'dispatcher',
    } }),
  };
  const env = {
    ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)),
    R2_ACCOUNT_ID: 'synthetic-r2-account', R2_ENDPOINT: 'https://r2.example.test',
    OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => activity },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError
    ? c.json(error.toJSON(), error.statusCode as never)
    : c.json({ error: 'Internal error' }, 500));
  app.route('/api/operator-activities', routes);
  const post = (body: unknown) => app.request('https://enterprise.example.test/api/operator-activities', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest',
      'cf-access-authenticated-user-email': claims.email,
    }, body: JSON.stringify(body),
  }, env);
  return { post, prepared: () => prepared };
}

function installedConductor(nativeSource = true) {
  piStorage.nativeSource = nativeSource;
  piStorage.objects.set('/owner-bucket/.pi/agent/settings.json', {
    defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: 'high',
    modelThinkingLevels: { 'openai/gpt-6.1-sol': 'high' },
  });
  piStorage.objects.set('/owner-bucket/.pi/agent/models.json', { providers: {} });
  // Admission reads settings/models only: no auth binding or credentials are needed.
  const policy = { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile',
    inference: { allowedSources: ['managed', 'pi-native'] as Array<'managed' | 'pi-native'>,
      routeIds: ['provider-default'], defaultRouteId: 'provider-default',
      reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'low', inheritUserDefaults: false } };
  const repositoryUrl = 'https://github.com/acme/review-operator';
  const workflow = { id: 9, ref: '.github/workflows/release.yml@refs/heads/main' };
  const selection: ManagementExecutionSelection = {
    controlsRevision: 4,
    installation: { id: 'review-install', operatorId: 'review-operator', name: 'Review',
      revision: 2, enabled: true, releaseId: 'review-release', approvedSourceRevision: 1,
      configurationJson: '{}', piReasoningOverride: 'low', policy: structuredClone(policy) },
    operator: { id: 'review-operator', operatorId: 'review-operator', revision: 3,
      repositoryUrl, repositoryId: 417, profile: 'conductor', realm: 'internal', enabled: true,
      managers: { users: [], groups: [] }, invokers: { users: [claims.email], groups: [] },
      policy: structuredClone(policy), source: { kind: 'github-release', repositoryUrl, repositoryId: 417,
        credentialConfigured: true, approvedWorkflow: workflow } },
    release: { id: 'review-release', operatorId: 'review-operator', githubReleaseId: 17,
      sourceCommit: 'a'.repeat(40), manifestDigest: 'b'.repeat(64), bundleDigest: 'd'.repeat(64),
      interfaceVersion: 1, approved: true, repositoryId: 417, sourceRevision: 1,
      coreVersion: '1', intentVersion: '1', requestedCapabilities: policy.capabilities, assets: [],
      provenance: { compilerCommit: 'c'.repeat(40), workflowId: workflow.id, workflowRef: workflow.ref,
        runId: 701, runAttempt: 1, artifactId: 801, artifactDigest: 'e'.repeat(64) } },
    manifestJson: JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'review-operator',
      name: 'Review operator', description: 'Admission fixture', profile: 'conductor',
      coreVersion: '1', intentVersion: '1', inputSchema: { type: 'object' },
      requiredCapabilities: policy.capabilities,
      artifact: { path: '/operator-bundle.json', sha256: 'd'.repeat(64) } }),
  };
  return fixture(selection);
}

async function nativeInference(overrides: Partial<Pick<NativeOperatorInference,
  'provider' | 'model' | 'api' | 'reasoningLevel'>> = {}): Promise<NativeOperatorInference> {
  // Nonsecret profile identity contract: hash the canonical selection, not saved settings or auth.
  const identity = { source: 'pi-native' as const, provider: 'openai', model: 'gpt-6.1-sol',
    api: 'openai-responses', reasoningLevel: 'low' as const, ...overrides };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)));
  const profileDigest = Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...identity, profileDigest };
}

function conductorInvocation(inference: NativeOperatorInference | { routeId: string; reasoningLevel: string }) {
  return { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId: 'caller-activity', operatorId: 'review-operator', runId: 'ordinary-review',
    source: { kind: 'direct', reference: 'acme/repository' },
    revision: { reference: 'a'.repeat(40), digest: 'b'.repeat(64) }, inputDigest: 'c'.repeat(64),
    input: { request: 'Review the supplied input' }, attachments: [],
    resources: { inference, session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  piStorage.objects.clear();
  piStorage.nativeSource = false;
});

describe('REQ-OPERATOR-047: generic directed profile admission', () => {
  it('admits a bounded Dispatcher package invocation without interpreting package business fields', async () => {
    const { post, prepared } = fixture();

    const response = await post({ operatorId: 'example-dispatcher', invocation: {
      packageAction: 'assess', target: { project: 'package-owned-value', item: 17 },
    } });

    expect(response.status).toBe(201);
    const body = await response.json() as { activityId: string; startCapability: string };
    expect(body).toMatchObject({ activityId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      startCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(prepared()).toMatchObject({
      intent: { operatorId: 'example-dispatcher', activityId: body.activityId,
        intentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      context: { activityId: body.activityId, operatorId: 'example-dispatcher', principal: 'operator' },
      invocationJson: JSON.stringify({ packageAction: 'assess', target: { project: 'package-owned-value', item: 17 } }),
    });
  });

  it('keeps platform authority outside the opaque package invocation', async () => {
    const { post, prepared } = fixture();

    const response = await post({ operatorId: 'example-dispatcher', installationId: 'caller-selected',
      invocation: { packageAction: 'assess' } });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: expect.any(String) });
    expect(prepared()).toBeUndefined();
  });
});

// #109 G1: 007 AC2/4/6 and 047 AC1 belong to ordinary HTTP admission,
// before Activity persists caller resources as trusted inference authority.
describe('REQ-OPERATOR-007/047: ordinary installed Conductor owner-profile admission', () => {
  it('admits matching saved OpenAI/model at installation Low without changing saved global/model High', async () => {
    const { post, prepared } = installedConductor();
    const inference = await nativeInference();
    const invocation = conductorInvocation(inference);
    const saved = structuredClone(piStorage.objects);

    const response = await post({ installationId: 'review-install', invocation });

    expect(response.status).toBe(201);
    const body = await response.json() as { activityId: string; startCapability: string };
    expect(body).toMatchObject({ activityId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      startCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(prepared()).toMatchObject({
      intent: { operatorId: 'review-operator', installationId: 'review-install', activityId: body.activityId,
        expectedRevision: 3, expectedInstallationRevision: 2, expectedControlsRevision: 4 },
      context: { activityId: body.activityId, operatorId: 'review-operator',
        owner: { subject: claims.subject, email: claims.email, issuer: claims.issuer } },
    });
    expect(JSON.parse(prepared()!.invocationJson)).toEqual({ ...invocation, activityId: body.activityId });
    expect(piStorage.objects).toEqual(saved);
  });

  it.each([
    { name: 'provider', override: { provider: 'openai-codex', api: 'openai-codex-responses' } },
    { name: 'model', override: { model: 'gpt-5-mini' } },
    { name: 'High reasoning despite installation Low', override: { reasoningLevel: 'high' as const } },
  ])('refuses an explicit conflicting $name without admission, substitution or saved-profile writes', async ({ override }) => {
    const { post, prepared } = installedConductor();
    // Both scopes approve native and Low/High; these are built-in selections,
    // not catalog/policy-invalid requests. The owner/installation provenance must refuse them.
    const invocation = conductorInvocation(await nativeInference(override));
    const saved = structuredClone(piStorage.objects);

    const response = await post({ installationId: 'review-install', invocation });

    expect([400, 403, 409]).toContain(response.status);
    await expect(response.json()).resolves.toMatchObject({ code: expect.any(String) });
    expect(prepared()).toBeUndefined();
    expect(piStorage.objects).toEqual(saved);
  });

  it('preserves managed installed Conductor inference without applying the native Low override', async () => {
    const { post, prepared } = installedConductor(false);
    const invocation = conductorInvocation({ routeId: 'provider-default', reasoningLevel: 'high' });
    const saved = structuredClone(piStorage.objects);

    const response = await post({ installationId: 'review-install', invocation });

    expect(response.status).toBe(201);
    const body = await response.json() as { activityId: string };
    expect(body.activityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared()).toMatchObject({ intent: { activityId: body.activityId,
      operatorId: 'review-operator', installationId: 'review-install' } });
    expect(JSON.parse(prepared()!.invocationJson)).toEqual({ ...invocation, activityId: body.activityId });
    expect(piStorage.objects).toEqual(saved);
  });
});
