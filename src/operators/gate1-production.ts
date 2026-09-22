import { getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../types';
import { parseOperatorContainerProfile } from '../container/operator-context';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup } from '../lib/access';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { getR2Config } from '../lib/r2-config';
import { getSseHeaders } from '../lib/r2-sse';
import { openOperatorExecutionAccess } from './execution-context';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { parseOperatorPolicy } from './policy';
import { GATE1_OPERATOR_ID, resolveGate1Resources, type Gate1Resources } from './gate1-resources';
import { ContainerOwnedSessionRuntime, type Gate1ContainerStub, type Gate1SessionBootstrap } from './gate1-runtime';
import { OwnedOperatorSessionService, type OwnedOperatorSessionState,
  type OwnedOperatorSessionStore } from './owned-session';
import { Gate1OperatorCapability } from './gate1-capability';
import { bootstrapOperatorSession } from './session-bootstrap';
import { verifyOperatorSync, type OperatorSyncReader } from './sync-verification';
import type { OperatorRuntimePlan, OperatorActivity } from './activity';
import type { OperatorAdmissionReceipt, ManagementAdmissionReceipt } from './registry';

type Gate1Activity = DurableObjectStub<OperatorActivity>;
interface OperatorRuntimeCapabilityProps { activityId: string; generation: number }

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
    && Number.isInteger(record.pullRequest) && record.pullRequest > 0
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

function activityStore(activity: Gate1Activity): OwnedOperatorSessionStore {
  return {
    load: async () => {
      const state = await activity.getOwnedSession();
      return state ? { schemaVersion: 1, requestId: state.requestId, requestDigest: state.requestDigest,
        activityId: state.activityId, ownerBucket: state.ownerBucket, sessionId: state.sessionId,
        profile: parseOperatorContainerProfile(state.profile), status: state.status } : null;
    },
    save: async (state: OwnedOperatorSessionState) => {
      const result = await activity.saveOwnedSession(state);
      if (!result.ok) throw new Error(`Owned session state ${result.reason}`);
    },
  };
}

export async function createOperatorSyncReader(
  env: Env,
  bucket: string,
  bootstrap: Gate1SessionBootstrap,
): Promise<OperatorSyncReader> {
  const config = await getR2Config(env);
  const client = createR2Client({
    R2_ACCESS_KEY_ID: bootstrap.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: bootstrap.r2SecretAccessKey,
  });
  return async (key, maxBytes) => {
    const signed = await client.sign(getR2Url(config.endpoint, bucket, key), {
      headers: getSseHeaders(env, bootstrap.r2SseDisabled === true),
    });
    const response = await fetch(signed);
    if (response.status === 404) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || (declared && declared > maxBytes)) throw new Error('Bounded R2 read failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('Bounded R2 read failed');
    return bytes;
  };
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
  const runtime = new ContainerOwnedSessionRuntime({ activityId: plan.activityId, ownerBucket,
    sessionId: resources.profile.sessionId, userEmail: authority.human.email.toLowerCase(), userGroups: groups,
    routes, bootstrap,
    resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as Gate1ContainerStub });
  const service = new OwnedOperatorSessionService(activityStore(activity), runtime);
  const requestDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plan.invocationJson));
  const digest = Array.from(new Uint8Array(requestDigest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const ensure = () => service.ensure({ requestId: 'gate1-session-v1', requestDigest: digest,
    activityId: plan.activityId, ownerBucket, profile: resources.profile, authority });
  const stop = () => service.stop({ activityId: plan.activityId, ownerBucket, drain: false });
  const container = getContainer(env.CONTAINER, `${ownerBucket}-${resources.profile.sessionId}`) as unknown as Gate1ContainerStub;
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
