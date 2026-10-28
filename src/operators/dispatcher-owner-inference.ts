/** Normal Dispatcher uses public configured Pi services; source policy remains parent-owned. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from '../types';
import { getContainerId, forwardExisting } from '../lib/container-helpers';
import { readBoundedResponse, readBoundedStream } from '../lib/bounded-stream';
import { loadEnterpriseRouteConfig, resolveSessionAccessGroup, resolveBucketName, operatorAccessSessionCurrent } from '../lib/access';
import { authorizeDispatcherPlan } from './operator-runtime-capability';
import { resolveOperatorInference } from './inference-selection';
import { operatorOwnerKey } from './browser-activity';
import { PiAuthRequiredError, safePiAuthFailure } from './pi-auth-failure';
import { inferenceRequestBytes } from './dispatcher-inference-limits';
import type { OperatorRuntimePlan } from './activity';

const identity = z.string().min(1).max(512).refine(value => [...value].every(character =>
  character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f));
const profile = z.strictObject({ provider: identity, model: identity, api: identity,
  reasoningLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ConfiguredDispatcherInference = z.infer<typeof profile> & (
  { source: 'pi-native' } | { source: 'managed'; routeId: string });
type Input = { generation: number; plan: OperatorRuntimePlan; env: Env; current(): Promise<boolean>; signal?: AbortSignal };

/** Current grants select the source. The SDK resolves models/authentication; no vendor lookup or fallback. */
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
  const trusted = container as unknown as { getPersonalPiSession(ref: typeof reference): Promise<{ generation: number }> };
  if ((await trusted.getPersonalPiSession(reference)).generation !== ownerSource.sessionGeneration
    || input.signal?.aborted || !await input.current()) throw new Error('Owner source changed');
  return { container, reference, source, ownerKey: await operatorOwnerKey(authority.human), sessionId: ownerSource.sessionId,
    sessionGeneration: ownerSource.sessionGeneration, deadline: plan.deadline,
    maxRequestBytes: inferenceRequestBytes(plan.receipt.selection.operator.policy),
    maxResponseBytes: inferenceRequestBytes(plan.receipt.selection.operator.policy),
    ...(selection ? { selection } : {}),
    // This is the platform's provisioned SDK namespace (entrypoint.sh), not a vendor/API mapping.
    ...(managed ? { managed: { provider: 'codeflare-gateway', model: managed.routeId, reasoningLevel: managed.reasoningLevel } } : {}),
    ...(source !== 'pi-native' || plan.receipt.selection.installation.piReasoningOverride === undefined ? {} : {
      reasoningOverride: plan.receipt.selection.installation.piReasoningOverride }) };
}

async function send(input: Input, pathname: string, body: Record<string, unknown>, selection?: ConfiguredDispatcherInference): Promise<Response> {
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
    const pending = forwardExisting(context.container, request);
    void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => {});
    response = await Promise.race([pending, cancelled]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
  const bytes = await readBoundedResponse(response, context.maxResponseBytes, 'Owner inference response', signal).catch(error => {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  });
  await ownerContext(input, selection);
  if (!response.ok) {
    let failure;
    try { failure = safePiAuthFailure(JSON.parse(new TextDecoder().decode(bytes)).authFailure); } catch { /* private failure */ }
    if (failure && selection?.source === 'pi-native' && failure.provider === selection.provider) throw new PiAuthRequiredError(failure.provider, failure.reason);
    throw new Error('Configured owner inference unavailable');
  }
  return new Response(bytes, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
export async function discoverDispatcherOwnerProfile(input: Input): Promise<ConfiguredDispatcherInference> {
  const context = await ownerContext(input);
  const response = await send(input, '/operator-inference/profile', {});
  const selected = profile.parse(await response.json());
  const result: ConfiguredDispatcherInference = context.source === 'pi-native' ? { source: 'pi-native', ...selected }
    : { source: 'managed', routeId: context.managed!.model, ...selected };
  if (result.source === 'pi-native' && result.reasoningLevel === null) throw new Error('Native reasoning unavailable');
  if (context.managed && (selected.provider !== context.managed.provider || selected.model !== context.managed.model
    || selected.reasoningLevel !== context.managed.reasoningLevel)) throw new Error('Managed SDK binding changed');
  await ownerContext(input, result);
  return result;
}
export async function forwardDispatcherOwnerInference(input: Input & { selection: ConfiguredDispatcherInference;
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
        || url.pathname !== '/v1/dispatcher/owner-context' || url.search) throw new Error('Denied');
      const props = z.strictObject({ bucket: identity, sessionId: identity, email: identity }).parse(this.ctx.props);
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
