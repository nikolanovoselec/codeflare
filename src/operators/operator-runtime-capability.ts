import { parseRenovateRunSettings, renovateRepositoryIdentity } from './renovate-run-settings';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { inferenceDiagnostic, type InferenceDiagnosticContext } from '../lib/inference-diagnostics';
import { interceptedGithubHosts } from '../github-interceptor';
import type { Env } from '../types';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup,
  resolveOperatorGroupIdentity, canInvokeOperator, operatorAccessSessionCurrent } from '../lib/access';
import { getAigConfig } from '../lib/aig-config';
import { sourceResponseBytes } from './dispatcher-source-limits';
import { DEFAULT_INFERENCE_REQUEST_BYTES } from './dispatcher-inference-limits';
import { dispatcherCapacities, type DispatcherCapacityPolicy } from './dispatcher-capacity-limits';
import { resolveOperatorInference } from './inference-selection';
import type { DispatcherInferenceSelection } from './dispatcher-inference-recovery';
import { z } from 'zod';
import { discoverRenovatePulls, eligibleRenovatePull, renovateGithub, executeRenovateDecision } from './renovate-publication';
import { openOperatorExecutionAccess } from './execution-context';
import { operatorOwnerKey } from './browser-activity';
import { parseOperatorPolicy } from './policy';
import { projectChangedCompose, projectDispatcherFiles } from './dispatcher-compose-projection';
import { createConductorProductionCapability } from './conductor-production';
import type { OperatorRuntimePlan } from './activity';
import { prospectiveRenovatePackageSupported, prospectiveRenovateTimestamp,
  type OperatorAdmissionReceipt, type ManagementAdmissionReceipt } from './registry';

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
const dispatcherTargetSchema = z.strictObject({ pullRequest: z.number().safe().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/) });
const dispatcherReadSchema = z.strictObject({ operationId: dispatcherOperationId,
  resource: z.enum(['pull-request', 'files', 'checks', 'release-notes', 'upstream-guide', 'changed-compose', 'open-pull-requests']),
  target: dispatcherTargetSchema.optional(),
  pullRequest: z.number().safe().int().positive().optional(), headSha: z.string().regex(/^[0-9a-f]{40}$/).optional() });
const dispatcherCommentSchema = (limits = dispatcherCapacities()) => z.strictObject({ operationId: dispatcherOperationId,
  target: dispatcherTargetSchema, decision: z.enum(['MERGE', 'DO_NOT_MERGE']),
  comment: z.string().min(1).refine(value => value.length <= limits.commentChars).refine(value => value.trim().length > 0) });
const dispatcherMergeSchema = (limits = dispatcherCapacities()) => dispatcherCommentSchema(limits).extend({ decision: z.literal('MERGE') });
const dispatcherInferenceSchema = (limits = dispatcherCapacities()) => z.strictObject({ operationId: dispatcherOperationId,
  input: z.strictObject({
    messages: z.array(z.json()).min(1).max(limits.inferenceMessageLimit), tools: z.array(z.json()).max(limits.inferenceToolLimit).optional(),
    tool_choice: z.json().optional(), max_tokens: z.number().int().min(1).max(limits.inferenceTokenLimit).optional(),
    temperature: z.number().min(0).max(2).optional(), stream: z.boolean().optional(),
    stream_options: z.strictObject({ include_usage: z.literal(true) }).optional(),
  }) });

const dispatcherReceiptSchema = z.strictObject({ operationId: dispatcherOperationId });
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
  capacityPolicy?: DispatcherCapacityPolicy): Promise<DispatcherOperation> {
  const limits = dispatcherCapacities(capacityPolicy);
  const url = new URL(request.url);
  if (url.origin !== 'https://operator.internal' || url.search || url.hash || request.method !== 'POST'
    || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('Dispatcher request denied');
  const value = JSON.parse(await readDispatcherBody(request, request.signal,
    url.pathname === '/v1/dispatcher/inference' ? inferenceByteLimit : limits.dispatcherRequestBytes));
  const schema = url.pathname === '/v1/dispatcher/github/read' ? dispatcherReadSchema
    : url.pathname === '/v1/dispatcher/github/comment' ? dispatcherCommentSchema(limits)
    : url.pathname === '/v1/dispatcher/github/merge' ? dispatcherMergeSchema(limits)
    : url.pathname === '/v1/dispatcher/inference' ? dispatcherInferenceSchema(limits)
    : url.pathname === '/v1/dispatcher/source' ? dispatcherSourceSchema(limits)
    : url.pathname === '/v1/dispatcher/receipt' ? dispatcherReceiptSchema
    : url.pathname === '/v1/dispatcher/resolve' ? dispatcherResolutionSchema(limits) : null;
  if (!schema) throw new Error('Dispatcher route denied');
  const body = schema.parse(value);
  if (url.pathname === '/v1/dispatcher/source') {
    const source = dispatcherSourceSchema(limits).parse(body);
    if ((source.method ?? 'GET') === 'GET' && source.body !== undefined) throw new Error('GET body denied');
    if ((source.method ?? 'GET') !== 'GET' && source.body === undefined) throw new Error('Mutation body required');
  }
  return { operationId: body.operationId, path: url.pathname, body, signal: request.signal };
}

/** Primitive body bound; approved inference requests and source responses supply their independent limits. */
export async function readDispatcherBody(message: Request | Response, signal?: AbortSignal,
  byteLimit = DEFAULT_DISPATCHER_BODY_BYTES): Promise<string> {
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
      if (size > byteLimit) throw new Error('Dispatcher body exceeds limit');
      value += decode(chunk.value, true);
    }
  } finally { signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
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
    || selected.value.release.bundleDigest !== pinned.release.bundleDigest
    || selected.value.operator.profile !== 'dispatcher') throw new Error('Dispatcher installation changed');
  const authority = await openOperatorExecutionAccess(plan.executionContext, env);
  const human = await resolveOperatorGroupIdentity(authority.human, authority.accessJwt);
  if (!canInvokeOperator(human, selected.value.operator)) throw new Error('Dispatcher invoker denied');
  const parent = z.strictObject({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pullRequest: z.number().safe().int().positive().optional() }).parse(JSON.parse(plan.invocationJson));
  // No resource resolver is introduced: only the direct read/inference profile is supported.
  if (pinned.installation.policy.resourceProfileId !== null) throw new Error('Dispatcher resource profile unavailable');
  let admittedTarget: DispatcherAdmittedTarget | undefined;
  if (plan.prospectiveAdmissionId) {
    const repositoryOnly = parent.pullRequest === undefined;
    const configured = repositoryOnly ? parseRenovateRunSettings(pinned.installation.configurationJson) : null;
    if (repositoryOnly ? !configured?.automaticRuns || parent.repository !== configured.repository
      || !prospectiveRenovatePackageSupported(pinned.manifestJson)
      || !prospectiveRenovatePackageSupported(selected.value.manifestJson)
      : prospectiveRenovatePackageSupported(pinned.manifestJson)) {
      throw new Error('Prospective package unsupported');
    }
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const proof = await registry.readProspectiveRenovateAdmission(plan.prospectiveAdmissionId);
    const created = proof ? prospectiveRenovateTimestamp(proof.createdAt) : null;
    const cutoff = proof ? prospectiveRenovateTimestamp(proof.activatedAt) : null;
    if (!proof || plan.prospectiveAdmissionId !== plan.activityId || proof.activityId !== plan.activityId
      || plan.executionContext.activityId !== plan.activityId
      || (repositoryOnly ? !renovateRepositoryIdentity.safeParse({ repository: proof.repository, repositoryId: proof.repositoryId, baseBranch: proof.baseBranch }).success
        || proof.repository !== parent.repository || proof.controlsRevision !== pinned.controlsRevision
        || proof.installationRevision !== pinned.installation.revision || proof.operatorRevision !== pinned.operator.revision
        || proof.releaseId !== pinned.release.id || proof.bundleDigest !== pinned.release.bundleDigest
        : proof.repositoryId !== 973175879)
      || (!repositoryOnly && (proof.pullRequest !== parent.pullRequest
        || parent.repository.toLowerCase() !== 'nikolanovoselec/komodo'))
      || !Number.isSafeInteger(proof.pullRequest) || proof.pullRequest < 1 || !/^[0-9a-f]{40}$/.test(proof.head)
      || created === null || cutoff === null || created <= cutoff || created > Date.now()
      || proof.installationId !== pinned.installation.id
      || proof.ownerKey !== await operatorOwnerKey(human)
      || proof.actor.subject !== human.subject || proof.actor.issuer !== human.issuer
      || proof.actor.email.toLowerCase() !== human.email.toLowerCase()
      || JSON.stringify([...proof.actor.audiences].sort()) !== JSON.stringify([...human.audiences].sort())) {
      throw new Error('Prospective admission changed');
    }
    const selectedActor = await registry.currentProspectiveRenovateRegistration(proof.actor.registrationId);
    if (!selectedActor || selectedActor.registrationId !== proof.actor.registrationId
      || selectedActor.installationId !== proof.installationId || selectedActor.activatedAt !== proof.activatedAt
      || (repositoryOnly && (selectedActor.repository !== proof.repository || selectedActor.repositoryId !== proof.repositoryId
        || selectedActor.baseBranch !== proof.baseBranch || selectedActor.controlsRevision !== proof.controlsRevision
        || selectedActor.installationRevision !== proof.installationRevision || selectedActor.operatorRevision !== proof.operatorRevision
        || selectedActor.releaseId !== proof.releaseId || selectedActor.bundleDigest !== proof.bundleDigest))
      || selectedActor.bucket !== proof.actor.bucket || selectedActor.sessionId !== proof.actor.sessionId
      || selectedActor.sessionGeneration !== proof.actor.sessionGeneration
      || selectedActor.human.subject !== human.subject || selectedActor.human.issuer !== human.issuer
      || selectedActor.human.email.toLowerCase() !== human.email.toLowerCase()
      || JSON.stringify([...selectedActor.human.audiences].sort()) !== JSON.stringify([...human.audiences].sort())
      || !await operatorAccessSessionCurrent(human, authority.accessJwt)) {
      throw new Error('Prospective actor expired');
    }
    if (repositoryOnly) admittedTarget = { repository: parent.repository, repositoryId: proof.repositoryId,
      pullRequest: proof.pullRequest, headSha: proof.head, createdAt: proof.createdAt,
      createdAfter: proof.activatedAt, baseBranch: proof.baseBranch };
  }
  return { authority: { ...authority, human }, parent, policy: pinned.installation.policy, admittedTarget };
}

/** Parent-only composition with the existing credential-injecting interceptors, never direct upstream fetch. */
export async function createDispatcherOperation(input: {
  plan: OperatorRuntimePlan; env: Env; exports: Record<string, (options: { props: Record<string, unknown> }) => Fetcher>;
  operation: DispatcherOperation; current: () => Promise<boolean>;
  effectContext?: { authorize: () => Promise<void>; reconcileOnly: boolean };
  diagnosticContext?: InferenceDiagnosticContext;
  pinInferenceSelection?: (selection: DispatcherInferenceSelection) => Promise<void>;
}): Promise<() => Promise<Response>> {
  const { plan, env, operation } = input;
  const limits = dispatcherCapacities(isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined);
  const { authority, parent, policy: installationPolicy, admittedTarget } = await authorizeDispatcherPlan(plan, env);
  const current = async () => {
    await authorizeDispatcherPlan(plan, env);
    if (!await input.current()) throw new Error('Dispatcher generation changed');
  };
  const inference = operation.path === '/v1/dispatcher/inference';
  if (!installationPolicy.capabilities.includes(inference ? 'inference' : 'fetch')) throw new Error('Dispatcher capability denied');
  if (operation.path === '/v1/dispatcher/source') {
    // Repository-only packages own source selection. Legacy single-PR profiles retain their fixed reads.
    if (parent.pullRequest !== undefined) throw new Error('Legacy Dispatcher source selection denied');
    const sourceCurrent = async () => {
      if (operation.signal?.aborted) throw new Error('Dispatcher caller cancelled');
      await current();
      if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) {
        throw new Error('Dispatcher caller session expired');
      }
    };
    await sourceCurrent();
    const source = dispatcherSourceSchema(limits).parse(operation.body);
    const responseBytes = sourceResponseBytes(installationPolicy);
    const url = new URL(source.url);
    const method = source.method ?? 'GET';
    const github = interceptedGithubHosts(env).includes(url.hostname);
    if (method !== 'GET' && (!github || url.origin !== dispatcherGithubApiOrigin(env))) {
      throw new Error('Mutation transport denied');
    }
    if (admittedTarget && method !== 'GET') {
      const base = `${dispatcherGithubApiOrigin(env)}/repos/${admittedTarget.repository}`;
      // Compare the original wire, not URL-normalized aliases (queries, encodings or traversal).
      const comment = method === 'POST' && source.url === `${base}/issues/${admittedTarget.pullRequest}/comments`;
      const merge = method === 'PUT' && source.url === `${base}/pulls/${admittedTarget.pullRequest}/merge`;
      if (!comment && !merge) throw new Error('Prospective mutation target denied');
      const body = JSON.parse(source.body!);
      if (comment) z.strictObject({ body: z.string().min(1).refine(value => value.length <= limits.targetCommentChars)
        .refine(value => value.trim().length > 0) }).parse(body);
      else z.strictObject({ sha: z.literal(admittedTarget.headSha), merge_method: z.literal('merge') }).parse(body);
    }
    const entrypoint = github ? input.exports.GitHubInterceptor : input.exports.EgressController;
    if (!entrypoint) throw new Error('Dispatcher source transport unavailable');
    const bucket = await resolveBucketName(env, authority.human.email);
    // Managed installations grant capabilities, not a manufactured legacy OperatorPolicy.
    // No resource credentials or account-scoped Gateway exemption are granted by fetch.
    const transport = entrypoint({ props: github
      ? { user: authority.human.email, bucket, strict: true }
      : { bucket, strict: true } });
    return async () => {
      await sourceCurrent();
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(limits.sourceTimeoutMs, plan.deadline - Date.now())));
      const signal = operation.signal ? AbortSignal.any([timeout, operation.signal]) : timeout;
      if (admittedTarget && method !== 'GET') {
        // Only NEW reserved mutations execute this closure. Cached and unknown receipts do not preflight/replay.
        const base = `${dispatcherGithubApiOrigin(env)}/repos/${admittedTarget.repository}`;
        const get = async (path: string) => {
          await sourceCurrent();
          const response = await transport.fetch(new Request(base + path, { redirect: 'manual', signal,
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Dispatcher' } }));
          if (response.status !== 200 || response.redirected) throw new Error('Prospective target unavailable');
          const value = JSON.parse(await readDispatcherBody(response, signal, responseBytes));
          await sourceCurrent();
          return value;
        };
        const repository = await get('');
        if (repository?.id !== admittedTarget.repositoryId || repository?.full_name !== admittedTarget.repository) {
          throw new Error('Prospective repository changed');
        }
        const pull = await get(`/pulls/${admittedTarget.pullRequest}`);
        if (pull?.number !== admittedTarget.pullRequest || pull?.state !== 'open' || pull?.draft !== false
          || pull?.head?.sha !== admittedTarget.headSha
          || prospectiveRenovateTimestamp(pull?.created_at) !== prospectiveRenovateTimestamp(admittedTarget.createdAt)
          || pull?.base?.ref !== admittedTarget.baseBranch || pull?.base?.repo?.id !== admittedTarget.repositoryId
          || pull?.base?.repo?.full_name !== admittedTarget.repository) throw new Error('Prospective target changed');
        await sourceCurrent();
        if (signal.aborted) throw new Error('Prospective preflight expired');
      }
      const fetchBegan = performance.now();
      inferenceDiagnostic(input.diagnosticContext, { stage: 'source-fetch', outcome: 'started', resource: 'source' });
      let response: Response;
      try {
        response = await transport.fetch(new Request(url, { method, body: source.body, redirect: 'manual', signal,
          headers: { accept: 'application/json, text/plain, text/html', 'user-agent': 'Codeflare-Operator-Dispatcher',
            ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) } }));
      } catch {
        inferenceDiagnostic(input.diagnosticContext, { stage: 'source-fetch', outcome: 'failed', failureClass: 'source-fetch', elapsedMs: performance.now() - fetchBegan });
        await sourceCurrent();
        if (method !== 'GET') throw new Error('Mutation response unknown');
        return Response.json({ code: 'OPERATOR_SOURCE_UNAVAILABLE' }, { status: 422 });
      }
      inferenceDiagnostic(input.diagnosticContext, { stage: 'source-fetch', outcome: 'completed', sourceStatus: response.status, elapsedMs: performance.now() - fetchBegan });
      let body: string;
      try { body = response.body ? await readDispatcherBody(response, signal, responseBytes) : ''; }
      catch {
        inferenceDiagnostic(input.diagnosticContext, { stage: 'source-read', outcome: signal.aborted ? 'canceled' : 'failed', failureClass: 'source-read', sourceStatus: response.status });
        await sourceCurrent();
        if (method !== 'GET') throw new Error('Mutation body unknown');
        return Response.json({ code: 'OPERATOR_SOURCE_INCOMPLETE' }, { status: 422 });
      }
      await sourceCurrent();
      if (method !== 'GET' && (signal.aborted || response.status >= 500 || (response.status >= 300 && response.status < 400))) {
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
  const phase = operation.path === '/v1/dispatcher/github/comment' ? 'comment'
    : operation.path === '/v1/dispatcher/github/merge' ? 'merge' : undefined;
  const effect = phase === 'comment' ? dispatcherCommentSchema(limits).parse(operation.body)
    : phase === 'merge' ? dispatcherMergeSchema(limits).parse(operation.body) : undefined;
  const read = !inference && !phase ? dispatcherReadSchema.parse(operation.body) : undefined;
  const resource = read?.resource;
  if (admittedTarget && (phase || resource === 'open-pull-requests')) {
    throw new Error('Prospective legacy endpoint denied');
  }
  if (read?.target && (read.pullRequest !== undefined || read.headSha !== undefined)) {
    throw new Error('Contradictory read target');
  }
  const target = effect?.target ?? read?.target ?? read;
  const pullRequest = target?.pullRequest ?? parent.pullRequest;
  if (admittedTarget && !inference && (pullRequest !== admittedTarget.pullRequest
    || target?.headSha !== admittedTarget.headSha)) throw new Error('Prospective read target denied');
  if (resource === 'open-pull-requests' && (read?.target || read?.pullRequest !== undefined || read?.headSha !== undefined)) {
    throw new Error('Discovery target denied');
  }
  if (!inference && resource !== 'open-pull-requests' && (!pullRequest
    || (parent.pullRequest !== undefined && pullRequest !== parent.pullRequest)
    || (parent.pullRequest === undefined && !target?.headSha))) throw new Error('Pull request target denied');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: resource === 'release-notes' || resource === 'upstream-guide'
      ? [parent.repository.toLowerCase(), 'amir20/dozzle'] : [parent.repository.toLowerCase()], methods: ['GET'] },
    storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
  if (inference) {
    if (!input.exports.LlmInterceptor) throw new Error('LLM interceptor unavailable');
    let groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
      headers: { 'cf-access-jwt-assertion': authority.accessJwt },
    }), env);
    const routes = await loadEnterpriseRouteConfig(env, groups);
    // Only the current human default is selected; a child cannot widen or replace it.
    policy.inference = { routeIds: [routes.defaultRoute], defaultRouteId: routes.defaultRoute,
      reasoningLevels: [routes.defaultReasoning], defaultReasoningLevel: routes.defaultReasoning, inheritUserDefaults: false };
    const trusted = resolveOperatorInference({ policy, eligible: { routeIds: routes.routeCatalog,
      defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning } });
    await input.pinInferenceSelection?.({ routeId: trusted.routeId, reasoningLevel: trusted.reasoningLevel });
    const aig = await getAigConfig(env);
    const value = dispatcherInferenceSchema(limits).parse(operation.body);
    return async () => {
      await current();
      if (input.pinInferenceSelection) {
        groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
          headers: { 'cf-access-jwt-assertion': authority.accessJwt },
        }), env);
        const latest = await loadEnterpriseRouteConfig(env, groups);
        if (!latest.routeCatalog.includes(trusted.routeId) || latest.defaultRoute !== trusted.routeId
          || latest.defaultReasoning !== trusted.reasoningLevel) throw new Error('Dispatcher inference route changed');
        await input.pinInferenceSelection({ routeId: trusted.routeId, reasoningLevel: trusted.reasoningLevel });
      }
      inferenceDiagnostic(input.diagnosticContext, { stage: 'authority', outcome: 'completed', resource: 'inference', messages: value.input.messages.length, tools: value.input.tools?.length ?? 0 });
      const transport = input.exports.LlmInterceptor({ props: { user: authority.human.email, groups,
        // Stable owner-scoped native replay, with the now-reserved parent ordinal.
        sessionId: plan.activityId,
        gatewayUrl: aig.gatewayUrl, gatewayId: aig.gatewayId, token: aig.token,
        operatorInference: { activityId: plan.activityId, operatorId: plan.executionContext.operatorId, policy, trusted,
          diagnosticContext: input.diagnosticContext } } });
      return await transport.fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: operation.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...value.input,
          max_tokens: value.input.max_tokens ?? limits.inferenceDefaultTokens, model: trusted.routeId, stream: value.input.stream ?? true }) }));
    };
  }
  if (!input.exports.GitHubInterceptor) throw new Error('GitHub interceptor unavailable');
  const bucket = await resolveBucketName(env, authority.human.email);
  const transport = input.exports.GitHubInterceptor({ props: { user: authority.human.email, bucket, strict: true, operatorPolicy: policy } });
  const host = env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error('GitHub host invalid');
  const base = `https://${host}/repos/${parent.repository}`;
  const readTimeout = resource === 'release-notes' ? limits.releaseReadTimeoutMs
    : resource === 'upstream-guide' ? limits.guideReadTimeoutMs
    : resource === 'changed-compose' ? limits.composeReadTimeoutMs : undefined;
  const readDeadline = readTimeout === undefined ? null : Math.min(plan.deadline, Date.now() + readTimeout);
  const readSignal = () => {
    const remaining = Math.min(plan.deadline, readDeadline ?? Date.now() + limits.sourceTimeoutMs) - Date.now();
    if (remaining <= 0) throw new Error('Dispatcher evidence deadline exceeded');
    return AbortSignal.timeout(remaining);
  };
  const get = async (path: string) => {
    await current();
    return await transport.fetch(new Request(base + path, { redirect: 'manual', signal: readSignal(), headers: {
      accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Dispatcher',
    } }));
  };
  return async () => {
    if (resource === 'open-pull-requests') return Response.json(await discoverRenovatePulls(parent.repository, get));
    const pull = await get(`/pulls/${pullRequest}`);
    if (!pull.ok) return pull;
    const pullBody = await readDispatcherBody(pull, undefined, limits.dispatcherRequestBytes);
    const observed = JSON.parse(pullBody);
    if (target?.headSha && observed?.head?.sha !== target.headSha) throw new Error('Pull request head changed');
    if (parent.pullRequest === undefined || phase) {
      const candidate = phase && input.effectContext?.reconcileOnly && observed?.state === 'closed'
        ? { ...observed, state: 'open' } : observed;
      if (!eligibleRenovatePull(candidate, parent.repository) || observed.number !== pullRequest) {
        throw new Error('Pull request outside discovery scope');
      }
    }
    if (phase && effect) {
      if (!input.effectContext) throw new Error('Dispatcher effect authority unavailable');
      const effectCurrent = async () => { await current(); await input.effectContext!.authorize(); };
      await effectCurrent();
      const github = renovateGithub({ env, exports: input.exports, user: authority.human.email, bucket,
        repository: parent.repository, pullRequest: effect.target.pullRequest, current: effectCurrent,
        prospective: false, repositoryDiscovery: true });
      return executeRenovateDecision({ github, activityId: plan.activityId, phase, value: effect, observed,
        reconcileOnly: input.effectContext.reconcileOnly });
    }
    if (!/^[0-9a-f]{40}$/.test(observed?.head?.sha ?? '')) throw new Error('Pull request evidence unavailable');
    if (resource === 'pull-request') return Response.json({ number: observed.number,
      head: { sha: observed.head.sha }, base: { sha: observed?.base?.sha ?? null },
      user: { id: observed?.user?.id ?? null, login: observed?.user?.login ?? null,
        type: observed?.user?.type ?? null } });
    if (resource === 'release-notes' || resource === 'upstream-guide') {
      const files = await get(`/pulls/${pullRequest}/files?per_page=100&page=1`);
      if (!files.ok || /rel="next"/.test(files.headers.get('link') ?? '')) throw new Error('Release diff unavailable');
      const changes = JSON.parse(await readDispatcherBody(files, undefined, limits.dispatcherRequestBytes));
      if (!Array.isArray(changes) || changes.length > 100) throw new Error('Release diff unavailable');
      const targets: string[] = [];
      for (const file of changes) {
        if (!/(?:^|\/)compose[^/]*\.ya?ml$/.test(file?.filename ?? '')) continue;
        if (file.status !== 'modified' || typeof file.patch !== 'string'
          || !Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) {
          throw new Error('Release diff incomplete');
        }
        const lines = file.patch.split('\n');
        if (lines.filter((line: string) => line.startsWith('+') && !line.startsWith('+++')).length !== file.additions
          || lines.filter((line: string) => line.startsWith('-') && !line.startsWith('---')).length !== file.deletions) {
          throw new Error('Release diff truncated');
        }
        const removed = lines.filter((line: string) => /^-\s*image:\s*amir20\/dozzle:/.test(line));
        const added = lines.filter((line: string) => /^\+\s*image:\s*amir20\/dozzle:/.test(line));
        if (!removed.length && !added.length) continue;
        if (removed.length !== 1 || added.length !== 1) throw new Error('Release diff ambiguous');
        const before = /^-\s*image:\s*amir20\/dozzle:(v[0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(removed[0]);
        const after = /^\+\s*image:\s*amir20\/dozzle:(v[0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(added[0]);
        if (!before || !after || before[1] === after[1]) throw new Error('Release diff ambiguous');
        targets.push(`${before[1]}:${after[1]}`);
      }
      if (!targets.length || targets.some(target => target !== targets[0])) throw new Error('Release diff ambiguous');
      const tag = targets[0].split(':')[1];
      const assertHead = async () => {
        const response = await get(`/pulls/${pullRequest}`);
        if (!response.ok) throw new Error('Upstream PR revision unavailable');
        const reread = JSON.parse(await readDispatcherBody(response, undefined, limits.dispatcherRequestBytes));
        if (reread?.head?.sha !== observed.head.sha
          || (resource === 'upstream-guide' && reread?.base?.sha !== observed?.base?.sha)) {
          throw new Error('Upstream PR revision changed');
        }
      };
      await assertHead();
      if (resource === 'upstream-guide') {
        const upstreamGet = async (path: string) => {
          await current();
          return transport.fetch(new Request(`https://${host}/repos/amir20/dozzle${path}`, {
            redirect: 'manual', signal: readSignal(), headers: {
              accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Dispatcher',
            },
          }));
        };
        const tagResponse = await upstreamGet(`/git/ref/tags/${tag}`);
        if (tagResponse.status !== 200) throw new Error('Upstream guide tag unavailable');
        const tagIdentity = JSON.parse(await readDispatcherBody(tagResponse, undefined, limits.dispatcherRequestBytes));
        const reference = tagIdentity?.object;
        if (tagIdentity?.ref !== `refs/tags/${tag}` || !/^[0-9a-f]{40}$/.test(reference?.sha ?? '')
          || !['tag', 'commit'].includes(reference?.type)) throw new Error('Upstream guide tag unverified');
        let commitSha: string = reference.sha;
        if (reference.type === 'tag') {
          const annotated = await upstreamGet(`/git/tags/${reference.sha}`);
          if (annotated.status !== 200) throw new Error('Upstream guide annotated tag unavailable');
          const tagged = JSON.parse(await readDispatcherBody(annotated, undefined, limits.dispatcherRequestBytes));
          if (tagged?.tag !== tag || tagged?.object?.type !== 'commit'
            || !/^[0-9a-f]{40}$/.test(tagged?.object?.sha ?? '')) {
            throw new Error('Upstream guide commit unverified');
          }
          commitSha = tagged.object.sha;
        }
        const path = 'docs/guide/agent.md';
        const guideResponse = await upstreamGet(`/contents/${path}?ref=${commitSha}`);
        if (guideResponse.status !== 200) throw new Error('Upstream agent guide unavailable');
        const guide = JSON.parse(await readDispatcherBody(guideResponse, undefined, limits.dispatcherRequestBytes));
        if (guide?.path !== path || guide?.type !== 'file' || guide?.encoding !== 'base64'
          || !/^[0-9a-f]{40}$/.test(guide?.sha ?? '') || typeof guide?.content !== 'string'
          || !Number.isSafeInteger(guide?.size) || guide.size < 1 || guide.size > limits.guideBytes) {
          throw new Error('Upstream agent guide unverified');
        }
        const encoded = guide.content.replace(/\s/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error('Upstream agent guide encoding invalid');
        }
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        if (bytes.length !== guide.size) throw new Error('Upstream agent guide size mismatch');
        const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
        const blob = new Uint8Array(header.length + bytes.length);
        blob.set(header); blob.set(bytes, header.length);
        const blobSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', blob)),
          byte => byte.toString(16).padStart(2, '0')).join('');
        if (blobSha !== guide.sha) throw new Error('Upstream agent guide blob mismatch');
        const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
        if (!body.trim()) throw new Error('Upstream agent guide empty');
        await assertHead();
        if (readDeadline === null || Date.now() >= readDeadline) throw new Error('Upstream guide deadline exceeded');
        return Response.json({ repository: 'amir20/dozzle', tag, commitSha, blobSha: guide.sha,
          observedHead: observed.head.sha,
          source: `https://github.com/amir20/dozzle/blob/${commitSha}/${path}`, body });
      }
      const release = await transport.fetch(new Request(`https://${host}/repos/amir20/dozzle/releases/tags/${tag}`, {
        redirect: 'manual', signal: readSignal(), headers: {
          accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Dispatcher',
        },
      }));
      if (release.status !== 200) throw new Error('Release notes unavailable');
      const evidence = JSON.parse(await readDispatcherBody(release, undefined, limits.dispatcherRequestBytes));
      const source = `https://github.com/amir20/dozzle/releases/tag/${tag}`;
      if (evidence?.tag_name !== tag || evidence?.html_url !== source || typeof evidence?.body !== 'string'
        || !evidence.body.trim()) throw new Error('Release notes unverified');
      await assertHead();
      if (readDeadline === null || Date.now() >= readDeadline) throw new Error('Release read deadline exceeded');
      return Response.json({ repository: 'amir20/dozzle', tag, source, observedHead: observed.head.sha,
        body: evidence.body });
    }
    if (resource === 'changed-compose') {
      const baseSha = observed?.base?.sha;
      if (!/^[0-9a-f]{40}$/.test(baseSha ?? '')) throw new Error('Compose base unavailable');
      const response = await get(`/pulls/${pullRequest}/files?per_page=100&page=1`);
      if (response.status !== 200 || /rel="next"/.test(response.headers.get('link') ?? '')) {
        throw new Error('Compose file list incomplete');
      }
      const files = JSON.parse(await readDispatcherBody(response, undefined, limits.dispatcherRequestBytes));
      if (!Array.isArray(files) || files.length === 0 || files.length > 100) throw new Error('Compose file list incomplete');
      const changed = files.filter(file => /(?:^|\/)compose[^/]*\.ya?ml$/.test(file?.filename ?? ''));
      if (!changed.length || changed.length > 20) throw new Error('Compose scope unavailable');
      const paths = new Set<string>();
      for (const file of changed) {
        const path = file?.filename;
        if (file?.status !== 'modified' || typeof path !== 'string' || path.length > 256
          || path.split('/').some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')
          || !/^[0-9a-f]{40}$/.test(file?.sha ?? '') || paths.has(path)) {
          throw new Error('Compose path unavailable');
        }
        paths.add(path);
      }
      const decodeBlob = async (file: { filename: string; sha: string }, ref: string) => {
        const encoded = file.filename.split('/').map(encodeURIComponent).join('/');
        const blobResponse = await get(`/contents/${encoded}?ref=${ref}`);
        if (blobResponse.status !== 200) throw new Error('Compose blob unavailable');
        const body = JSON.parse(await readDispatcherBody(blobResponse, undefined, limits.dispatcherRequestBytes));
        if (body?.path !== file.filename || body?.type !== 'file' || body?.encoding !== 'base64'
          || !/^[0-9a-f]{40}$/.test(body?.sha ?? '') || typeof body?.content !== 'string'
          || !Number.isSafeInteger(body?.size) || body.size < 0 || body.size > 32 * 1024) {
          throw new Error('Compose blob unverified');
        }
        const encodedBody = body.content.replace(/\s/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedBody)) {
          throw new Error('Compose blob invalid');
        }
        const bytes = Uint8Array.from(atob(encodedBody), char => char.charCodeAt(0));
        if (bytes.length !== body.size) throw new Error('Compose blob size mismatch');
        return { sha: body.sha as string, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
      };
      const projected = await Promise.all(changed.map(async file => {
        const [before, after] = await Promise.all([
          decodeBlob(file, baseSha), decodeBlob(file, observed.head.sha),
        ]);
        if (after.sha !== file.sha) throw new Error('Compose head blob mismatch');
        return projectChangedCompose({ repository: parent.repository, pullRequest: pullRequest!,
          baseSha, headSha: observed.head.sha, path: file.filename }, before, after);
      }));
      const reread = await get(`/pulls/${pullRequest}`);
      if (reread.status !== 200) throw new Error('Compose revision unavailable');
      const currentPull = JSON.parse(await readDispatcherBody(reread, undefined, limits.dispatcherRequestBytes));
      if (currentPull?.head?.sha !== observed.head.sha || currentPull?.base?.sha !== baseSha) {
        throw new Error('Compose revision moved');
      }
      const output = { repository: parent.repository, pullRequest, baseSha,
        observedHead: observed.head.sha, files: projected };
      if (readDeadline === null || Date.now() >= readDeadline
        || new TextEncoder().encode(JSON.stringify(output)).length > 48 * 1024) {
        throw new Error('Compose projection exceeds bound');
      }
      return Response.json(output);
    }
    if (resource === 'files') {
      const response = await get(`/pulls/${pullRequest}/files?per_page=100&page=1`);
      if (!response.ok) return response;
      const data = projectDispatcherFiles(JSON.parse(await readDispatcherBody(response, undefined, limits.dispatcherRequestBytes)));
      return Response.json({ data, observedHead: observed.head.sha,
        truncated: /rel="next"/.test(response.headers.get('link') ?? '') });
    }
    // Bounded check-run pages retain only the fields used to assess completeness;
    // incomplete pagination stays explicitly truncated.
    const checkRuns: Array<{ name: string; conclusion: string | null }> = [];
    const seenCheckIds = new Set<number>();
    let total: number | null = null;
    let truncated = false;
    for (let page = 1; page <= limits.checkRunPageLimit; page++) {
      const response = await get(`/commits/${observed.head.sha}/check-runs?per_page=${limits.checkRunPageSize}&page=${page}`);
      if (!response.ok) return response;
      const data = JSON.parse(await readDispatcherBody(response, undefined, limits.dispatcherRequestBytes));
      if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0
        || !Array.isArray(data.check_runs) || data.check_runs.length > limits.checkRunPageSize
        || data.check_runs.some((run: { name?: unknown; conclusion?: unknown }) => !run
          || typeof run.name !== 'string' || (run.conclusion !== null && typeof run.conclusion !== 'string'))) {
        throw new Error('Check evidence unavailable');
      }
      const expectedTotal: number = total ?? data.total_count;
      total = expectedTotal;
      if (data.total_count !== expectedTotal) { truncated = true; break; }
      for (const run of data.check_runs as Array<{ id: number; name: string; conclusion: string | null }>) {
        if (!Number.isSafeInteger(run.id) || seenCheckIds.has(run.id)) { truncated = true; break; }
        seenCheckIds.add(run.id);
        checkRuns.push({ name: run.name, conclusion: run.conclusion });
      }
      if (truncated) break;
      if (expectedTotal > limits.checkRunPageLimit * limits.checkRunPageSize || checkRuns.length > expectedTotal) { truncated = true; break; }
      const more = /rel="next"/.test(response.headers.get('link') ?? '');
      if (checkRuns.length === expectedTotal) { truncated = more; break; }
      if (data.check_runs.length !== limits.checkRunPageSize || !more) { truncated = true; break; }
    }
    return Response.json({ data: { check_runs: checkRuns }, observedHead: observed.head.sha,
      truncated: truncated || checkRuns.length !== total });
  };
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

type DispatcherInvocation = { repository: string; pullRequest: number; headSha: string };
function dispatcherInvocation(value: unknown): DispatcherInvocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository)
    && typeof record.pullRequest === 'number' && Number.isInteger(record.pullRequest) && record.pullRequest > 0
    && typeof record.headSha === 'string' && /^[0-9a-f]{40}$/.test(record.headSha)
    ? { repository: record.repository, pullRequest: record.pullRequest, headSha: record.headSha } : null;
}

async function dispatchRenovateAssessment(request: Request, parent: DispatcherInvocation,
  activityId: string, generation: number): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/dispatcher/renovate') {
    return deniedCapability(activityId, generation);
  }
  let value: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch { return deniedCapability(activityId, generation); }
  const allowed = new Set(['repository', 'pullRequest', 'headSha', 'bot', 'checks', 'diff', 'evidence']);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.repository !== parent.repository
    || value.pullRequest !== parent.pullRequest || typeof value.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(value.headSha)
    || (value.bot !== undefined && value.bot !== 'renovate[bot]')
    || (value.checks !== undefined && !Array.isArray(value.checks))
    || (value.diff !== undefined && (!value.diff || typeof value.diff !== 'object' || Array.isArray(value.diff)))
    || (value.evidence !== undefined && (!value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)))) {
    return deniedCapability(activityId, generation);
  }
  const diff = value.diff as Record<string, unknown> | undefined;
  const evidence = value.evidence as Record<string, unknown> | undefined;
  const truncated = diff?.truncated === true;
  const rateLimited = evidence?.rateLimited === true;
  return Response.json({ schemaVersion: 1, status: 'completed', result: {
    activityId, generation, repository: parent.repository, pullRequest: parent.pullRequest, headSha: value.headSha,
    observedHead: value.headSha, readOnly: true,
    evidence: { stale: value.headSha !== parent.headSha, complete: !truncated && !rateLimited, truncated, rateLimited },
  } }, { headers: { 'cache-control': 'no-store' } });
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
    if (!isManagementReceipt(plan.receipt) && plan.receipt.operatorId === 'renovate-dispatcher'
      && (plan.receipt as unknown as { profile?: unknown }).profile === 'dispatcher') {
      let parent: DispatcherInvocation | null = null;
      try { parent = dispatcherInvocation(JSON.parse(plan.invocationJson)); } catch { /* denied below */ }
      return parent ? dispatchRenovateAssessment(request, parent, props.activityId, props.generation)
        : deniedCapability(props.activityId, props.generation);
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
