import { getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../types';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup,
  resolveOperatorGroupIdentity, canInvokeOperator } from '../lib/access';
import { getAigConfig } from '../lib/aig-config';
import { resolveOperatorInference } from './inference-selection';
import { z } from 'zod';
import { openOperatorExecutionAccess } from './execution-context';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { parseOperatorPolicy } from './policy';
import { GATE1_OPERATOR_ID, resolveGate1Resources, type Gate1Resources } from './gate1-resources';
import { ContainerOwnedSessionRuntime, type OperatorContainerStub } from './owned-session-runtime';
import { OwnedOperatorSessionService } from './owned-session';
import { Gate1OperatorCapability } from './gate1-capability';
import { createConductorProductionCapability } from './conductor-production';
import { operatorActivitySessionStore, createOperatorSyncReader,
  type OperatorActivityStub } from './owned-session-production';
import { bootstrapOperatorSession } from './session-bootstrap';
import { verifyOperatorSync } from './sync-verification';
import type { OperatorRuntimePlan } from './activity';
import type { OperatorAdmissionReceipt, ManagementAdmissionReceipt } from './registry';

type Gate1Activity = OperatorActivityStub;

const dispatcherOperationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const dispatcherReadSchema = z.strictObject({ operationId: dispatcherOperationId,
  resource: z.enum(['pull-request', 'files', 'checks']) });
const dispatcherInferenceSchema = z.strictObject({ operationId: dispatcherOperationId,
  input: z.strictObject({
    messages: z.array(z.json()).min(1).max(128), tools: z.array(z.json()).max(32).optional(),
    tool_choice: z.json().optional(), max_tokens: z.number().int().min(1).max(8192).optional(),
    temperature: z.number().min(0).max(2).optional(), stream: z.boolean().optional(),
    stream_options: z.strictObject({ include_usage: z.literal(true) }).optional(),
  }) });

export type DispatcherOperation = { operationId: string; path: string; body: unknown };

/** Bounded transport wire: no arbitrary destination, headers, identity, model or resource selection. */
export async function parseDispatcherOperation(request: Request): Promise<DispatcherOperation> {
  const url = new URL(request.url);
  if (url.origin !== 'https://operator.internal' || url.search || url.hash || request.method !== 'POST'
    || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('Dispatcher request denied');
  const value = JSON.parse(await readDispatcherBody(request));
  const schema = url.pathname === '/v1/dispatcher/github/read' ? dispatcherReadSchema
    : url.pathname === '/v1/dispatcher/inference' ? dispatcherInferenceSchema : null;
  if (!schema) throw new Error('Dispatcher route denied');
  const body = schema.parse(value);
  return { operationId: body.operationId, path: url.pathname, body };
}

/** Shared byte ceiling for requests, child admission/status and persisted effect output. */
export async function readDispatcherBody(message: Request | Response): Promise<string> {
  if (!message.body) throw new Error('Dispatcher body unavailable');
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let value = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return value + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 64 * 1024) throw new Error('Dispatcher body exceeds limit');
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
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
    pullRequest: z.number().safe().int().positive() }).parse(JSON.parse(plan.invocationJson));
  // No resource resolver is introduced: only the direct read/inference profile is supported.
  if (pinned.installation.policy.resourceProfileId !== null) throw new Error('Dispatcher resource profile unavailable');
  return { authority: { ...authority, human }, parent, policy: pinned.installation.policy };
}

/** Parent-only composition with the existing credential-injecting interceptors, never direct upstream fetch. */
export async function createDispatcherOperation(input: {
  plan: OperatorRuntimePlan; env: Env; exports: Record<string, (options: { props: Record<string, unknown> }) => Fetcher>;
  operation: DispatcherOperation; current: () => Promise<boolean>;
}): Promise<() => Promise<Response>> {
  const { plan, env, operation } = input;
  const { authority, parent, policy: installationPolicy } = await authorizeDispatcherPlan(plan, env);
  const current = async () => {
    await authorizeDispatcherPlan(plan, env);
    if (!await input.current()) throw new Error('Dispatcher generation changed');
  };
  const inference = operation.path === '/v1/dispatcher/inference';
  if (!installationPolicy.capabilities.includes(inference ? 'inference' : 'fetch')) throw new Error('Dispatcher capability denied');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [parent.repository.toLowerCase()], methods: ['GET'] },
    storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
  if (inference) {
    if (!input.exports.LlmInterceptor) throw new Error('LLM interceptor unavailable');
    const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
      headers: { 'cf-access-jwt-assertion': authority.accessJwt },
    }), env);
    const routes = await loadEnterpriseRouteConfig(env, groups);
    // Only the current human default is selected; a child cannot widen or replace it.
    policy.inference = { routeIds: [routes.defaultRoute], defaultRouteId: routes.defaultRoute,
      reasoningLevels: [routes.defaultReasoning], defaultReasoningLevel: routes.defaultReasoning, inheritUserDefaults: false };
    const trusted = resolveOperatorInference({ policy, eligible: { routeIds: routes.routeCatalog,
      defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning } });
    const aig = await getAigConfig(env);
    const transport = input.exports.LlmInterceptor({ props: { user: authority.human.email, groups,
      sessionId: `operator-${plan.activityId}`, gatewayUrl: aig.gatewayUrl, gatewayId: aig.gatewayId, token: aig.token,
      operatorInference: { activityId: plan.activityId, operatorId: plan.executionContext.operatorId, policy, trusted } } });
    const value = dispatcherInferenceSchema.parse(operation.body);
    return async () => {
      await current();
      return transport.fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...value.input,
          max_tokens: value.input.max_tokens ?? 8192, model: trusted.routeId, stream: value.input.stream ?? true }) }));
    };
  }
  if (!input.exports.GitHubInterceptor) throw new Error('GitHub interceptor unavailable');
  const bucket = await resolveBucketName(env, authority.human.email);
  const transport = input.exports.GitHubInterceptor({ props: { user: authority.human.email, bucket, strict: true, operatorPolicy: policy } });
  const { resource } = dispatcherReadSchema.parse(operation.body);
  const host = env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error('GitHub host invalid');
  const base = `https://${host}/repos/${parent.repository}`;
  const get = async (path: string) => {
    await current();
    return transport.fetch(new Request(base + path, { headers: {
      accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Dispatcher',
    } }));
  };
  return async () => {
    const pull = await get(`/pulls/${parent.pullRequest}`);
    if (!pull.ok) return pull;
    const pullBody = await readDispatcherBody(pull);
    const observed = JSON.parse(pullBody);
    // Bot identity and assessment semantics belong to the forkable Dispatcher
    // package. The parent validates only the bounded admitted PR/read scope.
    if (!/^[0-9a-f]{40}$/.test(observed?.head?.sha ?? '')) throw new Error('Pull request evidence unavailable');
    if (resource === 'pull-request') return new Response(pullBody, { headers: { 'content-type': 'application/json' } });
    const response = await get(resource === 'files' ? `/pulls/${parent.pullRequest}/files?per_page=100&page=1`
      : `/commits/${observed.head.sha}/check-runs?per_page=100&page=1`);
    if (!response.ok) return response;
    const data = JSON.parse(await readDispatcherBody(response));
    return Response.json({ data, observedHead: observed.head.sha,
      truncated: /rel="next"/.test(response.headers.get('link') ?? '') });
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
    if (isManagementReceipt(plan.receipt) || plan.receipt.operatorId !== GATE1_OPERATOR_ID) {
      return deniedCapability(props.activityId, props.generation);
    }
    const invocation = parseOperatorConsumerInvocation(JSON.parse(plan.invocationJson));
    if (invocation.resources.session === null) return deniedCapability(props.activityId, props.generation);
    const connected = await createGate1ProductionCapability({ env: this.env, plan, activity,
      generation: props.generation });
    return connected.capability.fetch(request);
  }
}

/** Compose the single code-owned Gate 1 profile from protected parent state. */
async function createGate1ProductionCapability(input: {
  env: Env;
  plan: OperatorRuntimePlan;
  activity: Gate1Activity;
  generation: number;
}): Promise<{ capability: Fetcher; resources: Gate1Resources }> {
  const { env, plan, activity } = input;
  const authority = await openOperatorExecutionAccess(plan.executionContext, env);
  const invocation = parseOperatorConsumerInvocation(JSON.parse(plan.invocationJson));
  const receipt = plan.receipt;
  if (isManagementReceipt(receipt) || !receipt.policyJson) throw new Error('Gate 1 policy unavailable');
  const policy = parseOperatorPolicy(JSON.parse(receipt.policyJson));
  const ownerBucket = await resolveBucketName(env, authority.human.email);
  const { bootstrap } = await bootstrapOperatorSession({ env, authority, ownerBucket });
  const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': authority.accessJwt },
  }), env);
  const routes = await loadEnterpriseRouteConfig(env, groups);
  const resources = await resolveGate1Resources({ invocation, operatorId: receipt.operatorId,
    activityId: plan.activityId, ownerBucket, policy, policyDigest: plan.executionContext.policyDigest,
    deadline: plan.deadline, human: authority.human, eligibleInference: {
      routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute,
      defaultReasoningLevel: routes.defaultReasoning,
    } });
  const packageResources = await activity.getPackageResources();
  const runtime = new ContainerOwnedSessionRuntime({ activityId: plan.activityId, ownerBucket,
    sessionId: resources.profile.sessionId, userEmail: authority.human.email.toLowerCase(), userGroups: groups,
    routes, bootstrap, packageResources,
    resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as OperatorContainerStub });
  const service = new OwnedOperatorSessionService(operatorActivitySessionStore(activity), runtime);
  const requestDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plan.invocationJson));
  const digest = Array.from(new Uint8Array(requestDigest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const ensure = () => service.ensure({ requestId: 'gate1-session-v1', requestDigest: digest,
    activityId: plan.activityId, ownerBucket, profile: resources.profile, authority });
  const stop = () => service.stop({ activityId: plan.activityId, ownerBucket, drain: false });
  const container = getContainer(env.CONTAINER, `${ownerBucket}-${resources.profile.sessionId}`) as unknown as OperatorContainerStub;
  const reader = await createOperatorSyncReader(env, ownerBucket, bootstrap);
  const capability = new Gate1OperatorCapability({ activityId: plan.activityId, generation: input.generation,
    deadline: plan.deadline, resources, session: { ensure, stop },
    host: { fetch: (path, init) => container.fetch(new Request(`http://container${path}`, init)) },
    sync: {
      get: operationId => activity.getSync(operationId),
      prepare: value => activity.prepareSync(value),
      uploaded: (operationId, manifestDigest) => activity.recordSyncUploaded(operationId, manifestDigest),
      verified: (operationId, evidence) => activity.recordSyncVerified(operationId, evidence),
    },
    verify: expected => verifyOperatorSync(expected, reader),
  });
  return { capability: capability as unknown as Fetcher, resources };
}
