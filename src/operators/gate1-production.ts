import { getContainer } from '@cloudflare/containers';
import type { Env } from '../types';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup } from '../lib/access';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { getR2Config } from '../lib/r2-config';
import { openOperatorExecutionAccess } from './execution-context';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { parseOperatorPolicy } from './policy';
import { resolveGate1Resources, type Gate1Resources } from './gate1-resources';
import { ContainerOwnedSessionRuntime, type Gate1ContainerStub } from './gate1-runtime';
import { OwnedOperatorSessionService, type OwnedOperatorSessionState } from './owned-session';
import { Gate1OperatorCapability } from './gate1-capability';
import { verifyOperatorSync, type OperatorSyncReader } from './sync-verification';
import type { OperatorRuntimePlan, OperatorActivity } from './activity';

type Gate1Activity = Pick<OperatorActivity, 'getOwnedSession' | 'saveOwnedSession' | 'getSync'
  | 'prepareSync' | 'recordSyncUploaded' | 'recordSyncVerified'>;

function activityStore(activity: Gate1Activity) {
  return {
    load: () => activity.getOwnedSession(),
    save: async (state: OwnedOperatorSessionState) => {
      const result = await activity.saveOwnedSession(state);
      if (!result.ok) throw new Error(`Owned session state ${result.reason}`);
    },
  };
}

async function r2Reader(env: Env, bucket: string): Promise<OperatorSyncReader> {
  const config = await getR2Config(env);
  const client = createR2Client(env);
  return async (key, maxBytes) => {
    const signed = await client.sign(getR2Url(config.endpoint, bucket, key));
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
export async function createGate1ProductionCapability(input: {
  env: Env;
  plan: OperatorRuntimePlan;
  activity: Gate1Activity;
  generation: number;
}): Promise<{ capability: Fetcher; resources: Gate1Resources }> {
  const { env, plan, activity } = input;
  const authority = await openOperatorExecutionAccess(plan.executionContext, env);
  const invocation = parseOperatorConsumerInvocation(JSON.parse(plan.invocationJson));
  const policy = parseOperatorPolicy(JSON.parse(plan.receipt.policyJson));
  const ownerBucket = await resolveBucketName(env, authority.human.email);
  const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': authority.accessJwt },
  }), env);
  const routes = await loadEnterpriseRouteConfig(env, groups);
  const resources = await resolveGate1Resources({ invocation, operatorId: plan.receipt.operatorId,
    activityId: plan.activityId, ownerBucket, policy, policyDigest: plan.executionContext.policyDigest,
    deadline: plan.deadline, human: authority.human, eligibleInference: {
      routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute,
      defaultReasoningLevel: routes.defaultReasoning,
    } });
  const runtime = new ContainerOwnedSessionRuntime({ activityId: plan.activityId, ownerBucket,
    resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as Gate1ContainerStub });
  const service = new OwnedOperatorSessionService(activityStore(activity), runtime);
  const requestDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plan.invocationJson));
  const digest = Array.from(new Uint8Array(requestDigest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const ensure = () => service.ensure({ requestId: 'gate1-session-v1', requestDigest: digest,
    activityId: plan.activityId, ownerBucket, profile: resources.profile, authority });
  const stop = () => service.stop({ activityId: plan.activityId, ownerBucket, drain: false });
  const container = getContainer(env.CONTAINER, `${ownerBucket}-${resources.profile.sessionId}`) as unknown as Gate1ContainerStub;
  const reader = await r2Reader(env, ownerBucket);
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
  return { capability, resources };
}
