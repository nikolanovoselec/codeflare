/// <reference types="@cloudflare/vitest-plugin/types" />
import { expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import * as access from '../../../lib/access';
import activityRoutes from '../../../routes/operator-activities';
import { AppError } from '../../../lib/error-types';
import { OperatorActivity, OperatorDispatcherCapability, OperatorInstalledDispatcherCapability, createOperatorIntentDigest } from '../../../operators/activity';
import { driveDispatcherRuntime } from '../../../operators/runtime';
import { createOperatorExecutionContext } from '../../../operators/execution-context';
import { parseDispatcherOperation } from '../../../operators/operator-runtime-capability';
import type { DispatcherCapacityPolicy } from '../../../operators/dispatcher-capacity-limits';
import type { DispatcherBundle } from '../../../operators/distribution';
import type { Env } from '../../../types';
import { operatorOwnerKey } from '../../../operators/browser-activity';
import type { ProspectiveAdmission, CurrentProspectiveRegistration } from '../../../operators/registry';
import { LlmInterceptor } from '../../../llm-interceptor';
import { EgressController } from '../../../egress-controller';
import { getBuiltInProfileRef } from '../../../lib/reasoning-profiles';
import { verifiedRoutingConfiguration } from '../../helpers/verified-routing';
import { sealOperatorSecret } from '../../../operators/protected-secrets';
import { connectionSecret, createNormalDispatcherTransport, normalDeployment, normalDispatcherBundle } from './normal-dispatcher';

// Controlled sink comparison: retain every console argument, then assert the
// complete raw operation alongside the unchanged production-path outcomes.
export async function withCollectedLargeLogs<T>(collect: boolean, run: (output: unknown[][]) => Promise<T>): Promise<T> {
  const output: unknown[][] = [];
  if (!collect) return run(output);
  const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
    .mockImplementation((...args: unknown[]) => { output.push(args); }));
  try { return await run(output); }
  finally { spies.forEach(spy => spy.mockRestore()); }
}
export function collectedRawValues(output: unknown[][], stage: string): unknown[] {
  return output.flatMap(args => args.flatMap(arg => {
    if (typeof arg !== 'string') return [];
    try {
      const record = JSON.parse(arg);
      return record.module === 'operator-execution' && record.message === stage ? [record.data.value] : [];
    } catch { return []; }
  }));
}

let callerSessionCurrent = true;
let callerRoute = 'approved';
export let nativeProfileFiles = new Map<string, unknown>();
vi.mock('../../../lib/access', async original => ({ ...await original<typeof import('../../../lib/access')>(),
  resolveOperatorGroupIdentity: async (human: unknown) => human,
  resolveBucketName: async () => 'owner-bucket',
  resolveSessionAccessGroup: async () => [],
  operatorAccessSessionCurrent: async () => callerSessionCurrent,
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: [callerRoute], defaultRoute: callerRoute, defaultReasoning: 'off',
    ...(nativeProfileFiles.size ? { piDefaultSource: 'pi-native', allowPersonalPiProviders: true } : {}) }),
}));
vi.mock('../../../lib/aig-config', () => ({ getAigConfig: async () => ({ gatewayUrl: 'https://gateway.example.test', token: 'parent-only' }) }));
vi.mock('../../../lib/r2-client', async original => {
  const actual = await original<typeof import('../../../lib/r2-client')>();
  return { ...actual, createR2Client: (...args: Parameters<typeof actual.createR2Client>) => nativeProfileFiles.size
    ? { fetch: async (request: Request) => {
      const value = nativeProfileFiles.get(new URL(request.url).pathname);
      return value === undefined ? new Response(null, { status: 404 }) : Response.json(value);
    } } : actual.createR2Client(...args) };
});
vi.mock('../../../lib/r2-regime-state', async original => {
  const actual = await original<typeof import('../../../lib/r2-regime-state')>();
  return { ...actual,
    isBucketMigrating: (...args: Parameters<typeof actual.isBucketMigrating>) => nativeProfileFiles.size ? false : actual.isBucketMigrating(...args),
    isR2SseDisabledForBucket: (...args: Parameters<typeof actual.isR2SseDisabledForBucket>) => nativeProfileFiles.size ? true : actual.isR2SseDisabledForBucket(...args),
  };
});
/** Verified host routing data; the real interceptor owns routing and cancellation. */
function composedLlm(props: Record<string, unknown>, environment: Env) {
  const gatewayUrl = 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gw';
  const configuration = verifiedRoutingConfiguration({ schemaVersion: 1, customProfileRevisions: [],
    routeAssignments: { approved: { activeProfile: getBuiltInProfileRef('openai-gpt-chat-tools-off') } },
    fallbackRouting: { enabled: true, routes: ['approved'], defaultRoute: 'approved', reasoning: 'off' },
  }, { gatewayUrl, token: 'parent-only' });
  const kv: Record<string, string> = { 'setup:reasoning_configuration': JSON.stringify(configuration),
    'setup:dynamic_routes': '["approved"]', 'setup:default_route': '{"route":"approved","reasoning":"off"}' };
  return new LlmInterceptor({ props: { ...props, gatewayUrl } } as unknown as ExecutionContext,
    { ...environment, KV: { get: async (key: string, type?: string) => type === 'json' && kv[key]
      ? JSON.parse(kv[key]) : kv[key] ?? null } } as unknown as Env);
}

export const bundle: DispatcherBundle = { schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' }, className: 'FlueDispatcherAgent',
  compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
  modules: { 'index.js': { js: 'export class FlueDispatcherAgent {}' } } };
export const bytes = new TextEncoder().encode(JSON.stringify(bundle));
export const invocation = { repository: 'owner/repo', pullRequest: 17 };
export const genericWire = (path: string, body: unknown) => new Request(`https://operator.internal/v1/dispatcher/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
export const guideExcerpt = 'To create a Dozzle agent, you need to run Dozzle with the `agent` subcommand.\n      - DOZZLE_REMOTE_AGENT=agent:7007';
export const guideBlobSha = '9fd821c091950776b4aef53bdc5f55fc72df25af';
export async function digest(value: string | Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string'
    ? new TextEncoder().encode(value) : value)), b => b.toString(16).padStart(2, '0')).join('');
}

// Synthetic capability metadata exercises channel/selection/bounds only, not SDK-origin capture.
export const syntheticFramePaths = Array.from({ length: 4 }, (_, index) => {
  const prefix = 'src/__tests__/operators/fixtures/'; const suffix = `-${index}.ts`;
  return prefix + 's'.repeat(512 - prefix.length - suffix.length) + suffix;
});
const syntheticBudgetPaths = () => ((maximalDiagnosticEvent(2000, false).source as { frames: Array<{ path: string }> })
  .frames.map(frame => frame.path));
const syntheticFrameText = (index: number) => `// Synthetic source-map fixture ${index}; not an SDK-origin claim`;
const canonicalDiagnosticJson = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
async function syntheticSdkProvenance() {
  const integrity = async (value: string) => `sha512-${btoa(Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-512', new TextEncoder().encode(value))), byte => String.fromCharCode(byte)).join(''))}`;
  const original = 'synthetic SDK fixture before instrumentation';
  const transformed = 'synthetic SDK fixture after instrumentation';
  const metadata = { schemaVersion: 1, kind: 'codeflare-sdk-diagnostics',
    capabilities: ['origin-error-v1', 'strict-sse-v1', 'sdk-attempt-v1', 'canonical-commit-v1',
      'settlement-finalization-v1', 'cleanup-error-v1', 'local-outbox-v1'],
    basePackages: [
      { name: '@flue/runtime', version: '2.2.2', integrity: await integrity(original),
        tarballSha256: await digest(original) },
      { name: 'agents', version: '0.20.1', integrity: await integrity(transformed),
        tarballSha256: await digest(transformed) },
    ],
    targets: [{ package: '@flue/runtime', version: '2.2.2', path: 'dist/synthetic-fixture.mjs',
      originalSha256: await digest(original), transformedSha256: await digest(transformed) }],
    sources: [{ repository: 'nikolanovoselec/codeflare', commit: bundle.sourceCommit,
      path: 'src/__tests__/operators/fixtures/synthetic-sdk.ts', sha256: await digest(original) },
      ...await Promise.all([...syntheticFramePaths, ...syntheticBudgetPaths()].map(async (path, index) => ({ repository: 'nikolanovoselec/codeflare',
        commit: bundle.sourceCommit, path, sha256: await digest(syntheticFrameText(index)) })))],
    patches: [{ path: 'test/synthetic-sdk.patch', sha256: await digest(transformed) }],
    applicatorSha256: await digest('synthetic fixture applicator'),
  };
  return { ...metadata, patchSetDigest: await digest(canonicalDiagnosticJson(metadata)) };
}
type RuntimeEnvelope = {
  version: number; captureId: string; sequence: number; timestamp: number; boundary: string; outcome: string;
  code: string; origin: string; source: { package: string; boundary: string; baseVersion: string | null;
    patchSetDigest: string | null; status: string; frames: Array<Record<string, unknown>> };
  error?: { kind: string; publicCode: string | null; messageDigest: string | null; stackDigest: string | null;
    causes: Array<{ kind: string; messageDigest: string | null; stackDigest: string | null }>;
    loss: string[]; fingerprintScope: string };
  sdk?: { rootUid?: string; submissionId?: string; attemptId?: string; streamIncarnation?: string;
    batchSequence?: number; producerEpoch?: number; producerSequence?: number; recordIndex?: number;
    recordType?: string; inputApplied?: boolean; settlement?: string };
  local: { through: number; dropped: number; status: string };
};
export const encodeSdkHeader = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export async function runtimeEnvelope(f: DispatcherFixture, sequence = 1): Promise<RuntimeEnvelope> {
  return { version: 1, captureId: await digest(`synthetic-capture-${sequence}`), sequence, timestamp: Date.now(),
    boundary: 'model', outcome: 'failed', code: 'provider-failed', origin: 'originating',
    source: { package: '@flue/runtime', boundary: 'model', baseVersion: '2.2.2',
      patchSetDigest: f.sdkPatchSetDigest, status: 'partial', frames: [] },
    error: { kind: 'TypeError', publicCode: null, messageDigest: await digest('PRIVATE_SDK_MESSAGE'),
      stackDigest: await digest('PRIVATE_SDK_STACK'), causes: [{ kind: 'Error',
        messageDigest: await digest('PRIVATE_SDK_CAUSE'), stackDigest: null }], loss: [], fingerprintScope: 'full' },
    sdk: { rootUid: 'fixture-incarnation', submissionId: 'submission-1', attemptId: 'PRIVATE_SDK_ATTEMPT',
      streamIncarnation: 'PRIVATE_SDK_STREAM', batchSequence: 7, producerEpoch: 3, producerSequence: 11,
      recordIndex: 2, recordType: 'assistant_message_completed', inputApplied: false, settlement: 'unknown' },
    local: { through: sequence, dropped: 0, status: 'captured' } };
}
export async function importRuntime(f: DispatcherFixture, report: unknown, capability = f.capability, expected: number | readonly number[] = 204) {
  const response = await capability.fetch(genericWire('diagnostic/runtime', report));
  if (typeof expected === 'number') expect(response.status).toBe(expected);
  else expect(expected).toContain(response.status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).not.toMatch(/PRIVATE_|fixture-incarnation|private\.jwt/);
}

/** Instrumented SDK owner, not native Flue proof: native cases remain in loader-runtime.test.ts. */
export async function fixture(test: (f: {
  activity: OperatorActivity; capability: OperatorDispatcherCapability; staleCapability: OperatorDispatcherCapability; environment: Env;
  normalTransport: ReturnType<typeof createNormalDispatcherTransport> | undefined;
  installationCapability: OperatorInstalledDispatcherCapability;
  changeConnection: (patch: Record<string, unknown>) => void;
  refuseNormalHostAuth: () => void;
  ownerPortRequests: Array<{ url: string; loggingContext: unknown; body: unknown }>;
  setCurrentLogging: (enabled: boolean) => void;
  waitUntil: (promise: Promise<unknown>) => void;
  bundle: DispatcherBundle; artifactDigest: string; activityId: string; deliverTail: (events: unknown) => Promise<void>;
  deliveredTail: Array<{ activityId: string; generation: number; stage: string }>;
  sdkPatchSetDigest: string | null; sdkHeader: (value: string | undefined) => void;
  settle: (id?: string, outcome?: string, error?: unknown) => void; expire: () => void;
  advanceClock: (milliseconds: number) => void;
  seedLegacyJournal: (entries: Array<{ body: { operationId: string; url: string; method?: 'GET' | 'POST' | 'PUT'; body?: string };
    phase: 'reserved' | 'completed' | 'unknown'; ordinal: number; response?: unknown }>) => Promise<void>;
  revoke: () => void; sent: Request[]; childSubmissions: Request[]; abortStatus: () => string | undefined;
  readRemoteComments: () => Promise<unknown>;
  readRemoteMerge: () => unknown;
  mutateEvidence: (change: (storage: DurableObjectStorage) => Promise<void>) => Promise<void>;
  inOwnContext: <T>(action: () => Promise<T>) => Promise<T>;
  restart: () => OperatorActivity; drainBackground: () => Promise<void>; seedHistoricalAdmitting: () => Promise<void>;
  loseResponse: () => void; restoreTransport: () => void; throwTransport: () => void;
  emptyResponse: () => void; upstreamConflict: (enabled: boolean) => void; nextAlarm: () => Promise<number | null>;
  oversizedChecks: (count?: number, outputBytes?: number, overlap?: boolean) => void;
  messages: (value: unknown[]) => void; input: unknown; revokeSession: () => void;
  loaderEnv: () => Promise<Record<string, unknown>>; loaderOutbound: () => Promise<Fetcher | null>; genericReadback: (value: unknown) => void;
  sourceBody: (value: string) => void; files: (value: unknown[]) => void;
  compose: (value: Record<string, unknown>) => void;
  release: (value: unknown, status?: number) => void;
  guide: (value: unknown) => void; tag: (value: unknown) => void;
  annotatedTag: (value: unknown) => void;
  moveHeadAfterFiles: () => void;
  moveHeadAfterRelease: () => void; expireAfterRead: () => void;
  moveBaseAfterContents: () => void; moveBaseAfterGuide: () => void; exceedComposeDeadline: () => void;
  exceedReleaseDeadline: () => void; exceedGuideDeadline: () => void;
  proof: ProspectiveAdmission; admittedTarget: Record<string, unknown>;
  changeProof: (patch: Record<string, unknown> | null) => void;
  changeRegistration: (patch: Partial<CurrentProspectiveRegistration> | null) => void;
  changeTarget: (patch: Record<string, unknown>) => void;
  afterTargetRead: (action: () => void | Promise<void>) => void; revokeGrant: () => void;
  afterRegistryResolve: (action: () => Promise<void>) => void;
  afterBundleRead: (action: () => Promise<void>) => void;
  changeInferenceAuthority: (field: 'route' | 'installation' | 'digest') => void;
  loseAllocationAcknowledgement: (afterCommit?: () => Promise<void>) => void;
  statusFault: (fault: () => Response | Promise<Response>) => void;
  admissionFault: (fault: (() => Response | Promise<Response>) | undefined) => void;
  changeRetiredPin: (field: 'inputDigest' | 'artifactDigest') => Promise<void>;
  ownedChildReadbacks: () => Array<() => Promise<Response>>;
  interruptOwnedChild: (error: Error) => void;
  failOwnedAbort: () => void;
  seedCancelledReleased: () => Promise<void>;
}) => Promise<void>, options: { humanLifetimeSeconds?: number; repositoryOnly?: boolean; prospective?: boolean;
  configuredTarget?: { repository: string; repositoryId: number; baseBranch: string };
  legacyProspective?: boolean; inputExtra?: Record<string, unknown>; capabilities?: string[]; pagedStatus?: boolean; githubApiHost?: string;
  sourceResponseBytes?: number; installationSourceResponseBytes?: number; sourceBody?: string; sourceDelayMs?: number; inferenceBody?: string; inferenceRequestBytes?: number; inferenceMessageLimit?: number; operationLimit?: number; loggingEnabled?: boolean;
  capacityPolicy?: DispatcherCapacityPolicy; runtimeVersion?: '2.1.0' | '2.2.2'; sdkDiagnostics?: boolean;
  recovery?: boolean; intent4?: boolean; losePhaseAdmission?: number; facetContract?: boolean; receiptFixture?: boolean;
  inferenceAttemptLimit?: number; inferenceTransport?: (request: Request, attempt: number) => Promise<Response>;
  nativeInference?: boolean; nativeProviderDefault?: boolean; managedProviderDefault?: boolean;
  ownerTransport?: (request: Request) => Promise<Response | undefined>;
  normalProfileTransport?: (request: Request) => Promise<Response | undefined>;
  realInterceptors?: boolean; sourceTransport?: (request: Request) => Promise<Response>; normalHosting?: boolean;
  preserveGlobalMocks?: boolean } = {}) {
  callerSessionCurrent = true;
  callerRoute = 'approved';
  nativeProfileFiles = new Map<string, unknown>(options.nativeInference ? [
    ['/owner-bucket/.pi/agent/settings.json', { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: 'high' }],
    ['/owner-bucket/.pi/agent/auth.json', { 'openai-codex': { type: 'oauth', access: 'synthetic-native-access',
      refresh: 'synthetic-native-refresh', accountId: 'synthetic-account', expires: Date.now() + 120_000 } }],
    ['/owner-bucket/.pi/agent/models.json', { providers: {} }],
  ] : []);
  const configuredTarget = options.configuredTarget ?? { repository: 'nikolanovoselec/komodo', repositoryId: 973175879, baseBranch: 'main' };
  const fixtureInvocation = options.prospective ? { repository: configuredTarget.repository,
    ...(options.legacyProspective ? { pullRequest: 17 } : {}), ...options.inputExtra }
    : options.repositoryOnly ? { repository: 'another/service' } : invocation;
  const sdkProvenance = options.sdkDiagnostics ? await syntheticSdkProvenance() : null;
  const baseBundle: DispatcherBundle = options.runtimeVersion === '2.2.2' || options.sdkDiagnostics ? { ...bundle,
    versions: { runtime: '2.2.2', vitePlugin: '2.2.2', agents: '0.20.1' } } : bundle;
  // The untrusted schema-2 fixture intentionally reaches today's parser rather than requiring a new export at import time.
  const fixtureBundle: DispatcherBundle = options.normalHosting ? normalDispatcherBundle() as unknown as DispatcherBundle : sdkProvenance ? { ...baseBundle, modules: { ...baseBundle.modules,
    'codeflare/sdk-diagnostics-provenance.json': { text: canonicalDiagnosticJson(sdkProvenance) },
    ...Object.fromEntries([...syntheticFramePaths, ...syntheticBudgetPaths()].map((path, index) => [path, { text: syntheticFrameText(index) }])),
  } } : baseBundle;
  const fixtureBytes = options.normalHosting || options.runtimeVersion || sdkProvenance ? new TextEncoder().encode(JSON.stringify(fixtureBundle)) : bytes;
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const objectName = `dispatcher-${crypto.randomUUID()}`;
  await runInDurableObject(namespace.getByName(objectName), async (_instance, native) => {
    const activityId = `activity-${crypto.randomUUID()}`;
    const artifactDigest = await digest(fixtureBytes);
    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + (options.humanLifetimeSeconds ?? 300);
    const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['audience'], issuedAt: Math.floor(now / 1000) - 1, expiresAt };
    const policy = { capabilities: options.capabilities ?? ['fetch', 'inference'], resourceProfileId: null,
      ...(options.nativeInference ? { inference: { allowedSources: ['pi-native'], routeIds: [], defaultRouteId: null,
        reasoningLevels: ['low'], defaultReasoningLevel: options.nativeProviderDefault ? null : 'low', inheritUserDefaults: false } }
        : options.managedProviderDefault ? { inference: { allowedSources: ['managed'], routeIds: ['approved'], defaultRouteId: 'approved',
          reasoningLevels: ['off', 'low'], defaultReasoningLevel: null, inheritUserDefaults: false } } : {}),
      ...(options.sourceResponseBytes === undefined ? {} : { sourceResponseBytes: options.sourceResponseBytes }) };
    const fixtureOperatorId = options.prospective || options.intent4 ? 'renovate-dispatcher' : 'operator';
    let inferenceAttempts = 0;
    const selection = { controlsRevision: 1, installation: { id: 'installation', operatorId: fixtureOperatorId, revision: 1,
      enabled: true, ...(options.nativeInference && !options.nativeProviderDefault ? { piReasoningOverride: 'low' } : {}),
      policy: options.installationSourceResponseBytes === undefined ? policy
        : { ...policy, sourceResponseBytes: options.installationSourceResponseBytes },
      configurationJson: options.prospective ? JSON.stringify({ renovate: { repository: configuredTarget.repository, automaticRuns: true, repetitionIntervalSeconds: 900 } }) : '{}', releaseId: 'release' },
    operator: { operatorId: fixtureOperatorId, profile: 'dispatcher', revision: 1, invokers: { users: [human.email], groups: [] },
      policy: { ...policy, ...options.capacityPolicy, ...(options.inferenceMessageLimit === undefined ? {} : { inferenceMessageLimit: options.inferenceMessageLimit }), ...(options.inferenceAttemptLimit === undefined ? {} : { inferenceAttemptLimit: options.inferenceAttemptLimit }), ...(options.loggingEnabled === undefined ? {} : { loggingEnabled: options.loggingEnabled }), ...(options.operationLimit === undefined ? {} : { operationLimit: options.operationLimit }), ...(options.inferenceRequestBytes === undefined ? {} : { inferenceRequestBytes: options.inferenceRequestBytes }) } },
    release: { id: 'release', operatorId: fixtureOperatorId, bundleDigest: artifactDigest, sourceCommit: bundle.sourceCommit,
      ...(options.normalHosting ? { manifestDigest: 'd'.repeat(64), provenance: { compilerCommit: normalDeployment.compilerCommit } } : {}),
      ...(options.prospective || options.intent4 ? { intentVersion: options.intent4 ? '4' : options.legacyProspective ? '2' : '3', coreVersion: '1' } : {}) },
    manifestJson: options.prospective || options.intent4 ? JSON.stringify({ schemaVersion: 1, interfaceVersion: 1,
      id: 'renovate-dispatcher', name: 'Renovate Dispatcher', description: 'Prospective singleton fixture',
      coreVersion: '1', intentVersion: options.intent4 ? '4' : options.legacyProspective ? '2' : '3', profile: 'dispatcher',
      inputSchema: { type: 'object', additionalProperties: false,
        required: options.legacyProspective ? ['repository', 'pullRequest'] : ['repository'],
        properties: { repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
          ...(options.legacyProspective ? { pullRequest: { type: 'integer', minimum: 1 } } : {}) } },
      requiredCapabilities: ['inference', 'fetch'], artifact: { path: '/operator-bundle.json', sha256: artifactDigest } }) : '{}' };
    const proof = { activityId, installationId: 'installation', ...configuredTarget,
      controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest: artifactDigest,
      pullRequest: 17, head: 'b'.repeat(40), createdAt: new Date(now - 86_400_000).toISOString(),
      activatedAt: new Date(now - 2 * 86_400_000).toISOString(), ownerKey: await operatorOwnerKey(human),
      actor: { registrationId: 'scan-original', bucket: 'owner-bucket', sessionId: 'original-session',
        sessionGeneration: 3, subject: human.subject, issuer: human.issuer, email: human.email, audiences: human.audiences } } as unknown as ProspectiveAdmission;
    const admittedTarget = { repository: configuredTarget.repository, repositoryId: proof.repositoryId,
      pullRequest: proof.pullRequest, headSha: proof.head, createdAt: proof.createdAt,
      createdAfter: proof.activatedAt, baseBranch: configuredTarget.baseBranch };
    let currentProof: Record<string, unknown> | null = structuredClone(proof) as unknown as Record<string, unknown>;
    let currentRegistration: CurrentProspectiveRegistration | null = { registrationId: proof.actor.registrationId,
      installationId: proof.installationId, activatedAt: proof.activatedAt, bucket: proof.actor.bucket,
      sessionId: proof.actor.sessionId, sessionGeneration: proof.actor.sessionGeneration, human, accessJwt: 'private.jwt',
      ...configuredTarget, controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest: artifactDigest,
      repetitionIntervalSeconds: 900 } as unknown as CurrentProspectiveRegistration;
    let targetPatch: Record<string, unknown> = {};
    let afterTargetRead: (() => void | Promise<void>) | undefined;
    let afterRegistryResolve: (() => Promise<void>) | undefined;
    let afterBundleRead: (() => Promise<void>) | undefined;
    let revoked = false;
    let settlements: unknown[] = [];
    let messages: unknown[] = [];
    let streamBatch = 0;
    const streamOffset = () => `0000000000000000_${String(streamBatch).padStart(16, '0')}`;
    let messagesSet = false;
    let aborted: string | undefined;
    let uncertain = false;
    const genericComments: Array<{ id: number; body: string; user: { id: number } }> = [];
    let remoteMerge: unknown = null;
    let genericReadback: unknown;
    let loadedEnvironment: Promise<Record<string, unknown>> | undefined;
    let loadedOutbound: Promise<Fetcher | null> | undefined;
    let sourceBody = options.sourceBody ?? 'Official migration guidance';
    let transportThrows = false;
    let emptyResponse = false;
    let upstreamConflict = false;
    let oversizedChecks: { count: number; outputBytes: number; overlap: boolean } | null = null;
    let changedFiles: unknown[] = [];
    let composeBodies: Record<string, unknown> = {};
    let releaseBody: unknown = { tag_name: 'v11.1.2', body: 'No configuration changes', html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2' };
    let releaseStatus = 200;
    let guideBody: unknown = composeBlob('docs/guide/agent.md', guideBlobSha, guideExcerpt);
    let tagRef: unknown = { ref: 'refs/tags/v11.1.2', object: { type: 'tag', sha: '3'.repeat(40) } };
    let annotatedTag: unknown = { tag: 'v11.1.2', object: { type: 'commit', sha: '1'.repeat(40) } };
    let headSha = 'b'.repeat(40);
    let baseSha = 'a'.repeat(40);
    let moveAfterContents = false;
    let moveBaseAfterGuide = false;
    let moveAfterFiles = false;
    let moveAfterRelease = false;
    let expireAfterRead = false;
    let exceedDeadline = false;
    let composeElapsed = false;
    const sent: Request[] = [];
    const nativeTransport = (request: Request) => {
      sent.push(request.clone());
      return options.sourceTransport!(request);
    };
    const childSubmissions: Request[] = [];
    const deliveredTail: Array<{ activityId: string; generation: number; stage: string }> = [];
    let configuredTail: Promise<{ tail(events: unknown): Promise<void> }> | undefined;
    const pending: Promise<unknown>[] = [];
    let drained = 0;
    const drainBackground = async () => {
      // Lifecycle bookkeeping only: include work enqueued by constructor callbacks/background work.
      // Do not substitute a fake concurrency fence or infer recovery from callback counts.
      while (drained < pending.length) {
        const batch = pending.slice(drained);
        drained = pending.length;
        await Promise.all(batch);
      }
    };
    const blockConcurrencyWhile = native.blockConcurrencyWhile.bind(native);
    let activity: OperatorActivity;
    const phaseAdmissions = new Map<string, { submissionId: string; offset: string }>();
    let phaseAcknowledgementLost = false;
    let statusFault: (() => Response | Promise<Response>) | undefined;
    let admissionFault: (() => Response | Promise<Response>) | undefined;
    const child = {
      _cf_initAsFacet: async () => {},
      _cf_checkRunFibersForFacet: async () => 0,
      _cf_dispatchScheduledCallback: async () => true,
      sql: async (strings: readonly string[], ...values: (string | number | null)[]) =>
        native.storage.sql.exec(strings.join('?'), ...values).toArray(),
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/abort')) {
          aborted = (await activity.getBrowserDetail())?.executionStatus;
          return Response.json({ ok: true });
        }
        if (request.method === 'POST') {
          childSubmissions.push(request.clone());
          if (options.intent4) {
            if (admissionFault) return await admissionFault();
            const wire = await request.json() as { idempotencyKey: string; uid: string | null };
            const retained = phaseAdmissions.get(wire.idempotencyKey);
            if (!retained && (phaseAdmissions.size === 0 ? wire.uid !== null : wire.uid !== 'fixture-incarnation')) {
              return Response.json({ code: 'agent_instance_not_found' }, { status: 404 });
            }
            const receipt = retained ?? { submissionId: `submission-${phaseAdmissions.size + 1}`, offset: streamOffset() };
            phaseAdmissions.set(wire.idempotencyKey, receipt);
            // Fault AFTER SDK admission: replay must adopt that original receipt, not a replacement input.
            if (!phaseAcknowledgementLost && options.losePhaseAdmission === phaseAdmissions.size && !retained) {
              phaseAcknowledgementLost = true;
              throw new Error('Fixture lost phase admission acknowledgement');
            }
            const offset = retained ? '-1' : receipt.offset;
            return Response.json({ ...receipt, offset, uid: 'fixture-incarnation', streamUrl: request.url,
              ...(retained ? { deduplicated: true } : {}) }, { status: 202, headers: { 'stream-next-offset': offset } });
          }
          return Response.json({ submissionId: 'submission-1', offset: streamOffset(),
            uid: 'fixture-incarnation', streamUrl: request.url }, { status: 202, headers: { 'stream-next-offset': streamOffset() } });
        }
        if (request.method === 'GET' && new URL(request.url).searchParams.get('view') === 'updates') {
          const fault = statusFault; statusFault = undefined;
          if (fault) return await fault();
        }
        const snapshot = { v: 1, conversationId: 'fixture-conversation', offset: streamOffset(), settlements,
          messages: messages.map((value, index) => ({ id: `fixture-message-${index}`, role: 'assistant',
            purpose: 'assistant', display: 'visible', ...value as object })) };
        const url = new URL(request.url);
        if (url.searchParams.get('view') === 'updates') {
          if (options.pagedStatus && settlements.length) {
            const pageOffset = '0000000000000000_0000000000000100';
            if (url.searchParams.get('offset') !== pageOffset) return Response.json([{ type: 'conversation-reset',
              conversationId: snapshot.conversationId, position: { batch: streamBatch, index: 0 },
              snapshot: { ...snapshot, settlements: [] } }], { headers: { 'stream-next-offset': pageOffset } });
            return Response.json(settlements.map((settlement, index) => ({ type: 'submission-settled',
              conversationId: snapshot.conversationId, position: { batch: streamBatch + 1, index }, ...settlement as object })),
            { headers: { 'stream-next-offset': '0000000000000000_0000000000000101', 'stream-up-to-date': 'true' } });
          }
          const chunks = url.searchParams.get('offset') === streamOffset() ? [] : [{ type: 'conversation-reset',
            conversationId: snapshot.conversationId, position: { batch: streamBatch, index: 0 }, snapshot }];
          return Response.json(chunks, { headers: { 'stream-next-offset': streamOffset(), 'stream-up-to-date': 'true' } });
        }
        return Response.json(snapshot, { headers: { 'stream-next-offset': streamOffset(), 'stream-up-to-date': 'true' } });
      },
    };
    let sdkHeader: string | undefined;
    const ordinaryChildFetch = child.fetch;
    child.fetch = async request => {
      const response = await ordinaryChildFetch(request);
      if (sdkHeader !== undefined) response.headers.set('x-codeflare-sdk-diagnostics', sdkHeader);
      return response;
    };
    // External Cloudflare contract: abort invalidates existing stubs; get may
    // create a new runtime. SDK conversation data above outlives each runtime.
    // These callable outcomes test parent orchestration, not hosted cessation.
    const ownedChildReadbacks: Array<() => Promise<Response>> = [];
    let ownedRuntime: { valid: boolean; stub: typeof child; failure?: Error } | undefined;
    let failOwnedAbort = false;
    const facets = options.facetContract ? {
      get: () => {
        if (!ownedRuntime?.valid) {
          const runtime = { valid: true, stub: undefined as unknown as typeof child, failure: undefined as Error | undefined };
          const callable = <T>(action: () => Promise<T>): Promise<T> => {
            if (!runtime.valid) return Promise.reject(runtime.failure ?? new Error('Owned facet stub invalidated'));
            return action();
          };
          runtime.stub = {
            _cf_initAsFacet: () => callable(() => child._cf_initAsFacet()),
            _cf_checkRunFibersForFacet: () => callable(() => child._cf_checkRunFibersForFacet()),
            _cf_dispatchScheduledCallback: () => callable(() => child._cf_dispatchScheduledCallback()),
            sql: (strings, ...values) => callable(() => child.sql(strings, ...values)),
            fetch: request => callable(() => child.fetch(request)),
          };
          ownedChildReadbacks.push(() => runtime.stub.fetch(new Request(
            'https://flue.internal/agents/Dispatcher/dispatcher?view=snapshot')));
          ownedRuntime = runtime;
        }
        return ownedRuntime.stub;
      },
      abort: () => {
        if (failOwnedAbort) {
          failOwnedAbort = false;
          throw new Error('Controlled owned facet abort unavailable');
        }
        if (ownedRuntime) ownedRuntime.valid = false;
      },
    } : { get: () => child, abort: () => {} };
    // Agent validates the native DurableObjectState brand and SQLite capability.
    // Keep that real owner while replacing only the fixture's child/interceptor seams.
    Object.defineProperties(native, {
      blockConcurrencyWhile: { configurable: true, value: <T>(callback: () => Promise<T>) => {
        const promise = blockConcurrencyWhile(callback);
        pending.push(promise);
        return promise;
      } },
      facets: { configurable: true, value: facets },
      exports: { configurable: true, value: {
        OperatorDispatcherCapability: ({ props }: { props: { activityId: string; generation: number } }) =>
          new OperatorDispatcherCapability({ props } as unknown as ExecutionContext,
            environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]),
        OperatorDispatcherTail: ({ props }: { props: { activityId: string; generation: number } }) => ({
          tail: async (events: unknown) => {
            const stage = (events as Array<{ logs: Array<{ message: Array<{ stage?: string }> }> }>)[0]?.logs?.[0]?.message?.[1]?.stage;
            if (stage) deliveredTail.push({ ...props, stage });
          },
        }),
        EgressController: ({ props }: { props: Record<string, unknown> }) => options.nativeInference || options.realInterceptors
          ? new EgressController({ props } as unknown as ExecutionContext, { ...environment,
            EGRESS: { fetch: options.nativeInference ? environment.EGRESS?.fetch.bind(environment.EGRESS) ?? nativeTransport : options.sourceTransport } } as unknown as Env)
          : ({ fetch: async () => {
          if (options.sourceDelayMs) await new Promise(resolve => setTimeout(resolve, options.sourceDelayMs));
          return new Response(sourceBody, {
            headers: { 'content-type': 'text/plain', etag: 'guide-v3', 'set-cookie': 'private-session' },
          });
        } }),
        GitHubInterceptor: ({ props }: { props: { bucket: string } }) => ({ fetch: async (request: Request) => {
          if (request.url.includes('/repos/community/compiler')) return Response.json({
            tag_name: 'v3.2.1', guidance: props.bucket === 'owner-bucket' ? 'Owned authenticated research' : 'Foreign private data',
          });
          sent.push(options.prospective ? request.clone() : request);
          if (options.prospective && request.method === 'GET') {
            if (transportThrows) throw new Error('Target authority unavailable');
            if (emptyResponse) return new Response(null, { status: 200 });
            const repositoryUrl = `https://${options.githubApiHost ?? 'api.github.com'}/repos/${configuredTarget.repository}`;
            if (request.url === repositoryUrl) return Response.json({ id: proof.repositoryId,
              full_name: configuredTarget.repository, default_branch: configuredTarget.baseBranch, ...(targetPatch.repository as object | undefined) });
            if (request.url === `${repositoryUrl}/pulls/17`) {
              const observed = { number: 17, state: 'open', draft: false, created_at: proof.createdAt,
                user: { login: 'renovate[bot]', id: 29139614, type: 'Bot' },
                base: { ref: configuredTarget.baseBranch, sha: baseSha, repo: { id: proof.repositoryId, full_name: configuredTarget.repository } },
                head: { sha: headSha }, ...targetPatch };
              const action = afterTargetRead; afterTargetRead = undefined;
              await action?.();
              return Response.json(observed);
            }
          }
          if (request.url.endsWith('/issues/17/comments') && request.method === 'POST') {
            const data = await request.json() as { body: string };
            genericComments.push({ id: 91 + (options.receiptFixture ? genericComments.length : 0), body: data.body, user: { id: 42 } });
            if (uncertain) throw new Error('Lost mutation response');
            return Response.json(options.receiptFixture ? genericComments.at(-1) : genericComments[0], { status: 201 });
          }
          if (request.url.endsWith('/issues/17/comments') && request.method === 'GET') return Response.json(genericReadback ?? genericComments);
          if (options.receiptFixture && request.url.endsWith('/pulls/17/merge') && request.method === 'PUT') {
            remoteMerge = { sha: '8'.repeat(40), merged: true, message: 'Pull Request successfully merged' };
            if (uncertain) throw new Error('Lost mutation response');
            return Response.json(remoteMerge);
          }
          if (transportThrows) throw new Error('private transport failure');
          if (emptyResponse) return new Response(null, { status: 200 });
          if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          if (upstreamConflict) return Response.json({ error: 'upstream-conflict' }, { status: 409 });
          if (request.url.includes('/releases/tags/')) {
            if (moveAfterRelease) headSha = 'c'.repeat(40);
            if (exceedDeadline) vi.spyOn(Date, 'now').mockReturnValue(now + 9000);
            return Response.json(releaseBody, { status: releaseStatus });
          }
          if (request.url.includes('/git/ref/tags/')) return Response.json(tagRef);
          if (request.url.includes('/git/tags/')) return Response.json(annotatedTag);
          if (request.url.includes('/contents/docs/guide/agent.md')) {
            if (moveAfterRelease) headSha = 'c'.repeat(40);
            if (moveBaseAfterGuide) baseSha = 'c'.repeat(40);
            if (exceedDeadline) vi.spyOn(Date, 'now').mockReturnValue(now + 19_000);
            return guideBody instanceof Response ? guideBody : Response.json(guideBody);
          }
          if (request.url.includes('/contents/')) {
            const url = new URL(request.url);
            const key = `${url.searchParams.get('ref')}:${decodeURIComponent(url.pathname.split('/contents/')[1])}`;
            const body = composeBodies[key];
            if (composeElapsed) vi.spyOn(Date, 'now').mockReturnValue(now + 1500);
            if (moveAfterContents) baseSha = 'c'.repeat(40);
            return body instanceof Response ? body : body ? Response.json(body)
              : Response.json({ message: 'Missing' }, { status: 404 });
          }
          if (request.url.includes('/pulls/17/files')) {
            if (moveAfterFiles) headSha = 'c'.repeat(40);
            return Response.json(changedFiles);
          }
          const checks = oversizedChecks;
          if (checks && request.url.includes('/check-runs?')) {
            const url = new URL(request.url);
            const perPage = Number(url.searchParams.get('per_page'));
            const page = Number(url.searchParams.get('page'));
            const first = (page - 1) * perPage;
            const count = Math.max(0, Math.min(perPage, checks.count - first));
            return Response.json({ total_count: checks.count,
              check_runs: Array.from({ length: count }, (_, index) => ({ id: checks.overlap && first > 0 && index === 0
                ? first - 1 : first + index, name: `check-${first + index}`,
                conclusion: 'success', output: 'x'.repeat(checks.outputBytes) })) }, {
              headers: first + count < checks.count ? { link: '<https://api.github.com/next>; rel="next"' } : {},
            });
          }
          if (expireAfterRead) vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1);
          return Response.json({ number: 17, body: 'inline-secret',
            user: { login: 'fork-specific-bot[bot]', id: 42, type: 'Bot' },
            base: { sha: baseSha }, head: { sha: headSha } });
        } }),
        LlmInterceptor: ({ props }: { props: Record<string, unknown> }) => options.realInterceptors
          ? composedLlm(props, environment) : ({ fetch: async (request: Request) => {
          sent.push(request); inferenceAttempts++;
          if (options.inferenceTransport) return await options.inferenceTransport(request, inferenceAttempts);
          if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          return new Response(options.inferenceBody ?? 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        } }),
      } },
      waitUntil: { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } },
    });
    const context = native;
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const normalIdentity = options.nativeInference
      ? { provider: 'configured-provider', model: 'saved-model', api: 'configured-api', reasoningLevel: 'low' }
      : { provider: 'codeflare-gateway', model: 'approved', api: 'openai-completions', reasoningLevel: options.managedProviderDefault ? null : 'off' };
    const normalTransport = options.normalHosting ? createNormalDispatcherTransport({
      profile: { source: options.nativeInference ? 'pi-native' : 'managed', ...normalIdentity },
      profileTransport: options.normalProfileTransport,
    }) : undefined;
    let connectionRecord: Record<string, unknown> = { installationId: 'installation', releaseId: 'release', connectionRevision: 1,
      ...normalDeployment, manifestDigest: 'd'.repeat(64), bundleDigest: artifactDigest,
      connectionSecretCiphertext: await sealOperatorSecret(connectionSecret, encryption, { purpose: 'connection', recordId: 'installation' }) };
    if (normalTransport) vi.stubGlobal('fetch', normalTransport.fetcher);
    const originalAbortConnection = structuredClone(connectionRecord);
    const registry = { getManagementBundle: async () => {
      const action = afterBundleRead; afterBundleRead = undefined;
      await action?.();
      return fixtureBytes;
    },
      // Registry is the platform authority seam, not a mocked control implementation.
      getManagementDispatcherConnection: async (installationId: string) =>
        options.normalHosting && installationId === 'installation' ? structuredClone(connectionRecord) : null,
      getManagementDispatcherAbortConnection: async (installationId: string, revision: number) =>
        options.normalHosting && installationId === 'installation' && revision === 1 ? structuredClone(originalAbortConnection) : null,
      resolveManagementExecution: async () => {
        const action = afterRegistryResolve; afterRegistryResolve = undefined;
        await action?.();
        return revoked ? { ok: false, reason: 'disabled' } : { ok: true, value: selection };
      },
      admitManagement: async (input: unknown) => ({ ok: true, value: { ...input as object, admittedAt: now, selection } }),
      upsertOwnedActivity: async () => {},
      getOwnedActivity: async (ownerKey: string, requestedId: string) =>
        requestedId === activityId ? activity.getBrowserSummary(ownerKey) : null,
      readProspectiveRenovateAdmission: async () => structuredClone(currentProof),
      currentProspectiveRenovateRegistration: async () => structuredClone(currentRegistration),
    };
    // Historical Host completion stand-in retains its original profile/digest wire.
    // Current normal discovery uses the separate installed-Worker profile wrapper above.
    const normalProfile = { ...normalIdentity, profileDigest: await digest(JSON.stringify(normalIdentity)) };
    const normalWorkerProfileDigest = await digest(JSON.stringify({
      source: options.nativeInference ? 'pi-native' : 'managed', ...normalIdentity }));
    let normalModelOrdinal = 0;
    let normalHostAuthMissing = false;
    const ownerPortRequests: Array<{ url: string; loggingContext: unknown; body: unknown }> = [];
    const environment = { ...encryption, ENTERPRISE_MODE: 'active', GITHUB_API_HOST: options.githubApiHost,
      ...(options.normalHosting ? { CONTAINER: { getByName: () => ({
        getPersonalPiSession: async (ref: { bucket: string; sessionId: string; email: string }) => {
          if (ref.bucket !== 'owner-bucket' || ref.sessionId !== 'ownerhost123' || ref.email !== human.email
            || !callerSessionCurrent) throw new Error('Owner session unavailable');
          return { generation: 3 };
        },
        forwardExisting: async (request: Request, loggingContext?: unknown) => {
          ownerPortRequests.push({ url: request.url, loggingContext, body: await request.clone().json() });
          const controlled = await options.ownerTransport?.(request.clone());
          if (controlled) return controlled;
          const input = await request.json() as { sessionGeneration: number; profileDigest?: string; context?: unknown; options?: unknown };
          if (input.sessionGeneration !== 3) return Response.json({}, { status: 403 });
          if (new URL(request.url).pathname === '/operator-inference/profile') return Response.json(normalProfile);
          // Legacy completion tests can receive selection from either discovery wire.
          if (input.profileDigest !== normalProfile.profileDigest && input.profileDigest !== normalWorkerProfileDigest)
            return Response.json({}, { status: 409 });
          if (normalHostAuthMissing) return Response.json({ error: 'Configured inference unavailable',
            authFailure: { code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider: normalProfile.provider } }, { status: 401 });
          const result = { role: 'assistant', provider: normalProfile.provider, model: normalProfile.model,
            api: normalProfile.api, content: [{ type: 'text', text: JSON.stringify({ context: input.context, options: input.options, ordinal: ++normalModelOrdinal }) }],
            stopReason: 'stop', timestamp: Date.now() };
          return Response.json({ events: [{ type: 'done', reason: 'stop', message: result }], result });
        },
      }) } } : {}),
      ...(options.nativeInference ? { R2_ACCESS_KEY_ID: 'synthetic-scoped-id', R2_SECRET_ACCESS_KEY: 'synthetic-scoped-secret',
        R2_ACCOUNT_ID: 'synthetic-r2-account', R2_ENDPOINT: 'https://r2.example.test',
        KV: { get: async (key: string) => key === 'setup:strict_egress' ? 'active' : null },
        EGRESS: { fetch: nativeTransport } } : {}),
      OPERATOR_REGISTRY: { getByName: () => registry }, OPERATOR_ACTIVITY: { getByName: () => activity, idFromName: () => native.id },
      LOADER: { get: (_key: string, factory: () => Promise<{ env: Record<string, unknown>; globalOutbound: Fetcher | null; tails?: Array<{ tail(events: unknown): Promise<void> }> }>) => ({
        getDurableObjectClass: () => {
          const code = factory();
          loadedEnvironment = code.then(value => value.env);
          loadedOutbound = code.then(value => value.globalOutbound);
          configuredTail = code.then(value => value.tails?.[0] as { tail(events: unknown): Promise<void> });
          return {};
        },
      }) },
    } as unknown as Env;
    if (options.normalHosting) delete (environment as unknown as Record<string, unknown>).LOADER;
    const activityEnvironment = environment as unknown as ConstructorParameters<typeof OperatorActivity>[1];
    activity = new OperatorActivity(context, activityEnvironment);
    await drainBackground();
    if (options.prospective) expect(await activity.bindProspectiveRenovateAdmission(activityId)).toBe(true);
    const invocationJson = JSON.stringify(fixtureInvocation);
    const execution = await createOperatorExecutionContext({ activityId, operatorId: fixtureOperatorId, artifactDigest,
      policyDigest: await digest(JSON.stringify(selection.installation.policy)), human, accessJwt: 'private.jwt' }, encryption);
    await activity.prepareAuthorized({ activityId, operatorId: fixtureOperatorId, installationId: 'installation',
      intentDigest: await createOperatorIntentDigest(fixtureOperatorId, activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: expiresAt * 1000, startExpiresAt: expiresAt * 1000, startVerifier: await digest('s'.repeat(43)) }, execution, invocationJson);
    if (options.normalHosting) expect(await activity.bindDispatcherOwnerSource({ bucket: 'owner-bucket',
      sessionId: 'ownerhost123', sessionGeneration: 3 })).toBe(true);
    if (!options.recovery) {
      // Compatibility cases retain the admission format persisted before inference recovery existed.
      // New-policy cases below use the unmodified current prepareAuthorized outcome instead.
      const retained = await native.storage.get<Record<string, unknown>>('admission');
      const { inferenceRecoveryVersion: _version, ...historical } = retained!;
      await native.storage.put('admission', historical);
    }
    expect(await activity.start('s'.repeat(43))).toEqual({ ok: true, phase: 'queued' });
    const capability = new OperatorDispatcherCapability({ props: { activityId, generation: 1 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    const staleCapability = new OperatorDispatcherCapability({ props: { activityId, generation: 2 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    try {
      await test({ activity, capability, staleCapability, environment, bundle: fixtureBundle, artifactDigest, activityId, deliveredTail,
        normalTransport, changeConnection: patch => { connectionRecord = { ...connectionRecord, ...patch }; },
        refuseNormalHostAuth: () => { normalHostAuthMissing = true; normalTransport?.refuseProfileAuth(); },
        ownerPortRequests, setCurrentLogging: enabled => { selection.operator.policy.loggingEnabled = enabled; },
        waitUntil: native.waitUntil.bind(native),
        installationCapability: new OperatorInstalledDispatcherCapability({ props: {} } as unknown as ExecutionContext,
          environment as unknown as ConstructorParameters<typeof OperatorInstalledDispatcherCapability>[1]),
        sdkPatchSetDigest: sdkProvenance?.patchSetDigest ?? null, sdkHeader: value => { sdkHeader = value; },
        statusFault: fault => { statusFault = fault; },
        admissionFault: fault => { admissionFault = fault; },
        afterBundleRead: action => { afterBundleRead = action; },
        changeRetiredPin: async field => {
          const lease = await native.storage.get<Record<string, unknown>>('dispatcher:lease');
          if (!lease) throw new Error('Fixture lease missing');
          await native.storage.put('dispatcher:lease', { ...lease, [field]: 'e'.repeat(64) });
        },
        deliverTail: async events => { if (!configuredTail) throw new Error('No configured Dispatcher tail');
          await (await configuredTail).tail(events); }, sent, childSubmissions,
        settle: (id = 'submission-1', outcome = 'completed', error?: unknown) => {
          streamBatch++;
          settlements = [{ submissionId: id, outcome, error }];
          if (id === 'submission-1' && outcome === 'completed' && !messagesSet) {
            messages = [{ submissionId: id, parts: [{ type: 'data-assessment', data: {
              repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
              assessment: { classification: 'unknown', reasons: ['No verified compatibility declaration'] },
            } }] }];
          }
        },
        input: fixtureInvocation, revokeSession: () => { callerSessionCurrent = false; },
        proof, admittedTarget,
        changeProof: patch => { currentProof = patch === null ? null : { ...currentProof, ...patch }; },
        changeRegistration: patch => { currentRegistration = patch === null ? null : { ...currentRegistration!, ...patch }; },
        changeTarget: patch => { targetPatch = { ...targetPatch, ...patch }; },
        afterTargetRead: action => { afterTargetRead = action; },
        afterRegistryResolve: action => { afterRegistryResolve = action; },
        changeInferenceAuthority: field => {
          if (field === 'route') callerRoute = 'replacement';
          else if (field === 'installation') selection.installation.revision++;
          else selection.release.bundleDigest = 'e'.repeat(64);
        },
        loseAllocationAcknowledgement: afterCommit => {
          const transaction = native.storage.transaction.bind(native.storage);
          let lost = false;
          vi.spyOn(native.storage, 'transaction').mockImplementation(async callback => {
            const outcome = await transaction(callback);
            // Storage-fault injection after the atomic successor reservation commits,
            // not an assertion about calls or a substitute journal implementation.
            const allocated = outcome as { kind?: string; attempt?: { index: number } } | undefined;
            if (!lost && allocated?.kind === 'ready' && allocated.attempt?.index === 2) {
              lost = true; await afterCommit?.(); throw new Error('Fixture lost storage acknowledgement');
            }
            return outcome;
          });
        },
        revokeGrant: () => { selection.operator.invokers.users = []; },
        messages: value => { streamBatch++; messages = value; messagesSet = true; },
        sourceBody: value => { sourceBody = value; },
        files: value => { changedFiles = value; }, compose: value => { composeBodies = value; },
        release: (value, status = 200) => { releaseBody = value; releaseStatus = status; },
        guide: value => { guideBody = value; }, tag: value => { tagRef = value; },
        annotatedTag: value => { annotatedTag = value; },
        moveHeadAfterFiles: () => { moveAfterFiles = true; },
        moveHeadAfterRelease: () => { moveAfterRelease = true; },
        expireAfterRead: () => { expireAfterRead = true; },
        moveBaseAfterContents: () => { moveAfterContents = true; },
        exceedComposeDeadline: () => { composeElapsed = true; },
        moveBaseAfterGuide: () => { moveBaseAfterGuide = true; },
        exceedReleaseDeadline: () => { exceedDeadline = true; },
        exceedGuideDeadline: () => { exceedDeadline = true; },
        expire: () => { vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1); },
        advanceClock: milliseconds => { vi.spyOn(Date, 'now').mockReturnValue(now + milliseconds); },
        revoke: () => { revoked = true; },
        abortStatus: () => aborted, restart: () => (activity = new OperatorActivity(context, activityEnvironment)),
        drainBackground,
        readRemoteMerge: () => structuredClone(remoteMerge),
        mutateEvidence: change => change(native.storage),
        // Retain only the name; acquire the I/O stub in the current caller's context.
        inOwnContext: action => runInDurableObject(namespace.getByName(objectName), () => action()),
        readRemoteComments: async () => {
          // Independent remote readback: bypass the Activity journal/capability so a
          // cached parent response cannot conceal duplicate repository effects.
          const remote = (native as unknown as { exports: {
            GitHubInterceptor: (options: { props: { bucket: string } }) => Fetcher;
          } }).exports.GitHubInterceptor({ props: { bucket: 'owner-bucket' } });
          const repository = (fixtureInvocation as { repository: string }).repository;
          return (await remote.fetch(new Request(`https://${options.githubApiHost ?? 'api.github.com'}/repos/${repository}/issues/17/comments`))).json();
        },
        seedHistoricalAdmitting: async () => {
          // Controlled historical snapshot setup, not an oracle. Normal unkeyed transport
          // failure fences before returning, so represent the pre-acknowledgement crash here.
          const retained = await native.storage.get<Record<string, unknown>>('dispatcher:lease');
          if (!retained || retained.serial) throw new Error('Fixture requires an unkeyed historical lease');
          const { projection: _projection, ...lease } = retained;
          await native.storage.put('dispatcher:lease', { ...lease, status: 'admitting', submissionId: null });
        },
        loseResponse: () => { uncertain = true; },
        restoreTransport: () => { uncertain = false; transportThrows = false; },
        genericReadback: value => { genericReadback = value; },
        loaderEnv: async () => { if (!loadedEnvironment) throw new Error('Loader not started'); return loadedEnvironment; },
        loaderOutbound: async () => { if (!loadedOutbound) throw new Error('Loader not started'); return loadedOutbound; },
        throwTransport: () => { transportThrows = true; },
        emptyResponse: () => { emptyResponse = true; },
        upstreamConflict: enabled => { upstreamConflict = enabled; },
        oversizedChecks: (count = 76, outputBytes = 3000, overlap = false) => {
          oversizedChecks = { count, outputBytes, overlap };
        },
        // Persist the pre-migration aggregate and response blobs in real SQLite storage.
        // This is fixture setup only; recovery assertions use the public capability wire.
        seedLegacyJournal: async entries => {
          const operations: Record<string, unknown> = {};
          for (const entry of entries) {
            const operation = await parseDispatcherOperation(genericWire('source', entry.body));
            const response = entry.response === undefined ? undefined : {
              status: 200, contentType: 'application/json', body: JSON.stringify(entry.response),
            };
            operations[entry.body.operationId] = { generation: 1, ordinal: entry.ordinal, phase: entry.phase,
              requestDigest: await digest(JSON.stringify({ path: operation.path, body: operation.body })),
              request: { method: entry.body.method ?? 'GET', url: entry.body.url },
              ...(response ? { responseDigest: await digest(response.body) } : {}) };
            if (response) await native.storage.put(`dispatcher:response:${entry.body.operationId}`, response);
          }
          await native.storage.put('dispatcher:operations', operations);
        },
        nextAlarm: () => native.storage.getAlarm(),
        ownedChildReadbacks: () => [...ownedChildReadbacks],
        interruptOwnedChild: error => {
          if (!ownedRuntime?.valid) throw new Error('Fixture requires a live owned child connection');
          ownedRuntime.failure = error;
          ownedRuntime.valid = false;
        },
        failOwnedAbort: () => { failOwnedAbort = true; },
        seedCancelledReleased: async () => {
          // Historical previous-version cleanup snapshot, not an assertion oracle.
          await native.storage.transaction(async tx => {
            const admission = await tx.get<{ drive: { generation: number; status: string } }>('admission');
            const lease = await tx.get<Record<string, unknown>>('dispatcher:lease');
            if (!admission?.drive || !lease?.serial || lease.generation !== admission.drive.generation) {
              throw new Error('Fixture requires the original admitted intent4 generation');
            }
            await tx.put('admission', { ...admission, drive: {
              ...admission.drive, generation: admission.drive.generation + 1, status: 'cancel-requested',
            } });
            await tx.put('dispatcher:lease', { ...lease, status: 'unknown', sdkReleased: true });
          });
        },
      });
    } finally {
      failOwnedAbort = false;
      try { await activity.cancelDrive(); }
      finally {
        if (!options.preserveGlobalMocks) {
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
        }
        await Promise.allSettled(pending);
      }
    }
  });
}
export function diagnosticReport(body: unknown = { stage: 'fetch-rejected' }, path = '/v1/dispatcher/diagnostic', method = 'POST') {
  const url = `https://operator.internal${path}`;
  if (method === 'GET') return new Request(url, { method: 'GET' });
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
export function composeRead(operationId = 'compose-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'changed-compose', ...extra }) });
}
export function releaseRead(operationId = 'release-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'release-notes', ...extra }) });
}
export function guideRead(operationId = 'guide-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'upstream-guide', ...extra }) });
}
export function changedCompose(path: string, sha = 'd'.repeat(40)) {
  return { filename: path, status: 'modified', sha, additions: 1, deletions: 1,
    patch: '-    image: amir20/dozzle:v11.1.1\n+    image: amir20/dozzle:v11.1.2' };
}
export function composeBlob(path: string, sha: string, content: string) {
  return { path, sha, type: 'file', size: new TextEncoder().encode(content).byteLength,
    encoding: 'base64', content: btoa(content) };
}
export function dozzleFiles(before = 'v11.1.1', after = 'v11.1.2') {
  return [{ filename: 'compose.yaml', status: 'modified', additions: 1, deletions: 1,
    patch: `-    image: amir20/dozzle:${before}\n+    image: amir20/dozzle:${after}` }];
}
export function read(operationId = 'read-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'pull-request', ...extra }) });
}
export async function start(f: Parameters<Parameters<typeof fixture>[0]>[0], lifetimeMs = 25_000) {
  return driveDispatcherRuntime({ activity: f.activity, deadline: Date.now() + lifetimeMs,
    bundle: f.bundle, artifactDigest: f.artifactDigest, invocation: f.input });
}

// REQ-OPERATOR-081 public v2 wire helpers. This uses the real Activity/SQLite and
// the existing owner browser adapter, never a stubbed diagnostic-method result.
export type DiagnosticRecord = Record<string, unknown> & { kind: 'event' | 'operation'; id: string;
  sequence?: number; generation: number; boundary?: string; code?: string; outcome?: string;
  correlation?: Record<string, unknown>; capsuleId?: string };
export type DiagnosticPage = { version: number; activityId: string; capturedAt: number; consistency: string;
  binding: { generation: number; artifactDigest: string; inputDigest: string };
  highWater: { events: number | null; operations: number | null };
  health: { status: string; sdkImport: string; gaps: string[]; sdkImportReason?: 'retirement-tail-unwitnessed' };
  retention: { epoch: number | null; firstSequence: number | null; lastSequence: number | null;
    routineLimit: number; failureLimit: number; terminalLimit: number; evictedRoutine: number | null;
    droppedFailure: number | null; droppedTerminal: number | null; oversized: number | null; rejected: number | null };
  records: DiagnosticRecord[]; nextCursor: string | null; pageStatus: string; retainedStatus: string;
  sourceOrder: string; snapshotDigest?: string; partDigest?: string };
type DiagnosticSummary = Omit<DiagnosticPage, 'records' | 'nextCursor' | 'pageStatus' | 'retainedStatus' | 'sourceOrder'> & {
  capture: string; provenance: Record<string, string | null>; capabilities: Array<Record<string, string>>;
  sdkBinding: { status: string; rootDigest?: string; submissionDigest?: string; attemptDigest?: string; reason?: string };
  fence: null | { generation: number; timestamp: number; boundary: string; code: string; uncertain: boolean };
  diagnosis: { state: string; code: string; lastConfirmedId: string | null; failedId: string | null; nextCheck: string } };
export function diagnosticsBrowser(f: DispatcherFixture) {
  vi.spyOn(access, 'requireOperatorHumanContext').mockImplementation(async (_request, _env, email) => {
    // This fixture replaces JWT/principal verification, including its current-session denial.
    if (!callerSessionCurrent) throw new AppError('FORBIDDEN', 403, 'Authentication rejected');
    return { human: { subject: email === 'owner@example.test' ? 'owner' : 'foreign', email,
      issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600 }, accessJwt: 'PRIVATE_BROWSER_JWT' };
  });
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError
    ? c.json({ code: error.code }, error.statusCode as 400) : c.json({ code: 'INTERNAL_ERROR' }, 500));
  app.route('/api/operator-activities', activityRoutes);
  return (suffix = '/diagnostics/v2', email = 'owner@example.test', method = 'GET', activityId = f.activityId) =>
    app.request(`/api/operator-activities/${activityId}${suffix}`, { method, headers: {
      'cf-access-authenticated-user-email': email, 'X-Requested-With': 'XMLHttpRequest',
    } }, f.environment);
}
export async function diagnosticJson<T>(response: Response, status = 200): Promise<T> {
  // Unknown baseline v2 routes fail HERE (404 versus 200), before accessing wire fields.
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(65536);
  expect(text).not.toMatch(/PRIVATE_|private\.jwt|parent-only|fixture-incarnation|fixture-stream-incarnation/);
  return JSON.parse(text) as T;
}
export async function diagnosticSummary(f: DispatcherFixture) {
  return diagnosticJson<DiagnosticSummary>(await diagnosticsBrowser(f)());
}
export async function diagnosticTraversal(get: ReturnType<typeof diagnosticsBrowser>, route = '/diagnostics/v2/history',
  first?: DiagnosticPage) {
  const pages: DiagnosticPage[] = [];
  let page = first ?? await diagnosticJson<DiagnosticPage>(await get(route));
  const seenCursors = new Set<string>();
  for (;;) {
    expect(page).toMatchObject({ version: 2, consistency: 'stable-binding',
      sourceOrder: 'diagnostic-sequence-then-operation-storage-key' });
    expect(page.records.length).toBeLessThanOrEqual(32);
    expect(page.retainedStatus).not.toBe('unavailable');
    for (const value of Object.values(page.highWater)) expect(value === null || Number.isSafeInteger(value) && value >= 0).toBe(true);
    for (const record of page.records) {
      expect(Number.isSafeInteger(record.generation) && record.generation >= 0).toBe(true);
      if (record.kind === 'operation') {
        expect(record.id).toMatch(/^o-(0|[1-9][0-9]*)-[a-f0-9]{64}$/);
        expect(record.sequence).toBeUndefined();
      } else {
        expect(record.kind).toBe('event');
        expect(record.id).toBe(`e-${record.sequence}`);
        expect(Number.isSafeInteger(record.sequence) && record.sequence! >= 0).toBe(true);
        expect(typeof record.timestamp === 'number' && Number.isSafeInteger(record.timestamp) && record.timestamp >= 0).toBe(true);
        expect(['host', 'sdk', 'producer', 'platform', 'recorder']).toContain(record.owner);
        expect(['artifact', 'admission', 'construction', 'submission', 'scheduling', 'delivery', 'model',
          'inference-response', 'canonical-commit', 'tool', 'effect', 'recovery', 'settlement', 'continuation',
          'fence', 'release', 'platform', 'recorder']).toContain(record.boundary);
        expect(['started', 'accepted', 'applied', 'committed', 'completed', 'failed', 'recovered', 'unknown',
          'released', 'suppressed']).toContain(record.outcome);
        expect(['none', 'unclassified', 'artifact-unavailable', 'artifact-mismatch', 'admission-denied',
          'authority-expired', 'authority-denied', 'stale-drive', 'startup-failed', 'submission-failed',
          'sse-json-invalid', 'provider-failed', 'stream-failed', 'response-unusable', 'canonical-append-failed',
          'tool-failed', 'effect-unknown', 'settlement-failed', 'continuation-not-ready', 'cancelled',
          'deadline-expired', 'cleanup-failed', 'capacity-exhausted', 'recorder-unavailable',
          'platform-evidence-required']).toContain(record.code);
        expect(['observed', 'unavailable']).toContain(record.evidence);
        expect(['originating', 'catching', 'state-transition']).toContain(record.origin);
        expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(4096);
        expect(record.correlation).toEqual(expect.any(Object));
        for (const [key, value] of Object.entries(record.correlation!)) {
          expect(['logicalOrdinal', 'hostAttemptIndex', 'chargedOrdinal', 'sdkAttemptDigest', 'submissionDigest',
            'deliveryDigest', 'requestDigest', 'responseDigest', 'rootDigest', 'streamIncarnationDigest',
            'sdkBatchSequence', 'sdkProducerEpoch', 'sdkProducerSequence', 'sdkRecordIndex']).toContain(key);
          if (value !== null) {
            if (key.endsWith('Digest')) expect(value).toMatch(/^[a-f0-9]{64}$/);
            else expect(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0).toBe(true);
          }
        }
      }
    }
    pages.push(page);
    expect(pages.length).toBeLessThanOrEqual(200);
    if (page.nextCursor === null) { expect(page.pageStatus).toBe('complete'); break; }
    expect(page.pageStatus).toBe('more');
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new TextEncoder().encode(page.nextCursor).byteLength).toBeLessThanOrEqual(4096);
    expect(seenCursors.has(page.nextCursor)).toBe(false);
    seenCursors.add(page.nextCursor);
    const next = await diagnosticJson<DiagnosticPage>(await get(`${route}?cursor=${encodeURIComponent(page.nextCursor)}`));
    expect(next.binding).toEqual(page.binding);
    expect(next.highWater).toEqual(page.highWater);
    expect(next.retention.epoch).toBe(page.retention.epoch);
    page = next;
  }
  const records = pages.flatMap(page => page.records);
  expect(new Set(records.map(record => record.id)).size).toBe(records.length);
  const sequences = records.filter(record => record.kind === 'event').map(record => record.sequence!);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  const firstOperation = records.findIndex(record => record.kind === 'operation');
  if (firstOperation >= 0) expect(records.slice(firstOperation).every(record => record.kind === 'operation')).toBe(true);
  return { pages, records };
}
export async function retainedFence(f: DispatcherFixture, code: string, boundary?: string) {
  f.restart(); await f.drainBackground();
  const summary = await diagnosticSummary(f);
  expect(summary.binding).toMatchObject({ generation: 1, artifactDigest: f.artifactDigest });
  expect(summary.fence).toMatchObject({ generation: expect.any(Number), code, ...(boundary ? { boundary } : {}) });
  expect(summary.fence!.timestamp).toEqual(expect.any(Number));
  expect(summary.diagnosis.state).not.toBe('no-failure-observed');
  return summary;
}

// Test-side view of the proposed owner wire: no future production schema/type imports.
type PreparationEvent = DiagnosticRecord & { preparation?: { step: string; failureClass: string; route: string;
  byteLimit?: number; observedBytesLowerBound?: number } };
export async function preparationFailures(f: DispatcherFixture): Promise<PreparationEvent[]> {
  await f.drainBackground();
  const { records } = await diagnosticTraversal(diagnosticsBrowser(f));
  return records.filter(record => record.owner === 'host' && record.outcome === 'failed'
    && (record.boundary === 'tool' || record.boundary === 'admission'));
}
export const invalidPreparationRefusal = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'request-invalid', disposition: 'operation-local' });
};

export type FixtureDiagnosticIndex = { version: number; generation: number; artifactDigest: string; inputDigest: string;
  nextSequence: number; firstSequence: number; epoch: number; routineIds: string[]; failureIds: string[];
  terminalIds: string[]; pinnedEventIds: string[]; evictedRoutine: number; droppedFailure: number;
  droppedTerminal: number; oversized: number; rejected: number; sdkImport: string };
export const diagnosticIndexKey = 'dispatcher:diagnostics:index';
const diagnosticEventKey = (sequence: number) => `dispatcher:diagnostics:event:${String(sequence).padStart(16, '0')}`;
export async function seedDiagnosticSnapshot(f: DispatcherFixture, records: DiagnosticRecord[] = [],
  patch: Partial<FixtureDiagnosticIndex> = {}) {
  const old = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
  const binding = { generation: 1, artifactDigest: f.artifactDigest, inputDigest: old!.parent.lease!.inputDigest };
  const sequences = records.map(record => record.sequence!);
  const index: FixtureDiagnosticIndex = { version: 1, ...binding,
    nextSequence: sequences.length ? Math.max(...sequences) + 1 : 1,
    firstSequence: sequences.length ? Math.min(...sequences) : 1, epoch: 0,
    routineIds: records.map(record => record.id), failureIds: [], terminalIds: [], pinnedEventIds: [],
    evictedRoutine: 0, droppedFailure: 0, droppedTerminal: 0, oversized: 0, rejected: 0, sdkImport: 'legacy', ...patch };
  await f.mutateEvidence(async storage => {
    const admission = await storage.get<Record<string, unknown>>('admission');
    await storage.put('admission', { ...admission, diagnosticsVersion: 1 });
    for (const record of records) await storage.put(diagnosticEventKey(record.sequence!), record);
    // A complete synthetic v2 snapshot includes the same atomically initialized health
    // contract as production; a real missing health value is corruption, never legacy.
    await storage.put('dispatcher:diagnostics:health', { version: 1, captureIds: [], sdkThrough: 0,
      sdkLocalThrough: 0, sdkDropped: 0, pendingSequences: [], gaps: [] });
    await storage.put(diagnosticIndexKey, index);
  });
  return { index, binding };
}
export function maximalDiagnosticEvent(sequence: number, verifyBudget = true): DiagnosticRecord {
  const hash = 'd'.repeat(64);
  const record: DiagnosticRecord = { kind: 'event', id: `e-${sequence}`, sequence, generation: 1,
    timestamp: 1_900_000_000_000, owner: 'host', boundary: 'model', outcome: 'completed', code: 'none',
    evidence: 'observed', origin: 'state-transition', correlation: {
      logicalOrdinal: Number.MAX_SAFE_INTEGER, hostAttemptIndex: Number.MAX_SAFE_INTEGER,
      chargedOrdinal: Number.MAX_SAFE_INTEGER, sdkAttemptDigest: hash, submissionDigest: hash,
      deliveryDigest: hash, requestDigest: hash, responseDigest: hash, rootDigest: hash,
      streamIncarnationDigest: hash, sdkBatchSequence: Number.MAX_SAFE_INTEGER,
      sdkProducerEpoch: Number.MAX_SAFE_INTEGER, sdkProducerSequence: Number.MAX_SAFE_INTEGER,
      sdkRecordIndex: Number.MAX_SAFE_INTEGER,
    }, source: { package: 'codeflare', boundary: 'model', baseVersion: null, patchSetDigest: hash, status: 'partial',
      frames: Array.from({ length: 4 }, (_, index) => ({ repository: 'nikolanovoselec/codeflare', commit: bundle.sourceCommit,
        path: `src/synthetic-frame-${index}.ts`, line: 1, column: 0, kind: 'patch-boundary' })) },
    error: { kind: 'SyntaxError', publicCode: null, messageDigest: hash, stackDigest: hash,
      causes: Array.from({ length: 3 }, () => ({ kind: 'Error', messageDigest: hash, stackDigest: hash })),
      loss: ['message-truncated', 'stack-truncated', 'cause-depth'], fingerprintScope: 'bounded' },
  };
  const frames = (record.source as { frames: Array<{ path: string }> }).frames;
  let next = 0;
  while (new TextEncoder().encode(JSON.stringify(record)).byteLength < 4096) {
    frames[next++ % 4].path += 's';
  }
  // Intentional admissibility guard for the exact 4096-byte public-event budget.
  if (verifyBudget) expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBe(4096);
  return record;
}

export const denyDiagnosticWrites = async (f: DispatcherFixture) => f.mutateEvidence(async storage => {
    const denied = (key: unknown) => typeof key === 'string' ? key.startsWith('dispatcher:diagnostics:')
      : !!key && typeof key === 'object' && Object.keys(key).some(value => value.startsWith('dispatcher:diagnostics:'));
    const put = storage.put.bind(storage);
    vi.spyOn(storage, 'put').mockImplementation((async (key: string | Record<string, unknown>, value?: unknown) => {
      if (denied(key)) throw new Error('PRIVATE_OPTIONAL_RECORDER_WRITE_FAILURE');
      return put(key as string, value);
    }) as typeof storage.put);
    const transaction = storage.transaction.bind(storage);
    vi.spyOn(storage, 'transaction').mockImplementation(callback => transaction(tx => callback(new Proxy(tx, {
      get(target, property) {
        const member = Reflect.get(target, property);
        if (property === 'put') return (...args: unknown[]) => {
          if (denied(args[0])) throw new Error('PRIVATE_OPTIONAL_RECORDER_WRITE_FAILURE');
          return Reflect.apply(member, target, args);
        };
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }))));
  });

export function sourceRead(operationId: string, url: string, extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/source', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, url, ...extra }) });
}

// Instrumented production Activity/Fetcher boundary only; compiled connected acceptance is separate.
export type DispatcherFixture = Parameters<Parameters<typeof fixture>[0]>[0];
export const prospectiveRepo = 'nikolanovoselec/komodo';
export const prospectiveBase = `https://api.github.com/repos/${prospectiveRepo}`;
export const prospectiveComment = (operationId = 'admitted-comment', base = prospectiveBase) => ({ operationId,
  method: 'POST', url: `${base}/issues/17/comments`, body: JSON.stringify({ body: 'Exact admitted judgment' }) });
export const prospectiveMerge = (operationId = 'admitted-merge', base = prospectiveBase) => ({ operationId,
  method: 'PUT', url: `${base}/pulls/17/merge`, body: JSON.stringify({ sha: 'b'.repeat(40), merge_method: 'merge' }) });
export const remoteMutations = (f: DispatcherFixture) => f.sent.filter(request => request.method !== 'GET');
export async function startProspective(f: DispatcherFixture) {
  await start(f);
  expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  expect((await f.capability.fetch(genericWire('source', { operationId: 'admitted-initial-read',
    url: `${prospectiveBase}/pulls/17` }))).status).toBe(200);
}
