import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import type { BoundaryActivityBinding, OperatorRuntimePlan } from '../../operators/activity';
import { createOperatorIntentDigest } from '../../operators/activity';
import type { OperatorConsumerInvocation } from '../../operators/consumer-contracts';
import type { OperatorLoaderBinding } from '../../operators/loader';
import type { OperatorPackageResourceProjection } from '../../operators/package-resources';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { runOperatorActivity } from '../../operators/orchestrator';

const trust = vi.hoisted(() => ({ packetCurrent: true }));
// Only original-owner/external ports are controlled. The encrypted execution context,
// package projection, claimed binding, orchestration and runtime drive remain real.
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  resolveOperatorGroupIdentity: async (human: unknown) => human,
  resolveBucketName: async () => 'owner-bucket',
}));
vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'fixture-github' }));
vi.mock('../../operators/review-boundary-claim', () => ({
  verifyCurrentClaimedBoundaryPacket: async () => trust.packetCurrent,
}));

afterEach(() => {
  trust.packetCurrent = true;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function sha(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const head = 'b'.repeat(40), base = 'c'.repeat(40);
const context = { repositoryId: 138, pullRequest: 34, head, base, mergeBase: base };
type DriveState = { generation: number; status: string; checkpoint: unknown; result: unknown };
type Wire = { schemaVersion: number; action: string; activityId: string; generation: number;
  checkpoint: unknown; invocation: OperatorConsumerInvocation };
type Fault = 'prepopulated-boundary' | 'context-coordinate' | 'session-coordinate' | 'unclaimed-preparation'
  | 'input-digest' | 'package-digest' | 'policy-digest' | 'resource-bytes'
  | 'installation-revision' | 'original-owner' | 'claimant-packet';

/** In-memory parent/Loader composition, not compiled consumer or native acceptance.
 * Resource bytes use the same inert text-module shape as package-resources.test.ts. */
async function scenario(options: { ordinary?: boolean; fault?: Fault; holdPublisher?: boolean; wrongPublisher?: boolean } = {}) {
  const activityId = 'claimed-activity', operatorId = 'review-operator';
  const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
  const now = Date.now();
  const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
    audiences: ['audience'], issuedAt: Math.floor(now / 1000) - 10, expiresAt: Math.floor(now / 1000) + 300 };
  const policy = { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' };
  const text = 'approved package resource\n';
  const resource = { source: 'package/config.md', destination: 'review/config.md',
    sha256: await sha(text), size: new TextEncoder().encode(text).byteLength };
  const bundle = { schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05',
    compatibilityFlags: ['nodejs_compat'], mainModule: 'worker.js', modules: {
      'worker.js': { js: 'export default {}' }, 'package/config.md': {
        text: options.fault === 'resource-bytes' ? 'tampered package resource\n' : text },
    }, resources: { schemaVersion: 1, files: [resource] } };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const artifactDigest = await sha(bytes), policyDigest = await sha(JSON.stringify(policy));
  const selection = { controlsRevision: 4,
    installation: { id: 'review-install', revision: 2, policy },
    operator: { operatorId, revision: 3, profile: 'conductor', invokers: { users: [human.email], groups: [] } },
    release: { id: 'review-release', sourceCommit: 'a'.repeat(40), bundleDigest: artifactDigest } };
  const session = { bucket: 'owner-bucket', sessionId: 'session01', generation: 7 };
  const contextDigest = await sha(JSON.stringify(context));
  const business = { context: { ...context }, acknowledgedHead: null,
    ...(options.fault === 'prepopulated-boundary' ? { boundary: { commentAuthorId: 1 } } : {}) };
  if (options.fault === 'context-coordinate') business.context.pullRequest = 35;
  const invocation: OperatorConsumerInvocation = { schemaVersion: 1, interfaceVersion: 1,
    consumerId: 'boundary-review', activityId, operatorId, runId: 'review-run',
    source: { kind: 'session', reference: 'owner/repo' }, revision: { reference: head, digest: contextDigest },
    inputDigest: options.fault === 'input-digest' ? '0'.repeat(64) : await sha(JSON.stringify(business)),
    input: business, attachments: [], resources: { inference: { routeId: 'approved', reasoningLevel: null },
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
  const invocationJson = JSON.stringify(invocation);
  const intentDigest = await createOperatorIntentDigest(operatorId, activityId, invocationJson);
  const executionContext = await createOperatorExecutionContext({ activityId, operatorId, human,
    accessJwt: 'fixture-access', artifactDigest: options.fault === 'package-digest' ? '0'.repeat(64) : artifactDigest,
    policyDigest: options.fault === 'policy-digest' ? '0'.repeat(64) : policyDigest }, encryption);
  const plan = { activityId, deadline: now + 60_000, invocationJson, executionContext,
    receipt: { activityId, installationId: selection.installation.id, intentDigest, deadline: now + 60_000,
      expectedInstallationRevision: 2, expectedOperatorRevision: 3, expectedControlsRevision: 4,
      admittedAt: now, selection } } as unknown as OperatorRuntimePlan;
  const binding: BoundaryActivityBinding = { repositoryId: context.repositoryId, pullRequest: context.pullRequest,
    contextDigest, session: { ...session, generation: options.fault === 'session-coordinate' ? 8 : session.generation } };
  const preparation = { activityId, phase: options.fault === 'unclaimed-preparation' ? 'prepared' : 'claimed',
    roundGeneration: 1, contextDigest, claimedWorkflowSha: base,
    ownerKey: options.fault === 'original-owner' ? '0'.repeat(64) : await operatorOwnerKey(human) };
  let guard = { claimed: true, ...context, contextDigest, workflowId: 531, workflowSha: base,
    runId: 87, runAttempt: 2, generation: 7, session };
  let state: DriveState = { generation: 0, status: 'queued', checkpoint: null, result: null };
  let savedResources: OperatorPackageResourceProjection | null = null;
  const wires: Wire[] = [], effects: string[] = [];
  const terminalResult = { status: 'complete', activityId, repositoryId: 138, pullRequest: 34, head };
  const activity = {
    getRuntimePlan: async () => structuredClone(plan),
    getBoundaryStartBinding: async () => options.ordinary ? null : structuredClone(binding),
    savePackageResources: async (value: OperatorPackageResourceProjection) => {
      savedResources = structuredClone(value); return { ok: true };
    },
    operatorGenerationCurrent: async (generation: number) => generation === state.generation && state.status === 'running',
    beginDrive: async () => {
      state = { ...state, generation: state.generation + 1, status: 'running' };
      return { ok: true, state: structuredClone(state) };
    },
    commitDrive: async (generation: number, update: { status: string; checkpoint: unknown; result: unknown }) => {
      if (generation !== state.generation) return { ok: false, reason: 'stale-generation' };
      state = { generation, status: update.status, checkpoint: update.checkpoint, result: update.result };
      return { ok: true, state: structuredClone(state) };
    },
    interruptDrive: async () => {
      state = { ...state, status: 'unknown', result: null }; return { ok: true, state: structuredClone(state) };
    },
    fenceRuntimeFailure: async () => {
      state = { ...state, status: 'unknown', result: null }; return { ok: true, state: structuredClone(state) };
    },
  };
  const registry = {
    getManagementBundle: async () => bytes,
    getBoundaryStartGuard: async () => structuredClone(guard),
    getBoundaryPreparation: async () => structuredClone(preparation),
    resolveManagementExecution: async () => ({ ok: true, value: { ...selection, installation: {
      ...selection.installation, revision: options.fault === 'installation-revision' ? 3 : 2 } } }),
  };
  let publisherReached!: () => void, releasePublisher!: () => void;
  const publisherLookup = new Promise<void>(resolve => { publisherReached = resolve; });
  const publisherGate = new Promise<void>(resolve => { releasePublisher = resolve; });
  vi.stubGlobal('fetch', async (request: Request) => {
    if (request.headers.get('authorization') !== 'Bearer fixture-github') throw Error('Missing GitHub authority');
    if (new URL(request.url).pathname === '/users/github-actions%5Bbot%5D') {
      publisherReached();
      if (options.holdPublisher) await publisherGate;
      return Response.json({ id: 777, login: options.wrongPublisher ? 'other-bot' : 'github-actions[bot]', type: 'Bot' });
    }
    if (new URL(request.url).pathname === '/apps/github-actions') return Response.json({ id: 888, slug: 'github-actions' });
    throw Error('Unexpected external request');
  });
  const capability = { fetch: async (request: Request) => {
    effects.push(new URL(request.url).pathname);
    return Response.json({ status: 'completed', taskId: 'claimed-task' });
  } } as unknown as Fetcher;
  const loader: OperatorLoaderBinding = { load: code => ({ getEntrypoint: () => ({ fetch: async (request: Request) => {
    wires.push(await request.json() as Wire);
    // Controlled child admits an external task only after receiving the real parent wire.
    const response = await code.env.OPERATOR.fetch(new Request('https://operator.internal/v1/pi/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"taskId":"claimed-task"}',
    }));
    if (!response.ok) throw Error('Task denied');
    return Response.json({ schemaVersion: 1, status: 'completed', checkpoint: null, result: terminalResult });
  } } as unknown as Fetcher) }) };
  const environment = { ...encryption, LOADER: loader, OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
  const original = { invocationJson, intentDigest, inputDigest: invocation.inputDigest };
  const expectedResources = { schemaVersion: 1, artifactDigest, files: [{ destination: resource.destination,
    sha256: resource.sha256, size: resource.size, content: text }] };
  const expectedBoundary = { activityId, generation: 1, workflowId: 531, runId: 87, runAttempt: 2,
    commentAuthorId: 777, checkAppId: 888, inputDigest: invocation.inputDigest, packageDigest: artifactDigest,
    resourceDigest: await sha(JSON.stringify([{ destination: resource.destination, sha256: resource.sha256, size: resource.size }])),
    policyDigest };
  if (options.fault === 'claimant-packet') trust.packetCurrent = false;
  return {
    wires, effects, original, invocation, expectedResources, expectedBoundary, terminalResult,
    resources: () => savedResources,
    persisted: () => ({ invocationJson: plan.invocationJson, intentDigest: plan.receipt.intentDigest,
      inputDigest: JSON.parse(plan.invocationJson).inputDigest }),
    publisherLookup, releasePublisher,
    changeClaim: () => { guard = { ...guard, runAttempt: 3 }; },
    changeDrive: () => { state = { ...state, generation: state.generation + 1 }; },
    expireDrive: () => { vi.spyOn(Date, 'now').mockReturnValue(now + 60_001); },
    drive: async () => { await runOperatorActivity(activityId, environment, () => capability); return structuredClone(state); },
  };
}

describe('REQ-OPERATOR-053/056/074: Workers claimed Conductor parent security wire', () => {
  it('projects digest-bound resources and this claim into the child without rewriting the frozen prepared intent', async () => {
    const f = await scenario();
    expect(await f.drive()).toEqual({ generation: 1, status: 'completed', checkpoint: null, result: f.terminalResult });
    expect(f.resources()).toEqual(f.expectedResources);
    // Exact transport authority and immutable business identity are intentional security contracts.
    expect(f.wires).toEqual([{ schemaVersion: 1, action: 'start', activityId: 'claimed-activity', generation: 1,
      checkpoint: null, invocation: { ...f.invocation, input: { ...(f.invocation.input as object), boundary: f.expectedBoundary } } }]);
    expect(f.effects).toEqual(['/v1/pi/tasks']);
    expect(f.persisted()).toEqual(f.original);
  });

  it('fences an untrusted publisher without any child request or task/effect admission', async () => {
    const f = await scenario({ wrongPublisher: true });
    expect(await f.drive()).toMatchObject({ status: 'unknown', result: null });
    expect(f.wires).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(f.persisted()).toEqual(f.original);
  });

  it.each(['claim', 'drive', 'expiry'] as const)('rechecks %s after the awaited publisher lookup, before child admission', async change => {
    const f = await scenario({ holdPublisher: true });
    const attempt = f.drive();
    await f.publisherLookup;
    if (change === 'claim') f.changeClaim();
    else if (change === 'drive') f.changeDrive();
    else f.expireDrive();
    f.releasePublisher();
    expect(await attempt).toMatchObject({ status: 'unknown', result: null });
    expect(f.wires).toEqual([]);
    expect(f.effects).toEqual([]);
    expect(f.persisted()).toEqual(f.original);
  });

  it.each(['prepopulated-boundary', 'context-coordinate', 'session-coordinate', 'unclaimed-preparation',
    'input-digest', 'package-digest', 'policy-digest', 'resource-bytes', 'installation-revision', 'original-owner', 'claimant-packet'] as const)(
    'denies changed or caller-supplied claimed authority: %s', async fault => {
      const f = await scenario({ fault });
      expect(await f.drive()).toMatchObject({ status: 'unknown', result: null });
      expect(f.wires).toEqual([]);
      expect(f.effects).toEqual([]);
      expect(f.persisted()).toEqual(f.original);
    });

  it('keeps the old managed consumer wire and original data when no boundary binding exists', async () => {
    const f = await scenario({ ordinary: true });
    expect(await f.drive()).toEqual({ generation: 1, status: 'completed', checkpoint: null, result: f.terminalResult });
    expect(f.resources()).toEqual(f.expectedResources);
    expect(f.wires).toEqual([{ schemaVersion: 1, action: 'start', activityId: 'claimed-activity', generation: 1,
      checkpoint: null, invocation: f.invocation }]);
    expect(f.persisted()).toEqual(f.original);
  });
});
