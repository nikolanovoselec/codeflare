import { getContainer } from '@cloudflare/containers';
import type { Env } from '../types';
import { parseOperatorContainerProfile } from '../container/operator-context';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup,
  resolveOperatorGroupIdentity, canInvokeOperator } from '../lib/access';
import { openOperatorExecutionAccess } from './execution-context';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { parseOperatorPolicy } from './policy';
import { resolveOperatorInference } from './inference-selection';
import { bootstrapOperatorSession } from './session-bootstrap';
import { projectOperatorAttachments, resolveOperatorAttachment } from './attachments';
import { ContainerOwnedSessionRuntime, type OperatorContainerStub } from './owned-session-runtime';
import { OwnedOperatorSessionService } from './owned-session';
import { OperatorConductorCapability } from './conductor-capability';
import { operatorActivitySessionStore, createOperatorSyncReader,
  type OperatorActivityStub } from './owned-session-production';
import { verifyOperatorSync } from './sync-verification';
import type { OperatorRuntimePlan } from './activity';
import type { ManagementAdmissionReceipt } from './registry';

function management(receipt: OperatorRuntimePlan['receipt']): receipt is ManagementAdmissionReceipt {
  return 'selection' in receipt;
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Profile-neutral managed Conductor composition over existing enterprise owners. */
export async function createConductorProductionCapability(input: { env: Env; plan: OperatorRuntimePlan;
  activity: OperatorActivityStub; generation: number }): Promise<{ capability: Fetcher }> {
  const { env, plan, activity } = input;
  if (!management(plan.receipt) || plan.receipt.selection.operator.profile !== 'conductor') {
    throw new Error('Conductor authority denied');
  }
  const pinned = plan.receipt.selection;
  const authorize = async () => {
    if (plan.deadline <= Date.now() || !env.OPERATOR_REGISTRY
      || !await activity.operatorGenerationCurrent(input.generation)) throw new Error('Conductor generation changed');
    const selected = await env.OPERATOR_REGISTRY.getByName('registry').resolveManagementExecution(pinned.installation.id);
    if (!selected.ok || selected.value.installation.revision !== pinned.installation.revision
      || selected.value.operator.revision !== pinned.operator.revision
      || selected.value.controlsRevision !== pinned.controlsRevision
      || selected.value.release.bundleDigest !== pinned.release.bundleDigest
      || selected.value.operator.profile !== 'conductor') throw new Error('Conductor installation changed');
    const authority = await openOperatorExecutionAccess(plan.executionContext, env);
    const human = await resolveOperatorGroupIdentity(authority.human, authority.accessJwt);
    if (!canInvokeOperator(human, selected.value.operator)) throw new Error('Conductor invoker denied');
    return { authority: { ...authority, human }, selection: selected.value };
  };
  const admitted = await authorize();
  const invocation = parseOperatorConsumerInvocation(JSON.parse(plan.invocationJson));
  const installationPolicy = admitted.selection.installation.policy;
  if (!['session', 'pi', 'storage'].every(capability => installationPolicy.capabilities.includes(capability))
    || !installationPolicy.resourceProfileId || invocation.resources.session?.profileId !== installationPolicy.resourceProfileId
    || invocation.resources.storage?.scopeId !== installationPolicy.resourceProfileId || !invocation.resources.inference) {
    throw new Error('Conductor resources denied');
  }
  const ownerBucket = await resolveBucketName(env, admitted.authority.human.email);
  const { bootstrap } = await bootstrapOperatorSession({ env, authority: admitted.authority, ownerBucket });
  const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': admitted.authority.accessJwt },
  }), env);
  const routes = await loadEnterpriseRouteConfig(env, groups);
  const storage = { readPrefixes: ['Operators/', `.codeflare/operators/${plan.activityId}/`],
    writePrefixes: ['Operators/', `.codeflare/operators/${plan.activityId}/`] };
  const eligiblePolicy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [], methods: [] }, storage,
    inference: { routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute,
      reasoningLevels: [routes.defaultReasoning], defaultReasoningLevel: routes.defaultReasoning,
      inheritUserDefaults: false } });
  const effectiveInference = resolveOperatorInference({ eligible: { routeIds: routes.routeCatalog,
    defaultRouteId: routes.defaultRoute, defaultReasoningLevel: routes.defaultReasoning },
    trusted: invocation.resources.inference, policy: eligiblePolicy });
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
    storage, inference: { routeIds: [effectiveInference.routeId], defaultRouteId: effectiveInference.routeId,
      reasoningLevels: effectiveInference.reasoningLevel ? [effectiveInference.reasoningLevel] : [],
      defaultReasoningLevel: effectiveInference.reasoningLevel, inheritUserDefaults: false } });
  const sessionId = `conductor${(await digest(plan.activityId)).slice(0, 16)}`;
  const profile = parseOperatorContainerProfile({ schemaVersion: 1, activityId: plan.activityId,
    operatorId: pinned.operator.operatorId, sessionId, ownerBucket,
    policyDigest: plan.executionContext.policyDigest, deadline: plan.deadline, outputPrefix: 'Operators/',
    human: { subject: admitted.authority.human.subject, email: admitted.authority.human.email.toLowerCase(),
      issuer: new URL(admitted.authority.human.issuer).href, audiences: [...admitted.authority.human.audiences] },
    policy, jwtPolicy: { mode: 'off', destinations: [] }, piProfile: { provider: 'codeflare-gateway',
      model: effectiveInference.routeId, thinkingLevel: effectiveInference.reasoningLevel ?? 'off',
      systemPrompt: 'Execute only the installed Conductor package procedure over parent-restored inputs and approved resources.',
      tools: ['read', 'write', 'subagent'] } });
  const attachments = projectOperatorAttachments(invocation);
  const packageResources = await activity.getPackageResources();
  const runtime = new ContainerOwnedSessionRuntime({ activityId: plan.activityId, ownerBucket, sessionId,
    userEmail: admitted.authority.human.email.toLowerCase(), userGroups: groups, routes, bootstrap,
    packageResources, attachments,
    resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as OperatorContainerStub });
  const service = new OwnedOperatorSessionService(operatorActivitySessionStore(activity), runtime);
  const requestDigest = await digest(plan.invocationJson);
  const ensure = () => service.ensure({ requestId: 'conductor-session-v1', requestDigest,
    activityId: plan.activityId, ownerBucket, profile, authority: admitted.authority });
  const stop = () => service.stop({ activityId: plan.activityId, ownerBucket, drain: false });
  const container = getContainer(env.CONTAINER, `${ownerBucket}-${sessionId}`) as unknown as OperatorContainerStub;
  const reader = await createOperatorSyncReader(env, ownerBucket, bootstrap);
  const host = (path: string, init: RequestInit) => container.fetch(new Request(`http://container${path}`, init));
  const capability = new OperatorConductorCapability({ current: async () => { await authorize(); },
    session: { ensure: async () => ({ status: (await ensure()).status }),
      stop: async () => ({ status: (await stop()).status }) },
    attachments: { restore: async request => resolveOperatorAttachment(attachments, request) },
    pi: {
      ensure: async () => {
        const response = await host('/internal/operator/pi/ensure', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('Pi unavailable');
        return await response.json() as { ready: true; conversationId: string };
      },
      task: async task => {
        const response = await host('/internal/operator/pi/tasks', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
        if (!response.ok) throw new Error('Pi task unavailable');
        return await response.json() as { taskId: string; status: string };
      },
    },
    sync: { seal: async ({ operationId, paths }) => {
      const inspectedResponse = await host('/internal/operator/sync/inspect', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) });
      if (!inspectedResponse.ok) throw new Error('Sync inspection failed');
      const inspected = await inspectedResponse.json() as { files: Array<{ path: string; size: number; sha256: string }> };
      const requestDigest = await digest(JSON.stringify({ operationId, files: inspected.files }));
      const prefix = `.codeflare/operators/${plan.activityId}/${operationId}/`;
      const keys = inspected.files.map(file => `Operators/${file.path}`);
      const prepared = await activity.prepareSync({ operationId, sessionId, requestDigest,
        policyDigest: profile.policyDigest, prefix, keys, deadline: plan.deadline });
      if (!prepared.ok) throw new Error('Sync preparation failed');
      const upload = await host('/internal/bisync-trigger', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId, requestDigest, files: inspected.files }) });
      if (!upload.ok) throw new Error('Sync upload failed');
      const receipt = await upload.json() as { manifestDigest?: string; status?: string };
      if (receipt.status !== 'uploaded' || !receipt.manifestDigest) throw new Error('Sync upload uncertain');
      if (!(await activity.recordSyncUploaded(operationId, receipt.manifestDigest)).ok) throw new Error('Sync seal failed');
      const evidence = await verifyOperatorSync({ activityId: plan.activityId, sessionId, operationId,
        requestDigest, policyDigest: profile.policyDigest, manifestDigest: receipt.manifestDigest,
        prefix, filePrefix: profile.outputPrefix, deadline: plan.deadline }, reader);
      if (!(await activity.recordSyncVerified(operationId, evidence)).ok) throw new Error('Sync verification failed');
      return { status: 'sealed' as const, manifestDigest: receipt.manifestDigest,
        prefix, filePrefix: profile.outputPrefix };
    } },
    storage: { read: async ({ key, maxBytes }) => {
      if (!(await activity.authorizeSyncRead(key, maxBytes)).ok) throw new Error('Storage read denied');
      return reader(key, maxBytes);
    } },
  });
  return { capability: capability as unknown as Fetcher };
}
