import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import type { OperatorRuntimePlan, BoundaryActivityBinding } from '../../operators/activity';
import type { OperatorLoaderBinding } from '../../operators/loader';
import { parseOperatorBundle } from '../../operators/distribution';
import { projectOperatorPackageResources } from '../../operators/package-resources';
import { prepareVerifiedBoundary } from '../../operators/review-boundary-preparation';
import { runOperatorActivity } from '../../operators/orchestrator';
import { createAuthenticatedHistoryTransport } from '../../operators/review-history-transport';
import { publishBoundaryResult } from '../../../scripts/operator-boundary-action.mjs';

// Owner ports below are controlled, so imported platform class bases are never instantiated.
// Keep actual preparation, digest, orchestration and runtime functions intact in the Node lane.
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, RpcTarget: class {} }));
vi.mock('agents', () => ({ Agent: class {} }));
vi.mock('@cloudflare/containers', () => ({ getContainer: () => { throw Error('Unexpected container port in projection-only composition'); } }));
const trust = vi.hoisted(() => ({ current: true }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({ human: human(), accessJwt: 'fixture-access' }),
  resolveOperatorGroupIdentity: async () => human(),
  operatorAccessSessionCurrent: async () => trust.current,
  resolveBucketName: async () => 'owner-bucket', canInvokeOperator: () => true,
  resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: '' }),
}));
vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'fixture-github' }));
// The claimed-owner proof is a controlled port here, not native OIDC/D1 acceptance.
vi.mock('../../operators/review-boundary-claim', () => ({
  verifyCurrentClaimedBoundaryPacket: async () => trust.current,
}));

function human() {
  return { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
    audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
    expiresAt: Math.floor(Date.now() / 1000) + 300 };
}
const hashBytes = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => hashBytes(JSON.stringify(value));
const head = 'b'.repeat(40), priorHead = 'a'.repeat(40), base = 'c'.repeat(40);
const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const finding = { id: 'guard-gap', severity: 'HIGH', path: 'src/guard.ts', line: 12,
  message: 'Authorization missing', evidence: 'The write precedes authorization.' };
const context = { repositoryId: 138, pullRequest: 34, head, base, mergeBase: base };
const policy = { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' };
const workflow = 'name: fixture-boundary\non: pull_request_target\n';
const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/develop',
  workflowDigest: hashBytes(workflow), events: ['pull_request_target'], controlsRevision: 4 };

let moduleRoot: string;
let raw: Uint8Array;
let provenance: { bundleDigest: string; sourceCommit: string };
let bundle: Awaited<ReturnType<typeof parseOperatorBundle>>;
let resources: NonNullable<Awaited<ReturnType<typeof projectOperatorPackageResources>>>;
let worker: { fetch(request: Request, env: unknown): Promise<Response> };
beforeAll(async () => {
  raw = new Uint8Array(await readFile(fileURLToPath(new URL('./fixtures/conductor-review.generated.json', import.meta.url).href)));
  provenance = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/conductor-review.provenance.json', import.meta.url).href), 'utf8'));
  // Verify original raw bytes, not a reserialized bundle or a package checkout.
  bundle = await parseOperatorBundle(raw, provenance.bundleDigest);
  const projected = await projectOperatorPackageResources(bundle, provenance.bundleDigest);
  if (!projected) throw Error('Pinned Conductor resources unavailable');
  resources = projected;
  moduleRoot = await mkdtemp(join(tmpdir(), 'conductor-prepared-runtime-'));
  await writeFile(join(moduleRoot, 'package.json'), '{"type":"module"}\n');
  for (const [name, value] of Object.entries(bundle.modules)) {
    if (!('js' in value)) continue;
    const destination = join(moduleRoot, name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, value.js);
  }
  worker = (await import(pathToFileURL(join(moduleRoot, bundle.mainModule)).href)).default;
});
afterAll(async () => { if (moduleRoot) await rm(moduleRoot, { recursive: true, force: true }); });
afterEach(() => { trust.current = true; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Mode = 'clean' | 'silent' | 'resolved';
type Wire = { generation: number; invocation: { inputDigest: string; input: Record<string, any> } };

/** Focused composition: actual preparation/orchestrator/runtime/generated Worker; controlled
 * Registry/Activity and external session/Pi/storage/GitHub ports. No native/live acceptance,
 * reviewer judgment, physical cleanup, or new publication-policy coverage is claimed. */
async function scenario(mode: Mode = 'clean') {
  const selection = { controlsRevision: 4,
    installation: { id: 'review-install', revision: 2, policy },
    operator: { operatorId: 'review-operator', revision: 3, profile: 'conductor' },
    release: { id: 'review-release', sourceCommit: provenance.sourceCommit, bundleDigest: provenance.bundleDigest } };
  const comments: any[] = [], checks: any[] = [], artifacts: any[] = [];
  const session = { bucket: 'owner-bucket', sessionId: 'session01', generation: 7 };
  let preparation: any = null;
  let guard: any = null;
  let plan: OperatorRuntimePlan;
  let original: { invocationJson: string; intentDigest: string; inputDigest: string };
  let binding: BoundaryActivityBinding;
  let savedResources = resources;
  let state: any = { generation: 0, status: 'queued', checkpoint: null, result: null };
  let publisherFault: 'wrong-bot' | 'change-claim' | 'change-drive' | null = null;
  const wires: Wire[] = [];
  const packets = new Map<string, { content: Buffer; attachment: any }>();
  const objects = new Map<string, Uint8Array>();
  const effects: string[] = [];

  const pr = { number: 34, node_id: 'PR_node', state: 'open',
    head: { sha: head, ref: 'feature', repo: { id: 138 } },
    base: { sha: base, ref: 'develop', repo: { id: 138 } } };
  const github = async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname;
    if (url.hostname === 'objects.actions.githubusercontent.com') {
      if (request.headers.has('authorization')) throw Error('Credentials forwarded to signed archive');
      const artifact = artifacts.find(row => path === `/artifact-${row.id}.zip`);
      if (!artifact) throw Error('Unknown signed artifact');
      return new Response(zipSync({ 'review.json': strToU8(JSON.stringify(artifact.body)) }, { level: 0 }));
    }
    if (request.headers.get('authorization') !== 'Bearer fixture-github') throw Error('Missing GitHub authority');
    if (path === '/users/github-actions%5Bbot%5D') {
      if (publisherFault === 'change-claim') guard = { ...guard, runAttempt: 3 };
      if (publisherFault === 'change-drive') state = { ...state, generation: state.generation + 1 };
      return Response.json({ id: 777, login: publisherFault === 'wrong-bot' ? 'other-bot' : 'github-actions[bot]', type: 'Bot' });
    }
    if (path === '/apps/github-actions') return Response.json({ id: 888, slug: 'github-actions' });
    const root = '/repos/owner/repo';
    if (request.method === 'POST') {
      const body = await request.json() as any;
      if (path === `${root}/issues/34/comments`) {
        const row = { id: 501 + comments.length, user: { id: 777 }, issue_url: `https://api.github.com${root}/issues/34`, ...body };
        comments.push(row); return Response.json(row);
      }
      if (path === `${root}/check-runs`) {
        const row = { id: 601 + checks.length, app: { id: 888 }, ...body };
        checks.push(row); return Response.json(row);
      }
      throw Error(`Unexpected fixture write ${path}`);
    }
    if (path === root) return Response.json({ id: 138, full_name: 'owner/repo', default_branch: 'develop', permissions: { pull: true } });
    if (path === `${root}/pulls/34`) return Response.json(pr);
    if (path === `${root}/pulls` || /^\/repos\/owner\/repo\/commits\/[a-f0-9]{40}\/pulls$/.test(path)) return Response.json([pr]);
    if (path.startsWith(`${root}/compare/`)) return Response.json({ merge_base_commit: { sha: path.includes(`${priorHead}...`) ? priorHead : base } });
    if (path === `${root}/branches/develop`) return Response.json({ name: 'develop', protected: true, commit: { sha: base } });
    if (path === `${root}/actions/workflows/531`) return Response.json({ id: 531, path: action.workflowPath, state: 'active' });
    if (path === `${root}/contents/${action.workflowPath}`) return Response.json({ encoding: 'base64', content: btoa(workflow) });
    if (path === `${root}/issues/34/comments`) return Response.json(comments);
    if (path.startsWith(`${root}/issues/comments/`)) return Response.json(comments.find(row => path.endsWith(`/${row.id}`)));
    if (path.endsWith('/check-runs')) {
      const rows = checks.filter(row => path.includes(row.head_sha));
      return Response.json({ total_count: rows.length, check_runs: rows });
    }
    if (path.startsWith(`${root}/check-runs/`)) return Response.json(checks.find(row => path.endsWith(`/${row.id}`)));
    if (path === `${root}/actions/artifacts`) {
      const rows = artifacts.filter(row => !url.searchParams.has('name') || row.name === url.searchParams.get('name'));
      return Response.json({ total_count: rows.length, artifacts: rows.map(({ id, name }) => ({ id, name })) });
    }
    if (path.endsWith('/zip')) {
      const artifact = artifacts.find(row => path.endsWith(`/${row.id}/zip`));
      if (!artifact) throw Error('Unknown artifact');
      return new Response(null, { status: 302, headers: { location: `https://objects.actions.githubusercontent.com/artifact-${artifact.id}.zip` } });
    }
    if (path.startsWith(`${root}/actions/artifacts/`)) {
      const artifact = artifacts.find(row => path.endsWith(`/${row.id}`));
      return Response.json({ id: artifact.id, expired: false,
        workflow_run: { id: artifact.body.binding.admission.runId, repository_id: 138, head_sha: base } });
    }
    if (path.startsWith(`${root}/actions/runs/`)) {
      const id = Number(path.split('/').at(-1));
      return Response.json({ id, run_attempt: id === 87 ? 2 : 1, workflow_id: 531,
        repository: { id: 138 }, head_sha: base, event: 'pull_request_target', pull_requests: [{ number: 34 }] });
    }
    throw Error(`Unexpected fixture GitHub read ${path}`);
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => github(input instanceof Request ? input : new Request(input, init)));

  // Use the real Action publisher to create GitHub history, then independently read its
  // comment/check/ZIP bytes through authenticated transport. Not a pre-approved history snapshot.
  const publishHistory = async (admission: any, publishedContext: any, findings: any[]) => {
    const packetDigest = hash({ activity: admission.activityId, fixture: 'published-packet' });
    const result = { status: 'complete', activityId: admission.activityId, generation: admission.generation,
      activityGeneration: 4, ...publishedContext, packageDigest: admission.packageDigest,
      manifestDigest: hash({ activity: admission.activityId, fixture: 'published-manifest' }), cleanup: 'stopped',
      originalReports: lanes.map(lane => ({ schemaVersion: 1, lane, packetDigest, generation: admission.generation,
        head: publishedContext.head, complete: true, omissions: [], findings: lane === 'code-reviewer' ? findings : [] })),
      history: { findings: findings.map(item => ({ ...item, lane: 'code-reviewer' })), clear: !findings.length,
        coverageAdvanced: true, rebuttals: [] },
      presentation: { commentBody: 'Boundary Reviews fixture', check: { name: 'Boundary Reviews (shadow)',
        conclusion: findings.length ? 'failure' : 'success', summary: 'Authenticated fixture history' } } };
    const publishedBinding = { admission, context: publishedContext, packetDigest, activityGeneration: 4,
      runId: admission.runId, runAttempt: admission.runAttempt };
    const outcome = await publishBoundaryResult({ status: 'collected', activityId: admission.activityId, activityGeneration: 4, result },
      { activityId: admission.activityId, generation: 4, ...publishedContext,
        packageDigest: admission.packageDigest, resultDigest: hash(result) },
      { activityGeneration: 4, binding: publishedBinding, runId: admission.runId, runAttempt: admission.runAttempt,
        ledger: { current: async () => ({ activityId: admission.activityId, generation: 4, ...publishedContext }),
          effect: async (request: any) => request.operation === 'begin' ? { status: 'new' }
            : { status: 'published', externalId: request.externalId } },
        artifact: { list: async () => artifacts, read: async (id: number) => artifacts.find(row => row.id === id),
          upload: async (body: any) => { const row = { id: 701 + artifacts.length,
            name: `boundary-review-${body.digest}`, body }; artifacts.push(row); return row; } },
        github: { origin: 'https://api.github.com', repository: 'owner/repo', token: 'fixture-github',
          commentAuthorId: 777, checkAppId: 888, fetch: github } } as never);
    if (outcome.status !== 'published') throw Error(`Fixture publication failed: ${JSON.stringify(outcome)}`);
    return artifacts.at(-1).body;
  };

  let rejection: any = undefined;
  if (mode !== 'clean') {
    const prior = await publishHistory({ repositoryId: 138, pullRequest: 34, activityId: 'prior-activity', generation: 1,
      workflowId: 531, runId: 86, runAttempt: 1, packageDigest: provenance.bundleDigest,
      inputDigest: hash({ fixture: 'prior-input' }), resourceDigest: hash(resources.files.map(({ destination, sha256, size }) => ({ destination, sha256, size }))),
      policyDigest: hash(policy), acknowledgedHead: null }, { ...context, head: priorHead }, [finding]);
    rejection = { findingId: finding.id, priorActivityId: 'prior-activity', priorRound: 1,
      priorHead, originalReportDigest: prior.digest, rationale: 'Caller disagrees', evidence: 'Inspect guarded caller' };
  }

  const activity = {
    prepareAuthorized: async (intent: any, executionContext: any, invocationJson: string, parentBinding: BoundaryActivityBinding) => {
      binding = structuredClone(parentBinding);
      original = { invocationJson, intentDigest: intent.intentDigest, inputDigest: JSON.parse(invocationJson).inputDigest };
      plan = { activityId: intent.activityId, deadline: intent.deadline, invocationJson, executionContext,
        receipt: { ...intent, selection, admittedAt: Date.now() } } as OperatorRuntimePlan;
      return { ok: true, phase: 'prepared' };
    },
    getRuntimePlan: async () => plan,
    getBoundaryStartBinding: async () => structuredClone(binding),
    savePackageResources: async (value: typeof resources) => { savedResources = value; return { ok: true }; },
    getPackageResources: async () => savedResources,
    operatorGenerationCurrent: async (generation: number) => trust.current && generation === state.generation && state.status === 'running',
    beginDrive: async () => {
      state = { ...state, generation: state.generation + 1, status: 'running' };
      return { ok: true, state: structuredClone(state) };
    },
    commitDrive: async (generation: number, update: any) => {
      if (generation !== state.generation || !trust.current) return { ok: false, reason: 'authority-expired' };
      state = { generation, ...update }; return { ok: true, state };
    },
    interruptDrive: async () => { state = { ...state, status: 'unknown', result: null }; return { ok: true, state }; },
    fenceRuntimeFailure: async () => { state = { ...state, status: 'unknown', result: null }; return { ok: true, state }; },
  };
  const registry = {
    resolveManagementExecution: async () => ({ ok: true, value: selection }),
    getManagementBundle: async () => raw,
    getBoundaryAction: async () => action,
    getBoundaryPreparation: async () => preparation && structuredClone(preparation),
    reserveBoundaryPreparation: async (input: any) => {
      preparation = { ...input, activityId: 'prepared-activity', phase: 'reserved' };
      return { ok: true, value: { ...preparation, created: true } };
    },
    markBoundaryPrepared: async () => { preparation.phase = 'prepared'; return true; },
    upsertOwnedActivity: async () => {},
    getBoundaryStartGuard: async () => structuredClone(guard),
  };
  const history = () => createAuthenticatedHistoryTransport({ repository: 'owner/repo', ...context,
    token: 'fixture-github', current: async () => { if (!trust.current) throw Error('Claim changed'); }, fetch: github });
  const parent = { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname, body = await request.json() as any;
    if (path === '/v1/history/read') return Response.json(await history().read(body));
    if (path === '/v1/packets/prepare') {
      const lane = body.lane;
      const laneEvidence = lane === 'code-reviewer' ? { callSites: {}, anchorsCitingChanged: {} }
        : lane === 'spec-reviewer' ? { indexIntegrity: {}, dependencyGraph: {}, anchors: {} }
          : { indexIntegrity: {}, references: {}, anchors: {}, docsCitingChanged: {} };
      const packet = { scope: mode === 'clean' ? 'all' : 'diff',
        workSet: mode === 'clean' ? 'whole-requested-tree' : 'changed-hunks-and-direct-invalidations', lane,
        ...(mode === 'clean' ? {} : { range: `${priorHead}..${head}` }), files: [], changedInputs: [], patch: '',
        evidence: { lane, ...laneEvidence, ...(rejection ? { rejectedFindings: [rejection],
          originalFindings: [{ ...finding, lane: 'code-reviewer' }] } : {}) } };
      const content = Buffer.from(JSON.stringify(packet));
      const attachment = { name: `packet-${lane}.json`, mediaType: 'application/json', size: content.length,
        sha256: hashBytes(content), locator: `packet-${lane}` };
      packets.set(lane, { content, attachment });
      effects.push('packet');
      return Response.json({ preparationId: body.preparationId, attachment, bytes: content.toString('base64') });
    }
    if (path === '/v1/session/ensure') return Response.json({ status: 'ready' });
    if (path === '/v1/storage/restore') {
      const packet = [...packets.values()].find(item => item.attachment.locator === body.attachment.locator);
      if (!packet || packet.attachment.sha256 !== body.attachment.sha256) throw Error('Invalid restored packet');
      return Response.json({ status: 'restored', path: `input/${packet.attachment.name}` });
    }
    if (path === '/v1/pi/ensure') return Response.json({ ready: true, conversationId: 'fixture-conversation' });
    if (path === '/v1/pi/tasks') {
      effects.push('task');
      const packetDigest = hash({ contextDigest: preparation.contextDigest,
        packets: lanes.map(lane => ({ lane, digest: packets.get(lane)!.attachment.sha256 })) });
      const files = lanes.map(lane => {
        const report = { schemaVersion: 1, lane, packetDigest, generation: 1, head,
          complete: true, omissions: [], findings: [],
          ...(mode === 'resolved' && lane === 'code-reviewer' ? { reassessments: [{ findingId: finding.id,
            decision: 'resolved', reason: 'Guard independently verified', evidence: 'Guard blocks write before dispatch' }] } : {}) };
        const bytes = strToU8(JSON.stringify(report));
        const file = { path: `reports/prepared-activity-1-${lane}.json`, size: bytes.length, sha256: hashBytes(bytes) };
        objects.set(`output/${file.path}`, bytes); return file;
      });
      objects.set('private/manifest.json', strToU8(JSON.stringify({ operationId: body.taskId, files })));
      return Response.json({ status: 'completed', taskId: body.taskId });
    }
    if (path === '/v1/sync/seal') return Response.json({ status: 'sealed',
      manifestDigest: hashBytes(objects.get('private/manifest.json')!), prefix: 'private/', filePrefix: 'output/' });
    if (path === '/v1/storage/read') return Response.json({ bytes: Buffer.from(objects.get(body.key)!).toString('base64') });
    if (path === '/v1/session/stop') return Response.json({ status: 'stopped' });
    throw Error(`Unexpected fixture parent operation ${path}`);
  } } as unknown as Fetcher;
  const loader: OperatorLoaderBinding = { load: code => ({ getEntrypoint: () => ({
    fetch: async (request: Request) => {
      // Observe the real runtime wire, then execute immutable pinned code, not a test result stub.
      wires.push(await request.clone().json() as Wire);
      return worker.fetch(request, code.env);
    },
  } as unknown as Fetcher) }) };
  const env = { ENCRYPTION_KEY: btoa('a'.repeat(32)), LOADER: loader,
    OPERATOR_REGISTRY: { getByName: () => registry }, OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
  await prepareVerifiedBoundary({ generation: 7,
    input: { repositoryId: 138, pullRequest: 34, targetHead: head,
      acknowledgedHead: mode === 'clean' ? null : priorHead, payload: rejection ? { rejectedFindings: [rejection] } : {} },
    push: { owner: 'owner', repository: 'repo', ref: 'refs/heads/feature', head } },
  { human: human(), accessJwt: 'fixture-access' }, env,
  path => github(new Request(`https://api.github.com${path}`, { headers: { authorization: 'Bearer fixture-github' } })),
  { bucket: session.bucket, sessionId: session.sessionId }, async () => {});
  // Controlled Registry claim port preserves the values created by actual preparation.
  preparation = { ...preparation, phase: 'claimed', claimedWorkflowSha: base };
  guard = { claimed: true, ...context, contextDigest: preparation.contextDigest,
    workflowId: 531, workflowSha: base, runId: 87, runAttempt: 2, generation: 7, session };
  const expectedBoundary = { activityId: preparation.activityId, generation: preparation.roundGeneration,
    workflowId: 531, runId: 87, runAttempt: 2, commentAuthorId: 777, checkAppId: 888,
    inputDigest: original!.inputDigest, packageDigest: provenance.bundleDigest, policyDigest: hash(policy),
    resourceDigest: hash(resources.files.map(({ destination, sha256, size }) => ({ destination, sha256, size }))) };
  return {
    original: original!, expectedBoundary, wires, effects,
    persisted: () => ({ invocationJson: plan.invocationJson, intentDigest: plan.receipt.intentDigest,
      inputDigest: JSON.parse(plan.invocationJson).inputDigest }),
    fault: (value: typeof publisherFault) => { publisherFault = value; },
    inFlightHistory: async (changedResource: boolean) => publishHistory({ ...expectedBoundary,
      repositoryId: 138, pullRequest: 34, acknowledgedHead: null,
      ...(changedResource ? { resourceDigest: hash({ changed: 'resource-descriptor' }) } : {}) }, context, []),
    drive: async () => {
      for (let i = 0; i < 4 && !['completed', 'failed', 'unknown'].includes(state.status); i++) {
        await runOperatorActivity(preparation.activityId, env, () => parent);
      }
      return structuredClone(state);
    },
  };
}

describe('REQ-OPERATOR-053/056/074: prepared Conductor runtime projection (controlled composition, not native acceptance)', () => {
  it.each(['silent', 'resolved'] as const)('prepared rejection reaches compiled consumer and authentic prior history: %s', async mode => {
    const fixture = await scenario(mode);
    const before = structuredClone(fixture.original);
    const input = JSON.parse(before.invocationJson).input;
    expect(input.boundary).toBeUndefined();
    expect(before.inputDigest).toBe(hash(input));
    const result = await fixture.drive();
    expect(result).toMatchObject({ status: 'completed', generation: 4, result: {
      status: 'complete', activityId: 'prepared-activity', activityGeneration: 4, generation: 1,
      repositoryId: 138, pullRequest: 34, head, packageDigest: provenance.bundleDigest, cleanup: 'stopped',
      history: { coverageAdvanced: true, clear: mode === 'resolved',
        findings: mode === 'silent' ? [{ ...finding, lane: 'code-reviewer' }] : [],
        resolvedFindingIds: mode === 'resolved' ? [finding.id] : [] },
      presentation: { check: { conclusion: mode === 'resolved' ? 'success' : 'failure' } },
    } });
    expect(result.result.originalReports.map((report: any) => report.findings)).toEqual([[], [], []]);
    if (mode === 'resolved') expect(result.result.originalReports[0].reassessments)
      .toEqual([{ findingId: finding.id, decision: 'resolved', reason: 'Guard independently verified',
        evidence: 'Guard blocks write before dispatch' }]);
    // The transport security wire intentionally binds the original business-input digest.
    expect(fixture.wires[0].invocation).toEqual({ ...JSON.parse(before.invocationJson),
      input: { ...input, boundary: fixture.expectedBoundary } });
    expect(fixture.persisted()).toEqual(before); // Frozen intent is an intentional security contract.
  });

  it.each([false, true])('exact in-flight history compares truthful digests; changed resource=%s', async changed => {
    const fixture = await scenario();
    await fixture.inFlightHistory(changed);
    const result = await fixture.drive();
    expect(result).toMatchObject({ status: changed ? 'failed' : 'completed', result: {
      activityId: 'prepared-activity', generation: 1, packageDigest: provenance.bundleDigest,
      history: { clear: !changed, coverageAdvanced: !changed },
      presentation: { check: { conclusion: changed ? 'failure' : 'success' } },
    } });
    expect(fixture.wires[0].invocation.input.boundary).toEqual(fixture.expectedBoundary);
    expect(fixture.persisted()).toEqual(fixture.original);
  });

  it.each(['wrong-bot', 'change-claim', 'change-drive'] as const)(
    'publisher lookup cannot grant a compiled drive after %s', async fault => {
      const fixture = await scenario();
      fixture.fault(fault);
      const result = await fixture.drive();
      expect(result).toMatchObject({ status: 'unknown', result: null });
      expect(fixture.wires).toEqual([]); // No child invocation or external task admission.
      expect(fixture.effects).toEqual([]);
      expect(fixture.persisted()).toEqual(fixture.original);
    });
});
