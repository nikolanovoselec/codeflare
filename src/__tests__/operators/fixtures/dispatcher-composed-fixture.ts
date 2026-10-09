/** CI-only composition: real Activity/SQL journal/Loader/Flue; catalog, identity and interceptor upstreams are fixtures. */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import { OperatorActivity as ProductionActivity, OperatorDispatcherCapability as ProductionCapability,
  createOperatorIntentDigest } from '../../../operators/activity';
import { createOperatorExecutionContext } from '../../../operators/execution-context';
import { parseDispatcherBundle, type DispatcherBundle } from '../../../operators/distribution';
import { driveDispatcherRuntime } from '../../../operators/runtime';
import type { ManagementAdmissionRequest, ManagementExecutionSelection } from '../../../operators/registry';
import type { Env } from '../../../types';
import { SETUP_KEYS } from '../../../lib/kv-keys';
import { getBuiltInProfile, getBuiltInProfileRef } from '../../../lib/reasoning-profiles';
import { connectionFingerprint } from '../../../lib/reasoning-verification';
import { PI_WIRE_CANARY_VERSION } from '../../../lib/reasoning-discovery';
import { setLogLevel } from '../../../lib/logger';

type RecoveryScenario = 'ordinary' | 'incomplete' | 'native-error' | 'precommit-reset' | 'committed-reset' | 'duplicate' | 'persistent' | 'large-evidence-comment-batch' | 'thirty-target-original-evidence-recovery';
interface FixtureEnv {
  KV: KVNamespace;
  LOADER: NonNullable<Env['LOADER']>;
  OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity>;
  RECOVERY_SERVICES: DurableObjectNamespace<RecoveryServices>;
}
const issuer = 'https://dispatcher-fixture.cloudflareaccess.com';
const email = 'owner@example.test';
const accessJwt = 'fixture-only-access';
const encryption = { ENCRYPTION_KEY: btoa('f'.repeat(32)) };
const gateway = { gatewayUrl: `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/fixture/compat`, gatewayId: 'fixture', token: 'fixture-only-token' };
const repository = 'authorized/project';
const target = { pullRequest: 17, headSha: 'a'.repeat(40) };
const researchUrl = 'https://docs.example.test/migration';
const quote = 'Migration compatibility remains unverified.';
const comment = `${quote} Source: ${researchUrl}`;
// REQ-DISPATCHER-001 AC2; 002 AC2/3/4/5/7/10: upstream bytes, never synthetic tool decisions.
const largeEvidenceTargets = Array.from({ length: 7 }, (_, index) => ({
  pullRequest: 17 + index, headSha: (index + 1).toString(16).repeat(40),
}));
const largeEvidence = Array.from({ length: 32 }, (_, index) => {
  const target = largeEvidenceTargets[index % 7];
  const url = `https://docs.example.test/migration-${index}`;
  const quote = `Migration compatibility for PR ${target.pullRequest}, evidence ${index}, remains unverified.`;
  const length = index < 28 ? 8192 : 20480;
  return { target, url, quote, body: quote + 'x'.repeat(length - quote.length), kind: 'upstream' as const };
});
const largeComment = (index: number) => `${largeEvidence[index].quote} Source: ${largeEvidence[index].url}`;
const thirtyTargets = Array.from({ length: 30 }, (_, index) => ({
  pullRequest: 17 + index, headSha: (index + 1).toString(16).padStart(40, '0'),
}));
const thirtyEvidence = Array.from({ length: 36 }, (_, index) => {
  const target = thirtyTargets[index % 30];
  const url = `https://docs.example.test/migration-${index}`;
  const quote = `Migration compatibility for PR ${target.pullRequest}, evidence ${index}, remains unverified.`;
  const length = index < 28 ? 8192 : 20480;
  return { target, url, quote, body: quote + 'x'.repeat(length - quote.length), kind: 'upstream' as const };
});
const thirtyComment = (index: number) => `${thirtyEvidence[index].quote} Source: ${thirtyEvidence[index].url} ${'Missing verified configuration and migration evidence. '.repeat(16)}`;
const services = (env: FixtureEnv) => env.RECOVERY_SERVICES.getByName('services');
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const wire = (chunks: unknown[]) => new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
let identityService: (() => { identity(): Promise<Response> }) | undefined;
let diagnosticActivity: string | undefined;
const diagnostics: Array<Record<string, string | number | boolean | null>> = [];
// CI-only original-request trace; error level survives the harness's error-only logger.
export const fixtureObservationId = (request: Request): string | undefined => {
  const candidate = request.headers.get('x-codeflare-fixture-observation-id');
  const activity = new URL(request.url).searchParams.get('activity');
  return ['large-evidence-', 'thirty-evidence-'].some(prefix => activity?.startsWith(prefix)) && candidate
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidate) ? candidate : undefined;
};
export const observeBoundary = (observationId: string | undefined,
  boundary: 'worker-entered' | 'worker-rejected' | 'composed-entered' | 'request-body-started'
    | 'request-body-completed' | 'agent-lookup-started' | 'agent-lookup-completed'
    | 'rpc-started' | 'detail-completed'
    | 'external-completed' | 'activity-return-ready' | 'rpc-completed' | 'json-started' | 'json-completed' | 'diagnose-started') => {
  if (observationId) console.error(`[native-flue] observe-boundary=${JSON.stringify({ observationId, boundary })}`);
};
export type CanonicalAppendObservation = { category: 'canonical-append-oversized' | 'canonical-append-other'; largestRecordType?: 'state_write' };
type SdkObservation = { stage: 'sdk-submission-running' | 'sdk-submission-exhausted'; submissionDigest: string; attemptCount: number; maxAttempts: number };
type RetainedObservation = {
  inference: Array<{ inputDigest: string; turn: number }>;
  comments: Array<{ id: number; body: string; user: { id: number; login: string; type: string }; issue_url: string }>;
  sourceRequests: Array<{ url: string; method: string }>; held: boolean;
  duplicates: Array<{ statuses: number[]; digests: string[] }>;
  budget?: { operationCount: number; operationLimit: number };
  evidence: Array<{ index: number; complete: boolean }>; batches: string[][];
  firstAppend: CanonicalAppendObservation | null; sdkSubmissions: SdkObservation[];
};
/** Pure fixture-only classifier: public SDK errors in, closed evidence out. */
export function fixtureOperatorDispatcherTail(events: unknown): CanonicalAppendObservation | null {
  let first: CanonicalAppendObservation | null = null;
  const visit = (value: unknown): void => {
    if (first) return;
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try { visit(JSON.parse(value)); } catch { /* Unclassified text is not evidence. */ }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      const meta = item.meta as Record<string, unknown> | undefined;
      if (item.stage === 'sdk-canonical-append' && item.errorType === 'conversation_stream_store_failure'
        && item.operation === 'append' && ['canonical-append-oversized', 'canonical-append-other'].includes(String(item.category))) {
        first = { category: item.category as CanonicalAppendObservation['category'],
          ...(item.largestRecordType === 'state_write' ? { largestRecordType: 'state_write' as const } : {}) };
        return;
      }
      if (item.type === 'conversation_stream_store_failure' && meta?.operation === 'append') {
        first = { category: 'canonical-append-other' };
        if (typeof meta.reason !== 'string') return;
        const match = /^The batch serializes to ~[0-9]+\.[0-9]MB, above the 12MB per-append ceiling\. The largest record is a "([a-z_]+)" record \(id "[^"\r\n]+"\) at ~[0-9]+\.[0-9]MB\. Oversized tool results and message content must be truncated before they are recorded \(built-in tools cap results at 50KB\)\.$/.exec(meta.reason);
        if (match) first = { category: 'canonical-append-oversized', ...(match[1] === 'state_write' ? { largestRecordType: 'state_write' as const } : {}) };
        return;
      }
      Object.values(item).forEach(visit);
    }
  };
  visit(events);
  return first;
}

/** Public running/exhaustion counts correlated by the compiled app's opaque digest. */
export function fixtureSubmissionRunning(events: unknown): SdkObservation[] {
  const entries: SdkObservation[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try { visit(JSON.parse(value)); } catch { /* No raw text retained. */ }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      if ((item.stage === 'sdk-submission-running' || item.stage === 'sdk-submission-exhausted')
        && typeof item.submissionDigest === 'string' && /^[a-f0-9]{64}$/.test(item.submissionDigest)
        && typeof item.attemptCount === 'number' && typeof item.maxAttempts === 'number'
        && Number.isSafeInteger(item.attemptCount) && Number.isSafeInteger(item.maxAttempts)
        && item.attemptCount > 0 && item.maxAttempts >= item.attemptCount) {
        entries.push({ stage: item.stage, submissionDigest: item.submissionDigest, attemptCount: item.attemptCount, maxAttempts: item.maxAttempts });
      }
      Object.values(item).forEach(visit);
    }
  };
  visit(events);
  return entries;
}

const capture = (value: unknown) => {
  try {
    const entry = JSON.parse(String(value));
    const identityDenial = entry.module === 'access' && entry.message === 'Operator human authentication denied';
    if (!diagnosticActivity || (!identityDenial && (!['operator-inference', 'dispatcher-settlement'].includes(entry.module)
      || entry.data?.activityId !== diagnosticActivity))) return;
    const observation: Record<string, string | number | boolean | null> = { module: entry.module };
    for (const key of ['stage', 'outcome', 'boundary', 'status', 'failureClass', 'inferenceOutcome',
      'inferenceAttempt', 'operationOrdinal', 'operationCount', 'reasonCode', 'reasonDigest', 'reasonBytes',
      'errorType', 'lastToolRole', 'lastToolOutcome', 'reason', 'messages', 'tools']) {
      const item = entry.data[key];
      if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) observation[key] = item;
    }
    const sdkErrorType = entry.data.sdkErrorType;
    if (typeof sdkErrorType === 'string' && ['cloudflare_ai_binding_error', 'invalid_request', 'tool_input_validation',
      'tool_output_validation', 'operation_failed', 'submission_timeout', 'submission_aborted',
      'internal_error', 'submission_retry_exhausted', 'other'].includes(sdkErrorType)) observation.sdkErrorType = sdkErrorType;
    diagnostics.push(observation);
    if (diagnostics.length > 64) diagnostics.shift();
  } catch { /* Only selected fields from the existing closed diagnostic wire are retained. */ }
};
for (const level of ['log', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...values: unknown[]) => { capture(values[0]); original(...values); };
}
const externalFetch = globalThis.fetch;
// Synthetic Access upstream only. Production identity parsing, subject/email/grant checks remain real.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url === `${issuer}/cdn-cgi/access/get-identity`) {
    return identityService && request.redirect === 'manual' && request.headers.get('cookie') === `CF_Authorization=${accessJwt}`
      ? identityService().identity() : Promise.resolve(new Response(null, { status: 401 }));
  }
  return externalFetch(input, init);
}) as typeof fetch;

/** External service owns fault barriers; evicting the Activity does not erase paid-attempt observations. */
export class RecoveryServices extends DurableObject<FixtureEnv> {
  private releaseBarrier?: () => void;
  async configure(artifact: DispatcherBundle, digest: string, scenario: RecoveryScenario, attemptLimit: number, submissionAttemptLimit?: number, activityId?: string) {
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    await parseDispatcherBundle(bytes, digest);
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024) await this.ctx.storage.put(`bundle:${offset}`, bytes.slice(offset, offset + 48 * 1024));
    await this.ctx.storage.put({ bundleSize: bytes.length, scenario, attemptLimit, revoked: false,
      inference: [], comments: [], sourceRequests: [], duplicates: [], firstAppend: null, sdkSubmissions: [], activityId: activityId ?? null });
    const policy = { capabilities: ['fetch', 'inference'], resourceProfileId: null };
    const grants = { users: [email], groups: [] };
    const selection: ManagementExecutionSelection = {
      controlsRevision: 1, manifestJson: '{}',
      installation: { id: 'composed-installation', operatorId: 'composed-dispatcher', revision: 1, enabled: true,
        name: 'fixture', releaseId: 'composed-release', approvedSourceRevision: 1, policy,
        configurationJson: JSON.stringify({ renovate: { repository, automaticRuns: false, repetitionIntervalSeconds: 3600 } }) },
      operator: { id: 'composed-dispatcher', operatorId: 'composed-dispatcher', revision: 1,
        repositoryUrl: 'https://github.com/example/dispatcher', repositoryId: 1, profile: 'dispatcher', realm: 'internal', enabled: true,
        managers: grants, invokers: grants, policy: { ...policy, inferenceAttemptLimit: attemptLimit, ...(submissionAttemptLimit === undefined ? {} : { submissionAttemptLimit }) },
        source: { kind: 'github-release', repositoryUrl: 'https://github.com/example/dispatcher', repositoryId: 1, credentialConfigured: true, approvedWorkflow: null } },
      release: { id: 'composed-release', operatorId: 'composed-dispatcher', githubReleaseId: 1, sourceCommit: artifact.sourceCommit,
        manifestDigest: 'b'.repeat(64), bundleDigest: digest, interfaceVersion: 1, approved: true,
        repositoryId: 1, sourceRevision: 1, coreVersion: '1', intentVersion: '3', requestedCapabilities: ['fetch', 'inference'], assets: [],
        provenance: { workflowId: 1, workflowRef: 'refs/heads/develop', runId: 1, runAttempt: 1, artifactId: 1, artifactDigest: 'c'.repeat(64) } },
    };
    await this.ctx.storage.put('selection', selection);
    const ref = getBuiltInProfileRef('openai-gpt-chat-tools-off');
    await this.env.KV.put(SETUP_KEYS.DYNAMIC_ROUTES, JSON.stringify(['approved']));
    await this.env.KV.put(SETUP_KEYS.REASONING_CONFIGURATION, JSON.stringify({ schemaVersion: 1, customProfileRevisions: [],
      routeAssignments: { approved: { activeProfile: ref, verification: { schemaVersion: 1, profileRef: ref,
        routeVersion: 'fixture-v1', inventoryDigest: 'd'.repeat(64), connectionFingerprint: connectionFingerprint(gateway),
        canaryVersion: PI_WIRE_CANARY_VERSION, supportedLevels: getBuiltInProfile(ref.id)!.supportedLevels,
        scope: 'single-model', checkedAt: new Date().toISOString() } } },
      fallbackRouting: { enabled: true, routes: ['approved'], defaultRoute: 'approved', reasoning: 'off' } }));
    return { ok: true };
  }
  async changeSubmissionPolicy(submissionAttemptLimit: number) {
    const selection = (await this.ctx.storage.get<ManagementExecutionSelection>('selection'))!;
    await this.ctx.storage.put('selection', { ...selection, operator: { ...selection.operator,
      policy: { ...selection.operator.policy, submissionAttemptLimit } } });
  }
  async identity(): Promise<Response> {
    return await this.ctx.storage.get('revoked') ? new Response(null, { status: 401 })
      : Response.json({ user_uuid: 'fixture-owner', email });
  }
  async revoke() { await this.ctx.storage.put('revoked', true); }
  async resolveManagementExecution(_id: string) { return { ok: true, value: (await this.ctx.storage.get<ManagementExecutionSelection>('selection'))! }; }
  async admitManagement(request: ManagementAdmissionRequest) {
    return { ok: true, value: { ...request, admittedAt: Date.now(), selection: (await this.ctx.storage.get<ManagementExecutionSelection>('selection'))! } };
  }
  async upsertOwnedActivity(_owner: string, _summary: unknown) { /* Projection is read from the real owner in these cases. */ }
  async getManagementBundle(_digest: string) {
    const size = (await this.ctx.storage.get<number>('bundleSize'))!;
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 48 * 1024) bytes.set((await this.ctx.storage.get<Uint8Array>(`bundle:${offset}`))!, offset);
    return bytes;
  }
  private async append(key: string, value: unknown) {
    await this.ctx.storage.transaction(async tx => { await tx.put(key, [...(await tx.get<unknown[]>(key) ?? []), value]); });
  }
  async claimFault(kind: string): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => {
      if (await tx.get('scenario') !== kind || await tx.get(`fault:${kind}`)) return false;
      await tx.put(`fault:${kind}`, true); return true;
    });
  }
  async hold() {
    await this.ctx.storage.put('held', true);
    await new Promise<void>(resolve => { this.releaseBarrier = resolve; });
  }
  async release() { this.releaseBarrier?.(); this.releaseBarrier = undefined; await this.ctx.storage.put('released', true); }
  async duplicate(statuses: number[], digests: string[]) { await this.append('duplicates', { statuses, digests }); }
  async rememberSource(operationId: string) { if (!await this.ctx.storage.get('sourceId')) await this.ctx.storage.put('sourceId', operationId); }
  async sourceId() { return await this.ctx.storage.get<string>('sourceId'); }
  async budget(value: { operationCount: number; operationLimit: number }) { await this.ctx.storage.put('budget', value); }
  async recordTail(activityId: string, generation: number, firstAppend: CanonicalAppendObservation | null,
    sdkSubmissions: SdkObservation[]) {
    if (generation !== 1 || activityId !== await this.ctx.storage.get('activityId')) return;
    if (firstAppend && !await this.ctx.storage.get('firstAppend')) await this.ctx.storage.put('firstAppend', firstAppend);
    for (const entry of sdkSubmissions) await this.append('sdkSubmissions', entry);
  }
  async observe(): Promise<RetainedObservation> {
    return { inference: await this.ctx.storage.get<RetainedObservation['inference']>('inference') ?? [],
      comments: await this.ctx.storage.get<RetainedObservation['comments']>('comments') ?? [],
      sourceRequests: await this.ctx.storage.get<RetainedObservation['sourceRequests']>('sourceRequests') ?? [],
      held: await this.ctx.storage.get<boolean>('held') ?? false,
      duplicates: await this.ctx.storage.get<RetainedObservation['duplicates']>('duplicates') ?? [],
      budget: await this.ctx.storage.get<RetainedObservation['budget']>('budget'),
      evidence: await this.ctx.storage.get<RetainedObservation['evidence']>('evidence') ?? [],
      batches: await this.ctx.storage.get<RetainedObservation['batches']>('batches') ?? [],
      firstAppend: await this.ctx.storage.get<CanonicalAppendObservation | null>('firstAppend') ?? null,
      sdkSubmissions: await this.ctx.storage.get<SdkObservation[]>('sdkSubmissions') ?? [] };
  }
  async inference(request: Request): Promise<Response> {
    const body = await request.text();
    const input = JSON.parse(body) as { messages: Array<{ tool_calls?: Array<{ function?: { name?: string } }> }> };
    const scenario = await this.ctx.storage.get('scenario');
    if (scenario === 'large-evidence-comment-batch' || scenario === 'thirty-target-original-evidence-recovery') {
      return this.largeInference(input, body, scenario === 'thirty-target-original-evidence-recovery');
    }
    const names = input.messages.flatMap(message => message.tool_calls?.map(tool => tool.function?.name) ?? []);
    const sequence = ['discover_renovate', 'research_renovate', 'decide_renovate', 'seal_dispatcher', 'comment_renovate', 'finish_dispatcher'];
    const turn = Math.max(-1, ...names.map(name => sequence.indexOf(name ?? ''))) + 1;
    await this.append('inference', { inputDigest: await hash(body), turn });
    if (await this.claimFault('precommit-reset')) await this.hold();
    if (await this.claimFault('incomplete') || await this.ctx.storage.get('scenario') === 'persistent') return wire([{ choices: [{ delta: {}, finish_reason: null }] }]);
    if (await this.claimFault('native-error')) return wire([{ error: { code: 'NATIVE_BEDROCK_STREAM_ERROR' } }]);
    const tool = sequence[turn];
    if (!tool) return new Response(null, { status: 400 });
    const artifact = `artifact-${(await hash(JSON.stringify({ target, url: researchUrl, kind: 'upstream' }))).slice(0, 24)}`;
    const args = tool === 'research_renovate' ? { target, url: researchUrl, kind: 'upstream' }
      : tool === 'decide_renovate' ? { target, decision: 'DO_NOT_MERGE', comment,
        claims: [{ artifactId: artifact, quote, relevance: 'migration uncertainty', authority: 'publisher guidance' }],
        analysis: { changedUsage: 'unverified', configuration: 'unverified', interoperability: 'unverified', migration: 'unverified', gaps: ['No verified compatibility declaration'] } }
      : tool === 'comment_renovate' ? { target } : {};
    return wire([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `composed-${turn}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]);
  }
  private async largeInference(input: { messages: unknown[] }, body: string, recovery = false): Promise<Response> {
    const expectedTargets = recovery ? thirtyTargets : largeEvidenceTargets;
    const expectedEvidence = recovery ? thirtyEvidence : largeEvidence;
    const expectedComment = recovery ? thirtyComment : largeComment;
    const calls: Array<{ name: string; arguments: string }> = [];
    const artifacts = new Map<string, Record<string, unknown>>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
        try { visit(JSON.parse(value)); } catch { /* Plain source text is not a wire object. */ }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        if (typeof item.name === 'string' && typeof item.arguments === 'string') calls.push(item as { name: string; arguments: string });
        if (typeof item.id === 'string' && typeof item.body === 'string' && typeof item.digest === 'string') artifacts.set(item.id, item);
        Object.values(item).forEach(visit);
      }
    };
    visit(input.messages);
    const researched = calls.filter(item => item.name === 'research_renovate').length;
    const decided = calls.filter(item => item.name === 'decide_renovate').length;
    const sealed = calls.some(item => item.name === 'seal_dispatcher');
    const commentCalls = calls.filter(item => item.name === 'comment_renovate').length;
    const commented = recovery ? commentCalls >= expectedTargets.length * 2 : commentCalls > 0;
    const observed = [];
    for (const [index, expected] of expectedEvidence.entries()) {
      const id = `artifact-${(await hash(JSON.stringify({ target: expected.target, url: expected.url, kind: expected.kind }))).slice(0, 24)}`;
      const actual = artifacts.get(id);
      if (!actual) continue;
      observed.push({ index, complete: actual.complete === true && actual.status === 200 && actual.body === expected.body
        && actual.digest === await hash(expected.body) && actual.bodyOffset === 0 && actual.bodyLength === expected.body.length
        && actual.bodyTruncated === false && JSON.stringify(actual.target) === JSON.stringify(expected.target)
        && actual.url === expected.url && expected.body.includes(expected.quote) });
    }
    await this.ctx.storage.put('evidence', observed);
    let batch: Array<{ name: string; args: unknown }>;
    if (!calls.some(item => item.name === 'discover_renovate')) batch = [{ name: 'discover_renovate', args: {} }];
    else if (researched < expectedEvidence.length) batch = expectedEvidence.slice(researched, researched + 4).map(item => ({
      name: 'research_renovate', args: { target: item.target, url: item.url, kind: item.kind },
    }));
    else if (!decided) {
      // A model answer cannot bypass incomplete/truncated/misattributed research.
      if (observed.length !== expectedEvidence.length || observed.some(item => !item.complete)) return new Response(null, { status: 422 });
      batch = expectedTargets.map((target, index) => ({ name: 'decide_renovate', args: {
        target, decision: 'DO_NOT_MERGE', comment: expectedComment(index),
        claims: [{ artifactId: [...artifacts.keys()].find(id => artifacts.get(id)?.url === expectedEvidence[index].url),
          quote: expectedEvidence[index].quote, relevance: 'target-specific migration uncertainty', authority: 'publisher guidance' }],
        analysis: { changedUsage: 'unverified', configuration: 'unverified', interoperability: 'unverified',
          migration: 'unverified', gaps: ['No verified compatibility declaration'] },
      } }));
    } else if (!sealed) batch = [{ name: 'seal_dispatcher', args: {} }];
    else if (!commented) batch = expectedTargets.map(target => ({ name: 'comment_renovate', args: { target } }));
    else batch = [{ name: 'finish_dispatcher', args: {} }];
    // The next model turn explicitly reissues tools; a fresh source failure never retries itself.
    if (recovery && commentCalls === expectedTargets.length && !await this.ctx.storage.get('held')) await this.hold();
    await this.append('inference', { inputDigest: await hash(body), turn: calls.length });
    await this.append('batches', batch.map(item => item.name));
    return wire([{ choices: [{ index: 0, delta: { tool_calls: batch.map((item, index) => ({ index,
      id: `large-${calls.length}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]);
  }
  async source(request: Request): Promise<Response> {
    await this.append('sourceRequests', { url: request.url, method: request.method });
    const bot = { id: 29139614, login: 'renovate[bot]', type: 'Bot' };
    const scenario = await this.ctx.storage.get('scenario');
    const recovery = scenario === 'thirty-target-original-evidence-recovery';
    const actor = recovery && await this.ctx.storage.get('held')
      ? { id: 43, login: 'replacement-publisher', type: 'User' } : { id: 42, login: 'fixture-publisher', type: 'User' };
    const base = `https://api.github.com/repos/${repository}`;
    const large = scenario === 'large-evidence-comment-batch' || recovery;
    const targets = recovery ? thirtyTargets : largeEvidenceTargets;
    const selected = large ? targets.find(item => new URL(request.url).pathname.match(/\/(?:pulls|issues)\/(\d+)/)?.[1] === String(item.pullRequest)) ?? target : target;
    const pull = { number: selected.pullRequest, state: 'open', draft: false, created_at: new Date(Date.now() - 86400000).toISOString(),
      user: bot, head: { sha: selected.headSha }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 123, full_name: repository } } };
    const evidence = large && (recovery ? thirtyEvidence : largeEvidence).find(item => item.url === request.url);
    if (evidence) return new Response(evidence.body, { headers: { 'content-type': 'text/plain' } });
    if (request.url === researchUrl) return new Response(quote, { headers: { 'content-type': 'text/plain' } });
    if (request.url === `${base}/issues/${selected.pullRequest}/comments` && request.method === 'POST') {
      const value = await request.json<{ body: string }>();
      const entry = { id: 91 + (await this.ctx.storage.get<unknown[]>('comments') ?? []).length, body: value.body, user: actor, issue_url: `${base}/issues/${selected.pullRequest}` };
      await this.append('comments', entry); return Response.json(entry, { status: 201 });
    }
    if (request.method !== 'GET') return new Response(null, { status: 403 });
    if (recovery && request.url === 'https://api.github.com/user' && await this.claimFault('thirty-target-original-evidence-recovery')) {
      return Response.json({ error: 'Synthetic upstream read failure', code: 'GITHUB_FETCH_FAILED' }, { status: 502 });
    }
    if (large && request.url.startsWith(`${base}/pulls?`)) {
      const page = Number(new URL(request.url).searchParams.get('page'));
      const item = targets[page - 1];
      return Response.json(item ? [{ ...pull, number: item.pullRequest, head: { sha: item.headSha },
        created_at: new Date(Date.now() - (page + 1) * (recovery ? 3600000 : 86400000)).toISOString() }] : [],
        { headers: page < targets.length ? { link: `<${base}/pulls?page=${page + 1}>; rel="next"` } : {} });
    }
    const paths: Record<string, unknown> = {
      [base]: { id: 123, full_name: repository, default_branch: 'main' },
      'https://api.github.com/users/renovate%5Bbot%5D': bot,
      [`${base}/pulls?state=open&sort=created&direction=desc&per_page=1&page=1`]: [pull],
      [`${base}/pulls/${selected.pullRequest}`]: pull,
      [`${base}/issues/${selected.pullRequest}/comments?per_page=100`]: (await this.ctx.storage.get<Array<{ issue_url: string }>>('comments') ?? []).filter(item => item.issue_url === `${base}/issues/${selected.pullRequest}`),
      'https://api.github.com/user': actor,
    };
    return Object.hasOwn(paths, request.url) ? Response.json(paths[request.url]) : new Response(null, { status: 404 });
  }
}

/** This class name is deliberately the production SDK root path, not a separate synthetic Flue root. */
export class OperatorActivity extends ProductionActivity {
  private readonly instance = crypto.randomUUID();
  private readonly fixtureEnv: FixtureEnv;
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    identityService = () => services(env);
    super(ctx, { ...env, ...encryption, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: gateway.gatewayUrl,
      AIG_GATEWAY_ID: gateway.gatewayId, AIG_TOKEN: gateway.token,
      OPERATOR_REGISTRY: { getByName: () => services(env) },
      CONTAINER: { idFromName: (name: string) => name, get: () => ({ claimBucketOwner: async () => 'owned' }) },
    } as unknown as Env);
    this.fixtureEnv = env;
  }
  async startComposed(id: string, artifact: DispatcherBundle, digest: string) {
    diagnosticActivity = id; diagnostics.length = 0; setLogLevel('info');
    const now = Math.floor(Date.now() / 1000);
    const human = { subject: 'fixture-owner', email, issuer, audiences: ['fixture'], issuedAt: now - 1, expiresAt: now + 180 };
    const invocationJson = JSON.stringify({ repository });
    const context = await createOperatorExecutionContext({ activityId: id, operatorId: 'composed-dispatcher', artifactDigest: digest,
      policyDigest: await hash(JSON.stringify((await services(this.fixtureEnv).resolveManagementExecution('composed-installation')).value.installation.policy)), human, accessJwt }, encryption);
    const prepared = await this.prepareAuthorized({ activityId: id, operatorId: 'composed-dispatcher', installationId: 'composed-installation',
      intentDigest: await createOperatorIntentDigest('composed-dispatcher', id, invocationJson), expectedRevision: 1,
      expectedInstallationRevision: 1, expectedControlsRevision: 1, deadline: human.expiresAt * 1000,
      startExpiresAt: human.expiresAt * 1000, startVerifier: await hash('s'.repeat(43)) }, context, invocationJson);
    if (!prepared.ok) return prepared;
    const started = await this.start('s'.repeat(43));
    if (!started.ok) return started;
    const approved = await parseDispatcherBundle(await services(this.fixtureEnv).getManagementBundle(digest), digest);
    const result = await driveDispatcherRuntime({ activity: this, deadline: human.expiresAt * 1000, bundle: approved,
      artifactDigest: digest, invocation: { repository } });
    return { ...result, diagnostics: [...diagnostics] };

  }
  async observeComposed(observationId?: string) {
    // Match production status reads; drive/alarm paths own reconciliation.
    const detail = await this.getBrowserDetail();
    observeBoundary(observationId, 'detail-completed');
    const external = await services(this.fixtureEnv).observe();
    observeBoundary(observationId, 'external-completed');
    const retained = [...diagnostics];
    observeBoundary(observationId, 'activity-return-ready');
    return { instance: this.instance, detail, external, diagnostics: retained };
  }
  async diagnoseComposed(observationId?: string) {
    observeBoundary(observationId, 'diagnose-started');
    // Snapshot existing settlement evidence before journal inspection can evict it from the ring.
    const settlementBoundaries = diagnostics.flatMap(entry => {
      if (!['settlement', 'assessment', 'sdk-release'].includes(String(entry.stage))
        || !['started', 'completed', 'observed', 'pending', 'failed', 'unknown', 'denied'].includes(String(entry.outcome))) return [];
      return [{ stage: entry.stage, outcome: entry.outcome,
        ...(entry.boundary === 'recheck' ? { boundary: 'recheck' } : {}) }];
    });
    // Read retained owner/service evidence without reconciling or fetching the child.
    const detail = await this.getBrowserDetail();
    observeBoundary(observationId, 'detail-completed');
    const external = await services(this.fixtureEnv).observe();
    observeBoundary(observationId, 'external-completed');
    observeBoundary(observationId, 'activity-return-ready');
    return { executionStatus: detail?.executionStatus ?? 'unprepared',
      collectionStatus: detail?.collectionStatus ?? 'unavailable', firstAppend: external.firstAppend,
      sdkSubmissions: external.sdkSubmissions,
      sdkErrorTypes: [...new Set(diagnostics.flatMap(entry => typeof entry.sdkErrorType === 'string' ? [entry.sdkErrorType] : []))],
      inferenceCount: external.inference.length, commentCount: external.comments.length, settlementBoundaries };
  }
  evictComposed(): void { this.ctx.abort('CI composed Activity reset'); }
}

/** Production capability plus transparent fault delivery, never a substitute journal or SDK settlement. */
export class OperatorDispatcherCapability extends ProductionCapability {
  override async fetch(request: Request): Promise<Response> {
    const control = services(this.env as unknown as FixtureEnv);
    const path = new URL(request.url).pathname;
    if (path === '/v1/dispatcher/source') await control.rememberSource((await request.clone().json<{ operationId: string }>()).operationId);
    if (path !== '/v1/dispatcher/inference') return super.fetch(request);
    if (await control.claimFault('duplicate')) {
      const responses = await Promise.all([super.fetch(request.clone()), super.fetch(request)]);
      await control.duplicate(responses.map(response => response.status), await Promise.all(responses.map(async response => hash(await response.clone().text()))));
      return responses[0];
    }
    const upstream = await super.fetch(request);
    // Own the exact response bytes before ancillary fault-control RPCs; do not retain their live stream.
    const response = new Response(await upstream.arrayBuffer(), {
      status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
    });
    const operationId = await control.sourceId();
    if (response.ok && operationId) {
      const receipt = await super.fetch(new Request('https://operator.internal/v1/dispatcher/receipt', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId }) }));
      if (receipt.ok) {
        const { operationCount, operationLimit } = await receipt.json<{ operationCount: number; operationLimit: number }>();
        await control.budget({ operationCount, operationLimit });
      }
    }
    if (response.ok && await control.claimFault('committed-reset')) await control.hold();
    return response;
  }
}
export class LlmInterceptor extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request) { return services(this.env).inference(request); }
}
export class GitHubInterceptor extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request) { return services(this.env).source(request); }
}
export class EgressController extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request) { return services(this.env).source(request); }
}
export async function composedFixture(request: Request, env: FixtureEnv): Promise<Response> {
  const observationId = fixtureObservationId(request);
  observeBoundary(observationId, 'composed-entered');
  identityService = () => services(env);
  observeBoundary(observationId, 'request-body-started');
  const command = await request.json<{ action: string; artifact?: DispatcherBundle; digest?: string; scenario?: RecoveryScenario; attemptLimit?: number; submissionAttemptLimit?: number }>();
  observeBoundary(observationId, 'request-body-completed');
  const id = new URL(request.url).searchParams.get('activity')!;
  observeBoundary(observationId, 'agent-lookup-started');
  const activity = await getAgentByName(env.OPERATOR_ACTIVITY, id);
  observeBoundary(observationId, 'agent-lookup-completed');
  if (command.action === 'start') {
    await services(env).configure(command.artifact!, command.digest!, command.scenario ?? 'ordinary', command.attemptLimit ?? 4, command.submissionAttemptLimit, id);
    return Response.json(await activity.startComposed(id, command.artifact!, command.digest!));
  }
  if (command.action === 'change-submission-policy') { await services(env).changeSubmissionPolicy(command.submissionAttemptLimit!); return Response.json({ ok: true }); }
  if (command.action === 'observe') {
    observeBoundary(observationId, 'rpc-started');
    const value = await activity.observeComposed(observationId);
    observeBoundary(observationId, 'rpc-completed');
    observeBoundary(observationId, 'json-started');
    const response = Response.json(value);
    observeBoundary(observationId, 'json-completed');
    return response;
  }
  if (command.action === 'diagnose') {
    observeBoundary(observationId, 'rpc-started');
    const value = await activity.diagnoseComposed(observationId);
    observeBoundary(observationId, 'rpc-completed');
    observeBoundary(observationId, 'json-started');
    const response = Response.json(value);
    observeBoundary(observationId, 'json-completed');
    return response;
  }
  if (command.action === 'collect') return Response.json(await activity.collectBrowserResult());
  if (command.action === 'evict') { await activity.evictComposed().catch(() => {}); return Response.json({ evicted: true }); }
  if (command.action === 'release') { await services(env).release(); return Response.json({ released: true }); }
  if (command.action === 'revoke') { await services(env).revoke(); return Response.json({ revoked: true }); }
  if (command.action === 'cancel') return Response.json(await activity.cancelDrive());
  return new Response(null, { status: 400 });
}
