import { WorkerEntrypoint } from 'cloudflare:workers';
import { inferenceDiagnostic, inferenceDiagnosticWire, type InferenceDiagnosticContext, type InferencePrivateArchiveSink } from '../lib/inference-diagnostics';
import { interceptedGithubHosts } from '../github-interceptor';
import type { Env } from '../types';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup,
  observeOperatorAccessIdentity, canInvokeOperator, parseAccessGroups } from '../lib/access';
import { SETUP_KEYS } from '../lib/kv-keys';
import { getAigConfig } from '../lib/aig-config';
import { sourceResponseBytes } from './dispatcher-source-limits';
import { DEFAULT_INFERENCE_REQUEST_BYTES } from './dispatcher-inference-limits';
import { dispatcherCapacities, type DispatcherCapacityPolicy } from './dispatcher-capacity-limits';
import { resolveOperatorInference, type EligibleInference, type NativeOperatorInference } from './inference-selection';
import { createOwnerNativePiProfileReader } from './native-pi-profile';
import type { DispatcherInferenceSelection } from './dispatcher-inference-recovery';
import { z } from 'zod';
import { DispatcherRefusal } from './dispatcher-refusal';
import { openOperatorExecutionAccess, operatorDelegationSchema, type OperatorDelegation } from './execution-context';
import { parseOperatorPolicy, type OperatorPolicy } from './policy';
import { createConductorProductionCapability } from './conductor-production';
import type { OperatorRuntimePlan } from './activity';
import type { OperatorAdmissionReceipt, ManagementAdmissionReceipt } from './registry';
import { hasApplicationWorkflow } from './application-workflow';
import { applicationWriteRepositories } from './application-configuration';
import { parseOperatorManifest } from './distribution';

/** Read-only historical wire compatibility; never current application authority. */
export interface DispatcherAdmittedTarget {
  repository: string; repositoryId: number; pullRequest: number; headSha: string;
  createdAt: string; createdAfter: string; baseBranch: string;
}

const DEFAULT_DISPATCHER_BODY_BYTES = dispatcherCapacities().dispatcherRequestBytes;
const dispatcherOperationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const dispatcherSourceSchema = (limits = dispatcherCapacities()) => z.strictObject({ operationId: dispatcherOperationId,
  method: z.enum(['GET', 'POST', 'PUT']).optional(), body: z.string().refine(value => value.length <= limits.sourceRequestChars).optional(),
  url: z.string().refine(value => value.length <= limits.sourceUrlChars).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash
        && !url.port && url.hostname !== 'operator.internal';
    } catch { return false; }
  }) });
const dispatcherInferenceSchema = (limits = dispatcherCapacities()) => z.strictObject({ operationId: dispatcherOperationId,
  input: z.strictObject({
    messages: z.array(z.json()).min(1).max(limits.inferenceMessageLimit), tools: z.array(z.json()).max(limits.inferenceToolLimit).optional(),
    tool_choice: z.json().optional(), max_tokens: z.number().int().min(1).max(limits.inferenceTokenLimit).optional(),
    temperature: z.number().min(0).max(2).optional(), stream: z.boolean().optional(),
    stream_options: z.strictObject({ include_usage: z.literal(true) }).optional(),
  }) });

const dispatcherReceiptSchema = (limits = dispatcherCapacities()) => z.strictObject({ operationId: dispatcherOperationId,
  sourceResponse: z.strictObject({ generation: z.number().safe().int().positive(),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/), responseDigest: z.string().regex(/^[0-9a-f]{64}$/),
    url: dispatcherSourceSchema(limits).shape.url }).optional(),
});
// The original URL is capacity-checked in the proof; its archived canonical form
// may be longer after encoding, and is identity/byte-bounded below instead.
const retainedSourceEnvelopeSchema = z.strictObject({ url: z.string(),
  status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()).refine(headers =>
    Object.keys(headers).every(key => ['content-type', 'etag', 'last-modified', 'date', 'link', 'location'].includes(key))),
  body: z.string(),
});

/** Validate archived wire bytes, never a reason to fetch or repair missing evidence. */
export function parseRetainedDispatcherSource(body: string, url: string, byteLimit: number) {
  if (new TextEncoder().encode(body).byteLength > byteLimit) throw new Error('Retained source exceeds limit');
  const raw: unknown = JSON.parse(body);
  const value = retainedSourceEnvelopeSchema.parse(raw);
  if (value.url !== new URL(url).href) throw new Error('Retained source identity mismatch');
  // Preserve the original serialized envelope's field order for its receipt digest.
  return raw as typeof value;
}
// Structural inference-only guard while the canonical optional management field
// crosses the registry/RPC boundary. Never manufacture network/storage authority.
const dispatcherPolicyInferenceSchema = z.strictObject({
  allowedSources: z.array(z.enum(['managed', 'pi-native'])).optional(),
  routeIds: z.array(z.string()), defaultRouteId: z.string().nullable(),
  reasoningLevels: z.array(z.string()), defaultReasoningLevel: z.string().nullable(), inheritUserDefaults: z.boolean(),
});
function dispatcherInferencePolicy(policy: unknown): Pick<OperatorPolicy, 'inference'> {
  if (!policy || typeof policy !== 'object' || !('inference' in policy)) throw new Error('Dispatcher inference approval missing');
  return { inference: dispatcherPolicyInferenceSchema.parse(policy.inference) };
}
const dispatcherResolutionSchema = (limits = dispatcherCapacities()) => z.strictObject({ operationId: dispatcherOperationId,
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  readbacks: z.array(z.strictObject({ operationId: dispatcherOperationId,
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/), responseDigest: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(limits.resolutionReadbackLimit),
});

export function dispatcherGithubApiOrigin(env: Pick<Env, 'GITHUB_API_HOST'>): string {
  const host = env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error('GitHub host invalid');
  const origin = `https://${host}`;
  if (new URL(origin).hostname !== host || host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('GitHub host invalid');
  }
  return origin;
}

export type DispatcherOperation = { operationId: string; path: string; body: unknown; signal?: AbortSignal };
export type DispatcherInferenceCountObservation = {
  messages: number; tools: number | null; messageMinimum: number; messageMaximum: number;
  messageCountViolation: 'below-minimum' | 'above-maximum';
};
export type DispatcherBodyOverflowObservation = { byteLimit: number; observedBytesLowerBound: number };

/** Closed private diagnostic labels only; never export Zod paths, keys or values. */
export function dispatcherWireRules(error: z.ZodError): { wireRules: string[]; wireRulesTruncated: boolean } {
  const rules = new Set<string>();
  for (const issue of error.issues) {
    const [field, option] = issue.path;
    if (field === 'operationId') rules.add('operation-id');
    else if (field === 'input') {
      if (option === 'messages' || option === 'tools') {
        const bound = issue.code === 'too_big' || issue.code === 'too_small';
        rules.add(option === 'messages' ? (bound ? 'inference-messages-count' : 'inference-messages-shape')
          : (bound ? 'inference-tools-count' : 'inference-tools-shape'));
      } else if (option === 'max_tokens') {
        rules.add(issue.code === 'too_big' || issue.code === 'too_small' ? 'inference-token-bound' : 'inference-token-shape');
      } else if (option === 'temperature') rules.add('inference-temperature');
      else if (option === 'stream') rules.add('inference-stream');
      else if (option === 'stream_options') rules.add('inference-stream-options');
      else if (issue.code === 'unrecognized_keys') {
        if (issue.keys.includes('max_completion_tokens')) rules.add('inference-max-completion-tokens');
        if (issue.keys.some(key => key !== 'max_completion_tokens')) rules.add('inference-unsupported-field');
      } else rules.add('inference-input');
    } else rules.add('envelope-field');
    if (rules.size > 4) break;
  }
  return { wireRules: [...rules].slice(0, 4), wireRulesTruncated: rules.size > 4 };
}

/** Bounded transport wire; source reads select a URL, never credentials, identity or transport. */
export async function parseDispatcherOperation(request: Request, inferenceByteLimit = DEFAULT_INFERENCE_REQUEST_BYTES,
  capacityPolicy?: DispatcherCapacityPolicy,
  onInferenceCountRejected?: (value: DispatcherInferenceCountObservation) => void,
  onBodyLimitExceeded?: (value: DispatcherBodyOverflowObservation) => void): Promise<DispatcherOperation> {
  const limits = dispatcherCapacities(capacityPolicy);
  const url = new URL(request.url);
  if (url.origin !== 'https://operator.internal' || url.search || url.hash || request.method !== 'POST'
    || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('Dispatcher request denied');
  const value: unknown = JSON.parse(await readDispatcherBody(request, request.signal,
    url.pathname === '/v1/dispatcher/inference' ? inferenceByteLimit : limits.dispatcherRequestBytes, onBodyLimitExceeded));
  const schema = url.pathname === '/v1/dispatcher/inference' ? dispatcherInferenceSchema(limits)
    : url.pathname === '/v1/dispatcher/source' ? dispatcherSourceSchema(limits)
    : url.pathname === '/v1/dispatcher/receipt' ? dispatcherReceiptSchema(limits)
    : url.pathname === '/v1/dispatcher/resolve' ? dispatcherResolutionSchema(limits) : null;
  if (!schema) throw new Error('Dispatcher route denied');
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Structural counts from the already bounded parse only; never reread the body
    // or retain request values. Diagnostics cannot replace the original Zod denial.
    if (onInferenceCountRejected && url.pathname === '/v1/dispatcher/inference'
      && value && typeof value === 'object' && !Array.isArray(value) && 'input' in value) {
      const input = value.input;
      if (input && typeof input === 'object' && !Array.isArray(input) && 'messages' in input
        && Array.isArray(input.messages)) {
        const messages = input.messages.length;
        if (messages < 1 || messages > limits.inferenceMessageLimit) {
          try { onInferenceCountRejected({ messages,
            tools: 'tools' in input && Array.isArray(input.tools) ? input.tools.length : null,
            messageMinimum: 1, messageMaximum: limits.inferenceMessageLimit,
            messageCountViolation: messages < 1 ? 'below-minimum' : 'above-maximum' }); }
          catch { /* Best-effort observation does not change validation or authority. */ }
        }
      }
    }
    throw parsed.error;
  }
  const body = parsed.data;
  if (url.pathname === '/v1/dispatcher/source') {
    const source = dispatcherSourceSchema(limits).parse(body);
    if ((source.method ?? 'GET') === 'GET' && source.body !== undefined) throw new Error('GET body denied');
    if ((source.method ?? 'GET') !== 'GET' && source.body === undefined) throw new Error('Mutation body required');
  }
  return { operationId: body.operationId, path: url.pathname, body, signal: request.signal };
}

/** Primitive body bound; approved inference requests and source responses supply their independent limits. */
export async function readDispatcherBody(message: Request | Response, signal?: AbortSignal,
  byteLimit = DEFAULT_DISPATCHER_BODY_BYTES,
  onLimitExceeded?: (value: DispatcherBodyOverflowObservation) => void): Promise<string> {
  if (!message.body) throw new Error('Dispatcher body unavailable');
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const decode = (bytes?: Uint8Array, stream = false) => {
    try { return decoder.decode(bytes, { stream }); }
    catch { throw new Error('Dispatcher body encoding invalid'); }
  };
  let size = 0;
  let value = '';
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (chunk.done) return value + decode();
      size += chunk.value.byteLength;
      if (size > byteLimit) {
        const error = new Error('Dispatcher body exceeds limit');
        try { onLimitExceeded?.({ byteLimit, observedBytesLowerBound: size }); }
        catch { /* Optional observation cannot replace the original reader failure. */ }
        throw error;
      }
      value += decode(chunk.value, true);
    }
  } finally { signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Local closed failure: absence of current evidence is not observed revocation. */
export class DispatcherAuthorityUnavailable extends Error {
  constructor() { super('Dispatcher authority unavailable'); }
}

/** Current management authority is re-opened for each effect; receipt pins are never refreshed. */
export async function authorizeDispatcherPlan(plan: OperatorRuntimePlan, env: Env) {
  if (!isManagementReceipt(plan.receipt) || plan.receipt.selection.operator.profile !== 'dispatcher'
    || plan.deadline <= Date.now() || !env.OPERATOR_REGISTRY) throw new Error('Dispatcher authority denied');
  const pinned = plan.receipt.selection;
  const selected = await env.OPERATOR_REGISTRY.getByName('registry').resolveManagementExecution(pinned.installation.id);
  if (!selected.ok || selected.value.installation.revision !== pinned.installation.revision
    || selected.value.operator.revision !== pinned.operator.revision
    || selected.value.controlsRevision !== pinned.controlsRevision
    || selected.value.release.id !== pinned.release.id
    || selected.value.release.bundleDigest !== pinned.release.bundleDigest
    || selected.value.manifestJson !== pinned.manifestJson
    || selected.value.installation.configurationJson !== pinned.installation.configurationJson
    || selected.value.operator.id !== pinned.operator.id
    || selected.value.operator.repositoryId !== pinned.operator.repositoryId
    || selected.value.operator.profile !== 'dispatcher') throw new Error('Dispatcher installation changed');
  const authority = await openOperatorExecutionAccess(plan.executionContext, env);
  let human = authority.human;
  // Public input is immutable opaque application data, never a source of authority.
  const parent: unknown = JSON.parse(plan.invocationJson);
  if (pinned.installation.policy.resourceProfileId !== null) throw new DispatcherRefusal('policy-denied', 'Dispatcher resource profile unavailable');
  const application = hasApplicationWorkflow(pinned.manifestJson);
  let delegation: OperatorDelegation | undefined;
  if (application && authority.delegation) {
    delegation = operatorDelegationSchema.parse(authority.delegation);
    // Delegation preserves the original expiry, not a revoked administrator role.
    const stored = await env.KV.get(`user:${human.email.trim().toLowerCase()}`);
    const user: unknown = stored ? JSON.parse(stored) : null;
    if (!user || typeof user !== 'object' || !('role' in user) || user.role !== 'admin'
      || !Array.isArray(human.groups)) throw new Error('Dispatcher delegation revoked');
  } else {
    // Historical automatic records have no sealed generic delegation. Do not
    // synthesize one, consult deleted business helpers, or renew their authority.
    if (plan.prospectiveAdmissionId) throw new Error('Legacy Dispatcher admission retired');
    const observed = await observeOperatorAccessIdentity(human, authority.accessJwt);
    if (observed.status === 'unavailable') throw new DispatcherAuthorityUnavailable();
    if (observed.status !== 'current') throw new Error('Dispatcher authority denied');
    human = { ...human, groups: observed.groups };
  }
  const admittedTarget: DispatcherAdmittedTarget | undefined = undefined;
  if (human.expiresAt * 1000 <= Date.now() || plan.deadline <= Date.now()
    || !canInvokeOperator(human, selected.value.operator)) throw new Error('Dispatcher invoker denied');
  return { authority: { ...authority, human }, delegation, parent, policy: pinned.installation.policy, admittedTarget,
    inferencePolicies: [pinned.installation.policy, pinned.operator.policy,
      selected.value.installation.policy, selected.value.operator.policy] };
}

/** Captured labels confer membership only in the CURRENT configured routing groups.
 * Callers pass a fresh trusted authorization, never plan/package metadata. */
export async function dispatcherRoutingGroups(authorization: Awaited<ReturnType<typeof authorizeDispatcherPlan>>, env: Env): Promise<string[]> {
  const delegation = authorization.delegation;
  if (delegation) {
    const configured = parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
    return configured.filter(group => delegation.routingGroups.includes(group));
  }
  return resolveSessionAccessGroup(new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': authorization.authority.accessJwt },
  }), env);
}

/** Current owner/source authority for Dispatcher native bootstrap and every later binding/send.
 * Management policies expose inference only when explicitly installed; legacy omission denies native.
 */
export async function prepareDispatcherNative(input: { plan: OperatorRuntimePlan; env: Env;
  selection?: NativeOperatorInference; current(): Promise<boolean>; signal?: AbortSignal }) {
  const { plan, env } = input;
  if (!isManagementReceipt(plan.receipt)) throw new Error('Dispatcher native authority denied');
  const pinned = plan.receipt.selection;
  let ownerBucket: string | undefined;
  const authorize = async (selection?: NativeOperatorInference) => {
    if (input.signal?.aborted || !await input.current()) throw new Error('Dispatcher native generation changed');
    const authorization = await authorizeDispatcherPlan(plan, env);
    const { authority, delegation } = authorization;
    if (!env.OPERATOR_REGISTRY) throw new Error('Dispatcher native authority denied');
    const selected = await env.OPERATOR_REGISTRY.getByName('registry').resolveManagementExecution(pinned.installation.id);
    if (!selected.ok || selected.value.installation.revision !== pinned.installation.revision
      || selected.value.operator.revision !== pinned.operator.revision
      || selected.value.controlsRevision !== pinned.controlsRevision
      || selected.value.release.id !== pinned.release.id
      || selected.value.release.bundleDigest !== pinned.release.bundleDigest
      || selected.value.manifestJson !== pinned.manifestJson
      || selected.value.installation.configurationJson !== pinned.installation.configurationJson
      || selected.value.operator.id !== pinned.operator.id
      || selected.value.operator.repositoryId !== pinned.operator.repositoryId) throw new Error('Dispatcher native installation changed');
    const groups = await dispatcherRoutingGroups(authorization, env);
    const routes = await loadEnterpriseRouteConfig(env, groups);
    const personal = { piDefaultSource: routes.piDefaultSource, allowPersonalPiProviders: routes.allowPersonalPiProviders };
    if (!selection && !input.selection && personal.piDefaultSource !== 'pi-native') return { native: false as const };
    if (!delegation) {
      const identity = await observeOperatorAccessIdentity(authority.human, authority.accessJwt);
      if (identity.status === 'unavailable') throw new DispatcherAuthorityUnavailable();
      if (identity.status !== 'current') throw new Error('Dispatcher native session expired');
    }
    if (!personal.allowPersonalPiProviders) throw new Error('Dispatcher native permission denied');
    const bucket = await resolveBucketName(env, authority.human.email);
    if (ownerBucket !== undefined && ownerBucket !== bucket) throw new Error('Dispatcher native owner changed');
    ownerBucket = bucket;
    for (const policy of [pinned.installation.policy, pinned.operator.policy,
      selected.value.installation.policy, selected.value.operator.policy]) {
      if (!policy.capabilities.includes('inference')) throw new Error('Dispatcher inference grant denied');
      const parsed = dispatcherInferencePolicy(policy);
      if (!parsed.inference.allowedSources?.includes('pi-native')) throw new Error('Dispatcher native source denied');
      if (selection) resolveOperatorInference({ policy: parsed, trusted: selection, eligible: {
        routeIds: [], defaultRouteId: '', defaultReasoningLevel: '', allowPersonalPiProviders: personal.allowPersonalPiProviders } });
    }
    if (delegation) await authorizeDispatcherPlan(plan, env);
    if (input.signal?.aborted || !await input.current()) throw new Error('Dispatcher native generation changed');
    return { native: true as const };
  };
  if (!(await authorize(input.selection)).native) return undefined;
  const reader = await createOwnerNativePiProfileReader({ env, ownerBucket: ownerBucket!, deadline: plan.deadline,
    signal: input.signal, authorize: async () => { await authorize(input.selection); } });
  // New Dispatcher selections inherit owner R2 reasoning. Existing selections remain pinned;
  // the generic reader's installation override is retained for unrelated profiles.
  const selection = input.selection ?? await reader.resolveSelection(
    pinned.operator.profile === 'dispatcher' ? undefined : pinned.installation.piReasoningOverride);
  await authorize(selection);
  return { selection, bind: async () => {
    await authorize(selection);
    const bound = await reader.bind(selection);
    await authorize(selection);
    return bound;
  } };
}

/** Parent-only composition with the existing credential-injecting interceptors, never direct upstream fetch. */
export async function createDispatcherOperation(input: {
  plan: OperatorRuntimePlan; env: Env; exports: Record<string, (options: { props: Record<string, unknown> }) => Fetcher>;
  operation: DispatcherOperation; current: () => Promise<boolean>;
  diagnosticContext?: InferenceDiagnosticContext;
  /** Native capability injected by the Worker owner; never constructed by Node-bundled code. */
  privateArchiveSink?: InferencePrivateArchiveSink;
  pinInferenceSelection?: (selection: DispatcherInferenceSelection) => Promise<void>;
}): Promise<() => Promise<Response>> {
  const { plan, env, operation } = input;
  const limits = dispatcherCapacities(isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined);
  const authorization = await authorizeDispatcherPlan(plan, env);
  const { authority, policy: installationPolicy, inferencePolicies } = authorization;
  const current = async () => {
    const latest = await authorizeDispatcherPlan(plan, env);
    if (!await input.current()) throw new DispatcherRefusal('execution-inactive', 'Dispatcher generation changed');
    return latest;
  };
  const inference = operation.path === '/v1/dispatcher/inference';
  if (!installationPolicy.capabilities.includes(inference ? 'inference' : 'fetch')) throw new DispatcherRefusal('policy-denied', 'Dispatcher capability denied');
  if (operation.path === '/v1/dispatcher/source') {
    const sourceCurrent = async () => {
      if (operation.signal?.aborted) throw new DispatcherRefusal('execution-inactive', 'Dispatcher caller cancelled');
      const latest = await current();
      if (latest.delegation) return;
      const identity = await observeOperatorAccessIdentity(latest.authority.human, latest.authority.accessJwt);
      if (identity.status === 'unavailable') throw new DispatcherAuthorityUnavailable();
      if (identity.status !== 'current') {
        throw new DispatcherRefusal('authority-unverified', 'Dispatcher caller session expired');
      }
    };
    await sourceCurrent();
    const source = dispatcherSourceSchema(limits).parse(operation.body);
    const responseBytes = sourceResponseBytes(installationPolicy);
    const url = new URL(source.url);
    const method = source.method ?? 'GET';
    const github = interceptedGithubHosts(env).includes(url.hostname);
    if (method !== 'GET') {
      if (!github || url.origin !== dispatcherGithubApiOrigin(env) || !isManagementReceipt(plan.receipt)) {
        throw new DispatcherRefusal('policy-denied', 'Mutation transport denied');
      }
      const { selection } = plan.receipt;
      const definition = parseOperatorManifest(selection.manifestJson, 'https://operator.invalid/').application;
      const repositories = applicationWriteRepositories(definition, JSON.parse(selection.installation.configurationJson));
      const path = url.pathname.toLowerCase();
      if (url.search || !repositories.some(repository => path.startsWith(`/repos/${repository}/`))) {
        throw new DispatcherRefusal('policy-denied', 'Mutation resource denied');
      }
    }
    const entrypoint = github ? input.exports.GitHubInterceptor : input.exports.EgressController;
    if (!entrypoint) throw new DispatcherRefusal('operation-failed', 'Dispatcher source transport unavailable');
    const bucket = await resolveBucketName(env, authority.human.email);
    // Managed installations grant capabilities, not a manufactured legacy OperatorPolicy.
    // No resource credentials or account-scoped Gateway exemption are granted by fetch.
    const transport = entrypoint({ props: github
      ? { user: authority.human.email, bucket, strict: true }
      : { bucket, strict: true } });
    const diagnosticContext = input.diagnosticContext ? { ...input.diagnosticContext,
      credentials: [...(input.diagnosticContext.credentials ?? []), authority.accessJwt] } : undefined;
    return async () => {
      await sourceCurrent();
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(limits.sourceTimeoutMs, plan.deadline - Date.now())));
      const signal = operation.signal ? AbortSignal.any([timeout, operation.signal]) : timeout;
      const fetchBegan = performance.now();
      inferenceDiagnostic(diagnosticContext, { stage: 'source-fetch', outcome: 'started', resource: 'source' }, () => ({ url: url.href, method, body: source.body }));
      let response: Response;
      try {
        response = await transport.fetch(new Request(url, { method, body: source.body, redirect: 'manual', signal,
          headers: { accept: 'application/json, text/plain, text/html', 'user-agent': 'Codeflare-Operator-Dispatcher',
            ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) } }));
      } catch (error) {
        inferenceDiagnostic(diagnosticContext, { stage: 'source-fetch', outcome: 'failed', failureClass: 'source-fetch', elapsedMs: performance.now() - fetchBegan }, () => error);
        await sourceCurrent();
        if (method !== 'GET') throw new Error('Mutation response unknown');
        return Response.json({ code: 'OPERATOR_SOURCE_UNAVAILABLE' }, { status: 422 });
      }
      inferenceDiagnostic(input.diagnosticContext, { stage: 'source-fetch', outcome: 'completed', sourceStatus: response.status, elapsedMs: performance.now() - fetchBegan });
      let body: string;
      try { body = response.body ? await readDispatcherBody(response, signal, responseBytes) : ''; }
      catch (error) {
        inferenceDiagnostic(diagnosticContext, { stage: 'source-read', outcome: signal.aborted ? 'canceled' : 'failed', failureClass: 'source-read', sourceStatus: response.status }, () => error);
        await sourceCurrent();
        if (method !== 'GET') throw new Error('Mutation body unknown');
        return Response.json({ code: 'OPERATOR_SOURCE_INCOMPLETE' }, { status: 422 });
      }
      inferenceDiagnostic(diagnosticContext, { stage: 'source-read', outcome: 'completed', sourceStatus: response.status },
        () => ({ status: response.status, headers: response.headers, body }));
      await sourceCurrent();
      if (method !== 'GET' && (signal.aborted || response.status >= 500
        || response.status === 408 || (response.status >= 300 && response.status < 400))) {
        throw new Error('Mutation outcome unknown');
      }
      if (signal.aborted) return Response.json({ code: 'OPERATOR_SOURCE_UNAVAILABLE' }, { status: 422 });
      // Only response metadata needed for provenance, paging and explicit redirects crosses the boundary.
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'etag', 'last-modified', 'date', 'link', 'location']) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      inferenceDiagnostic(input.diagnosticContext, { stage: 'source-read', outcome: 'completed', sourceStatus: response.status, responseBytes: new TextEncoder().encode(body).byteLength, elapsedMs: performance.now() - fetchBegan });
      const envelope = JSON.stringify({ url: url.href, status: response.status, headers, body });
      if (envelope.includes(authority.accessJwt)) {
        inferenceDiagnostic(input.diagnosticContext, { stage: 'source-read', outcome: 'failed', failureClass: 'source-reflection' });
        if (method !== 'GET') throw new Error('Mutation receipt unavailable');
        return Response.json({ code: 'OPERATOR_SOURCE_CREDENTIAL_REFLECTION' }, { status: 422 });
      }
      if (new TextEncoder().encode(envelope).byteLength > responseBytes) {
        inferenceDiagnostic(input.diagnosticContext, { stage: 'source-read', outcome: 'failed', failureClass: 'source-envelope' });
        if (method !== 'GET') throw new Error('Mutation receipt incomplete');
        return Response.json({ code: 'OPERATOR_SOURCE_INCOMPLETE' }, { status: 422 });
      }
      return new Response(envelope, { headers: { 'content-type': 'application/json' } });
    };
  }
  // Domain-specific read/comment/merge endpoints are retired, not a second
  // live application implementation. Approved HTTP and inference remain generic.
  if (!inference) throw new DispatcherRefusal('request-invalid', 'Dispatcher route retired');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [], methods: ['GET'] }, storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
  if (inference) {
    if (!input.exports.LlmInterceptor) throw new DispatcherRefusal('operation-failed', 'LLM interceptor unavailable');
    let groups = await dispatcherRoutingGroups(authorization, env);
    const routes = await loadEnterpriseRouteConfig(env, groups);
    // Only the current human default is selected; a child cannot widen or replace it.
    policy.inference = { routeIds: [routes.defaultRoute], defaultRouteId: routes.defaultRoute,
      reasoningLevels: [routes.defaultReasoning], defaultReasoningLevel: routes.defaultReasoning, inheritUserDefaults: false };
    const trusted = resolveOperatorInference({ policy, eligible: { routeIds: routes.routeCatalog,
      defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning } });
    const enforcePolicies = (policies: typeof inferencePolicies, eligible: EligibleInference) => {
      for (const installed of policies) {
        // Legacy omission permits managed inference only; explicit restrictions all intersect.
        if (installed.inference) {
          resolveOperatorInference({ policy: dispatcherInferencePolicy(installed), eligible, trusted });
        }
      }
    };
    enforcePolicies(inferencePolicies, { routeIds: routes.routeCatalog,
      defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning });
    await input.pinInferenceSelection?.({ routeId: trusted.routeId, reasoningLevel: trusted.reasoningLevel });
    const aig = await getAigConfig(env);
    const value = dispatcherInferenceSchema(limits).parse(operation.body);
    return async () => {
      await current();
      const latestAuthority = await authorizeDispatcherPlan(plan, env);
      groups = await dispatcherRoutingGroups(latestAuthority, env);
      const latest = await loadEnterpriseRouteConfig(env, groups);
      resolveOperatorInference({ policy, trusted, eligible: { routeIds: latest.routeCatalog,
        defaultRouteId: latest.defaultRoute, defaultReasoningLevel: latest.defaultReasoning } });
      enforcePolicies(latestAuthority.inferencePolicies, { routeIds: latest.routeCatalog,
        defaultRouteId: latest.defaultRoute, defaultReasoningLevel: latest.defaultReasoning });
      if (input.pinInferenceSelection) {
        if (latest.defaultRoute !== trusted.routeId
          || latest.defaultReasoning !== trusted.reasoningLevel) throw new Error('Dispatcher inference route changed');
        await input.pinInferenceSelection({ routeId: trusted.routeId, reasoningLevel: trusted.reasoningLevel });
      }
      inferenceDiagnostic(input.diagnosticContext, { stage: 'authority', outcome: 'completed', resource: 'inference', messages: value.input.messages.length, tools: value.input.tools?.length ?? 0 });
      const transport = input.exports.LlmInterceptor({ props: { user: authority.human.email, groups,
        // Stable owner-scoped native replay, with the now-reserved parent ordinal.
        sessionId: plan.activityId,
        gatewayUrl: aig.gatewayUrl, gatewayId: aig.gatewayId, token: aig.token,
        operatorInference: { activityId: plan.activityId, operatorId: plan.executionContext.operatorId, policy, trusted,
          diagnosticContext: inferenceDiagnosticWire(input.diagnosticContext, input.privateArchiveSink) } } });
      return await transport.fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: operation.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...value.input,
          max_tokens: value.input.max_tokens ?? limits.inferenceDefaultTokens, model: trusted.routeId, stream: value.input.stream ?? true }) }));
    };
  }
  throw new DispatcherRefusal('request-invalid', 'Dispatcher route retired');
}

interface OperatorRuntimeCapabilityProps { activityId: string; generation: number; driveDeadline?: number }

function isManagementReceipt(receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt): receipt is ManagementAdmissionReceipt {
  return 'selection' in receipt;
}

function deniedCapability(activityId: string, generation: number): Response {
  return new Response(JSON.stringify({ error: 'Capability unavailable',
    code: 'OPERATOR_CAPABILITY_DENIED', activityId, generation }), {
    status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Platform loopback service binding supplied to each dynamically loaded operator Worker. */
export class OperatorRuntimeCapability extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props?: OperatorRuntimeCapabilityProps }).props;
    if (!props || !/^[A-Za-z0-9_-]{1,128}$/.test(props.activityId)
      || !Number.isSafeInteger(props.generation) || props.generation < 1
      || !this.env.OPERATOR_ACTIVITY) {
      return deniedCapability('', 0);
    }
    const activity = this.env.OPERATOR_ACTIVITY.getByName(props.activityId);
    const plan = await activity.getRuntimePlan() as OperatorRuntimePlan | null;
    if (!plan || plan.activityId !== props.activityId) {
      return deniedCapability(props.activityId, props.generation);
    }
    if (isManagementReceipt(plan.receipt) && plan.receipt.selection.operator.profile === 'conductor') {
      try {
        const connected = await createConductorProductionCapability({ env: this.env, plan, activity,
          generation: props.generation, driveDeadline: props.driveDeadline ?? 0 });
        return connected.capability.fetch(request);
      } catch { return deniedCapability(props.activityId, props.generation); }
    }
    return deniedCapability(props.activityId, props.generation);
  }
}
