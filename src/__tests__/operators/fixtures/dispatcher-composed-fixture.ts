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
import type { DispatcherPhaseContext, DispatcherPhase } from '../../../operators/dispatcher-phases';
import intent4Manifest from './dispatcher-v024-native.manifest.json';
import { fixtureBrowserAccessUpstream, fixtureOwnerDiagnostics } from './dispatcher-owner-diagnostics';
import type { OperatorBrowserSummary } from '../../../operators/browser-activity';
import { readSdkProvenance, runtimeSchema } from '../../../operators/dispatcher-diagnostics-wire';

const intent4Source = '987af47fb295147d445436b428a410b90cb09be0';

type RecoveryScenario = 'ordinary' | 'incomplete' | 'native-error' | 'precommit-reset' | 'committed-reset' | 'duplicate' | 'persistent' | 'large-evidence-comment-batch' | 'thirty-target-original-evidence-recovery' | 'target-response-failed' | 'target-comment-unknown';
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
// Small supplemental scopes only; the seven/thirty workloads remain unchanged.
const isolationTargets = [target, { pullRequest: 18, headSha: 'c'.repeat(40) }];
const isolationEvidence = isolationTargets.map(target => {
  const quote = `Migration compatibility for PR ${target.pullRequest} remains unverified.`;
  return { target, url: `https://docs.example.test/isolation-${target.pullRequest}`, quote, body: quote, kind: 'upstream' as const };
});
const isolationComment = (index: number) => `${isolationEvidence[index].quote} Source: ${isolationEvidence[index].url}`;
const isIsolation = (scenario: unknown) => scenario === 'target-response-failed' || scenario === 'target-comment-unknown';
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
  return ['large-evidence-', 'thirty-evidence-', 'isolation-'].some(prefix => activity?.startsWith(prefix)) && candidate
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
export type NativeFaultSettlement = {
  submissionDigest: string; attemptDigest: string; obligationDigest: string;
  batchSequence: number; recordIndex: number; producerEpoch: number; producerSequence: number;
  canonicalSequence: number; failureSequence: number; finalizedSequence: number;
};
export type NativeFaultImport = {
  generation: number; events: number; indexSdkImport: string; through: number; localThrough: number;
  dropped: number; pendingSequences: number[] | null; gaps: string[]; armedThrough: number;
};
export type NativeImportOmission = {
  captureDigest: string; submissionDigest: string; attemptDigest: string; rootDigest: string; patchSetDigest: string;
  failureSequence: number; canonicalSequence: number; recoveredSequence: number;
  batchSequence: number; recordIndex: number; producerEpoch: number; producerSequence: number;
  // Frozen source-window counters at recovery capture, not the later tail or parent import.
  localThrough: number; localDropped: number; imported: false;
};
type NativeFaultArm = { scenario: 'ordinary' | 'precommit-reset'; submissionId: string; prefix: string; watermark: number; withholdSdkImports?: boolean };
type FixtureSqlFacet = { sql(strings: string[], ...values: unknown[]): Promise<Record<string, unknown>[]> };
const sqlIdentifier = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) throw new Error('Fixture SDK table name unavailable');
  return `"${name}"`;
};
const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** Decorate collaborators only: native accessors and callable methods retain their
 * original receiver, including SQL, facet initialization, alarms and abort. */
function delegateNative<T extends object>(native: T,
  decorate: (key: PropertyKey, invoke: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): T {
  const methods = new Map<PropertyKey, { original: unknown; delegated: (...args: unknown[]) => unknown }>();
  return new Proxy(native, { get(target, key) {
    const original = Reflect.get(target, key, target);
    if (typeof original !== 'function') return original;
    let method = methods.get(key);
    if (!method || method.original !== original) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor && !descriptor.configurable && 'writable' in descriptor && !descriptor.writable) {
        throw new Error('Native facet method cannot be safely decorated');
      }
      method = { original, delegated: decorate(key, (...args) => Reflect.apply(original, target, args)) };
      methods.set(key, method);
    }
    return method.delegated;
  } });
}
function withoutSdkHeader(response: Response): Response {
  if (!response.headers.has('x-codeflare-sdk-diagnostics')) return response;
  try {
    response.headers.delete('x-codeflare-sdk-diagnostics');
    return response; // Preserve genuine response identity whenever mutable.
  } catch {
    const headers = new Headers(response.headers);
    headers.delete('x-codeflare-sdk-diagnostics');
    // Transfer the untouched stream, never buffer/clone/parse execution bytes.
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
export type FiberObservation = {
  type: 'fiber:run:started' | 'fiber:run:completed' | 'fiber:run:failed' | 'fiber:run:interrupted';
  fiberDigest: string;
};
// Fixture-only bound; overflow is an evidence failure, never a truncated success.
const fiberEvidenceLimit = 512;
/** Agents0.20.1 docs/observability.md Tail wire + BaseEvent payload contract.
 * No recursive log parsing, submission attribution, or synthetic endings.
 */
export async function fixtureFiberLifecycle(events: unknown): Promise<FiberObservation[] | null> {
  if (!Array.isArray(events)) throw new Error('Fixture Tail trace array unavailable');
  if (events.length > 64) throw new Error('Fixture Tail trace evidence bound exceeded');
  const entries: FiberObservation[] = [];
  let inspected = 0;
  for (const trace of events) {
    if (!trace || typeof trace !== 'object') throw new Error('Fixture Tail trace malformed');
    // Absence is retained as unavailable, not interpreted as no active fibers.
    if (!Object.hasOwn(trace, 'diagnosticsChannelEvents')) continue;
    if (!Array.isArray(trace.diagnosticsChannelEvents)) throw new Error('Fixture Tail diagnostic array malformed');
    for (const diagnostic of trace.diagnosticsChannelEvents) {
      if (++inspected > 1024) throw new Error('Fixture Tail diagnostic evidence bound exceeded');
      if (diagnostic?.channel !== 'agents:fiber') continue;
      const event = diagnostic.message;
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Fixture SDK fiber event malformed');
      if (!['fiber:run:started', 'fiber:run:completed', 'fiber:run:failed', 'fiber:run:interrupted'].includes(event.type)) continue;
      const id: unknown = event.payload?.fiberId;
      if (typeof id !== 'string' || !id.length || id.length > 1024) throw new Error('Fixture SDK fiber identity unavailable');
      if (entries.length >= fiberEvidenceLimit) throw new Error('Fixture SDK fiber evidence bound exceeded');
      entries.push({ type: event.type as FiberObservation['type'], fiberDigest: await hash(id) });
    }
  }
  return entries.length ? entries : null;
}
type RetainedObservation = {
  phases: Array<{ context: DispatcherPhaseContext; commentCount: number }>;
  inference: Array<{ inputDigest: string; turn: number; phase?: DispatcherPhase }>;
  comments: Array<{ id: number; body: string; user: { id: number; login: string; type: string }; issue_url: string }>;
  sourceRequests: Array<{ url: string; method: string }>; held: boolean;
  sourceDeliveries: Array<{ operationId: string; url: string; method: string }>;
  isolationFaults: Array<{ kind: string; pullRequest: number; status?: number }>;

  duplicates: Array<{ statuses: number[]; digests: string[] }>;
  budget?: { operationCount: number; operationLimit: number };
  evidence: Array<{ index: number; complete: boolean }>; batches: string[][];
  firstAppend: CanonicalAppendObservation | null; sdkSubmissions: SdkObservation[];
  fiberEvents: FiberObservation[] | null;
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
    for (const key of ['stage', 'outcome', 'boundary', 'status', 'failureClass', 'preparationStep', 'inferenceOutcome',
      'inferenceAttempt', 'operationOrdinal', 'operationCount', 'reasonCode', 'reasonDigest', 'reasonBytes',
      'errorType', 'lastToolRole', 'lastToolOutcome', 'reason', 'messages', 'tools', 'messageMinimum', 'messageMaximum']) {
      const item = entry.data[key];
      if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) observation[key] = item;
    }
    const messageCountViolation = entry.data.messageCountViolation;
    if (messageCountViolation === 'below-minimum' || messageCountViolation === 'above-maximum') {
      observation.messageCountViolation = messageCountViolation;
    }
    // Retain only the existing closed parser labels, never rejected wire data.
    const wireRules = entry.data.wireRules;
    if (Array.isArray(wireRules) && wireRules.length <= 4 && wireRules.every(rule => typeof rule === 'string'
      && /^(?:operation-id|envelope-field|inference-(?:messages-count|messages-shape|tools-count|tools-shape|token-bound|token-shape|temperature|stream|stream-options|max-completion-tokens|unsupported-field|input))$/.test(rule))) {
      observation.wireRules = wireRules.join(',');
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
  if (request.url === `${issuer}/cdn-cgi/access/certs` || request.url === `${issuer}/cdn-cgi/access/get-identity`) {
    return (async () => {
      const browser = await fixtureBrowserAccessUpstream(request);
      if (browser) return browser;
      if (request.url === `${issuer}/cdn-cgi/access/get-identity`) {
        return identityService && request.redirect === 'manual' && request.headers.get('cookie') === `CF_Authorization=${accessJwt}`
          ? identityService().identity() : new Response(null, { status: 401 });
      }
      return externalFetch(input, init);
    })();
  }
  return externalFetch(input, init);
}) as typeof fetch;

/** External service owns fault barriers; evicting the Activity does not erase paid-attempt observations. */
export class RecoveryServices extends DurableObject<FixtureEnv> {
  private releaseBarrier?: () => void;
  async configure(artifact: DispatcherBundle, digest: string, scenario: RecoveryScenario, attemptLimit: number, submissionAttemptLimit?: number, activityId?: string, qualificationManifest?: string, diagnosticCandidate = false, withholdSdkImports = false) {
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    await parseDispatcherBundle(bytes, digest);
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024) await this.ctx.storage.put(`bundle:${offset}`, bytes.slice(offset, offset + 48 * 1024));
    await this.ctx.storage.put({ bundleSize: bytes.length, scenario, attemptLimit, revoked: false,
      inference: [], comments: [], sourceRequests: [], sourceDeliveries: [], isolationFaults: [], duplicates: [], firstAppend: null, sdkSubmissions: [], fiberEvents: null, activityId: activityId ?? null });
    const releaseBrief = qualificationManifest !== undefined && !diagnosticCandidate;
    if (diagnosticCandidate && (!qualificationManifest || !readSdkProvenance(artifact)
      || artifact.versions.runtime !== '2.2.2' || artifact.versions.vitePlugin !== '2.2.2'
      || artifact.versions.agents !== '0.20.1')) {
      throw new Error('Diagnostic candidate requires its verified manifest and exact derived intent4 SDK');
    }
    const intentVersion = releaseBrief ? '1' : diagnosticCandidate || artifact.sourceCommit === intent4Source ? '4' : '3';
    if (qualificationManifest !== undefined) {
      const manifest = JSON.parse(qualificationManifest);
      if (manifest.intentVersion !== intentVersion || manifest.profile !== 'dispatcher'
        || manifest.artifact?.sha256 !== digest || releaseBrief && manifest.id !== 'release-brief-dispatcher-ci') {
        throw new Error('CI qualification manifest mismatch');
      }
    }
    if (diagnosticCandidate && scenario !== 'ordinary' && scenario !== 'precommit-reset') {
      throw new Error('Native faults are limited to the two approved candidate supplements');
    }
    if (withholdSdkImports && (!diagnosticCandidate || scenario !== 'ordinary')) {
      throw new Error('SDK import withholding requires the ordinary native candidate');
    }
    await this.ctx.storage.put({ releaseBrief, diagnosticCandidate, withholdSdkImports });
    // Official v24 stays immutable. An explicitly CI-pinned diagnostic candidate
    // retains intent4; historical artifacts keep their original admission.
    const manifestJson = qualificationManifest ?? (intentVersion === '4' ? JSON.stringify({ ...intent4Manifest,
      artifact: { ...intent4Manifest.artifact, sha256: digest } }) : '{}');
    await this.ctx.storage.put({ intentVersion, phases: [], ...(intentVersion === '4' ? { evidence: [], batches: [] } : {}) });
    const policy = { capabilities: ['fetch', 'inference'], resourceProfileId: null };
    const grants = { users: [email], groups: [] };
    const selection: ManagementExecutionSelection = {
      controlsRevision: 1, manifestJson,
      installation: { id: 'composed-installation', operatorId: 'composed-dispatcher', revision: 1, enabled: true,
        name: 'fixture', releaseId: 'composed-release', approvedSourceRevision: 1, policy,
        configurationJson: JSON.stringify({ renovate: { repository, automaticRuns: false, repetitionIntervalSeconds: 3600 } }) },
      operator: { id: 'composed-dispatcher', operatorId: 'composed-dispatcher', revision: 1,
        repositoryUrl: 'https://github.com/example/dispatcher', repositoryId: 1, profile: 'dispatcher', realm: 'internal', enabled: true,
        managers: grants, invokers: grants, policy: { ...policy, inferenceAttemptLimit: attemptLimit, ...(submissionAttemptLimit === undefined ? {} : { submissionAttemptLimit }) },
        source: { kind: 'github-release', repositoryUrl: 'https://github.com/example/dispatcher', repositoryId: 1, credentialConfigured: true, approvedWorkflow: null } },
      release: { id: 'composed-release', operatorId: 'composed-dispatcher', githubReleaseId: 1, sourceCommit: artifact.sourceCommit,
        manifestDigest: releaseBrief || intentVersion === '4' ? await hash(manifestJson) : 'b'.repeat(64), bundleDigest: digest, interfaceVersion: 1, approved: true,
        repositoryId: 1, sourceRevision: 1, coreVersion: '1', intentVersion, requestedCapabilities: ['fetch', 'inference'], assets: [],
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
  async sdkImportsWithheld(activityId: string, generation: number) {
    return generation === 1 && activityId === await this.ctx.storage.get('activityId')
      && await this.ctx.storage.get('withholdSdkImports') === true;
  }
  async nativeQualification() {
    if (!await this.ctx.storage.get('diagnosticCandidate')) return null;
    const scenario = await this.ctx.storage.get<RecoveryScenario>('scenario');
    if (scenario !== 'ordinary' && scenario !== 'precommit-reset') throw new Error('Native fault scenario denied');
    return { scenario, phases: await this.ctx.storage.get<RetainedObservation['phases']>('phases') ?? [],
      withholdSdkImports: await this.ctx.storage.get('withholdSdkImports') === true };
  }
  async holdNativeQualification(phase: DispatcherPhase) {
    const candidate = await this.nativeQualification();
    if (candidate?.scenario !== 'ordinary' || phase.kind !== 'discovery'
      || await this.ctx.storage.get('nativeBarrier')) return;
    await this.ctx.storage.put('nativeBarrier', true);
    await this.hold();
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
  async upsertOwnedActivity(owner: string, summary: OperatorBrowserSummary) {
    await this.ctx.storage.put(`fixture:owner:${summary.activityId}`, { owner, summary });
  }
  async getOwnedActivity(owner: string, activityId: string) {
    const row = await this.ctx.storage.get<{ owner: string; summary: OperatorBrowserSummary }>(`fixture:owner:${activityId}`);
    return row?.owner === owner ? row.summary : null;
  }
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
  async recordSourceDelivery(value: { operationId: string; url: string; method?: string }) {
    if (isIsolation(await this.ctx.storage.get('scenario'))) await this.append('sourceDeliveries', {
      operationId: value.operationId, url: value.url, method: value.method ?? 'GET',
    });
  }

  async budget(value: { operationCount: number; operationLimit: number }) { await this.ctx.storage.put('budget', value); }
  async recordTail(activityId: string, generation: number, firstAppend: CanonicalAppendObservation | null,
    sdkSubmissions: SdkObservation[], fiberEvents: FiberObservation[] | null) {
    if (generation !== 1 || activityId !== await this.ctx.storage.get('activityId')) return;
    if (firstAppend && !await this.ctx.storage.get('firstAppend')) await this.ctx.storage.put('firstAppend', firstAppend);
    for (const entry of sdkSubmissions) await this.append('sdkSubmissions', entry);
    if (fiberEvents && await this.ctx.storage.get('intentVersion') === '4') {
      await this.ctx.storage.transaction(async tx => {
        const retained = await tx.get<FiberObservation[] | null>('fiberEvents') ?? [];
        for (const entry of fiberEvents) {
          // Tail retries/reordering do not invent another run or replace its ID.
          if (retained.some(row => row.type === entry.type && row.fiberDigest === entry.fiberDigest)) continue;
          if (retained.length >= fiberEvidenceLimit) throw new Error('Fixture retained fiber evidence bound exceeded');
          retained.push(entry);
        }
        await tx.put('fiberEvents', retained);
      });
    }
  }
  async recordPhase(context: DispatcherPhaseContext) {
    await this.ctx.storage.transaction(async tx => {
      const phases = await tx.get<RetainedObservation['phases']>('phases') ?? [];
      // Record actual capability responses only. Exact repeated intake is not a
      // new phase; changed stamps remain visible and fail the lineage assertions.
      if (phases.some(row => JSON.stringify(row.context) === JSON.stringify(context))) return;
      await tx.put('phases', [...phases, { context, commentCount: (await tx.get<unknown[]>('comments') ?? []).length }]);
    });
  }
  async observe(): Promise<RetainedObservation> {
    return { phases: await this.ctx.storage.get<RetainedObservation['phases']>('phases') ?? [],
      inference: await this.ctx.storage.get<RetainedObservation['inference']>('inference') ?? [],
      comments: await this.ctx.storage.get<RetainedObservation['comments']>('comments') ?? [],
      sourceRequests: await this.ctx.storage.get<RetainedObservation['sourceRequests']>('sourceRequests') ?? [],
      sourceDeliveries: await this.ctx.storage.get<RetainedObservation['sourceDeliveries']>('sourceDeliveries') ?? [],
      isolationFaults: await this.ctx.storage.get<RetainedObservation['isolationFaults']>('isolationFaults') ?? [],
      held: await this.ctx.storage.get<boolean>('held') ?? false,
      duplicates: await this.ctx.storage.get<RetainedObservation['duplicates']>('duplicates') ?? [],
      budget: await this.ctx.storage.get<RetainedObservation['budget']>('budget'),
      evidence: await this.ctx.storage.get<RetainedObservation['evidence']>('evidence') ?? [],
      batches: await this.ctx.storage.get<RetainedObservation['batches']>('batches') ?? [],
      firstAppend: await this.ctx.storage.get<CanonicalAppendObservation | null>('firstAppend') ?? null,
      sdkSubmissions: await this.ctx.storage.get<SdkObservation[]>('sdkSubmissions') ?? [],
      fiberEvents: await this.ctx.storage.get<FiberObservation[] | null>('fiberEvents') ?? null };
  }
  async inference(request: Request): Promise<Response> {
    const body = await request.text();
    const input = JSON.parse(body) as { messages: Array<{ tool_calls?: Array<{ function?: { name?: string } }> }> };
    const scenario = await this.ctx.storage.get('scenario');
    if (await this.ctx.storage.get('releaseBrief')) {
      const names = input.messages.flatMap(message => message.tool_calls?.map(tool => tool.function?.name) ?? []);
      const turn = names.includes('read_release') ? 1 : 0;
      await this.append('inference', { inputDigest: await hash(body), turn });
      const name = turn ? 'finish_release' : 'read_release';
      const args = turn ? { summary: 'This release adds CSV export.', quote: 'Added CSV export' } : {};
      return wire([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `release-${turn}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]);
    }
    if (await this.ctx.storage.get('intentVersion') === '4') return this.phaseInference(input, body, scenario);
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
  private async phaseInference(input: { messages: unknown[] }, body: string, scenario: unknown): Promise<Response> {
    // Select work ONLY from the compiled journey's public active-phase signal in
    // the genuine SDK model context. Service-held phase stamps are observation,
    // never model policy, SDK settlement, or an alternative driving path.
    let phase: DispatcherPhase | undefined;
    let currentMessages: unknown[] = [];
    const phaseText = (value: unknown): DispatcherPhase | undefined => {
      if (typeof value === 'string') {
        const text = value.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
        let latest: DispatcherPhase | undefined;
        for (const signal of text.matchAll(/<signal type="dispatcher-active-phase"[^>]*>\n(.*?)\n<\/signal>/gs)) {
          const match = /^Current parent-admitted phase: (\{.*?\})\.(?: Immutable target coordinates:| Do only this phase\.)/.exec(signal[1]);
          if (match) latest = JSON.parse(match[1]) as DispatcherPhase;
        }
        return latest;
      }
      const fields = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
      return fields.map(phaseText).filter((item): item is DispatcherPhase => item !== undefined).at(-1);
    };
    for (const message of input.messages) {
      const latest = phaseText(message);
      if (latest) { phase = latest; currentMessages = []; }
      currentMessages.push(message);
    }
    if (!phase) return new Response(null, { status: 422 });
    const recovery = scenario === 'thirty-target-original-evidence-recovery';
    const large = scenario === 'large-evidence-comment-batch' || recovery;
    const isolation = isIsolation(scenario);
    const expectedTargets = isolation ? isolationTargets : large ? recovery ? thirtyTargets : largeEvidenceTargets : [target];
    const expectedEvidence = isolation ? isolationEvidence : large ? recovery ? thirtyEvidence : largeEvidence
      : [{ target, url: researchUrl, quote, body: quote, kind: 'upstream' as const }];
    const expectedComment = isolation ? isolationComment : large ? recovery ? thirtyComment : largeComment : () => comment;
    if (scenario === 'target-response-failed' && phase.kind === 'target' && phase.index === 0) {
      // A genuine nonrecoverable provider response, only after successful
      // discovery and before this PR's research/judgment. Parent preserves422;
      // the compiled provider and SDK, not this service, terminalize the response.
      await this.append('inference', { inputDigest: await hash(body), turn: 1, phase });
      await this.append('isolationFaults', { kind: 'model-rejected', pullRequest: phase.target.pullRequest, status: 422 });
      return Response.json({ error: { type: 'invalid_request_error', code: 'FIXTURE_TARGET_REJECTED',
        message: 'The fixture target assessment is rejected.' } }, { status: 422 });
    }
    const calls: Array<{ name: string; arguments: string }> = [];
    const artifacts = new Map<string, Record<string, unknown>>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
        try { visit(JSON.parse(value)); } catch { /* Plain source text is not wire data. */ }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        if (typeof item.name === 'string' && typeof item.arguments === 'string') calls.push(item as { name: string; arguments: string });
        if (typeof item.id === 'string' && typeof item.body === 'string' && typeof item.digest === 'string') artifacts.set(item.id, item);
        Object.values(item).forEach(visit);
      }
    };
    visit(currentMessages);
    const observed = new Map((await this.ctx.storage.get<RetainedObservation['evidence']>('evidence') ?? []).map(row => [row.index, row]));
    for (const [index, expected] of expectedEvidence.entries()) {
      const id = `artifact-${(await hash(JSON.stringify({ target: expected.target, url: expected.url, kind: expected.kind }))).slice(0, 24)}`;
      const actual = artifacts.get(id);
      if (!actual) continue;
      observed.set(index, { index, complete: actual.complete === true && actual.status === 200 && actual.body === expected.body
        && actual.digest === await hash(expected.body) && actual.bodyOffset === 0 && actual.bodyLength === expected.body.length
        && actual.bodyTruncated === false && JSON.stringify(actual.target) === JSON.stringify(expected.target)
        && actual.url === expected.url && expected.body.includes(expected.quote) });
    }
    // Retain proofs of complete immutable bytes actually seen in earlier PR
    // responses; do not demand their bodies be recopied into every model turn.
    await this.ctx.storage.put('evidence', [...observed.values()].sort((a, b) => a.index - b.index));
    let tool: string;
    let args: unknown = {};
    if (phase.kind === 'discovery') tool = 'discover_renovate';
    else if (phase.kind === 'final') tool = 'finish_dispatcher';
    else {
      const active = expectedTargets[phase.index];
      if (JSON.stringify(active) !== JSON.stringify(phase.target)) return new Response(null, { status: 422 });
      const evidence = expectedEvidence.map((item, index) => ({ item, index }))
        .filter(({ item }) => item.target.pullRequest === active.pullRequest && item.target.headSha === active.headSha);
      const researched = calls.filter(call => call.name === 'research_renovate').length;
      if (researched < evidence.length) {
        const { item } = evidence[researched];
        tool = 'research_renovate'; args = { target: active, url: item.url, kind: item.kind };
      } else if (!calls.some(call => call.name === 'decide_renovate')) {
        if (evidence.some(({ index }) => observed.get(index)?.complete !== true)) return new Response(null, { status: 422 });
        const cited = expectedEvidence[phase.index];
        tool = 'decide_renovate'; args = { target: active, decision: 'DO_NOT_MERGE', comment: expectedComment(phase.index),
          claims: [{ artifactId: [...artifacts.keys()].find(id => artifacts.get(id)?.url === cited.url), quote: cited.quote,
            relevance: 'target-specific migration uncertainty', authority: 'publisher guidance' }],
          analysis: { changedUsage: 'unverified', configuration: 'unverified', interoperability: 'unverified',
            migration: 'unverified', gaps: ['No verified compatibility declaration'] } };
      } else if (!calls.some(call => call.name === 'seal_dispatcher')) tool = 'seal_dispatcher';
      else {
        const commentCalls = calls.filter(call => call.name === 'comment_renovate').length;
        // After the original publisher502, the next genuine model call remains
        // on PR30. Hold it before its explicit comment recovery; no deferral or
        // advance, no phantom completed result, and no revisit of PR1..29.
        if (recovery && phase.index === 29 && commentCalls === 1 && !await this.ctx.storage.get('held')) await this.hold();
        if (commentCalls === 0 || recovery && phase.index === 29 && commentCalls === 1) {
          tool = 'comment_renovate'; args = { target: active };
        } else tool = 'defer_renovate'; // The real tool emits progress from its receipt-backed existing disposition.
      }
    }
    const turn = !large ? ['discover_renovate', 'research_renovate', 'decide_renovate', 'seal_dispatcher',
      'comment_renovate', 'defer_renovate', 'finish_dispatcher'].indexOf(tool) : calls.length;
    await this.append('inference', { inputDigest: await hash(body), turn, phase });
    await this.holdNativeQualification(phase);
    if (await this.claimFault('precommit-reset')) await this.hold();
    if (await this.claimFault('incomplete') || scenario === 'persistent') return wire([{ choices: [{ delta: {}, finish_reason: null }] }]);
    if (await this.claimFault('native-error')) return wire([{ error: { code: 'NATIVE_BEDROCK_STREAM_ERROR' } }]);
    await this.append('batches', [tool]);
    // One domain tool at a time: the package explicitly refuses concurrent
    // current-target calls, rather than silently serializing an all-PR batch.
    return wire([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `phase-${phase.kind}-${phase.kind === 'target' ? phase.index : 0}-${calls.length}`,
      type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
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
    if (await this.ctx.storage.get('releaseBrief')) return request.method === 'GET'
      && request.url === `https://api.github.com/repos/${repository}/releases/latest`
      ? Response.json({ tag_name: 'v2.4.0', body: 'Added CSV export', draft: false, prerelease: false })
      : new Response(null, { status: 403 });
    const bot = { id: 29139614, login: 'renovate[bot]', type: 'Bot' };
    const scenario = await this.ctx.storage.get('scenario');
    const recovery = scenario === 'thirty-target-original-evidence-recovery';
    const actor = recovery && await this.ctx.storage.get('held')
      ? { id: 43, login: 'replacement-publisher', type: 'User' } : { id: 42, login: 'fixture-publisher', type: 'User' };
    const base = `https://api.github.com/repos/${repository}`;
    const isolation = isIsolation(scenario);
    const large = scenario === 'large-evidence-comment-batch' || recovery || isolation;
    const targets = isolation ? isolationTargets : recovery ? thirtyTargets : largeEvidenceTargets;
    const selected = large ? targets.find(item => new URL(request.url).pathname.match(/\/(?:pulls|issues)\/(\d+)/)?.[1] === String(item.pullRequest)) ?? target : target;
    const pull = { number: selected.pullRequest, state: 'open', draft: false, created_at: new Date(Date.now() - 86400000).toISOString(),
      user: bot, head: { sha: selected.headSha }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 123, full_name: repository } } };
    const evidence = large && (isolation ? isolationEvidence : recovery ? thirtyEvidence : largeEvidence).find(item => item.url === request.url);
    if (evidence) return new Response(evidence.body, { headers: { 'content-type': 'text/plain' } });
    if (request.url === researchUrl) return new Response(quote, { headers: { 'content-type': 'text/plain' } });
    if (request.url === `${base}/issues/${selected.pullRequest}/comments` && request.method === 'POST') {
      const value = await request.json<{ body: string }>();
      const entry = { id: 91 + (await this.ctx.storage.get<unknown[]>('comments') ?? []).length, body: value.body, user: actor, issue_url: `${base}/issues/${selected.pullRequest}` };
      await this.append('comments', entry);
      if (scenario === 'target-comment-unknown' && selected.pullRequest === target.pullRequest
        && await this.claimFault('target-comment-unknown')) {
        // Persist the actual upstream effect before losing its acknowledgement.
        // No receipt/success/failure is supplied in place of the lost response.
        await this.append('isolationFaults', { kind: 'comment-response-lost', pullRequest: selected.pullRequest });
        throw new Error('Fixture comment acknowledgement lost');
      }
      return Response.json(entry, { status: 201 });
    }
    if (request.method !== 'GET') return new Response(null, { status: 403 });
    if (scenario === 'target-comment-unknown' && selected.pullRequest === target.pullRequest
      && request.url === `${base}/issues/${selected.pullRequest}/comments?per_page=100`
      && (await this.ctx.storage.get<Array<{ issue_url: string }>>('comments') ?? [])
        .some(row => row.issue_url === `${base}/issues/${selected.pullRequest}`)) {
      // Baseline reads were real and successful. The later original readback
      // is genuinely unavailable, so it cannot positively resolve the write.
      await this.append('isolationFaults', { kind: 'comment-readback-unavailable', pullRequest: selected.pullRequest, status: 502 });
      return Response.json({ error: 'Fixture comment readback unavailable' }, { status: 502 });
    }
    if (recovery && request.url === 'https://api.github.com/user'
      && (await this.ctx.storage.get('intentVersion') !== '4' || (await this.ctx.storage.get<unknown[]>('comments') ?? []).length === 29)
      && await this.claimFault('thirty-target-original-evidence-recovery')) {
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
  async startComposed(id: string, artifact: DispatcherBundle, digest: string, withholdSdkImports = false) {
    if (withholdSdkImports) this.#withholdNativeHeaders();
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
  #withholdNativeHeaders() {
    const context = this.ctx as unknown as { facets: object };
    const children = new WeakMap<object, object>();
    const facets = delegateNative(context.facets, (key, invoke) => key !== 'get' ? invoke : (...args) => {
      const child = invoke(...args);
      if (args[0] !== 'dispatcher') return child;
      if (!child || typeof child !== 'object') throw new Error('Native facet collaborator unavailable');
      let decorated = children.get(child);
      if (!decorated) {
        decorated = delegateNative(child, (method, call) => method !== 'fetch' ? call : async (...values) => {
          const response = await call(...values);
          if (!(response instanceof Response)) throw new Error('Native facet response unavailable');
          return withoutSdkHeader(response);
        });
        children.set(child, decorated);
      }
      return decorated;
    });
    try { Object.defineProperty(context, 'facets', { configurable: true, value: facets }); }
    catch { throw new Error('Native context facets cannot be safely decorated'); }
  }
  // Only an already-live execution facet may be used here. Agents0.20.1's
  // base sql(strings, ...values) executes in that facet's isolated SQLite scope.
  // A cache miss fails closed: this fixture never constructs a diagnostic child.
  #liveNativeSql(): FixtureSqlFacet {
    const context = this.ctx as unknown as { facets: { get(name: string, init: () => never): FixtureSqlFacet } };
    return context.facets.get('dispatcher', () => { throw new Error('Fixture live SDK storage unavailable'); });
  }
  #nativeQuery(child: FixtureSqlFacet, query: string, ...values: unknown[]) {
    return child.sql(query.split('?'), ...values);
  }
  async armNativeFaults() {
    const candidate = await services(this.fixtureEnv).nativeQualification();
    if (!candidate || candidate.phases.length !== 1 || candidate.phases[0].context.phase.kind !== 'discovery'
      || !await this.dispatcherGenerationCurrent(1) || await this.ctx.storage.get('fixture:native-fault')) {
      throw new Error('Native candidate fault arming denied');
    }
    const submissionId = candidate.phases[0].context.submissionId;
    if (!submissionId || submissionId.length > 512 || submissionId.includes('?')) throw new Error('Fixture submission unavailable');
    const child = this.#liveNativeSql();
    const query = (text: string, ...values: unknown[]) => this.#nativeQuery(child, text, ...values);
    const names = await query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 129");
    if (names.length > 128) throw new Error('Fixture SDK schema bound exceeded');
    const tables = ['flue_agent_submissions', 'flue_conversation_stream_batches',
      'codeflare_sdk_diagnostic_outbox', 'codeflare_sdk_diagnostic_index'] as const;
    // Normally these are logical unprefixed names (isolated facet storage).
    // If the runtime exposes physical names, accept only a single validated,
    // common prefix with ALL pinned tables and the actual selected submission.
    const prefixes: string[] = [];
    for (const row of names) {
      if (typeof row.name !== 'string' || !row.name.endsWith(tables[0])) continue;
      sqlIdentifier(row.name);
      const prefix = row.name.slice(0, -tables[0].length);
      if (prefix && !/^[A-Za-z_][A-Za-z0-9_]*_$/.test(prefix)) continue;
      if (!tables.every(table => names.some(item => item.name === prefix + table))) continue;
      const selected = await query(`SELECT attempt_id FROM ${sqlIdentifier(prefix + tables[0])}
        WHERE submission_id = ? AND status = 'running' AND attempt_id IS NOT NULL`, submissionId);
      if (selected.length === 1 && typeof selected[0].attempt_id === 'string') prefixes.push(prefix);
    }
    if (prefixes.length !== 1) throw new Error('Fixture shared SDK tables unavailable or ambiguous');
    const prefix = prefixes[0];
    const required = [['submission_id', 'attempt_id', 'status', 'settlement_record_id', 'settlement_record', 'settled_at'],
      ['path', 'seq', 'data', 'submission_id', 'attempt_id', 'producer_epoch', 'producer_sequence'],
      ['sequence', 'envelope', 'imported'], ['id', 'through_sequence']] as const;
    for (const [index, table] of tables.entries()) {
      const columns = await query(`PRAGMA table_info(${sqlIdentifier(prefix + table)})`);
      if (!required[index].every(column => columns.some(row => row.name === column))) {
        throw new Error('Fixture pinned SDK columns unavailable');
      }
    }
    const outbox = sqlIdentifier(prefix + tables[2]);
    const index = await query(`SELECT through_sequence FROM ${sqlIdentifier(prefix + tables[3])} WHERE id = 1`);
    const watermark = index[0]?.through_sequence;
    const actual = await query(`SELECT sequence FROM ${outbox} WHERE json_extract(envelope, '$.sdk.submissionId') = ?
      AND json_extract(envelope, '$.boundary') = 'submission' AND json_extract(envelope, '$.outcome') = 'started'`, submissionId);
    if (index.length !== 1 || !Number.isSafeInteger(watermark) || (watermark as number) < 1 || !actual.length) {
      throw new Error('Fixture actual source outbox unavailable');
    }
    const selected = sqlLiteral(submissionId);
    const captured = (boundary: string, code: string) => `EXISTS (SELECT 1 FROM ${outbox}
      WHERE sequence > ${watermark} AND json_extract(envelope, '$.sdk.submissionId') = ${selected}
      AND json_extract(envelope, '$.boundary') = '${boundary}' AND json_extract(envelope, '$.outcome') = 'failed'
      AND json_extract(envelope, '$.code') = '${code}')`;
    // RAISE(ABORT) rolls back the SDK transaction. There is deliberately no
    // failure counter in it: only genuine synchronous capture OUTSIDE that
    // failed transaction disarms each trigger, before the SDK's normal retry.
    if (candidate.scenario === 'ordinary') {
      await query(`CREATE TRIGGER codeflare_fixture_reject_append BEFORE INSERT ON ${sqlIdentifier(prefix + tables[1])}
        WHEN NEW.submission_id = ${selected} AND NOT ${captured('canonical-commit', 'canonical-append-failed')}
        BEGIN SELECT RAISE(ABORT, 'Fixture canonical SQLite rejection'); END`);
      if (!candidate.withholdSdkImports) {
        await query(`CREATE TRIGGER codeflare_fixture_reject_finalization BEFORE UPDATE OF status ON ${sqlIdentifier(prefix + tables[0])}
          WHEN OLD.submission_id = ${selected} AND OLD.status = 'terminalizing' AND NEW.status = 'settled'
          AND NOT ${captured('submission', 'submission-failed')}
          BEGIN SELECT RAISE(ABORT, 'Fixture operational finalization rejection'); END`);
        // Observe the selected source captures AT INSERT, while this child is
        // live. The acknowledged 64-row outbox may legitimately evict them
        // before the next external observe RPC. One fixed row retains ONLY
        // source sequences and committed coordinates, never envelopes/raw IDs
        // or an import acknowledgement. This uses the same armed SQL machinery
        // as the faults; no SDK callback, flush or execution barrier is added.
        const witness = sqlIdentifier(prefix + 'codeflare_fixture_settlement_witness');
        const submissions = sqlIdentifier(prefix + tables[0]);
        await query(`CREATE TABLE ${witness} (id INTEGER PRIMARY KEY CHECK (id = 1),
          canonical_sequence INTEGER, failure_sequence INTEGER, finalized_sequence INTEGER,
          batch_sequence INTEGER, record_index INTEGER, producer_epoch INTEGER, producer_sequence INTEGER)`);
        await query(`INSERT INTO ${witness} (id) VALUES (1)`);
        await query(`CREATE TRIGGER codeflare_fixture_observe_settlement AFTER INSERT ON ${outbox}
          WHEN NEW.sequence > ${watermark} AND json_extract(NEW.envelope, '$.sdk.submissionId') = ${selected}
          AND EXISTS (SELECT 1 FROM ${submissions} WHERE submission_id = ${selected}
            AND attempt_id = json_extract(NEW.envelope, '$.sdk.attemptId'))
          BEGIN
            UPDATE ${witness} SET canonical_sequence = NEW.sequence,
              batch_sequence = json_extract(NEW.envelope, '$.sdk.batchSequence'),
              record_index = json_extract(NEW.envelope, '$.sdk.recordIndex'),
              producer_epoch = json_extract(NEW.envelope, '$.sdk.producerEpoch'),
              producer_sequence = json_extract(NEW.envelope, '$.sdk.producerSequence')
              WHERE id = 1 AND canonical_sequence IS NULL
              AND json_extract(NEW.envelope, '$.boundary') = 'canonical-commit'
              AND json_extract(NEW.envelope, '$.outcome') = 'committed'
              AND json_extract(NEW.envelope, '$.sdk.recordType') = 'submission_settled';
            UPDATE ${witness} SET failure_sequence = NEW.sequence
              WHERE id = 1 AND failure_sequence IS NULL
              AND json_extract(NEW.envelope, '$.boundary') = 'submission'
              AND json_extract(NEW.envelope, '$.outcome') = 'failed'
              AND json_extract(NEW.envelope, '$.code') = 'submission-failed';
            UPDATE ${witness} SET finalized_sequence = NEW.sequence
              WHERE id = 1 AND finalized_sequence IS NULL
              AND json_extract(NEW.envelope, '$.boundary') = 'settlement'
              AND json_extract(NEW.envelope, '$.outcome') = 'completed';
          END`);
        await this.ctx.storage.put('fixture:native-cleanup-armed', true);
      } else {
        // Both import channels are withheld, so unacknowledged rows can leave
        // the 64-row source ring before the external observer runs. Freeze ONE
        // actual failure/commit/recovery window, not another ring or an ack.
        // These <=4096-byte source envelopes stay child-private; only their
        // validated hashes/coordinates may later enter parent storage.
        const witness = sqlIdentifier(prefix + 'codeflare_fixture_omission_witness');
        await query(`CREATE TABLE ${witness} (id INTEGER PRIMARY KEY CHECK (id = 1),
          failure_sequence INTEGER NOT NULL, canonical_sequence INTEGER NOT NULL, recovered_sequence INTEGER NOT NULL,
          failure_envelope TEXT NOT NULL CHECK (length(CAST(failure_envelope AS BLOB)) <= 4096),
          canonical_envelope TEXT NOT NULL CHECK (length(CAST(canonical_envelope AS BLOB)) <= 4096),
          recovered_envelope TEXT NOT NULL CHECK (length(CAST(recovered_envelope AS BLOB)) <= 4096),
          failure_imported INTEGER NOT NULL CHECK (failure_imported = 0),
          canonical_imported INTEGER NOT NULL CHECK (canonical_imported = 0),
          recovered_imported INTEGER NOT NULL CHECK (recovered_imported = 0),
          through_sequence INTEGER NOT NULL, dropped INTEGER NOT NULL)`);
        // Outbox.capture updates this index AFTER insertion in the SAME source
        // transaction. NEW therefore includes the recovery capture, unlike an
        // index read from an outbox AFTER INSERT trigger. Observe all three
        // real rows and their current import flags together before eviction.
        await query(`CREATE TRIGGER codeflare_fixture_observe_omission AFTER UPDATE OF through_sequence
          ON ${sqlIdentifier(prefix + tables[3])}
          WHEN NEW.through_sequence > ${watermark} AND NOT EXISTS (SELECT 1 FROM ${witness})
          BEGIN
            INSERT INTO ${witness} SELECT 1, f.sequence, c.sequence, r.sequence,
              f.envelope, c.envelope, r.envelope, f.imported, c.imported, r.imported,
              NEW.through_sequence, NEW.dropped
              FROM ${outbox} f JOIN ${outbox} c ON c.sequence > f.sequence
              JOIN ${outbox} r ON r.sequence > c.sequence
              WHERE f.sequence > ${watermark} AND r.sequence = NEW.through_sequence
              AND f.imported = 0 AND c.imported = 0 AND r.imported = 0
              AND json_extract(f.envelope, '$.sdk.submissionId') = ${selected}
              AND json_extract(c.envelope, '$.sdk.submissionId') = ${selected}
              AND json_extract(r.envelope, '$.sdk.submissionId') = ${selected}
              AND json_extract(c.envelope, '$.sdk.attemptId') = json_extract(f.envelope, '$.sdk.attemptId')
              AND json_extract(r.envelope, '$.sdk.attemptId') = json_extract(f.envelope, '$.sdk.attemptId')
              AND json_extract(f.envelope, '$.boundary') = 'canonical-commit'
              AND json_extract(f.envelope, '$.outcome') = 'failed'
              AND json_extract(f.envelope, '$.code') = 'canonical-append-failed'
              AND json_extract(c.envelope, '$.boundary') = 'canonical-commit'
              AND json_extract(c.envelope, '$.outcome') = 'committed'
              AND json_extract(r.envelope, '$.boundary') = 'canonical-commit'
              AND json_extract(r.envelope, '$.outcome') = 'recovered'
              AND json_extract(r.envelope, '$.code') = 'canonical-append-failed'
              AND (SELECT COUNT(*) FROM ${outbox} e WHERE e.sequence > ${watermark}
                AND json_extract(e.envelope, '$.sdk.submissionId') = ${selected}
                AND json_extract(e.envelope, '$.boundary') = 'canonical-commit'
                AND json_extract(e.envelope, '$.outcome') = 'failed'
                AND json_extract(e.envelope, '$.code') = 'canonical-append-failed') = 1
              ORDER BY f.sequence, c.sequence, r.sequence LIMIT 1;
          END`);
      }
    } else {
      await query(`CREATE TRIGGER codeflare_fixture_reject_replacement BEFORE UPDATE OF attempt_id ON ${sqlIdentifier(prefix + tables[0])}
        WHEN OLD.submission_id = ${selected} AND OLD.status = 'running' AND NEW.status = 'running'
        AND OLD.attempt_id IS NOT NULL AND NEW.attempt_id != OLD.attempt_id
        AND NOT ${captured('recovery', 'submission-failed')}
        BEGIN SELECT RAISE(ABORT, 'Fixture interrupted replacement rejection'); END`);
    }
    await this.ctx.storage.put<NativeFaultArm>('fixture:native-fault', {
      scenario: candidate.scenario, submissionId, prefix, watermark: watermark as number,
      withholdSdkImports: candidate.withholdSdkImports,
    });
    return { armed: true };
  }
  async #nativeImportObservation(): Promise<NativeFaultImport | null> {
    // Root ledger metadata only, including AFTER retirement. This is an
    // observation of the known imported window, never a child scrape, flush,
    // fabricated acknowledgement or witness for an unobserved retirement tail.
    return this.ctx.storage.transaction(async tx => {
      const arm = await tx.get<NativeFaultArm>('fixture:native-fault');
      // With both channels withheld, initial parent counters do not witness
      // source through/drop counts. Keep that unavailable, not guessed zero.
      if (!arm || arm.withholdSdkImports) return null;
      const index = await tx.get<{ generation: number; nextSequence: number; sdkImport: string }>('dispatcher:diagnostics:index');
      const health = await tx.get<{ sdkThrough: number; sdkLocalThrough: number; sdkDropped: number;
        pendingSequences?: number[]; gaps: string[] }>('dispatcher:diagnostics:health');
      if (!index || !health) return null;
      return { generation: index.generation, events: index.nextSequence - 1, indexSdkImport: index.sdkImport, through: health.sdkThrough,
        localThrough: health.sdkLocalThrough, dropped: health.sdkDropped, pendingSequences: health.pendingSequences ?? null,
        gaps: health.gaps, armedThrough: arm.watermark };
    });
  }
  async captureNativeSettlement() {
    const arm = await this.ctx.storage.get<NativeFaultArm>('fixture:native-fault');
    if (!arm || arm.scenario !== 'ordinary') return;
    if (arm.withholdSdkImports) { await this.#captureNativeOmission(arm); return; }
    if (await this.ctx.storage.get('fixture:native-settlement')) return;
    const candidate = await services(this.fixtureEnv).nativeQualification();
    // This gates only the later settled-obligation read, not source capture:
    // the armed trigger already observes each source INSERT during discovery.
    if (!candidate || candidate.phases.length < 2) return;
    if (!await this.dispatcherGenerationCurrent(1)) throw new Error('Native settlement observation denied');
    const child = this.#liveNativeSql();
    const query = (text: string, ...values: unknown[]) => this.#nativeQuery(child, text, ...values);
    // Read only real canonical metadata for the retained settlement obligation.
    // The small discovery batch is not spilled; absent JSON fails qualification.
    const rows = await query(`SELECT s.attempt_id, s.settlement_record_id, b.seq, b.producer_epoch, b.producer_sequence,
      r.key AS record_index FROM ${sqlIdentifier(arm.prefix + 'flue_agent_submissions')} s
      JOIN ${sqlIdentifier(arm.prefix + 'flue_conversation_stream_batches')} b ON b.submission_id = s.submission_id AND b.attempt_id = s.attempt_id
      JOIN json_each(b.data) r ON json_extract(r.value, '$.id') = s.settlement_record_id
      WHERE s.submission_id = ? AND s.status = 'settled' AND s.settled_at IS NOT NULL
      AND json_extract(r.value, '$.type') = 'submission_settled' AND json_extract(r.value, '$.outcome') = 'completed'`, arm.submissionId);
    if (rows.length !== 1) throw new Error('Actual canonical/finalized discovery obligation unavailable');
    const row = rows[0];
    // The one-row witness was captured before ring eviction, not reconstructed
    // from a later phase or a host event ordinal. Independently match ALL actual
    // canonical coordinates to the SQL-settled discovery obligation above.
    const witnessed = await query(`SELECT canonical_sequence, failure_sequence, finalized_sequence,
      batch_sequence, record_index, producer_epoch, producer_sequence
      FROM ${sqlIdentifier(arm.prefix + 'codeflare_fixture_settlement_witness')} WHERE id = 1`);
    const source = witnessed[0];
    const canonicalSequence = source?.canonical_sequence;
    const failureSequence = source?.failure_sequence;
    const finalizedSequence = source?.finalized_sequence;
    if (witnessed.length !== 1 || ![canonicalSequence, failureSequence, finalizedSequence,
      source?.batch_sequence, source?.record_index, source?.producer_epoch, source?.producer_sequence]
      .every(value => Number.isSafeInteger(value) && Number(value) >= 0)
      || Number(canonicalSequence) <= arm.watermark
      || source.batch_sequence !== row.seq || source.record_index !== Number(row.record_index)
      || source.producer_epoch !== row.producer_epoch || source.producer_sequence !== row.producer_sequence
      || !(Number(canonicalSequence) < Number(failureSequence) && Number(failureSequence) < Number(finalizedSequence))) {
      // The 64-row source outbox is not historical retention. Preserve only
      // closed presence/count/coordinate evidence at this failing observation;
      // never guess which capture is missing, waive ordering, or flush the SDK.
      try {
        const local = await query(`SELECT through_sequence, dropped,
          (SELECT MIN(sequence) FROM ${sqlIdentifier(arm.prefix + 'codeflare_sdk_diagnostic_outbox')}) AS retained_from
          FROM ${sqlIdentifier(arm.prefix + 'codeflare_sdk_diagnostic_index')} WHERE id = 1`);
        console.error('[native-flue] native-settlement-source', {
          armedThrough: arm.watermark, witnessed: witnessed.length,
          retainedFrom: local[0]?.retained_from ?? null, localThrough: local[0]?.through_sequence ?? null,
          localDropped: local[0]?.dropped ?? null,
          batchSequence: row.seq, recordIndex: Number(row.record_index),
          canonicalSequence: canonicalSequence ?? null, failureSequence: failureSequence ?? null,
          finalizedSequence: finalizedSequence ?? null,
        });
      } catch { /* Optional failure evidence cannot replace the original qualification error. */ }
      throw new Error('Actual canonical/failure/finalization source ordering unavailable');
    }
    const evidence: NativeFaultSettlement = { submissionDigest: await hash(arm.submissionId),
      attemptDigest: await hash(String(row.attempt_id)), obligationDigest: await hash(String(row.settlement_record_id)),
      batchSequence: Number(row.seq), recordIndex: Number(row.record_index), producerEpoch: Number(row.producer_epoch),
      producerSequence: Number(row.producer_sequence), canonicalSequence: Number(canonicalSequence),
      failureSequence: Number(failureSequence), finalizedSequence: Number(finalizedSequence) };
    await this.ctx.storage.put('fixture:native-settlement', evidence);
  }
  async #captureNativeOmission(arm: NativeFaultArm) {
    if (await this.ctx.storage.get('fixture:native-omission')) return;
    const candidate = await services(this.fixtureEnv).nativeQualification();
    if (!candidate || candidate.phases.length < 2) return;
    if (!await this.dispatcherGenerationCurrent(1)) throw new Error('Native omission live observation missed');
    const child = this.#liveNativeSql();
    const query = (text: string, ...values: unknown[]) => this.#nativeQuery(child, text, ...values);
    // Read the bounded source window frozen while all three actual records
    // were still unimported in the original ring, not a late scan of that ring.
    // No raw envelope/SDK identity is persisted in parent storage or returned.
    const rows = await query(`SELECT * FROM ${sqlIdentifier(arm.prefix + 'codeflare_fixture_omission_witness')} WHERE id = 1`);
    if (rows.length !== 1) throw new Error('Native selected source window unavailable');
    const snapshot = rows[0];
    const captured = (['failure', 'canonical', 'recovered'] as const).map(slot => {
      const envelope = snapshot[`${slot}_envelope`];
      if (typeof envelope !== 'string' || new TextEncoder().encode(envelope).byteLength > 4096
        || snapshot[`${slot}_imported`] !== 0) throw new Error('Native unimported source capture unavailable');
      const value = runtimeSchema.parse(JSON.parse(envelope));
      if (value.sequence !== snapshot[`${slot}_sequence`] || value.sdk?.submissionId !== arm.submissionId) {
        throw new Error('Native selected source identity unavailable');
      }
      return value;
    });
    const failures = captured.filter(row => row.boundary === 'canonical-commit' && row.outcome === 'failed'
      && row.code === 'canonical-append-failed');
    if (failures.length !== 1) throw new Error('Native selected append failure capture unavailable');
    const failure = failures[0];
    const recovered = captured.find(row => row.boundary === 'canonical-commit' && row.outcome === 'recovered'
      && row.code === failure.code && row.sdk?.attemptId === failure.sdk?.attemptId && row.sequence > failure.sequence);
    const canonical = captured.find(row => row.boundary === 'canonical-commit' && row.outcome === 'committed'
      && row.sdk?.attemptId === failure.sdk?.attemptId && row.sequence > failure.sequence
      && recovered && row.sequence < recovered.sequence);
    if (!failure.error || failure.origin !== 'catching' || !failure.sdk?.attemptId || !failure.sdk.rootUid
      || !recovered || !canonical) throw new Error('Native real failure/recovery coordinates unavailable');
    const sdk = canonical.sdk!;
    const coordinates = [sdk.batchSequence, sdk.recordIndex, sdk.producerEpoch, sdk.producerSequence];
    if (!coordinates.every(value => Number.isSafeInteger(value) && value! >= 0)) throw new Error('Native committed coordinates unavailable');
    if (captured.some(row => row.sdk?.rootUid && row.sdk.rootUid !== failure.sdk!.rootUid)) {
      throw new Error('Native selected source root changed');
    }
    // Frozen AFTER the recovery's actual source-index update, never replaced
    // by a newer tail count or inferred from the three selected coordinates.
    if (![snapshot.through_sequence, snapshot.dropped].every(value => Number.isSafeInteger(value) && Number(value) >= 0)
      || snapshot.through_sequence !== recovered.local.through || snapshot.dropped !== recovered.local.dropped
      || Number(snapshot.through_sequence) < recovered.sequence
      || Number(snapshot.through_sequence) - failure.sequence >= 64) throw new Error('Native local outbox watermark unavailable');
    const witness: NativeImportOmission = { captureDigest: await hash(failure.captureId), patchSetDigest: failure.source.patchSetDigest!,
      submissionDigest: await hash(arm.submissionId), attemptDigest: await hash(failure.sdk.attemptId), rootDigest: await hash(failure.sdk.rootUid),
      failureSequence: failure.sequence, canonicalSequence: canonical.sequence, recoveredSequence: recovered.sequence,
      batchSequence: sdk.batchSequence!, recordIndex: sdk.recordIndex!, producerEpoch: sdk.producerEpoch!, producerSequence: sdk.producerSequence!,
      localThrough: Number(snapshot.through_sequence), localDropped: Number(snapshot.dropped), imported: false };
    await this.ctx.storage.put('fixture:native-omission', witness);
  }
  override async dispatcherBridge(generation: number, method: Parameters<ProductionActivity['dispatcherBridge']>[1], args: unknown[]): Promise<unknown> {
    const result = await super.dispatcherBridge(generation, method, args);
    const reject = method === '_cf_releaseFacetKeepAlive' && await this.ctx.storage.transaction(async tx => {
      if (!await tx.get('fixture:native-cleanup-armed')) return false;
      await tx.delete('fixture:native-cleanup-armed');
      return true;
    });
    if (reject) {
      // Bookkeeping already succeeded. The actual Agents disposer catches this
      // one fixed Error, captures cleanup-error, and preserves the fiber result.
      throw new Error('Fixture swallowed facet cleanup rejection');
    }
    return result;
  }
  async observeComposed(observationId?: string) {
    // Native-only evidence observation is driven by the existing external test
    // observer, never an awaited child/capability -> parent callback. It does
    // not hold execution or retirement open; a missed live window fails closed.
    await this.captureNativeSettlement();
    // Match production status reads; drive/alarm paths own reconciliation.
    const detail = await this.getBrowserDetail();
    observeBoundary(observationId, 'detail-completed');
    const { fiberEvents, ...external } = await services(this.fixtureEnv).observe();
    observeBoundary(observationId, 'external-completed');
    const original = external.sourceDeliveries.find(row => row.method === 'POST'
      && row.url === `https://api.github.com/repos/${repository}/issues/${target.pullRequest}/comments`);
    const journal = original ? await this.ctx.storage.transaction(async tx => {
      const summary = await tx.get<{ generation: number; unresolved: number }>('dispatcher:journal');
      if (!summary) return null;
      const receipt = await tx.get<{ generation: number; phase: string; requestDigest: string; responseDigest?: string;
        resolution?: unknown; request?: { method: string; url: string };
        phaseBinding?: { submissionId: string; deliveryToken: string; phase: DispatcherPhase } }>(
        `dispatcher:operation:${summary.generation}:${original.operationId}`);
      // Existing owner ledger only: retain missing evidence as missing. This
      // fixture observation creates neither a receipt nor a second journal.
      return receipt ? { generation: summary.generation, unresolved: summary.unresolved,
        operationId: original.operationId, receipt } : null;
    }) : undefined;
    const retained = [...diagnostics];
    observeBoundary(observationId, 'activity-return-ready');
    return { instance: this.instance, detail, external, fiberEvents, diagnostics: retained,
      nativeSettlement: await this.ctx.storage.get<NativeFaultSettlement>('fixture:native-settlement') ?? null,
      nativeOmission: await this.ctx.storage.get<NativeImportOmission>('fixture:native-omission') ?? null,
      nativeImport: await this.#nativeImportObservation(), ...(original ? { journal } : {}) };
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
      sdkSubmissions: external.sdkSubmissions, fiberEvents: external.fiberEvents,
      sdkErrorTypes: [...new Set(diagnostics.flatMap(entry => typeof entry.sdkErrorType === 'string' ? [entry.sdkErrorType] : []))],
      inferenceCount: external.inference.length, commentCount: external.comments.length, settlementBoundaries };
  }
  evictComposed(): void { this.ctx.abort('CI composed Activity reset'); }
  evictChildComposed(): void {
    // Supported runtime facet abort: retain the root and all original durable storage.
    this.abortDispatcherFacet('CI composed child-only reset');
  }
}

/** Production capability plus transparent fault delivery, never a substitute journal or SDK settlement. */
export class OperatorDispatcherCapability extends ProductionCapability {
  override async fetch(request: Request): Promise<Response> {
    const control = services(this.env as unknown as FixtureEnv);
    const path = new URL(request.url).pathname;
    const props = this.ctx.props as { activityId?: unknown; generation?: unknown } | undefined;
    if (request.method === 'POST' && request.url === 'https://operator.internal/v1/dispatcher/diagnostic/runtime'
      && typeof props?.activityId === 'string' && typeof props.generation === 'number'
      && await control.sdkImportsWithheld(props.activityId, props.generation)) {
      // Stall only diagnostic delivery before the parent transaction. Never
      // acknowledge it or release it as an execution/retirement barrier: the
      // actual SDK must finish while its bounded deliveries remain pending.
      return new Promise<Response>(() => {});
    }
    if (path === '/v1/dispatcher/source') {
      const value = await request.clone().json<{ operationId: string; url: string; method?: string }>();
      await control.rememberSource(value.operationId);
      await control.recordSourceDelivery(value);
    }
    if (path === '/v1/dispatcher/phase-context') {
      const upstream = await super.fetch(request);
      // Transparent receipt observation, not a fabricated context response.
      const response = new Response(await upstream.arrayBuffer(), {
        status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
      });
      if (response.ok) await control.recordPhase(await response.clone().json<DispatcherPhaseContext>());
      return response;
    }
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
        headers: { 'content-type': 'application/json',
          ...(request.headers.has('x-codeflare-dispatcher-delivery')
            ? { 'x-codeflare-dispatcher-delivery': request.headers.get('x-codeflare-dispatcher-delivery')! } : {}) },
        body: JSON.stringify({ operationId }) }));
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
  const id = new URL(request.url).searchParams.get('activity')!;
  if (request.method === 'GET' && new URL(request.url).searchParams.has('diagnostics')) {
    return fixtureOwnerDiagnostics(request, { ...env, ...encryption, ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => services(env) },
      CONTAINER: { idFromName: (name: string) => name, get: () => ({ claimBucketOwner: async () => 'owned' }) },
    } as unknown as Env, id);
  }
  observeBoundary(observationId, 'request-body-started');
  const command = await request.json<{ action: string; artifact?: DispatcherBundle; digest?: string; scenario?: RecoveryScenario; attemptLimit?: number; submissionAttemptLimit?: number; qualificationManifest?: string; diagnosticCandidate?: boolean; withholdSdkImports?: boolean }>();
  observeBoundary(observationId, 'request-body-completed');
  observeBoundary(observationId, 'agent-lookup-started');
  const activity = await getAgentByName(env.OPERATOR_ACTIVITY, id);
  observeBoundary(observationId, 'agent-lookup-completed');
  if (command.action === 'start') {
    await services(env).configure(command.artifact!, command.digest!, command.scenario ?? 'ordinary', command.attemptLimit ?? 4, command.submissionAttemptLimit, id, command.qualificationManifest, command.diagnosticCandidate, command.withholdSdkImports);
    return Response.json(await activity.startComposed(id, command.artifact!, command.digest!, command.withholdSdkImports));
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
  if (command.action === 'arm-native-faults') return Response.json(await activity.armNativeFaults());
  if (command.action === 'collect') return Response.json(await activity.collectBrowserResult());
  if (command.action === 'evict') { await activity.evictComposed().catch(() => {}); return Response.json({ evicted: true }); }
  if (command.action === 'evict-child') { await activity.evictChildComposed(); return Response.json({ evicted: true }); }
  if (command.action === 'release') { await services(env).release(); return Response.json({ released: true }); }
  if (command.action === 'revoke') { await services(env).revoke(); return Response.json({ revoked: true }); }
  if (command.action === 'cancel') return Response.json(await activity.cancelDrive());
  return new Response(null, { status: 400 });
}
