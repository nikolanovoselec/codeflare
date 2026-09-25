import { describe, expect, it, vi } from 'vitest';
import { createConductorProductionCapability } from '../../operators/conductor-production';

const state = vi.hoisted(() => ({ current: true, stopAfterHost: false, stopAfterR2: false,
  ownedSession: false, reserveDuringHost: false,
  hostRequests: [] as Array<{ path: string; authorization: string | null; body: Uint8Array }>,
  objects: new Map<string, Uint8Array>(), files: [] as unknown[] }));
const packet = new TextEncoder().encode(JSON.stringify({ scope: 'all', workSet: 'whole-requested-tree',
  lane: 'code-reviewer', files: [], changedInputs: [], patch: '',
  evidence: { lane: 'code-reviewer', callSites: [], anchorsCitingChanged: [] } }));
const head = 'a'.repeat(40), contextDigest = 'b'.repeat(64);
const activityId = 'activity-packet';
const guard = { claimed: true, repositoryId: 138, pullRequest: 34, head, base: 'c'.repeat(40),
  mergeBase: 'd'.repeat(40), contextDigest, runId: 87, runAttempt: 1, generation: 1,
  session: { bucket: 'owner-bucket', sessionId: 'session01', generation: 1 } };
const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], expiresAt: Math.floor(Date.now() / 1000) + 300 };
const selection = { installation: { id: 'review-install', revision: 2,
  policy: { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' } },
operator: { operatorId: 'review-operator', revision: 3, profile: 'conductor' },
release: { bundleDigest: 'e'.repeat(64) }, controlsRevision: 4 };
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ fetch: async (request: Request) => {
  const body = new Uint8Array(await request.arrayBuffer());
  state.hostRequests.push({ path: new URL(request.url).pathname,
    authorization: request.headers.get('authorization'), body });
  if (state.stopAfterHost) state.current = false;
  if (state.reserveDuringHost) state.ownedSession = true;
  return new Response(packet, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
} }) }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: async () => 'owner-bucket', resolveOperatorGroupIdentity: async () => human,
  canInvokeOperator: () => true, resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: '', routeContextWindows: {},
    routeReasoningLevels: {}, modelDisplayNames: {} }),
}));
vi.mock('../../operators/execution-context', () => ({
  openOperatorExecutionAccess: async () => ({ human, accessJwt: 'sealed-access' }),
}));
vi.mock('../../operators/session-bootstrap', () => ({ bootstrapOperatorSession: async () => ({ bootstrap: {
  r2AccessKeyId: 'scoped-id', r2SecretAccessKey: 'scoped-secret', r2Endpoint: 'https://r2.example.test',
} }) }));
vi.mock('../../operators/approved-git-pack', () => ({ fetchApprovedGitPack: async () => new TextEncoder().encode('PACK-data') }));
vi.mock('../../operators/review-boundary-claim', () => ({
  verifyCurrentClaimedBoundaryPacket: async () => state.current,
}));
vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'parent-github-token' }));
vi.mock('../../lib/r2-regime-state', () => ({
  isBucketMigrating: async () => false, isR2SseDisabledForBucket: async () => true,
}));
vi.mock('../../lib/r2-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/r2-client')>(),
  createR2Client: () => ({ fetch: async (request: Request) => {
    const key = new URL(request.url).pathname;
    if (request.method === 'PUT') {
      if (state.objects.has(key)) return new Response(null, { status: 412 });
      state.objects.set(key, new Uint8Array(await request.arrayBuffer()));
      if (state.stopAfterR2) state.current = false;
      return new Response(null, { status: 200 });
    }
    return state.objects.has(key) ? new Response(state.objects.get(key)) : new Response(null, { status: 404 });
  } }),
}));
vi.mock('../../operators/owned-session-runtime', () => ({ ContainerOwnedSessionRuntime: class {} }));
vi.mock('../../operators/owned-session', () => ({ OwnedOperatorSessionService: class {
  ensure = async () => ({ status: 'ready' });
  stop = async () => ({ status: 'stopped' });
} }));
vi.mock('../../operators/owned-session-production', () => ({
  operatorActivitySessionStore: () => ({}), createOperatorSyncReader: async () => async () => null,
}));

async function capability(driveDeadline = Date.now() + 25_000) {
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId, operatorId: 'review-operator', runId: activityId,
    source: { kind: 'session', reference: 'owner/repo' },
    revision: { reference: head, digest: contextDigest }, inputDigest: 'f'.repeat(64),
    input: { acknowledgedHead: null }, attachments: [],
    resources: { inference: { routeId: 'provider-default', reasoningLevel: null },
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
  const activity = {
    operatorGenerationCurrent: async () => state.current,
    getPackageResources: async () => null, getOwnedSession: async () => state.ownedSession ? { status: 'ready' } : null,
    readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: state.files }),
    saveApprovedPacketAttachment: async (input: { name: string; mediaType: string; size: number;
      sha256: string; locator: string; preparationId: string; driveGeneration: number }) => {
      if (input.driveGeneration !== 1 || !state.current) return { ok: false };
      state.files = [{ name: input.name, mediaType: input.mediaType, size: input.size,
        sha256: input.sha256, locator: input.locator }];
      return { ok: true, preparationId: input.preparationId, attachment: state.files[0] };
    },
  };
  const env = { OPERATOR_REGISTRY: { getByName: () => ({
    resolveManagementExecution: async () => ({ ok: true, value: selection }),
    getBoundaryStartGuard: async () => state.current ? guard : { ...guard, claimed: false },
  }) }, CONTAINER: {} };
  const plan = { activityId, deadline: Date.now() + 300_000, invocationJson: JSON.stringify(invocation),
    receipt: { selection }, executionContext: { policyDigest: 'e'.repeat(64) } };
  return (await createConductorProductionCapability({ env: env as never, plan: plan as never,
    activity: activity as never, generation: 1, driveDeadline })).capability;
}
const prepare = (owner: Fetcher) => owner.fetch(new Request('https://operator.internal/v1/packets/prepare', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ schemaVersion: 1, preparationId: 'round-1', lane: 'code-reviewer' }),
}));

describe('REQ-OPERATOR-050/053: claimed parent packet crosses only the ordinary Host and sealed storage', () => {
  it('sends inert pack bytes without GitHub authority, verifies storage and exposes the accepted descriptor', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false; state.ownedSession = false;
    state.reserveDuringHost = false;
    state.hostRequests = []; state.files = []; state.objects.clear();
    const owner = await capability();
    const response = await prepare(owner);
    expect(response.status).toBe(200);
    const result = await response.json() as { bytes: string;
      attachment: { name: string; locator: string; sha256: string } };
    expect(result.attachment.name).toBe('packet-code-reviewer.json');
    expect(Uint8Array.from(atob(result.bytes), char => char.charCodeAt(0))).toEqual(packet);
    expect(state.hostRequests).toEqual([{ path: '/internal/operator/approved-packet',
      authorization: null, body: new TextEncoder().encode('PACK-data') }]);
    const keys = [...state.objects.keys()];
    expect(keys).toEqual([`/owner-bucket/.codeflare/operator-inputs/${activityId}/${result.attachment.locator}`]);
    expect(state.objects.get(keys[0])).toEqual(packet);
    expect(state.files).toMatchObject([result.attachment]);
    const restored = await owner.fetch(new Request('https://operator.internal/v1/storage/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, attachment: { locator: result.attachment.locator,
        sha256: result.attachment.sha256, size: packet.length } }),
    }));
    expect(restored.status).toBe(200);
    const acceptedRequests = [...state.hostRequests];
    const acceptedObjects = new Map(state.objects);
    expect((await prepare(owner)).status).toBe(200);
    const restartedParent = await capability();
    const replay = await prepare(restartedParent);
    expect(replay.status).toBe(200);
    expect(Uint8Array.from(atob((await replay.json() as { bytes: string }).bytes), char => char.charCodeAt(0)))
      .toEqual(packet);
    expect(state.hostRequests).toEqual(acceptedRequests);
    expect(state.objects).toEqual(acceptedObjects);
    state.ownedSession = true;
    expect((await prepare(owner)).status).toBe(200);
    expect(state.hostRequests).toEqual(acceptedRequests);
    expect(state.objects).toEqual(acceptedObjects);
  });

  it('denies replay from a corrupt accepted R2 object without rerunning Host', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false;
    state.ownedSession = false; state.reserveDuringHost = false;
    state.hostRequests = []; state.files = []; state.objects.clear();
    const first = await capability();
    expect((await prepare(first)).status).toBe(200);
    const acceptedRequests = [...state.hostRequests];
    for (const key of state.objects.keys()) state.objects.set(key, new TextEncoder().encode('altered'));
    const restarted = await capability();
    expect((await prepare(restarted)).status).toBe(403);
    expect(state.hostRequests).toEqual(acceptedRequests);
  });

  it('denies a session-configuration race instead of silently omitting a later packet', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false; state.ownedSession = false;
    state.reserveDuringHost = true; state.hostRequests = []; state.files = []; state.objects.clear();
    const owner = await capability();
    expect((await prepare(owner)).status).toBe(403);
    expect(state.files).toEqual([]);
  });

  it('denies a stale captured drive deadline before transport even when human authority remains live', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false; state.ownedSession = false;
    state.reserveDuringHost = false; state.hostRequests = []; state.files = []; state.objects.clear();
    const owner = await capability(Date.now() - 1);
    expect((await prepare(owner)).status).toBe(403);
    expect(state.hostRequests).toEqual([]);
    expect(state.objects.size).toBe(0);
  });

  it('does not accept a packet when Stop occurs during conditional R2 persistence', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = true;
    state.ownedSession = false; state.reserveDuringHost = false;
    state.hostRequests = []; state.files = []; state.objects.clear();
    const owner = await capability();
    expect((await prepare(owner)).status).toBe(403);
    expect(state.files).toEqual([]);
  });

  it('does not accept a Host result after source Stop', async () => {
    state.current = true; state.stopAfterHost = true; state.stopAfterR2 = false; state.ownedSession = false;
    state.reserveDuringHost = false;
    state.hostRequests = []; state.files = []; state.objects.clear();
    const owner = await capability();
    expect((await prepare(owner)).status).toBe(403);
    expect(state.files).toEqual([]);
    expect(state.objects.size).toBe(0);
  });
});
