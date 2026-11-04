import { afterEach, expect, it, vi } from 'vitest';
import { createConductorProductionCapability } from '../../operators/conductor-production';
import { operatorOwnerKey } from '../../operators/browser-activity';
import type { OperatorPolicy } from '../../operators/policy';

const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], expiresAt: Math.floor(Date.now() / 1000) + 300 };
const piTransport = vi.hoisted(() => ({ task: null as unknown,
  requests: [] as Array<{ path: string; body: unknown }>, profiles: [] as unknown[],
  objects: new Map<string, unknown>(), reads: [] as Array<{ method: string; path: string }>,
  current: true, bucket: 'owner-bucket', revokeAfterRead: false, authFailure: null as unknown,
  reasoning: '', provisionedBuckets: new Set<string>() }));
afterEach(() => {
  piTransport.requests = []; piTransport.profiles = []; piTransport.objects.clear(); piTransport.reads = [];
  piTransport.current = true; piTransport.bucket = 'owner-bucket'; piTransport.revokeAfterRead = false;
  piTransport.authFailure = null; piTransport.reasoning = ''; piTransport.provisionedBuckets.clear();
});
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ fetch: async (request: Request) => {
  const path = new URL(request.url).pathname;
  const body = request.body ? await request.json() : null;
  piTransport.requests.push({ path, body });
  if (path === '/internal/operator/pi/tasks') {
    piTransport.task = body;
    return Response.json({ taskId: 'approved-round', status: piTransport.authFailure ? 'failed' : 'completed',
      ...(piTransport.authFailure ? { authFailure: piTransport.authFailure } : {}) });
  }
  return Response.json({ ready: true });
} }) }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: async () => piTransport.bucket,
  resolveOperatorGroupIdentity: async () => human,
  canInvokeOperator: () => true,
  resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: piTransport.reasoning, routeContextWindows: {},
    routeReasoningLevels: {}, modelDisplayNames: {},
    ...(piTransport.objects.size ? { piDefaultSource: 'pi-native', allowPersonalPiProviders: true } : {}) }),
}));
vi.mock('../../operators/execution-context', () => ({
  openOperatorExecutionAccess: async () => ({ human, accessJwt: 'sealed-access' }),
}));
vi.mock('../../operators/session-bootstrap', () => ({ bootstrapOperatorSession: async (input: { ownerBucket: string }) => {
  piTransport.provisionedBuckets.add(input.ownerBucket);
  return { bootstrap: { r2AccessKeyId: 'synthetic-scoped-id', r2SecretAccessKey: 'synthetic-scoped-secret',
    r2Endpoint: 'https://r2.example.test' } };
} }));
vi.mock('../../lib/r2-regime-state', () => ({
  isBucketMigrating: async () => false, isR2SseDisabledForBucket: async () => true,
}));
vi.mock('../../lib/r2-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/r2-client')>(),
  createR2Client: () => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    piTransport.reads.push({ method: request.method, path });
    if (piTransport.revokeAfterRead) piTransport.current = false;
    const value = piTransport.objects.get(path);
    return value === undefined ? new Response(null, { status: 404 }) : Response.json(value);
  } }),
}));
vi.mock('../../operators/owned-session-runtime', () => ({ ContainerOwnedSessionRuntime: class {} }));
vi.mock('../../operators/owned-session', () => ({ OwnedOperatorSessionService: class {
  ensure = async (input: { profile: unknown }) => {
    piTransport.profiles.push(input.profile);
    return { status: 'ready' };
  };
  stop = async () => ({ status: 'stopped' });
} }));
vi.mock('../../operators/owned-session-production', () => ({
  operatorActivitySessionStore: () => ({}), createOperatorSyncReader: async () => async () => null,
}));

const activityId = 'review-activity';
const selection = { installation: { id: 'review-install', revision: 2,
  policy: { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' } },
operator: { operatorId: 'review-operator', revision: 3, profile: 'conductor',
  policy: { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' } },
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
    getCurrentDriveCheckpointJson: async (generation: number) => generation === 1
      ? JSON.stringify({ initialization: checkpointInitialization }) : null,
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

type InferencePolicy = OperatorPolicy['inference'];
const managedPolicy: InferencePolicy = { allowedSources: ['managed'], routeIds: ['provider-default'],
  defaultRouteId: 'provider-default', reasoningLevels: ['off'], defaultReasoningLevel: 'off', inheritUserDefaults: false };
const managedRestrictions: Array<[string, InferencePolicy]> = [
  ['source', { ...managedPolicy, allowedSources: ['pi-native'] }],
  ['route', { ...managedPolicy, routeIds: ['other-route'], defaultRouteId: 'other-route' }],
  ['reasoning', { ...managedPolicy, reasoningLevels: ['high'], defaultReasoningLevel: 'high' }],
];
async function managedCapability(policies: { operator?: InferencePolicy; installation?: InferencePolicy },
  inference: { routeId: string; reasoningLevel: string | null } | null = { routeId: 'provider-default', reasoningLevel: 'off' }) {
  const selected = structuredClone(selection);
  const current = () => ({ ...selected,
    installation: { ...selected.installation, policy: { ...selected.installation.policy, inference: policies.installation } },
    operator: { ...selected.operator, policy: { ...selected.operator.policy, inference: policies.operator } } });
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId, operatorId: 'review-operator', runId: activityId,
    source: { kind: 'session', reference: 'owner/repo' },
    revision: { reference: 'a'.repeat(40), digest: 'b'.repeat(64) }, inputDigest: 'c'.repeat(64),
    input: {}, attachments: [], resources: { inference,
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
  const activity = { operatorGenerationCurrent: async () => true, getPackageResources: async () => null,
    readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: [] }) };
  const env = { OPERATOR_REGISTRY: { getByName: () => ({ resolveManagementExecution: async () => ({ ok: true, value: current() }) }) },
    CONTAINER: {} };
  const plan = { activityId, deadline: Date.now() + 300_000, invocationJson: JSON.stringify(invocation),
    receipt: { selection: structuredClone(current()) }, executionContext: { policyDigest: 'e'.repeat(64) } };
  return (await createConductorProductionCapability({ env: env as never, plan: plan as never,
    activity: activity as never, generation: 1, driveDeadline: Date.now() + 25_000 })).capability;
}

for (const role of ['operator', 'installation'] as const) {
  it.each(managedRestrictions)(`REQ-OPERATOR-007/047: managed Conductor ${role} %s denial precedes bootstrap`, async (_name, restriction) => {
    piTransport.reasoning = 'off';
    await expect(managedCapability({ [role]: restriction })).rejects.toThrow();
    expect(piTransport.provisionedBuckets).toEqual(new Set());
    expect(piTransport.requests).toEqual([]);
    expect(piTransport.profiles).toEqual([]);
  });

  it.each(managedRestrictions)(`REQ-OPERATOR-007/047: warmed managed Conductor rechecks ${role} %s before execution`, async (_name, restriction) => {
    piTransport.reasoning = 'off';
    const policies = { operator: managedPolicy, installation: managedPolicy };
    const capability = await managedCapability(policies);
    const ensure = () => capability.fetch(new Request('https://operator.internal/v1/session/ensure', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1 }),
    }));
    expect((await ensure()).status).toBe(200);
    const profiles = structuredClone(piTransport.profiles);
    const requests = structuredClone(piTransport.requests);
    policies[role] = restriction;
    expect((await ensure()).status).toBe(403);
    const task = await capability.fetch(new Request('https://operator.internal/v1/pi/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1,
        taskId: 'denied-round', digest: 'c'.repeat(64), mode: 'tool', toolName: 'run_approved_tasks',
        arguments: { initializationDigest: 'd'.repeat(64) } }),
    }));
    expect(task.status).toBe(403);
    expect(piTransport.profiles).toEqual(profiles);
    expect(piTransport.requests).toEqual(requests);
  });
}

it('REQ-OPERATOR-007/053: null inference resource denies before bootstrap without inheriting a human default', async () => {
  await expect(managedCapability({}, null)).rejects.toThrow();
  expect(piTransport.provisionedBuckets).toEqual(new Set());
  expect(piTransport.requests).toEqual([]);
  expect(piTransport.profiles).toEqual([]);
});

it('REQ-OPERATOR-007/047: null managed selection cannot bypass installed source restrictions before bootstrap', async () => {
  await expect(managedCapability({ operator: { ...managedPolicy, allowedSources: ['pi-native'] } }, null)).rejects.toThrow();
  expect(piTransport.provisionedBuckets).toEqual(new Set());
  expect(piTransport.requests).toEqual([]);
  expect(piTransport.profiles).toEqual([]);
});

// Native obligations belong to 007/047, not completion of 050's historical
// universal-initialization/checkpoint gap. All credentials below are synthetic.
const nativeSelection = { source: 'pi-native', provider: 'openai-codex', model: 'gpt-6.1-sol',
  api: 'openai-codex-responses', reasoningLevel: 'low', profileDigest: '9'.repeat(64) };
const recovery = 'The saved Pi authentication is missing, expired or rejected. Open your Pi session, run /login or update the API key, wait for successful synchronization to R2, then explicitly retry.';
async function nativeCapability(auth: 'valid' | 'missing' | 'expired' = 'valid',
  storageEnvironment: Record<string, unknown> = {}, persisted: { authFailure?: unknown } = {}) {
  piTransport.objects.set('/owner-bucket/.pi/agent/settings.json', {
    defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: 'high',
  });
  piTransport.objects.set('/owner-bucket/.pi/agent/models.json', { providers: {} });
  piTransport.objects.set('/owner-bucket/.pi/agent/auth.json', auth === 'missing' ? {} : {
    'openai-codex': { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh-never-forward',
      expires: Date.now() + (auth === 'expired' ? -1_000 : 60_000), accountId: 'synthetic-account' },
  });
  const policy = { ...selection.operator.policy, loggingEnabled: false,
    inference: { allowedSources: ['pi-native'], routeIds: [], defaultRouteId: null,
      reasoningLevels: ['low'], defaultReasoningLevel: 'low', inheritUserDefaults: false } };
  const selected = { ...selection, installation: { ...selection.installation,
    piReasoningOverride: 'low', policy }, operator: { ...selection.operator, policy } };
  const ownerKey = await operatorOwnerKey(human);
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId, operatorId: 'review-operator', runId: activityId,
    source: { kind: 'session', reference: 'owner/repo' },
    revision: { reference: 'a'.repeat(40), digest: 'b'.repeat(64) }, inputDigest: 'c'.repeat(64),
    input: {}, attachments: [], resources: { inference: nativeSelection,
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
  const activity = { operatorGenerationCurrent: async () => piTransport.current,
    getRuntimePlan: async () => ({ ...plan, inferenceSelection: nativeSelection, ...persisted }),
    recordConductorPiAuthFailure: async (generation: number, profileDigest: string, failure: unknown) => {
      if (!piTransport.current || generation !== 1 || profileDigest !== nativeSelection.profileDigest) return false;
      persisted.authFailure = failure; return true;
    },
    getPackageResources: async () => null,
    readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: [] }) };
  const env = { ENCRYPTION_KEY: btoa('p'.repeat(32)), CONTAINER: {},
    R2_ACCOUNT_ID: 'synthetic-r2-account', R2_ENDPOINT: 'https://r2.example.test',
    OPERATOR_REGISTRY: { getByName: () => ({ resolveManagementExecution: async () => ({ ok: true, value: selected }) }) },
    ...storageEnvironment };
  const plan = { activityId, deadline: Date.now() + 300_000, invocationJson: JSON.stringify(invocation),
    receipt: { selection: selected }, executionContext: { ownerKey, policyDigest: 'e'.repeat(64) } };
  return (await createConductorProductionCapability({ env: env as never, plan: plan as never,
    activity: activity as never, generation: 1, driveDeadline: Date.now() + 25_000 })).capability;
}
const ensureNative = (capability: Fetcher) => capability.fetch(new Request('https://operator.internal/v1/session/ensure', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1 }),
}));

it('REQ-OPERATOR-007/047: Conductor reads only the owner fixed Pi keys and prepares native Low', async () => {
  const capability = await nativeCapability();
  const result = await ensureNative(capability);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ status: 'ready' });
  expect(piTransport.profiles).toEqual([expect.objectContaining({ ownerBucket: 'owner-bucket',
    piProfile: expect.objectContaining({ source: 'pi-native', provider: 'openai-codex',
      model: 'gpt-6.1-sol', api: nativeSelection.api, thinkingLevel: 'low' }) })]);
  expect(piTransport.reads.length).toBeGreaterThan(0);
  for (const read of piTransport.reads) {
    expect(read.method).toBe('GET');
    expect(['/owner-bucket/.pi/agent/settings.json', '/owner-bucket/.pi/agent/auth.json',
      '/owner-bucket/.pi/agent/models.json']).toContain(read.path);
  }
  expect(JSON.stringify(piTransport.profiles)).not.toMatch(/synthetic-access|synthetic-refresh|synthetic-scoped/);
});

it('REQ-OPERATOR-047: native preparation without configured storage denies without account discovery or configuration writes', async () => {
  const configuration = new Map<string, string>();
  const destinations: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    destinations.push(input instanceof Request ? input.url : String(input));
    return Response.json({ success: true, result: [{ id: 'synthetic-discovered-account' }] });
  });
  try {
    const capability = await nativeCapability('valid', { R2_ACCOUNT_ID: undefined, R2_ENDPOINT: undefined,
      CLOUDFLARE_API_TOKEN: 'synthetic-platform-token', KV: {
        get: async (key: string) => configuration.get(key) ?? null,
        put: async (key: string, value: string) => { configuration.set(key, value); },
      } });
    expect((await ensureNative(capability)).status).not.toBe(200);
    // Read-only native preparation permits no account-discovery destination or setup writes.
    expect(destinations).toEqual([]);
    expect(configuration).toEqual(new Map());
    expect(piTransport.requests).toEqual([]);
    expect(piTransport.profiles).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});

it('REQ-OPERATOR-047: native preparation can read an already-configured KV account without changing configuration', async () => {
  const configuration = new Map([['setup:account_id', 'synthetic-r2-account']]);
  const capability = await nativeCapability('valid', { R2_ACCOUNT_ID: undefined, R2_ENDPOINT: undefined, KV: {
    get: async (key: string) => configuration.get(key) ?? null,
    put: async (key: string, value: string) => { configuration.set(key, value); },
  } });
  const response = await ensureNative(capability);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ready' });
  expect(configuration).toEqual(new Map([['setup:account_id', 'synthetic-r2-account']]));
  expect(piTransport.profiles).toEqual([expect.objectContaining({ ownerBucket: 'owner-bucket' })]);
});

it('REQ-OPERATOR-047: mid-read revocation cannot bind credentials or start Conductor native work', async () => {
  piTransport.revokeAfterRead = true;
  // Preparation may deny before a capability exists; either way no protected
  // host effect or credential write is permitted after revocation.
  let denied = false;
  try { denied = (await ensureNative(await nativeCapability())).status !== 200; }
  catch { denied = true; }
  expect(denied).toBe(true);
  expect(piTransport.requests).toEqual([]);
  expect(piTransport.profiles).toEqual([]);
  expect(piTransport.reads.length).toBeGreaterThan(0);
  expect(piTransport.reads.every(read => read.method === 'GET' && read.path.startsWith('/owner-bucket/.pi/agent/'))).toBe(true);
});

it('REQ-OPERATOR-047: missing or expired Conductor native auth remains actionable with logging OFF', async () => {
  for (const reason of ['missing', 'expired'] as const) {
    const persisted: { authFailure?: unknown } = {};
    const response = await ensureNative(await nativeCapability(reason, {}, persisted));
    expect(response.status).not.toBe(200);
    expect(await response.json()).toMatchObject({ authFailure: { code: 'PI_LOGIN_REQUIRED', reason,
      provider: 'openai-codex' }, error: recovery });
    expect(piTransport.requests).toEqual([]);
    expect(piTransport.profiles).toEqual([]);
    expect(piTransport.reads.every(read => read.method === 'GET')).toBe(true);
    expect(persisted.authFailure).toEqual({ code: 'PI_LOGIN_REQUIRED', reason, provider: 'openai-codex' });
    const before = [...piTransport.reads];
    const cold = await nativeCapability('valid', {}, persisted);
    const replay = await ensureNative(cold);
    expect(await replay.json()).toMatchObject({ authFailure: persisted.authFailure });
    expect(piTransport.reads).toEqual(before); // New credentials cannot clear the admitted Activity's durable login-stop.
    const cleanup = await cold.fetch(new Request('https://operator.internal/v1/session/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1 }),
    }));
    expect(cleanup.status).toBe(200);
  }
});

it('REQ-OPERATOR-047: Conductor retains safe rejected child auth failure instead of generic 403 with logging OFF', async () => {
  const persisted: { authFailure?: unknown } = {};
  const capability = await nativeCapability('valid', {}, persisted);
  expect((await ensureNative(capability)).status).toBe(200);
  piTransport.authFailure = { code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider: 'openai-codex' };
  const result = await capability.fetch(new Request('https://operator.internal/v1/pi/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1,
      taskId: 'approved-round', digest: 'c'.repeat(64), mode: 'tool', toolName: 'run_approved_tasks',
      arguments: { initializationDigest: 'd'.repeat(64) } }),
  }));
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ taskId: 'approved-round', status: 'failed', authFailure: piTransport.authFailure });
  expect(piTransport.reads.every(read => read.method === 'GET')).toBe(true);
  expect(persisted.authFailure).toEqual(piTransport.authFailure);
  const before = { reads: [...piTransport.reads], requests: [...piTransport.requests] };
  const cold = await nativeCapability('valid', {}, persisted);
  expect(await (await ensureNative(cold)).json()).toMatchObject({ authFailure: persisted.authFailure });
  expect(piTransport.reads).toEqual(before.reads);
  expect(piTransport.requests).toEqual(before.requests);
});
