/** Normal Dispatcher uses saved owner configuration with Flue; source policy remains parent-owned. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from '../types';
import { emitRaw, type RawLogContext } from '../../host/src/operator-raw-logging';
import { getContainerId, forwardExisting, getPersonalPiSession } from '../lib/container-helpers';
import { readBoundedResponse, readBoundedStream } from '../lib/bounded-stream';
import { loadEnterpriseRouteConfig, resolveSessionAccessGroup, resolveBucketName, operatorAccessSessionCurrent } from '../lib/access';
import { authorizeDispatcherPlan, dispatcherRoutingGroups } from './operator-runtime-capability';
import { OperatorInferenceSelectionError, resolveOperatorInference } from './inference-selection';
import { operatorOwnerKey } from './browser-activity';
import { PiAuthRequiredError, safePiAuthFailure } from './pi-auth-failure';
import { DispatcherRefusal } from './dispatcher-refusal';
import { inferenceRequestBytes } from './dispatcher-inference-limits';
import { installedDispatcherConnection, type OperatorRuntimePlan } from './activity';
import { openOperatorSecret } from './protected-secrets';

const identity = z.string().min(1).max(512).refine(value => [...value].every(character =>
  character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f));
const profile = z.strictObject({ provider: identity, model: identity, api: identity,
  reasoningLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ConfiguredDispatcherInference = z.infer<typeof profile> & (
  { source: 'pi-native' } | { source: 'managed'; routeId: string });
type Input = { generation: number; plan: OperatorRuntimePlan; env: Env; current(): Promise<boolean>; signal?: AbortSignal;
  connection?: Awaited<ReturnType<typeof installedDispatcherConnection>> };
type SendInput = Input & Pick<ExecutionContext, 'waitUntil'> & { raw?: RawLogContext };

/** Current grants select the source. Normal Flue providers resolve models; no Root vendor lookup or fallback. */
/** Root authority/configuration scope only: never resolves models or opens a user Host. */
export async function dispatcherSdkOwnerContext(input: Input, selection?: ConfiguredDispatcherInference) {
  const { plan, env } = input;
  if (input.signal?.aborted || plan.authFailure || !await input.current() || !('selection' in plan.receipt)) throw new Error('Owner inference denied');
  const authorization = await authorizeDispatcherPlan(plan, env);
  const { authority, inferencePolicies, delegation } = authorization;
  if (!delegation && !await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) throw new Error('Owner access expired');
  const bucket = await resolveBucketName(env, authority.human.email);
  const groups = await dispatcherRoutingGroups(authorization, env);
  const routes = await loadEnterpriseRouteConfig(env, groups);
  const source = routes.piDefaultSource === 'pi-native' && routes.allowPersonalPiProviders === true ? 'pi-native' : 'managed';
  if (selection && selection.source !== source) throw new Error('Owner inference source changed');
  const eligible = { routeIds: routes.routeCatalog, defaultRouteId: '', defaultReasoningLevel: '' };
  const installed = plan.receipt.selection.installation.policy.inference;
  if (source === 'managed' && !installed?.defaultRouteId) {
    throw new OperatorInferenceSelectionError('ROUTE_SELECTION_REQUIRED', 'Configure a managed Gateway route for this installation');
  }
  const managed = source !== 'managed' ? undefined : resolveOperatorInference({
    policy: { inference: installed! }, trusted: {
      routeId: installed!.defaultRouteId!, reasoningLevel: installed!.defaultReasoningLevel }, eligible });
  const supportedReasoning = managed && routes.routeReasoningLevels?.[managed.routeId];
  if (managed && managed.reasoningLevel !== null && supportedReasoning && !supportedReasoning.some(level => level === managed.reasoningLevel)) {
    throw new OperatorInferenceSelectionError('REASONING_NOT_ELIGIBLE', 'Installation reasoning is not supported by its Gateway route');
  }
  if (managed && selection && (selection.source !== 'managed' || selection.routeId !== managed.routeId
    || selection.reasoningLevel !== managed.reasoningLevel)) throw new Error('Owner managed selection changed');
  for (const policy of inferencePolicies) {
    if (!policy.capabilities.includes('inference')) throw new Error('Owner inference policy denied');
    if (source === 'pi-native') {
      if (!policy.inference?.allowedSources?.includes('pi-native')) {
        throw new Error('Owner native policy denied');
      }
    } else if (policy.inference) {
      resolveOperatorInference({ policy: { inference: policy.inference }, trusted: managed!, eligible });
    }
  }
  if (managed && !routes.routeCatalog.includes(managed.routeId)) throw new Error('Owner managed route unavailable');
  if (delegation) await authorizeDispatcherPlan(plan, env);
  if (Date.now() >= plan.deadline || input.signal?.aborted || !await input.current()) throw new Error('Owner inference expired');
  return { bucket, email: authority.human.email.trim().toLowerCase(), authority, groups, source,
    ownerKey: await operatorOwnerKey(authority.human), managed, routeContextWindows: routes.routeContextWindows,
    deadline: plan.deadline };
}

async function ownerContext(input: Input, selection?: ConfiguredDispatcherInference) {
  const { plan, env } = input;
  if (input.signal?.aborted || plan.authFailure || !await input.current() || !('selection' in plan.receipt)) throw new Error('Owner inference denied');
  const { authority, inferencePolicies } = await authorizeDispatcherPlan(plan, env);
  if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) throw new Error('Owner access expired');
  const bucket = await resolveBucketName(env, authority.human.email);
  const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': authority.accessJwt } }), env);
  const routes = await loadEnterpriseRouteConfig(env, groups);
  const source = routes.piDefaultSource === 'pi-native' ? 'pi-native' : 'managed';
  if (selection && selection.source !== source) throw new Error('Owner inference source changed');
  const eligible = { routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning };
  const declared = inferencePolicies.find(policy => policy.inference !== undefined)?.inference;
  const managed = source !== 'managed' ? undefined : declared
    ? resolveOperatorInference({ policy: { inference: declared }, eligible })
    : { routeId: routes.defaultRoute, reasoningLevel: routes.defaultReasoning || null };
  if (source === 'pi-native' && routes.allowPersonalPiProviders !== true) throw new Error('Owner inference source denied');
  if (managed && selection && (selection.source !== 'managed' || selection.routeId !== managed.routeId
    || selection.reasoningLevel !== managed.reasoningLevel)) throw new Error('Owner managed selection changed');
  for (const policy of inferencePolicies) {
    if (!policy.capabilities.includes('inference')) throw new Error('Owner inference policy denied');
    if (source === 'pi-native') {
      if (!policy.inference?.allowedSources?.includes('pi-native')
        || selection && (selection.reasoningLevel === null || !policy.inference.reasoningLevels.includes(selection.reasoningLevel))) {
        throw new Error('Owner native policy denied');
      }
    } else if (policy.inference) {
      resolveOperatorInference({ policy: { inference: policy.inference }, trusted: managed!, eligible: {
        routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning } });
    }
  }
  if (managed && !routes.routeCatalog.includes(managed.routeId)) throw new Error('Owner managed route unavailable');
  let ownerSource = plan.ownerSource;
  if (plan.prospectiveAdmissionId) {
    const proof = await env.OPERATOR_REGISTRY!.getByName('registry').readProspectiveRenovateAdmission(plan.prospectiveAdmissionId);
    if (!proof || proof.activityId !== plan.activityId || proof.ownerKey !== await operatorOwnerKey(authority.human)) throw new Error('Owner source unavailable');
    ownerSource = { bucket: proof.actor.bucket, sessionId: proof.actor.sessionId, sessionGeneration: proof.actor.sessionGeneration };
  }
  if (!ownerSource || ownerSource.bucket !== bucket) throw new Error('Owner source unavailable');
  const reference = { bucket, sessionId: ownerSource.sessionId, email: authority.human.email };
  const container = env.CONTAINER.getByName(getContainerId(bucket, ownerSource.sessionId));
  if ((await getPersonalPiSession(container, reference, true)).generation !== ownerSource.sessionGeneration
    || input.signal?.aborted || !await input.current()) throw new Error('Owner source changed');
  return { container, reference, source, ownerKey: await operatorOwnerKey(authority.human), sessionId: ownerSource.sessionId,
    loggingEnabled: plan.receipt.selection.operator.policy.loggingEnabled !== false,
    sessionGeneration: ownerSource.sessionGeneration, deadline: plan.deadline,
    maxRequestBytes: inferenceRequestBytes(plan.receipt.selection.operator.policy),
    maxResponseBytes: inferenceRequestBytes(plan.receipt.selection.operator.policy),
    ...(selection ? { selection } : {}),
    // This is the platform's provisioned SDK namespace (entrypoint.sh), not a vendor/API mapping.
    ...(managed ? { managed: { provider: 'codeflare-gateway', model: managed.routeId, reasoningLevel: managed.reasoningLevel } } : {}) };
}

async function send(input: SendInput, pathname: string, body: Record<string, unknown>, selection?: ConfiguredDispatcherInference): Promise<Response> {
  const loggingContext = { ...input.raw, activityId: input.plan.activityId, generation: input.generation,
    loggingEnabled: 'selection' in input.plan.receipt && input.plan.receipt.selection.operator.policy.loggingEnabled !== false };
  try {
    const context = await ownerContext(input, selection);
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, context.deadline - Date.now()))])
      : AbortSignal.timeout(Math.max(1, context.deadline - Date.now()));
    // Stable RPC supports Request/Response, but not an explicit AbortSignal; keep cancellation local.
    const request = new Request(`http://container${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-codeflare-operator-activity': input.plan.activityId, 'x-codeflare-operator-generation': String(input.generation) },
      body: JSON.stringify({ schemaVersion: 1, activityId: input.plan.activityId,
        generation: input.generation, sessionGeneration: context.sessionGeneration, ...body }) });
    signal.throwIfAborted();
    if (Date.now() >= context.deadline) throw new Error('Owner inference deadline expired');
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Owner inference response aborted'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    let response: Response;
    try {
      emitRaw(loggingContext, 'owner-request', () => ({ pathname, body }));
      const pending = forwardExisting(context.container, request, { activityId: loggingContext.activityId,
        generation: loggingContext.generation, loggingEnabled: loggingContext.loggingEnabled });
      input.waitUntil(pending.then(response => {
        if (signal.aborted) return response.body?.cancel().catch(() => undefined);
      }, () => {}));
      response = await Promise.race([pending, cancelled]);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
    const bytes = await readBoundedResponse(response, context.maxResponseBytes, 'Owner inference response', signal,
      event => emitRaw(loggingContext, `owner-${event.type}`, () => event, () => ({ type: event.type, wireCaptured: true }))).catch(error => {
      if (response.body) input.waitUntil(response.body.cancel().catch(() => undefined));
      throw error;
    });
    emitRaw(loggingContext, 'owner-response', () => ({ pathname, status: response.status,
      headers: response.headers, body: new TextDecoder().decode(bytes) }));
    await ownerContext(input, selection);
    if (!response.ok) {
      let failure;
      try { failure = safePiAuthFailure(JSON.parse(new TextDecoder().decode(bytes)).authFailure); } catch { /* private failure */ }
      if (failure && selection?.source === 'pi-native' && failure.provider === selection.provider) throw new PiAuthRequiredError(failure.provider, failure.reason);
      throw new Error('Configured owner inference unavailable');
    }
    return new Response(bytes, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) {
    emitRaw(loggingContext, 'owner-failure', () => error);
    throw error;
  }
}
export async function discoverDispatcherOwnerProfile(input: SendInput): Promise<ConfiguredDispatcherInference> {
  const logging = { ...input.raw, activityId: input.plan.activityId, generation: input.generation,
    loggingEnabled: 'selection' in input.plan.receipt && input.plan.receipt.selection.operator.policy.loggingEnabled !== false,
    credentials: [...(input.raw?.credentials ?? [])] };
  try {
    const context = await dispatcherSdkOwnerContext(input);
    if (!('selection' in input.plan.receipt)) throw new Error('Dispatcher installation missing');
    const { installation, release } = input.plan.receipt.selection;
    const connection = input.connection ?? await installedDispatcherConnection(input.env, installation.id);
    if (connection.installationId !== installation.id || connection.releaseId !== release.id
      || connection.bundleDigest !== release.bundleDigest || connection.sourceCommit !== release.sourceCommit
      || connection.manifestDigest !== release.manifestDigest || connection.compilerCommit !== release.provenance?.compilerCommit) {
      throw new Error('Dispatcher profile deployment changed');
    }
    const secret = await openOperatorSecret(connection.connectionSecretCiphertext, input.env,
      { purpose: 'connection', recordId: installation.id });
    logging.credentials.push(secret);
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(Math.max(1, Math.min(15_000, input.plan.deadline - Date.now())))]);
    emitRaw(logging, 'owner-request', () => ({ pathname: '/control/profile', installationId: installation.id,
      activityId: input.plan.activityId, generation: input.generation, releaseId: release.id,
      connectionRevision: connection.connectionRevision, workerVersionId: connection.workerVersionId }));
    const response = await fetch(new Request(`${connection.controlOrigin}/control/profile`, {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ id: `${input.plan.activityId}-g${input.generation}`, installationId: installation.id,
        activityId: input.plan.activityId, generation: input.generation, releaseId: release.id,
        connectionRevision: connection.connectionRevision, workerVersionId: connection.workerVersionId }),
    }));
    const bytes = await readBoundedResponse(response, 1024 * 1024, 'SDK profile', signal,
      event => emitRaw(logging, `owner-${event.type}`, () => event, () => ({ type: event.type, wireCaptured: true })));
    emitRaw(logging, 'owner-response', () => ({ pathname: '/control/profile', status: response.status,
      headers: response.headers, body: new TextDecoder().decode(bytes) }));
    if (!response.ok) {
      await dispatcherSdkOwnerContext(input);
      // Status is authoritative even when the installed service refuses with plain text.
      // Only the existing closed JSON auth contract can select Pi login recovery.
      let failure;
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        failure = safePiAuthFailure(value && typeof value === 'object' ? (value as { authFailure?: unknown }).authFailure : undefined);
      } catch { /* A refusal need not be JSON; discard parser details from bounded failure metadata. */ }
      const refusal = context.source === 'pi-native' && failure ? new PiAuthRequiredError(failure.provider, failure.reason)
        : new DispatcherRefusal([401, 403].includes(response.status) ? 'authority-unverified' : 'upstream-unavailable',
          'Configured owner inference unavailable');
      throw Object.assign(refusal, { transportStatus: response.status });
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new DispatcherRefusal('request-invalid', 'SDK profile response invalid'); }
    const result = z.strictObject({ selection: z.discriminatedUnion('source', [
      profile.extend({ source: z.literal('pi-native') }),
      profile.extend({ source: z.literal('managed'), routeId: identity }),
    ]) }).safeParse(value);
    if (!result.success) throw new DispatcherRefusal('request-invalid', 'SDK profile response invalid');
    const parsed = result.data.selection;
    if (parsed.source !== context.source || parsed.source === 'managed' && (!context.managed || parsed.provider !== 'codeflare-gateway'
        || parsed.model !== context.managed.routeId || parsed.routeId !== context.managed.routeId
        || parsed.reasoningLevel !== context.managed.reasoningLevel)) throw new Error('SDK profile selection changed');
    const canonical = { source: parsed.source, provider: parsed.provider, model: parsed.model,
      api: parsed.api, reasoningLevel: parsed.reasoningLevel };
    const expectedDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical)))), byte => byte.toString(16).padStart(2, '0')).join('');
    if (parsed.profileDigest !== expectedDigest) throw new Error('SDK profile digest changed');
    const selection = parsed as ConfiguredDispatcherInference;
    await dispatcherSdkOwnerContext(input, selection);
    return selection;
  } catch (error) {
    emitRaw(logging, 'owner-profile-failure', () => error);
    throw error;
  }
}
export async function forwardDispatcherOwnerInference(input: SendInput & { selection: ConfiguredDispatcherInference;
  operation: { operationId: string; context: unknown; options: Record<string, unknown>; requestDigest: string } }): Promise<Response> {
  // Caller options cannot replace admitted reasoning; null remains the SDK provider default, not Off.
  const { reasoning: _callerReasoning, ...options } = input.operation.options;
  if (input.selection.reasoningLevel !== null) options.reasoning = input.selection.reasoningLevel;
  const bytes = new TextEncoder().encode(JSON.stringify({ context: input.operation.context, options }));
  const requestDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return send(input, '/operator-inference', { ...input.operation, options, requestDigest,
    profileDigest: input.selection.profileDigest }, input.selection);
}

/** Container-bound authority lookup. Props come from the owner DO, never a public caller. */
export class OperatorOwnerInferenceAuthority extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.origin !== 'https://operator.internal'
        || !['/v1/dispatcher/owner-context', '/v1/dispatcher/owner-raw'].includes(url.pathname) || url.search || url.hash) throw new Error('Denied');
      const props = z.strictObject({ bucket: identity, sessionId: identity, email: identity }).parse(this.ctx.props);
      if (url.pathname === '/v1/dispatcher/owner-raw') {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('Denied');
        const input = z.strictObject({ activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          generation: z.number().int().positive().safe(), stage: z.string().min(1), value: z.unknown() }).parse(await request.json());
        if (!Object.hasOwn(input, 'value')) throw new Error('Denied');
        const container = this.env.CONTAINER.getByName(getContainerId(props.bucket, props.sessionId));
        const session = await getPersonalPiSession(container, props, true);
        const receipt = await this.env.OPERATOR_ACTIVITY!.getByName(input.activityId).retainDispatcherOwnerObservation(
          input.generation, { ...props, sessionGeneration: session.generation }, input.stage, input.value);
        return Response.json(receipt, { status: receipt.status === 'complete' ? 200 : 503,
          headers: { 'cache-control': 'no-store' } });
      }
      const bytes = await readBoundedStream(request.body, 4096, 'Owner context', AbortSignal.timeout(5000));
      const input = z.strictObject({ activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        generation: z.number().int().positive().safe() }).parse(JSON.parse(new TextDecoder().decode(bytes)));
      const activity = this.env.OPERATOR_ACTIVITY!.getByName(input.activityId);
      const plan = await activity.getRuntimePlan();
      if (!plan) throw new Error('Denied');
      const current = () => activity.operatorGenerationCurrent(input.generation);
      const context = await ownerContext({ generation: input.generation, plan, env: this.env, current }, plan.configuredSelection);
      if (context.reference.bucket !== props.bucket || context.reference.sessionId !== props.sessionId
        || context.reference.email.toLowerCase() !== props.email.toLowerCase()) throw new Error('Denied');
      const { container: _container, reference: _reference, source: _source, ...publicContext } = context;
      return Response.json(publicContext, { headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ error: 'Owner inference denied' }, { status: 403, headers: { 'cache-control': 'no-store' } }); }
  }
}
