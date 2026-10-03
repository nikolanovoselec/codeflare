import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConductorProductionCapability } from '../../operators/conductor-production';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { storeGithubConnection } from '../../lib/github-token';
import { createMockKV } from '../helpers/mock-kv';
import { createReviewPublicationGitHubFixture, reviewPublicationFaults } from '../helpers/review-publication-github-fixture';

const state = vi.hoisted(() => ({ current: true, stopAfterHost: false, stopAfterR2: false,
  ownedSession: false, reserveDuringHost: false, hostStalled: false,
  hostCancelled: false, hostStarted: null as null | (() => void),
  hostRequests: [] as Array<{ path: string; authorization: string | null; body: Uint8Array }>,
  objects: new Map<string, Uint8Array>(), files: [] as unknown[], checkpoint: null as string | null,
  resources: null as unknown }));
const packet = new TextEncoder().encode(JSON.stringify({ scope: 'all', workSet: 'whole-requested-tree',
  lane: 'code-reviewer', files: [], changedInputs: [], patch: '',
  evidence: { lane: 'code-reviewer', callSites: [], anchorsCitingChanged: [] } }));
const head = 'a'.repeat(40), contextDigest = 'b'.repeat(64);
const activityId = 'activity-packet';
const rejectedFinding = { findingId: 'finding-one', priorActivityId: 'prior-activity',
  priorRound: 1, priorHead: 'f'.repeat(40),
  rationale: 'Existing guard', evidence: 'Guard precedes write' };
const guard = { claimed: true, repositoryId: 138, pullRequest: 34, workflowId: 531, head, base: 'c'.repeat(40),
  mergeBase: 'd'.repeat(40), contextDigest, runId: 87, runAttempt: 1, generation: 1,
  workflowSha: 'e'.repeat(40),
  session: { bucket: 'owner-bucket', sessionId: 'session01', generation: 1 } };
const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://team.cloudflareaccess.com',
  audiences: ['operator-audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300 };
const originalFinding = { id: 'finding-one', severity: 'HIGH', path: 'src/file.ts', line: 1,
  message: 'Bypass', evidence: 'Caller missing guard' };
const publicationFixture = (extraFindings = 0, longEvidence = false) => createReviewPublicationGitHubFixture({
  currentHead: head, priorHead: rejectedFinding.priorHead, activityId: rejectedFinding.priorActivityId,
  round: rejectedFinding.priorRound, token: 'parent-github-token', finding: originalFinding,
  extraFindings, longEvidence,
});
let priorPublication: ReturnType<typeof publicationFixture>;
const rejection = () => ({ ...rejectedFinding, originalReportDigest: priorPublication.digest });
const selection = { installation: { id: 'review-install', revision: 2,
  policy: { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' } },
operator: { operatorId: 'review-operator', revision: 3, profile: 'conductor',
  invokers: { users: [], groups: [{ issuer: human.issuer, id: 'reviewers' }] } },
release: { bundleDigest: 'e'.repeat(64) }, controlsRevision: 4 };
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ fetch: async (request: Request) => {
  const body = new Uint8Array(await request.arrayBuffer());
  state.hostRequests.push({ path: new URL(request.url).pathname,
    authorization: request.headers.get('authorization'), body });
  if (state.stopAfterHost) state.current = false;
  if (state.reserveDuringHost) state.ownedSession = true;
  if (state.hostStalled) {
    state.hostStarted?.();
    return new Response(new ReadableStream<Uint8Array>({ cancel() { state.hostCancelled = true; } }),
      { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }
  return new Response(packet, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
} }) }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: async () => 'owner-bucket', resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: '', routeContextWindows: {},
    routeReasoningLevels: {}, modelDisplayNames: {} }),
}));
vi.mock('../../operators/session-bootstrap', () => ({ bootstrapOperatorSession: async () => ({ bootstrap: {
  r2AccessKeyId: 'scoped-id', r2SecretAccessKey: 'scoped-secret', r2Endpoint: 'https://r2.example.test',
} }) }));
vi.mock('../../operators/approved-git-pack', () => ({ fetchApprovedGitPack: async () => new TextEncoder().encode('PACK-data') }));
vi.mock('../../operators/review-boundary-claim', () => ({
  verifyCurrentClaimedBoundaryPacket: async () => state.current,
}));
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

async function capability(driveDeadline = Date.now() + 25_000, evidence?: unknown) {
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId, operatorId: 'review-operator', runId: activityId,
    source: { kind: 'session', reference: 'owner/repo' },
    revision: { reference: head, digest: contextDigest }, inputDigest: 'f'.repeat(64),
    input: { acknowledgedHead: evidence ? 'f'.repeat(40) : null,
      ...(evidence ? { evidence } : {}) }, attachments: [],
    resources: { inference: { routeId: 'provider-default', reasoningLevel: null },
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
  const activity = {
    operatorGenerationCurrent: async () => state.current,
    getPackageResources: async () => state.resources, getOwnedSession: async () => state.ownedSession ? { status: 'ready' } : null,
    readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: state.files }),
    getCurrentDriveCheckpointJson: async (generation: number) => generation === 1 ? state.checkpoint : null,
    saveApprovedPacketAttachment: async (input: { name: string; mediaType: string; size: number;
      sha256: string; locator: string; preparationId: string; driveGeneration: number }) => {
      if (input.driveGeneration !== 1 || !state.current || state.ownedSession) return { ok: false };
      state.files = [{ name: input.name, mediaType: input.mediaType, size: input.size,
        sha256: input.sha256, locator: input.locator }];
      return { ok: true, preparationId: input.preparationId, attachment: state.files[0] };
    },
  };
  const env = { ENCRYPTION_KEY: btoa('p'.repeat(32)), KV: createMockKV(),
    OPERATOR_REGISTRY: { getByName: () => ({
    resolveManagementExecution: async () => ({ ok: true, value: selection }),
    getBoundaryStartGuard: async () => state.current ? guard : { ...guard, claimed: false },
  }) }, CONTAINER: {} };
  await storeGithubConnection(env as never, 'owner-bucket', { accessToken: 'parent-github-token', source: 'pat' });
  const executionContext = await createOperatorExecutionContext({ activityId, operatorId: 'review-operator',
    artifactDigest: selection.release.bundleDigest, policyDigest: 'e'.repeat(64), human,
    accessJwt: 'sealed-access' }, env);
  const plan = { activityId, deadline: Date.now() + 300_000, invocationJson: JSON.stringify(invocation),
    receipt: { selection }, executionContext };
  return (await createConductorProductionCapability({ env: env as never, plan: plan as never,
    activity: activity as never, generation: 1, driveDeadline })).capability;
}
const prepare = (owner: Fetcher) => owner.fetch(new Request('https://operator.internal/v1/packets/prepare', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ schemaVersion: 1, preparationId: 'round-1', lane: 'code-reviewer' }),
}));

beforeEach(() => {
  state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false;
  state.ownedSession = false; state.reserveDuringHost = false; state.hostStalled = false;
  state.hostCancelled = false; state.hostStarted = null; state.hostRequests = [];
  state.files = []; state.objects.clear(); state.checkpoint = null; state.resources = null;
  priorPublication = publicationFixture();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `${human.issuer}/cdn-cgi/access/get-identity`) {
      if (request.headers.get('cookie') !== 'CF_Authorization=sealed-access')
        return new Response(null, { status: 401 });
      return Response.json({ id: human.subject, email: human.email, groups: [{ id: 'reviewers' }] });
    }
    return priorPublication.fetcher(request);
  });
});
afterEach(() => vi.restoreAllMocks());

// Q14 maps to REQ-OPERATOR-065 AC1/3/4: real publisher authentication,
// exact prior tuple and bounded originals before packet sealing (OPERATOR-050 AC3).
describe('REQ-OPERATOR-050/053: claimed parent packet crosses only the ordinary Host and sealed storage', () => {
  it('puts an independently authenticated prior finding in the actor-bound approved packet', async () => {
    state.current = true; state.ownedSession = false; state.files = []; state.objects.clear();
    const owner = await capability(Date.now() + 25_000, { rejectedFindings: [rejection()] });
    const response = await prepare(owner);
    expect(response.status).toBe(200);
    const value = await response.json() as { bytes: string };
    const approved = JSON.parse(Buffer.from(value.bytes, 'base64').toString());
    expect(approved.evidence.rejectedFindings).toEqual([rejection()]);
    expect(approved.evidence.originalFindings).toMatchObject([{ id: 'finding-one',
      lane: 'code-reviewer', severity: 'HIGH', path: 'src/file.ts', line: 1,
      message: 'Bypass', evidence: 'Caller missing guard' }]);
    expect(JSON.stringify(approved)).not.toContain('sealed-access');
    expect(JSON.stringify(approved)).not.toContain('parent-github-token');
    expect(state.hostRequests.every(request => request.authorization === null)).toBe(true);
    for (const request of priorPublication.requests) {
      expect(request.headers.has('cf-access-jwt-assertion')).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
      if (new URL(request.url).hostname === 'objects.actions.githubusercontent.com')
        expect(request.headers.has('authorization')).toBe(false);
    }
    state.files = []; state.objects.clear(); state.hostRequests = [];
    priorPublication.setFault('unavailable');
    const denied = await capability(Date.now() + 25_000, { rejectedFindings: [rejection()] });
    expect((await prepare(denied)).status).toBe(403);
    expect(state.files).toEqual([]);
    expect(state.objects.size).toBe(0);
    expect(state.hostRequests).toEqual([]);
  });
  it.each(reviewPublicationFaults)('REQ-OPERATOR-065: withholds a forged or unavailable %s publication before Host or storage', async fault => {
    priorPublication.setFault(fault);
    const owner = await capability(Date.now() + 25_000, { rejectedFindings: [rejection()] });
    const response = await prepare(owner);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(originalFinding.evidence);
    expect(state.hostRequests).toEqual([]);
    expect(state.objects.size).toBe(0);
    expect(state.files).toEqual([]);
  });
  it('withholds truncated or omitted original evidence from the next reviewer packet', async () => {
    for (const flags of [{ extraFindings: 20, longEvidence: false }, { extraFindings: 0, longEvidence: true }]) {
      state.current = true; state.ownedSession = false; state.files = []; state.objects.clear();
      priorPublication = publicationFixture(flags.extraFindings, flags.longEvidence);
      const owner = await capability(Date.now() + 25_000, { rejectedFindings: [rejection()] });
      expect((await prepare(owner)).status).toBe(403);
      expect(state.files).toEqual([]);
    }
  });
  it('rejects mismatched publication references and extraneous authority fields before sealing', async () => {
    for (const forged of [
      { findingId: 'foreign' }, { originalReportDigest: 'e'.repeat(64) },
      { priorActivityId: 'foreign-activity' }, { priorHead: 'e'.repeat(40) },
      { priorRound: 2 }, { repository: 'other/repo' }, { repositoryId: 139 },
      { pullRequest: 35 }, { actorSubject: 'someone-else' },
    ]) {
      state.current = true; state.ownedSession = false;
      state.files = []; state.objects.clear();
      const owner = await capability(Date.now() + 25_000,
        { rejectedFindings: [{ ...rejection(), ...forged }] });
      expect((await prepare(owner)).status).toBe(403);
      expect(state.files).toEqual([]);
    }
  });
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

  it('aborts a stalled Host response at the captured parent deadline without a child-supplied signal', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false;
    state.ownedSession = false; state.reserveDuringHost = false; state.hostStalled = true;
    state.hostCancelled = false; state.hostRequests = []; state.files = []; state.objects.clear();
    const started = new Promise<void>(resolve => { state.hostStarted = resolve; });
    const owner = await capability(Date.now() + 1_000);
    const pending = prepare(owner);
    await Promise.race([started, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Host did not begin')), 2_000);
    })]);
    expect((await pending).status).toBe(403);
    expect(state.hostCancelled).toBe(true);
    expect(state.files).toEqual([]);
    state.hostStalled = false; state.hostStarted = null;
  });

  it('does not accept a Host result after source Stop', async () => {
    state.current = true; state.stopAfterHost = true; state.stopAfterR2 = false;
    state.hostStalled = false; state.ownedSession = false;
    state.reserveDuringHost = false;
    state.hostRequests = []; state.files = []; state.objects.clear();
    const owner = await capability();
    expect((await prepare(owner)).status).toBe(403);
    expect(state.files).toEqual([]);
    expect(state.objects.size).toBe(0);
  });
});

describe('REQ-OPERATOR-050: claimed packet initialization requires its private Activity checkpoint', () => {
  it('admits matching initialization and denies a changed or missing checkpoint before startup', async () => {
    state.current = true; state.stopAfterHost = false; state.stopAfterR2 = false;
    state.hostStalled = false; state.ownedSession = false; state.reserveDuringHost = false;
    state.files = []; state.objects.clear(); state.checkpoint = null;
    const instruction = 'Review';
    state.resources = { schemaVersion: 1, artifactDigest: 'a'.repeat(64), files: [{
      destination: 'review/instruction.md', content: instruction, size: instruction.length,
      sha256: createHash('sha256').update(instruction).digest('hex'),
    }] };
    const owner = await capability();
    expect((await prepare(owner)).status).toBe(200);
    const initialization = { schemaVersion: 1, profileId: 'review-profile', contextPath: 'review/context.json',
      context: '{}', inputs: [{ kind: 'attachment', reference: 'packet-code-reviewer.json',
        target: 'review/packet-code-reviewer.json' }, { kind: 'resource', reference: 'review/instruction.md',
        target: 'review/instruction.md' }], tasks: [{ id: 'code', instruction: 'review/instruction.md',
        reads: ['review/context.json', 'review/packet-code-reviewer.json', 'review/instruction.md'],
        output: 'reports/code.json' }] };
    const ensure = () => owner.fetch(new Request('https://operator.internal/v1/session/ensure', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, initialization }),
    }));
    state.checkpoint = JSON.stringify({ initialization });
    expect((await ensure()).status).toBe(200);
    state.checkpoint = JSON.stringify({ initialization: { ...initialization, context: '{"changed":true}' } });
    expect((await ensure()).status).toBe(403);
    state.checkpoint = null;
    expect((await ensure()).status).toBe(403);
  });
});
