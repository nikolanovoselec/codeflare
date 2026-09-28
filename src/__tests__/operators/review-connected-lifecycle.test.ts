import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { registerOperatorReviewRemote } from '../../../preseed/agents/pi/extensions/operator-review-remote';
import { createConductorProductionCapability } from '../../operators/conductor-production';

const parentState = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(),
  files: [] as unknown[] }));
vi.mock('@cloudflare/containers', () => ({ getContainer: () => ({ fetch: async (request: Request) => {
  const encoded = request.headers.get('x-codeflare-packet-input');
  if (!encoded) throw Error('Approved packet input unavailable');
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
    lane: string; head: string; acknowledgedHead: string | null };
  const evidence = input.lane === 'code-reviewer'
    ? { callSites: {}, anchorsCitingChanged: {} }
    : input.lane === 'spec-reviewer' ? { indexIntegrity: {}, dependencyGraph: {}, anchors: {} }
    : { indexIntegrity: {}, references: {}, anchors: {}, docsCitingChanged: {} };
  const packet = { scope: 'diff', workSet: 'changed-hunks-and-direct-invalidations', lane: input.lane,
    range: `${input.acknowledgedHead}..${input.head}`, files: [], changedInputs: [], patch: '',
    evidence: { lane: input.lane, ...evidence } };
  return new Response(new TextEncoder().encode(JSON.stringify(packet)), {
    headers: { 'content-type': 'application/octet-stream' } });
} }) }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: async () => 'owner-bucket',
  resolveOperatorGroupIdentity: async () => ({ subject: 'owner', email: 'owner@example.test',
    issuer: 'https://access.example.test', audiences: ['operator-audience'],
    expiresAt: Math.floor(Date.now() / 1000) + 300 }),
  canInvokeOperator: () => true, resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['provider-default'],
    defaultRoute: 'provider-default', defaultReasoning: '', routeContextWindows: {},
    routeReasoningLevels: {}, modelDisplayNames: {} }),
}));
vi.mock('../../operators/execution-context', () => ({ openOperatorExecutionAccess: async () => ({
  human: { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
    audiences: ['operator-audience'], expiresAt: Math.floor(Date.now() / 1000) + 300 },
  accessJwt: 'sealed-access' }) }));
vi.mock('../../operators/session-bootstrap', () => ({ bootstrapOperatorSession: async () => ({ bootstrap: {
  r2AccessKeyId: 'scoped-id', r2SecretAccessKey: 'scoped-secret', r2Endpoint: 'https://r2.example.test',
} }) }));
vi.mock('../../operators/approved-git-pack', () => ({ fetchApprovedGitPack: async () => new Uint8Array([1]) }));
vi.mock('../../operators/review-boundary-claim', () => ({ verifyCurrentClaimedBoundaryPacket: async () => true }));
vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'user-token' }));
vi.mock('../../lib/r2-regime-state', () => ({ isBucketMigrating: async () => false,
  isR2SseDisabledForBucket: async () => true }));
vi.mock('../../lib/r2-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/r2-client')>(),
  createR2Client: () => ({ fetch: async (request: Request) => {
    const key = new URL(request.url).pathname;
    if (request.method === 'PUT') {
      parentState.objects.set(key, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    return parentState.objects.has(key) ? new Response(parentState.objects.get(key))
      : new Response(null, { status: 404 });
  } }),
}));
vi.mock('../../operators/owned-session-runtime', () => ({ ContainerOwnedSessionRuntime: class {} }));
vi.mock('../../operators/owned-session', () => ({ OwnedOperatorSessionService: class {
  ensure = async () => ({ status: 'ready' });
  stop = async () => ({ status: 'stopped' });
} }));
vi.mock('../../operators/owned-session-production', () => ({ operatorActivitySessionStore: () => ({}),
  createOperatorSyncReader: async () => async () => null }));
import { collectBoundaryResult, publishBoundaryResult } from '../../../scripts/operator-boundary-action.mjs';
import { createAuthenticatedHistoryTransport, readPublishedReview } from '../../operators/review-history-transport';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const priorHead = 'a'.repeat(40), nextHead = 'b'.repeat(40), base = 'c'.repeat(40);
const finding = { id: 'guard-gap', severity: 'HIGH', path: 'src/guard.ts', line: 12,
  message: 'Authorization missing', evidence: 'The write precedes authorization.' };
const admission = { repositoryId: 138, pullRequest: 34, activityId: 'prior-activity', generation: 2,
  workflowId: 531, runId: 7, runAttempt: 1, packageDigest: 'e'.repeat(64),
  inputDigest: '1'.repeat(64), resourceDigest: '2'.repeat(64), policyDigest: '3'.repeat(64) };
const context = { repositoryId: 138, pullRequest: 34, head: priorHead, base, mergeBase: base };
const presentation = { commentBody: 'Boundary Reviews findings\nActivity prior-activity; complete; 1 finding(s)',
  check: { name: 'Boundary Reviews (shadow)', conclusion: 'failure',
    summary: 'Activity prior-activity; complete; 1 finding(s)' } };

// GitHub is the only history source: the artifact, comment and check below are written by
// the actual Action publisher, then read back through its authenticated HTTP transport.
describe('REQ-OPERATOR-053/056: connected publisher and external history boundary', () => {
  it('connects protected collection through authenticated Pi rejection and compiled next-round reassessment', async () => {
    const binding = { admission, context, packetDigest: 'd'.repeat(64), activityGeneration: 4,
      runId: 7, runAttempt: 1 };
    const result = { status: 'complete', activityId: admission.activityId, generation: 2,
      activityGeneration: 4, repositoryId: 138, pullRequest: 34, head: priorHead,
      packageDigest: admission.packageDigest, manifestDigest: '4'.repeat(64), cleanup: 'stopped',
      originalReports: ['code-reviewer', 'spec-reviewer', 'doc-updater'].map(lane => ({
        schemaVersion: 1, lane, packetDigest: binding.packetDigest, generation: 2,
        head: priorHead, complete: true, omissions: [], findings: lane === 'code-reviewer' ? [finding] : [],
      })), history: { findings: [{ ...finding, lane: 'code-reviewer' }], clear: false,
        coverageAdvanced: true, rebuttals: [] }, presentation };
    const comments: any[] = [], checks: any[] = [], artifacts: any[] = [];
    const json = (value: unknown) => Response.json(value);
    const collected = await collectBoundaryResult({ origin: 'https://enterprise.example.test',
      activityId: admission.activityId, startCapability: 's'.repeat(43) }, {
      fetch: async (request: Request) => {
        const operation = new URL(request.url).pathname.split('/').at(-1);
        if (operation === 'start') return json({ ok: true, phase: 'queued', readCapability: 'r'.repeat(43) });
        if (operation === 'status') return json({ ok: true, terminal: true,
          status: 'completed', generation: 4 });
        if (operation === 'result') return json({ ok: true, terminal: true,
          status: 'completed', generation: 4, result });
        throw Error('Unexpected protected Activity operation');
      }, now: () => 0,
    });
    expect(collected).toMatchObject({ status: 'collected', activityGeneration: 4 });
    if (collected.status !== 'collected') throw new Error('Protected result was not collected');
    expect(collected.result.originalReports[0].findings).toEqual([finding]);
    const publication = await publishBoundaryResult(
      collected,
      { activityId: admission.activityId, generation: 4, repositoryId: 138, pullRequest: 34,
        head: priorHead, packageDigest: admission.packageDigest, resultDigest: digest(result) },
      { activityGeneration: 4, binding, runId: 7, runAttempt: 1,
        ledger: { current: async () => ({ activityId: admission.activityId, generation: 4,
          repositoryId: 138, pullRequest: 34, head: priorHead, base, mergeBase: base }),
          effect: async (request: any) => request.operation === 'begin'
            ? { status: 'new' } : { status: 'published', externalId: request.externalId } },
        artifact: { list: async () => artifacts, read: async (id: number) => artifacts.find(row => row.id === id),
          upload: async (body: any) => { const row = { id: 701,
            name: `boundary-review-${body.digest}`, body }; artifacts.push(row); return row; } },
        github: { origin: 'https://api.github.com', repository: 'owner/repo', token: 'test-token',
          commentAuthorId: 777, checkAppId: 888,
          fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            if (request.method === 'POST') {
              const body = await request.json() as Record<string, unknown>;
              if (path.endsWith('/comments')) {
                const row = { id: 501, user: { id: 777 },
                  issue_url: 'https://api.github.com/repos/owner/repo/issues/34', ...body };
                comments.push(row); return json(row);
              }
              const row = { id: 601, app: { id: 888 }, ...body };
              checks.push(row); return json(row);
            }
            if (path.endsWith('/comments')) return json(comments);
            if (path.endsWith('/check-runs')) return json({ total_count: checks.length, check_runs: checks });
            return json([...comments, ...checks].find(row => path.endsWith(`/${row.id}`)));
          } },
      } as never);
    expect(publication).toMatchObject({ status: 'published' });
    const artifact = artifacts[0].body;
    const signed = 'https://objects.actions.githubusercontent.com/review.zip';
    let zip = zipSync({ 'review.json': strToU8(JSON.stringify(artifact)) }, { level: 0 });
    let liveHead = nextHead;
    const fetch = async (request: Request) => {
      const url = new URL(request.url), path = url.pathname;
      if (url.href === signed) {
        if (request.headers.has('authorization')) throw Error('Signed archive received GitHub credentials');
        return new Response(zip);
      }
      if (request.headers.get('authorization') !== 'Bearer user-token') throw Error('Missing user authority');
      if (path.endsWith('/zip')) return new Response(null, { status: 302, headers: { location: signed } });
      const root = '/repos/owner/repo';
      if (path === root) return json({ id: 138, permissions: { pull: true } });
      if (path === `${root}/pulls/34`) return json({ number: 34, state: 'open',
        head: { sha: liveHead, repo: { id: 138 } }, base: { sha: base, repo: { id: 138 } } });
      if (path === `${root}/commits/${priorHead}/pulls`) return json([{ number: 34 }]);
      if (path === `${root}/commits/${nextHead}/pulls`) return json([{ number: 34 }]);
      if (path === `${root}/compare/${base}...${nextHead}`) return json({ merge_base_commit: { sha: base } });
      if (path.endsWith('/issues/34/comments')) return json(comments);
      if (path.endsWith('/issues/comments/501')) return json(comments[0]);
      if (path.endsWith('/actions/artifacts')) return json({ total_count: 1,
        artifacts: [{ id: 701, name: artifacts[0].name }] });
      if (path.endsWith('/actions/artifacts/701')) return json({ id: 701, expired: false,
        workflow_run: { id: 7, repository_id: 138, head_sha: base } });
      if (path.endsWith('/actions/runs/7')) return json({ id: 7, run_attempt: 1,
        workflow_id: 531, repository: { id: 138 }, head_sha: base,
        event: 'pull_request_target', pull_requests: [{ number: 34 }] });
      if (path.endsWith(`/commits/${priorHead}/check-runs`)) return json({ total_count: 1, check_runs: checks });
      if (path.endsWith('/check-runs/601')) return json(checks[0]);
      throw Error(`Unexpected GitHub path ${path}`);
    };
    const history = createAuthenticatedHistoryTransport({ repository: 'owner/repo', repositoryId: 138,
      pullRequest: 34, head: nextHead, token: 'user-token', current: async () => {}, fetch });
    const published = await readPublishedReview({ repository: 'owner/repo', repositoryId: 138,
      pullRequest: 34, activityId: admission.activityId, trustedWorkflowId: 531,
      head: priorHead, currentHead: nextHead, publisher: { commentAuthorId: 777, checkAppId: 888 }, history });
    expect(published).toMatchObject({ status: 'published', head: priorHead, artifactDigest: artifact.digest,
      findings: [{ ...finding, lane: 'code-reviewer' }] });

    // Pi consumes the same authenticated publication under the current user's GitHub access.
    liveHead = priorHead;
    const branch: any[] = [], messages: any[] = [], submitted: any[] = [];
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
    registerOperatorReviewRemote({
      on: (name: string, handler: (event: any, ctx: any) => Promise<void>) => {
        handlers.set(name, handler); return () => handlers.delete(name);
      },
      sendMessage: (message: any) => { messages.push(message); branch.push({ type: 'custom_message', ...message }); },
      appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }),
    } as never, {
      currentBoundary: async () => ({ repository: 'owner/repo', repositoryId: 138,
        pullRequest: 34, head: liveHead, repo: '/workspace/repo' }),
      selectBoundary: async (boundary: any) => { submitted.push(boundary);
        return { mode: 'remote', activityId: admission.activityId } as const; },
      readPublishedResult: async () => readPublishedReview({ repository: 'owner/repo', repositoryId: 138,
        pullRequest: 34, activityId: admission.activityId, trustedWorkflowId: 531,
        head: priorHead, currentHead: liveHead, publisher: { commentAuthorId: 777, checkAppId: 888 },
        history: createAuthenticatedHistoryTransport({ repository: 'owner/repo', repositoryId: 138,
          pullRequest: 34, head: liveHead, token: 'user-token', current: async () => {}, fetch }) }),
    });
    const piContext = { cwd: '/workspace/repo', sessionManager: {
      getBranch: () => branch, getSessionFile: () => '/owned/review-session.jsonl',
    } };
    const push = { type: 'tool_result', toolName: 'bash', input: { command: 'git push origin feature' },
      result: { isError: false } };
    await handlers.get('tool_result')?.(push, piContext);
    branch.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall',
      id: 'ci-launch', name: 'subagent', arguments: { subagent_type: 'ci-monitor',
        run_in_background: true, inherit_context: false, prompt: JSON.stringify({ repo: 'owner/repo',
          pr: 34, head: priorHead, cwd: '/workspace/repo' }) } }] } });
    branch.push({ type: 'message', message: { role: 'toolResult', toolCallId: 'ci-launch',
      toolName: 'subagent', isError: false } });
    branch.push({ type: 'custom_message', customType: 'subagent-notification',
      content: `<tool-use-id>ci-launch</tool-use-id><status>Done</status>`
        + `<result>CI_RESULT success\npr=34 head=${priorHead} repo=owner/repo</result>` });
    await handlers.get('agent_settled')?.({ type: 'agent_settled' }, piContext);
    expect(messages.at(-1)).toMatchObject({ customType: 'pr-boundary-original-findings',
      details: { head: priorHead, artifactDigest: artifact.digest, findings: [{ id: finding.id }] } });
    branch.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text',
      text: '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n'
        + '|---|---|---|---|---|\n'
        + '| guard-gap | Rejected: guard already covers write | None | Caller checks authorization first | Rejected |',
    }] } });
    await handlers.get('agent_end')?.({ type: 'agent_end' }, piContext);
    liveHead = nextHead;
    await handlers.get('tool_result')?.(push, piContext);
    expect(submitted.at(-1)).toMatchObject({ repositoryId: 138, pullRequest: 34, head: nextHead,
      rejectedFindings: [{ findingId: finding.id, priorActivityId: admission.activityId,
        priorHead, priorRound: admission.generation, originalReportDigest: artifact.digest,
        rationale: 'guard already covers write', evidence: 'Caller checks authorization first' }] });

    // The parent independently re-reads the publication; Pi's submitted evidence is not trusted.
    parentState.files = [];
    parentState.objects.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/users/github-actions%5Bbot%5D') return json({ id: 777,
        login: 'github-actions[bot]', type: 'Bot' });
      if (path === '/apps/github-actions') return json({ id: 888, slug: 'github-actions' });
      return fetch(request);
    };
    try {
      const activityId = 'next-activity';
      const selection = { installation: { id: 'review-install', revision: 2,
        policy: { capabilities: ['session', 'pi', 'storage'], resourceProfileId: 'review-profile' } },
      operator: { operatorId: 'review-operator', revision: 3, profile: 'conductor' },
      release: { bundleDigest: 'e'.repeat(64) }, controlsRevision: 4 };
      const guard = { claimed: true, repositoryId: 138, pullRequest: 34, head: nextHead, base,
        mergeBase: base, contextDigest: '5'.repeat(64), workflowId: 531, runId: 8,
        runAttempt: 1, generation: 1, workflowSha: 'e'.repeat(40),
        session: { bucket: 'owner-bucket', sessionId: 'session01', generation: 1 } };
      const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
        activityId, operatorId: 'review-operator', runId: activityId,
        source: { kind: 'session', reference: 'owner/repo' },
        revision: { reference: nextHead, digest: guard.contextDigest }, inputDigest: 'f'.repeat(64),
        input: { acknowledgedHead: priorHead, evidence: { rejectedFindings: submitted.at(-1).rejectedFindings } },
        attachments: [], resources: { inference: { routeId: 'provider-default', reasoningLevel: null },
          session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' } } };
      const activity = {
        operatorGenerationCurrent: async () => true, getPackageResources: async () => null,
        getOwnedSession: async () => null,
        getCurrentDriveCheckpointJson: async () => null,
        readApprovedPacketAttachments: async () => ({ schemaVersion: 1, activityId, files: parentState.files }),
        saveApprovedPacketAttachment: async (input: any) => {
          const attachment = { name: input.name, mediaType: input.mediaType,
            size: input.size, sha256: input.sha256, locator: input.locator };
          parentState.files.push(attachment);
          return { ok: true, preparationId: input.preparationId, attachment };
        },
      };
      const env = { OPERATOR_REGISTRY: { getByName: () => ({
        resolveManagementExecution: async () => ({ ok: true, value: selection }),
        getBoundaryStartGuard: async () => guard,
      }) }, CONTAINER: {} };
      const plan = { activityId, deadline: Date.now() + 300_000,
        invocationJson: JSON.stringify(invocation), receipt: { selection },
        executionContext: { policyDigest: 'e'.repeat(64) } };
      const createOwner = async () => (await createConductorProductionCapability({ env: env as never,
        plan: plan as never, activity: activity as never, generation: 1,
        driveDeadline: Date.now() + 25_000 })).capability;
      const packetRequest = (lane: string) => new Request('https://operator.internal/v1/packets/prepare', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, preparationId: `round-1-${lane}`, lane }),
      });
      const authenticZip = zip;
      zip = zipSync({ 'review.json': strToU8(JSON.stringify({ ...artifact,
        result: { ...artifact.result, originalReports: [
          { ...artifact.result.originalReports[0], findings: [{ ...finding, message: 'forged' }] },
          ...artifact.result.originalReports.slice(1),
        ] } })) }, { level: 0 });
      expect((await (await createOwner()).fetch(packetRequest('code-reviewer'))).status).toBe(403);
      expect(parentState.files).toEqual([]);
      zip = authenticZip;
      const owner = await createOwner();
      const response = await owner.fetch(packetRequest('code-reviewer'));
      expect(response.status).toBe(200);
      const sealed = await response.json() as { bytes: string; attachment: {
        name: string; mediaType: string; size: number; sha256: string; locator: string } };
      const approved = JSON.parse(Buffer.from(sealed.bytes, 'base64').toString());
      expect(approved.evidence.rejectedFindings).toEqual(submitted.at(-1).rejectedFindings);
      expect(approved.evidence.originalFindings).toEqual([{ ...finding, lane: 'code-reviewer' }]);
      const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
      const packets = [{ lane: lanes[0], attachment: sealed.attachment,
        content: Buffer.from(sealed.bytes, 'base64') }];
      for (const lane of lanes.slice(1)) {
        const prepared = await owner.fetch(packetRequest(lane));
        expect(prepared.status).toBe(200);
        const next = await prepared.json() as typeof sealed;
        const content = Buffer.from(next.bytes, 'base64');
        expect(JSON.parse(content.toString()).evidence.originalFindings).toEqual([{ ...finding, lane: 'code-reviewer' }]);
        packets.push({ lane, attachment: next.attachment, content });
      }
      expect(packets.map(packet => bytesDigest(packet.content)))
        .toEqual(packets.map(packet => packet.attachment.sha256));

      // Materialize the already pinned package; only the external Pi task/results are simulated.
      const bundle = JSON.parse(await readFile(new URL('./fixtures/conductor-review.generated.json', import.meta.url),
        'utf8')) as { mainModule: string; modules: Record<string, { js?: string }> };
      const moduleRoot = await mkdtemp(join(tmpdir(), 'connected-review-'));
      try {
        await writeFile(join(moduleRoot, 'package.json'), '{"type":"module"}\n');
        await Promise.all(Object.entries(bundle.modules).filter(([, value]) => typeof value.js === 'string')
          .map(([name, value]) => writeFile(join(moduleRoot, name), value.js!)));
        const worker = (await import(pathToFileURL(join(moduleRoot, bundle.mainModule)).href))
          .default as { fetch(request: Request, env: unknown): Promise<Response> };
        const packetDigest = bytesDigest(Buffer.from(JSON.stringify({ contextDigest: guard.contextDigest,
          packets: packets.map(packet => ({ lane: packet.lane, digest: packet.attachment.sha256 })) })));
        const compiledInvocation = { ...invocation, input: { ...invocation.input,
          context: { repositoryId: 138, pullRequest: 34, head: nextHead, base, mergeBase: base },
          boundary: { activityId, workflowId: 531, runId: 8, runAttempt: 1,
            commentAuthorId: 777, checkAppId: 888, generation: 1,
            inputDigest: '1'.repeat(64), resourceDigest: '2'.repeat(64),
            policyDigest: '3'.repeat(64), packageDigest: admission.packageDigest } } };
        for (const decision of ['silent', 'resolved'] as const) {
          const objects = new Map<string, Uint8Array>();
          const restored = new Map<string, Buffer>();
          const compiledHistory = createAuthenticatedHistoryTransport({ repository: 'owner/repo',
            repositoryId: 138, pullRequest: 34, head: nextHead, token: 'user-token',
            current: async () => {}, fetch });
          let output: any;
          const parent = { OPERATOR: { fetch: async (request: Request) => {
            const path = new URL(request.url).pathname;
            const body = await request.json() as any;
            if (path === '/v1/history/read') return json(await compiledHistory.read(body));
            if (path === '/v1/packets/prepare') {
              const packet = packets.find(item => item.lane === body.lane);
              if (!packet) throw Error('Unexpected reviewer lane');
              return json({ preparationId: body.preparationId, attachment: packet.attachment,
                bytes: packet.content.toString('base64') });
            }
            if (path === '/v1/session/ensure') return json({ status: 'ready' });
            if (path === '/v1/storage/restore') {
              const packet = packets.find(item => item.attachment.locator === body.attachment.locator);
              if (!packet || packet.attachment.sha256 !== body.attachment.sha256
                || !packet.content.equals(Buffer.from(parentState.objects.get(
                  `/owner-bucket/.codeflare/operator-inputs/${activityId}/${packet.attachment.locator}`) ?? []))) {
                throw Error('Restored packet differs from approved parent bytes');
              }
              restored.set(packet.lane, packet.content);
              return json({ status: 'restored', path: `input/${packet.attachment.name}` });
            }
            if (path === '/v1/pi/ensure') return json({ ready: true, conversationId: 'review-conversation' });
            if (path === '/v1/pi/tasks') {
              expect([...restored.keys()]).toEqual(lanes);
              const codePacket = JSON.parse(restored.get('code-reviewer')!.toString());
              expect(codePacket.evidence.rejectedFindings).toEqual(submitted.at(-1).rejectedFindings);
              expect(codePacket.evidence.originalFindings).toEqual([{ ...finding, lane: 'code-reviewer' }]);
              const reportFiles = lanes.map(lane => {
                const reassessments = lane === 'code-reviewer' && decision === 'resolved'
                  ? [{ findingId: finding.id, decision: 'resolved',
                    reason: 'Authorization before write independently verified',
                    evidence: 'The guarded caller blocks the write before dispatch.' }] : [];
                const report = { schemaVersion: 1, lane, head: nextHead, generation: 1,
                  packetDigest, complete: true, omissions: [], findings: [],
                  ...(reassessments.length ? { reassessments } : {}) };
                const bytes = new TextEncoder().encode(JSON.stringify(report));
                const file = { path: `reports/${activityId}-1-${lane}.json`,
                  size: bytes.length, sha256: bytesDigest(bytes) };
                objects.set(`output/${file.path}`, bytes);
                return file;
              });
              objects.set('private/manifest.json', new TextEncoder().encode(JSON.stringify({
                operationId: `review-${packetDigest}`, files: reportFiles })));
              return json({ status: 'completed', taskId: `review-${packetDigest}` });
            }
            if (path === '/v1/sync/seal') return json({ status: 'sealed',
              manifestDigest: bytesDigest(objects.get('private/manifest.json')!),
              prefix: 'private/', filePrefix: 'output/' });
            if (path === '/v1/storage/read') return json({ bytes: Buffer.from(objects.get(body.key)!).toString('base64') });
            if (path === '/v1/session/stop') return json({ status: 'stopped' });
            throw Error(`Unexpected parent operation ${path}`);
          } } };
          let checkpoint: unknown = null;
          for (let generation = 1; generation <= 4; generation++) {
            output = await (await worker.fetch(new Request('https://operator.internal/drive', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ generation, checkpoint, invocation: compiledInvocation }),
            }), parent)).json();
            if (generation < 4) {
              expect(output.status).toBe('waiting');
              checkpoint = output.checkpoint;
            }
          }
          expect(output).toMatchObject({ status: 'completed', result: { cleanup: 'stopped',
            history: decision === 'silent' ? { clear: false, findings: [{ id: finding.id }] }
              : { clear: true, findings: [] },
            presentation: { check: { conclusion: decision === 'silent' ? 'failure' : 'success' } },
          } });
        }
      } finally { await rm(moduleRoot, { recursive: true, force: true }); }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
