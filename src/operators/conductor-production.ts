import { getContainer } from '@cloudflare/containers';
import type { Env } from '../types';
import { parseOperatorContainerProfile } from '../container/operator-context';
import { resolveBucketName, loadEnterpriseRouteConfig, resolveSessionAccessGroup,
  resolveOperatorGroupIdentity, canInvokeOperator } from '../lib/access';
import { openOperatorExecutionAccess } from './execution-context';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { parseOperatorPolicy } from './policy';
import { resolveOperatorInference, type NativeOperatorInference } from './inference-selection';
import { createOwnerNativePiProfileReader, type NativePiBinding } from './native-pi-profile';
import { PiAuthRequiredError, safePiAuthFailure, type SafePiAuthFailure } from './pi-auth-failure';
import { bootstrapOperatorSession } from './session-bootstrap';
import { projectOperatorAttachments, resolveOperatorAttachment,
  persistApprovedPacketAttachment, readApprovedPacketAttachment, parseOperatorAttachmentProjection } from './attachments';
import { fetchApprovedGitPack } from './approved-git-pack';
import { parseOperatorPiInitialization } from './session-initialization';
import { verifyCurrentClaimedBoundaryPacket } from './review-boundary-claim';
import { getValidGithubToken } from '../lib/github-token';
import { getContainerId } from '../lib/container-helpers';
import { readBoundedResponse } from '../lib/bounded-stream';
import { createR2Client } from '../lib/r2-client';
import { isBucketMigrating, isR2SseDisabledForBucket } from '../lib/r2-regime-state';
import { ContainerOwnedSessionRuntime, type OperatorContainerStub, type OperatorSessionBootstrap } from './owned-session-runtime';
import { OwnedOperatorSessionService } from './owned-session';
import { OperatorConductorCapability } from './conductor-capability';
import { createAuthenticatedHistoryTransport, readGithubActionsPublisherIdentity,
  readPublishedReview } from './review-history-transport';
import { operatorActivitySessionStore, createOperatorSyncReader,
  type OperatorActivityStub } from './owned-session-production';
import { verifyOperatorSync } from './sync-verification';
import type { OperatorRuntimePlan, OperatorActivity } from './activity';
import type { OperatorPackageResourceProjection } from './package-resources';
import { operatorOwnerKey } from './browser-activity';
import type { ManagementAdmissionReceipt } from './registry';

function management(receipt: OperatorRuntimePlan['receipt']): receipt is ManagementAdmissionReceipt {
  return 'selection' in receipt;
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

/** Add transport authority only after the real claim/drive; preserve the frozen prepared intent. */
export async function bindClaimedConductorInvocation(input: { env: Env; plan: OperatorRuntimePlan;
  activity: Pick<OperatorActivity, 'getBoundaryStartBinding' | 'operatorGenerationCurrent'>;
  resources: OperatorPackageResourceProjection | null; generation: number; driveDeadline: number }) {
  const { env, plan, activity, resources, generation } = input;
  const binding = await activity.getBoundaryStartBinding(plan.activityId);
  if (!binding) return null; // Ordinary managed/local consumers keep their existing path.
  const invocation = parseOperatorConsumerInvocation(JSON.parse(plan.invocationJson));
  if (!management(plan.receipt) || plan.receipt.selection.operator.profile !== 'conductor'
    || !env.OPERATOR_REGISTRY || !resources) throw Error('Conductor boundary authority denied');
  const registry = env.OPERATOR_REGISTRY.getByName('registry');
  const pinned = plan.receipt.selection;
  const guard = await registry.getBoundaryStartGuard(plan.activityId);
  const prepared = guard && await registry.getBoundaryPreparation(guard.repositoryId, guard.pullRequest);
  const business = invocation.input as { context?: unknown; boundary?: unknown };
  const context = business?.context as Record<string, unknown> | undefined;
  if (!guard?.claimed || !prepared || prepared.activityId !== plan.activityId || prepared.phase !== 'claimed'
    || prepared.roundGeneration !== 1 || prepared.contextDigest !== guard.contextDigest
    || prepared.claimedWorkflowSha !== guard.workflowSha || !guard.workflowSha
    || !/^[a-f0-9]{40}$/i.test(guard.workflowSha)
    || binding.repositoryId !== guard.repositoryId || binding.pullRequest !== guard.pullRequest
    || binding.contextDigest !== guard.contextDigest || binding.session.bucket !== guard.session.bucket
    || binding.session.sessionId !== guard.session.sessionId || binding.session.generation !== guard.session.generation
    || invocation.activityId !== plan.activityId || invocation.operatorId !== pinned.operator.operatorId
    || invocation.revision.reference !== guard.head || invocation.revision.digest !== guard.contextDigest
    || !business || typeof business !== 'object' || Array.isArray(business) || 'boundary' in business
    || !context || typeof context !== 'object' || Array.isArray(context)
    || context.repositoryId !== guard.repositoryId || context.pullRequest !== guard.pullRequest
    || context.head !== guard.head || context.base !== guard.base || context.mergeBase !== guard.mergeBase
    || ![guard.workflowId, guard.runId, guard.runAttempt].every(value => Number.isSafeInteger(value) && value > 0)
    || resources.artifactDigest !== pinned.release.bundleDigest
    || plan.executionContext.artifactDigest !== pinned.release.bundleDigest
    || await digest(JSON.stringify(business)) !== invocation.inputDigest
    || await digest(JSON.stringify(pinned.installation.policy)) !== plan.executionContext.policyDigest) {
    throw Error('Conductor boundary binding changed');
  }
  const current = async () => {
    if (Math.min(plan.deadline, input.driveDeadline) <= Date.now()
      || !await activity.operatorGenerationCurrent(generation)) throw Error('Conductor generation changed');
    const selected = await registry.resolveManagementExecution(pinned.installation.id);
    if (!selected.ok || selected.value.installation.revision !== pinned.installation.revision
      || selected.value.operator.revision !== pinned.operator.revision
      || selected.value.controlsRevision !== pinned.controlsRevision
      || selected.value.release.bundleDigest !== pinned.release.bundleDigest
      || selected.value.operator.profile !== 'conductor') throw Error('Conductor installation changed');
    const authority = await openOperatorExecutionAccess(plan.executionContext, env);
    const human = await resolveOperatorGroupIdentity(authority.human, authority.accessJwt);
    if (!canInvokeOperator(human, selected.value.operator) || await operatorOwnerKey(human) !== prepared.ownerKey
      || await resolveBucketName(env, human.email) !== guard.session.bucket
      || !await verifyCurrentClaimedBoundaryPacket(env, plan.activityId, invocation.source.reference)) {
      throw Error('Conductor claimant changed');
    }
    const next = await registry.getBoundaryStartGuard(plan.activityId);
    if (!next?.claimed || next.repositoryId !== guard.repositoryId || next.pullRequest !== guard.pullRequest
      || next.contextDigest !== guard.contextDigest || next.head !== guard.head || next.base !== guard.base
      || next.mergeBase !== guard.mergeBase || next.workflowId !== guard.workflowId || next.workflowSha !== guard.workflowSha
      || next.runId !== guard.runId || next.runAttempt !== guard.runAttempt || next.generation !== guard.generation
      || next.session.bucket !== guard.session.bucket || next.session.sessionId !== guard.session.sessionId
      || next.session.generation !== guard.session.generation) throw Error('Conductor claim changed');
    if (Math.min(plan.deadline, input.driveDeadline) <= Date.now()
      || !await activity.operatorGenerationCurrent(generation)) throw Error('Conductor generation changed');
  };
  await current();
  const token = await getValidGithubToken(env, guard.session.bucket);
  if (!token) throw Error('Conductor publisher unavailable');
  const publisher = await readGithubActionsPublisherIdentity({ token, fetch: request => fetch(request) });
  if (!publisher) throw Error('Conductor publisher unavailable');
  const resourceDigest = await digest(JSON.stringify(resources.files.map(({ destination, sha256, size }) => ({ destination, sha256, size }))));
  await current();
  return parseOperatorConsumerInvocation({ ...invocation, input: { ...business, boundary: {
    activityId: plan.activityId, generation: prepared.roundGeneration,
    workflowId: guard.workflowId, runId: guard.runId, runAttempt: guard.runAttempt,
    commentAuthorId: publisher.commentAuthorId, checkAppId: publisher.checkAppId,
    inputDigest: invocation.inputDigest, packageDigest: pinned.release.bundleDigest,
    resourceDigest, policyDigest: plan.executionContext.policyDigest,
  } } });
}

/** Profile-neutral managed/native Conductor composition over existing enterprise owners. */
export async function createConductorProductionCapability(input: { env: Env; plan: OperatorRuntimePlan;
  activity: OperatorActivityStub; generation: number; driveDeadline: number }): Promise<{ capability: Fetcher }> {
  const { env, plan, activity } = input;
  if (!management(plan.receipt) || plan.receipt.selection.operator.profile !== 'conductor') {
    throw new Error('Conductor authority denied');
  }
  const pinned = plan.receipt.selection;
  const invocation = parseOperatorConsumerInvocation(JSON.parse(plan.invocationJson));
  const nativeSelection: NativeOperatorInference | undefined = invocation.resources.inference
    && 'source' in invocation.resources.inference ? invocation.resources.inference : undefined;
  let managedSelection = invocation.resources.inference && !('source' in invocation.resources.inference)
    ? invocation.resources.inference : undefined;
  let resolvedOwnerBucket: string | undefined;
  let nativeOwnerKey: string | undefined;
  const authorize = async () => {
    if (Math.min(plan.deadline, input.driveDeadline) <= Date.now() || !env.OPERATOR_REGISTRY
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
    if (nativeSelection) {
      if (nativeOwnerKey !== undefined && await operatorOwnerKey(human) !== nativeOwnerKey
        || resolvedOwnerBucket !== undefined && await resolveBucketName(env, human.email) !== resolvedOwnerBucket) {
        throw new Error('Conductor native owner changed');
      }
    }
    const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
      headers: { 'cf-access-jwt-assertion': authority.accessJwt },
    }), env);
    const routes = await loadEnterpriseRouteConfig(env, groups);
    if (!nativeSelection) {
      managedSelection = resolveOperatorInference({ eligible: { routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute,
        defaultReasoningLevel: routes.defaultReasoning }, trusted: managedSelection,
        policy: { inference: { routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute,
          reasoningLevels: routes.defaultReasoning ? [routes.defaultReasoning] : [],
          defaultReasoningLevel: routes.defaultReasoning || null, inheritUserDefaults: false } } });
    }
    for (const policy of [pinned.installation.policy, pinned.operator.policy,
      selected.value.installation.policy, selected.value.operator.policy]) {
      if (nativeSelection && (!policy.inference
        || !['session', 'pi', 'storage'].every(capability => policy.capabilities.includes(capability)))) {
        throw new Error('Conductor native resources denied');
      }
      // Omitted installation inference is legacy managed-only, never native approval.
      if (policy.inference) {
        resolveOperatorInference({ eligible: { routeIds: routes.routeCatalog, defaultRouteId: routes.defaultRoute,
          defaultReasoningLevel: routes.defaultReasoning, allowPersonalPiProviders: routes.allowPersonalPiProviders },
          policy: { inference: policy.inference }, trusted: nativeSelection ?? managedSelection });
      }
    }
    if (Math.min(plan.deadline, input.driveDeadline) <= Date.now()
      || !await activity.operatorGenerationCurrent(input.generation)) throw new Error('Conductor generation changed');
    return { authority: { ...authority, human }, selection: selected.value };
  };
  const admitted = await authorize();
  nativeOwnerKey = await operatorOwnerKey(admitted.authority.human);
  const installationPolicy = admitted.selection.installation.policy;
  if (!['session', 'pi', 'storage'].every(capability => installationPolicy.capabilities.includes(capability))
    || !installationPolicy.resourceProfileId || invocation.resources.session?.profileId !== installationPolicy.resourceProfileId
    || invocation.resources.storage?.scopeId !== installationPolicy.resourceProfileId || !invocation.resources.inference) {
    throw new Error('Conductor resources denied');
  }
  const ownerBucket = await resolveBucketName(env, admitted.authority.human.email);
  resolvedOwnerBucket = ownerBucket;
  let bootstrap: OperatorSessionBootstrap | undefined;
  const sessionBootstrap = async () => {
    const current = await authorize();
    if (!bootstrap) {
      ({ bootstrap } = await bootstrapOperatorSession({ env, authority: current.authority, ownerBucket,
        loggingEnabled: admitted.selection.operator.policy.loggingEnabled !== false }));
    }
    await authorize();
    return bootstrap;
  };
  const groups = await resolveSessionAccessGroup(new Request('https://operator.internal/', {
    headers: { 'cf-access-jwt-assertion': admitted.authority.accessJwt },
  }), env);
  const routes = await loadEnterpriseRouteConfig(env, groups);
  const storage = { readPrefixes: ['Operators/', `.codeflare/operators/${plan.activityId}/`],
    writePrefixes: ['Operators/', `.codeflare/operators/${plan.activityId}/`] };
  const managedInference = managedSelection;
  // Both installed restrictions and human eligibility precede bootstrap effects.
  // Native authentication remains checked before its deferred bootstrap.
  if (!nativeSelection) await sessionBootstrap();
  const effectiveInference = nativeSelection ?? managedInference!;
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
    storage, inference: nativeSelection ? { allowedSources: ['pi-native'], routeIds: [], defaultRouteId: null,
      reasoningLevels: [nativeSelection.reasoningLevel], defaultReasoningLevel: nativeSelection.reasoningLevel,
      inheritUserDefaults: false } : { routeIds: [managedInference!.routeId], defaultRouteId: managedInference!.routeId,
      reasoningLevels: managedInference!.reasoningLevel ? [managedInference!.reasoningLevel] : [],
      defaultReasoningLevel: managedInference!.reasoningLevel, inheritUserDefaults: false } });
  const sessionId = `conductor${(await digest(plan.activityId)).slice(0, 16)}`;
  const authBinding = nativeSelection ? { ownerKey: nativeOwnerKey, activityId: plan.activityId,
    sessionId, generation: input.generation, selectionDigest: await digest(JSON.stringify(nativeSelection)),
    profileDigest: nativeSelection.profileDigest, deadline: plan.deadline } : undefined;
  const profile = parseOperatorContainerProfile({ schemaVersion: 1, activityId: plan.activityId,
    operatorId: pinned.operator.operatorId, sessionId, ownerBucket,
    policyDigest: plan.executionContext.policyDigest, deadline: plan.deadline, outputPrefix: 'Operators/',
    human: { subject: admitted.authority.human.subject, email: admitted.authority.human.email.toLowerCase(),
      issuer: new URL(admitted.authority.human.issuer).href, audiences: [...admitted.authority.human.audiences] },
    policy, jwtPolicy: { mode: 'off', destinations: [] }, piProfile: {
      ...(nativeSelection ? { source: 'pi-native', api: nativeSelection.api, authBinding } : {}),
      provider: nativeSelection?.provider ?? 'codeflare-gateway',
      model: nativeSelection?.model ?? managedInference!.routeId,
      thinkingLevel: effectiveInference.reasoningLevel ?? 'off',
      systemPrompt: 'Execute only the installed Conductor package procedure over parent-restored inputs and approved resources.',
      tools: ['read', 'write', 'subagent'] } });
  const admittedAttachments = projectOperatorAttachments(invocation);
  const packageResources = await activity.getPackageResources();
  const currentAttachments = async () => {
    const prepared = await activity.readApprovedPacketAttachments();
    if (prepared.files.length && prepared.activityId !== plan.activityId) throw new Error('Packet attachment owner changed');
    return parseOperatorAttachmentProjection({ schemaVersion: 1, activityId: plan.activityId,
      files: [...admittedAttachments.files, ...prepared.files] });
  };
  const service = async (attachments: typeof admittedAttachments) => new OwnedOperatorSessionService(
    operatorActivitySessionStore(activity), new ContainerOwnedSessionRuntime({ activityId: plan.activityId,
      ownerBucket, sessionId, userEmail: admitted.authority.human.email.toLowerCase(), userGroups: groups,
      routes, bootstrap: await sessionBootstrap(), packageResources, attachments,
      current: async () => { await authorize(); },
      resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as OperatorContainerStub }));
  let privateBinding: NativePiBinding | undefined;
  let loginStop: SafePiAuthFailure | undefined;
  const authorizeNativeAuth = async () => {
    await authorize();
    const current = await activity.getRuntimePlan();
    if (!nativeSelection || !current || current.activityId !== plan.activityId
      || current.invocationJson !== plan.invocationJson
      || JSON.stringify(current.inferenceSelection) !== JSON.stringify(nativeSelection)) {
      throw new Error('Conductor native admission changed');
    }
    if (current.authFailure) {
      const failure = safePiAuthFailure(current.authFailure);
      if (!failure || failure.provider !== nativeSelection.provider) throw new Error('Invalid Pi authentication outcome');
      loginStop = failure; privateBinding = undefined;
    }
    if (loginStop) throw new PiAuthRequiredError(loginStop.provider, loginStop.reason);
  };
  const persistLoginStop = async (failure: SafePiAuthFailure) => {
    loginStop = failure; privateBinding = undefined;
    if (!nativeSelection || !await activity.recordConductorPiAuthFailure(input.generation, nativeSelection.profileDigest, failure)) {
      throw new Error('Conductor authentication stop unavailable');
    }
  };
  const nativeAuth = async () => {
    if (!nativeSelection) return undefined;
    await authorizeNativeAuth();
    try {
      if (!privateBinding) {
        const reader = await createOwnerNativePiProfileReader({ env, ownerBucket,
          deadline: Math.min(plan.deadline, input.driveDeadline), authorize: authorizeNativeAuth });
        privateBinding = await reader.bind(nativeSelection);
      }
      if (privateBinding.expiresAt !== null && privateBinding.expiresAt <= Date.now()) {
        throw new PiAuthRequiredError(nativeSelection.provider, 'expired');
      }
      await authorizeNativeAuth();
      return privateBinding;
    } catch (error) {
      if (error instanceof PiAuthRequiredError) await persistLoginStop(error.authFailure);
      throw error;
    }
  };
  const ensure = async (request: { initialization?: unknown }) => {
    await nativeAuth();
    const attachments = await currentAttachments();
    const prepared = await activity.readApprovedPacketAttachments();
    if (prepared.files.length && request.initialization === undefined) throw new Error('Approved input initialization required');
    const initialization = request.initialization === undefined ? undefined
      : parseOperatorPiInitialization(request.initialization, {
        profileId: installationPolicy.resourceProfileId!, attachments, resources: packageResources,
      });
    if (prepared.files.length) {
      const checkpointJson = await activity.getCurrentDriveCheckpointJson(input.generation);
      const checkpoint: unknown = checkpointJson === null ? null : JSON.parse(checkpointJson);
      const checkpointInitialization = checkpoint && typeof checkpoint === 'object' && 'initialization' in checkpoint
        ? checkpoint.initialization : undefined;
      if (!checkpoint || JSON.stringify(initialization) !== JSON.stringify(checkpointInitialization)) {
        throw new Error('Approved input initialization changed');
      }
    }
    const sessionProfile = initialization ? parseOperatorContainerProfile({ ...profile,
      piProfile: { ...profile.piProfile, tools: ['read', 'write'], initialization } }) : profile;
    const requestDigest = await digest(JSON.stringify({ invocationJson: plan.invocationJson,
      attachments, ...(initialization ? { initialization } : {}) }));
    const current = await authorize();
    const state = await (await service(attachments)).ensure({ requestId: 'conductor-session-v1', requestDigest,
      activityId: plan.activityId, ownerBucket, profile: sessionProfile, authority: current.authority });
    if (state.status === 'ready') await bindNativeHost();
    return state;
  };
  // Cleanup keeps its existing authority-independent owned-session destruction path.
  const stop = async () => {
    privateBinding = undefined;
    return new OwnedOperatorSessionService(operatorActivitySessionStore(activity), new ContainerOwnedSessionRuntime({
      activityId: plan.activityId, ownerBucket, sessionId, userEmail: admitted.authority.human.email.toLowerCase(),
      userGroups: groups, routes, bootstrap: bootstrap!,
      resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as OperatorContainerStub,
    })).stop({ activityId: plan.activityId, ownerBucket, drain: false });
  };
  const container = getContainer(env.CONTAINER, `${ownerBucket}-${sessionId}`) as unknown as OperatorContainerStub;
  const reader = async (key: string, maxBytes: number) => {
    const read = await createOperatorSyncReader(env, ownerBucket, await sessionBootstrap());
    return read(key, maxBytes);
  };
  const host = async (path: string, init: RequestInit) => {
    await authorize();
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(Math.max(1, Math.min(plan.deadline, input.driveDeadline) - Date.now()))]);
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Conductor Host deadline expired'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    let response: Response;
    try {
      const pending = container.fetch(new Request(`http://container${path}`, { ...init, signal, redirect: 'manual' }));
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => {});
      response = await Promise.race([pending, cancelled]);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
    try { await authorize(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    return response;
  };
  const bindNativeHost = async () => {
    const bound = await nativeAuth();
    if (!bound) return;
    await container.bindOperatorAuthority?.((await authorize()).authority);
    const response = await host('/internal/operator/pi/auth-bind', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor: authBinding,
        auth: bound.auth, ...(bound.env ? { env: bound.env } : {}), expiresAt: bound.expiresAt }) });
    await readPiResult(response);
    if (!response.ok) throw new Error('Pi authentication binding unavailable');
  };
  const readPiResult = async (response: Response) => {
    const signal = AbortSignal.timeout(Math.max(1, Math.min(plan.deadline, input.driveDeadline) - Date.now()));
    const value: unknown = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, 64 * 1024, 'Pi result', signal)));
    await authorize();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi response');
    const result = value as Record<string, unknown>;
    if (result.authFailure !== undefined) {
      const failure = safePiAuthFailure(result.authFailure);
      if (!failure || failure.provider !== nativeSelection?.provider) throw new Error('Invalid Pi authentication outcome');
      await persistLoginStop(failure);
      if (!response.ok) throw new PiAuthRequiredError(failure.provider, failure.reason);
      // Host task outcomes retain their existing status and carry only closed safe detail.
      if (typeof result.taskId !== 'string' || typeof result.status !== 'string') throw new Error('Invalid Pi task outcome');
      return { taskId: result.taskId, status: result.status, authFailure: failure };
    }
    return value;
  };
  const preparePacket = async ({ preparationId, lane }: { preparationId: string; lane: string }, signal: AbortSignal) => {
    if (!Number.isSafeInteger(input.driveDeadline) || input.driveDeadline <= Date.now()
      || !env.OPERATOR_REGISTRY) throw new Error('Packet drive unavailable');
    const driveSignal = AbortSignal.any([signal,
      AbortSignal.timeout(Math.max(1, input.driveDeadline - Date.now()))]);
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const guard = await registry.getBoundaryStartGuard(plan.activityId);
    const reference = invocation.source.reference;
    const names = reference.split('/');
    const boundaryInput = invocation.input && typeof invocation.input === 'object' && !Array.isArray(invocation.input)
      ? invocation.input as Record<string, unknown> : null;
    const acknowledgedHead = boundaryInput?.acknowledgedHead;
    if (!guard?.claimed || guard.session.bucket !== ownerBucket || !boundaryInput
      || invocation.source.kind !== 'session' || names.length !== 2
      || names.some(name => !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..')
      || invocation.revision.reference !== guard.head || invocation.revision.digest !== guard.contextDigest
      || acknowledgedHead !== null && (typeof acknowledgedHead !== 'string'
        || !/^[a-f0-9]{40}$/.test(acknowledgedHead) || acknowledgedHead === guard.head)) {
      throw new Error('Packet boundary unavailable');
    }
    const current = async (github = false) => {
      await authorize();
      const next = await registry.getBoundaryStartGuard(plan.activityId);
      if (!next?.claimed || next.contextDigest !== guard.contextDigest || next.runId !== guard.runId
        || next.runAttempt !== guard.runAttempt || next.generation !== guard.generation
        || next.head !== guard.head || next.workflowSha !== guard.workflowSha
        || JSON.stringify(next.session) !== JSON.stringify(guard.session)
        || driveSignal.aborted || Date.now() >= input.driveDeadline
        || github && !await verifyCurrentClaimedBoundaryPacket(env, plan.activityId, reference)) {
        throw new Error('Packet boundary changed');
      }
    };
    await current(true);
    const accepted = await currentAttachments();
    const locator = `packet-${await digest(`${plan.activityId}:${preparationId}:${lane}`)}`;
    const attachment = accepted.files.find(item => item.name === `packet-${lane}.json`
      && item.locator === locator);
    const bootstrap = await sessionBootstrap();
    const client = createR2Client({ R2_ACCESS_KEY_ID: bootstrap.r2AccessKeyId,
      R2_SECRET_ACCESS_KEY: bootstrap.r2SecretAccessKey });
    if (attachment) {
      const bytes = await readApprovedPacketAttachment({ projection: accepted, file: attachment,
        ownerBucket, endpoint: bootstrap.r2Endpoint, fetcher: request => client.fetch(request),
        authorize: () => current(), isBucketMigrating: () => isBucketMigrating(env, ownerBucket),
        isSseDisabledForBucket: () => isR2SseDisabledForBucket(env, ownerBucket),
        sseKey: env.ENCRYPTION_KEY, signal: driveSignal });
      await current(true);
      return { preparationId, attachment, bytes: base64(bytes) };
    }
    if (accepted.files.some(item => item.name === `packet-${lane}.json` || item.locator === locator)
      || await activity.getOwnedSession()) throw new Error('Packet preparation after session start denied');
    const token = await getValidGithubToken(env, ownerBucket);
    if (!token) throw new Error('GitHub transport unavailable');
    const raw = boundaryInput.evidence && typeof boundaryInput.evidence === 'object'
      && !Array.isArray(boundaryInput.evidence)
      ? (boundaryInput.evidence as Record<string, unknown>).rejectedFindings : undefined;
    let rejectedFindings: Array<Record<string, unknown>> | undefined;
    let verifiedOriginalFindings: Array<{ id: string; lane: string; severity: string;
      path: string; line: number; message: string; evidence: string }> | undefined;
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw new Error('Invalid rejected findings');
      const fields = ['findingId', 'priorActivityId', 'priorRound', 'priorHead',
        'originalReportDigest', 'rationale', 'evidence'];
      const ids = new Set<string>();
      rejectedFindings = [];
      for (const value of raw) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)))
          throw new Error('Invalid rejected finding authority');
        const item = value as Record<string, unknown>;
        if (typeof item.findingId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.findingId)
          || ids.has(item.findingId) || typeof item.priorActivityId !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(item.priorActivityId)
          || !Number.isSafeInteger(item.priorRound) || (item.priorRound as number) < 1
          || typeof item.priorHead !== 'string' || !/^[a-f0-9]{40}$/.test(item.priorHead)
          || item.priorHead !== acknowledgedHead
          || typeof item.originalReportDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.originalReportDigest)
          || typeof item.rationale !== 'string' || !item.rationale.trim() || item.rationale.length > 2048
          || typeof item.evidence !== 'string' || !item.evidence.trim() || item.evidence.length > 2048)
          throw new Error('Invalid rejected finding');
        ids.add(item.findingId);
        rejectedFindings.push(Object.fromEntries(fields.map(field => [field, item[field]])));
      }
      if (rejectedFindings.length) {
        await current(true);
        const publisher = await readGithubActionsPublisherIdentity({ token, fetch: request => fetch(request) });
        if (!publisher) throw new Error('Review publisher unavailable');
        const history = createAuthenticatedHistoryTransport({ repository: reference,
          repositoryId: guard.repositoryId, pullRequest: guard.pullRequest, head: guard.head,
          base: guard.base, token, fetch: request => fetch(request), current: () => current(true) });
        const originalFindings: NonNullable<typeof verifiedOriginalFindings> = [];
        for (const key of new Set(rejectedFindings.map(item => JSON.stringify([item.priorActivityId,
          item.priorHead, item.priorRound, item.originalReportDigest])))) {
          const [priorActivityId, priorHead, priorRound, originalReportDigest] = JSON.parse(key) as
            [string, string, number, string];
          const published = await readPublishedReview({ repository: reference,
            repositoryId: guard.repositoryId, pullRequest: guard.pullRequest,
            activityId: priorActivityId, head: priorHead, currentHead: guard.head,
            trustedWorkflowId: guard.workflowId, publisher, history });
          if (published.status !== 'published' || published.activityId !== priorActivityId
            || published.head !== priorHead || published.round !== priorRound
            || published.artifactDigest !== originalReportDigest || published.repositoryId !== guard.repositoryId
            || published.pullRequest !== guard.pullRequest || published.omittedFindings !== 0)
            throw new Error('Rejected finding publication unavailable');
          for (const item of rejectedFindings.filter(row => row.priorActivityId === priorActivityId
            && row.priorHead === priorHead && row.priorRound === priorRound
            && row.originalReportDigest === originalReportDigest)) {
            const matches = published.findings.filter(finding => finding.id === item.findingId
              && !finding.message.includes('[truncated]') && !finding.evidence.includes('[truncated]'));
            if (matches.length !== 1) throw new Error('Rejected finding publication unavailable');
            originalFindings.push(matches[0]!);
          }
        }
        if (originalFindings.length !== rejectedFindings.length) throw new Error('Rejected finding unavailable');
        verifiedOriginalFindings = originalFindings;
        await current(true);
      }
    }
    const deadline = Math.min(plan.deadline, input.driveDeadline, Date.now() + 5 * 60_000);
    const maxPackBytes = 32 * 1024 * 1024, maxOutputBytes = 8 * 1024 * 1024;
    const pack = await fetchApprovedGitPack({ owner: names[0], repository: names[1], head: guard.head,
      acknowledgedHead: acknowledgedHead as string | null, deadline, maxPackBytes, signal: driveSignal,
      send: request => { const headers = new Headers(request.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(new Request(request, { headers })); } });
    await current(true);
    const metadata = { head: guard.head, acknowledgedHead, lane, deadline, maxPackBytes,
      maxCheckoutBytes: 128 * 1024 * 1024, maxOutputBytes };
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(metadata))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const source = getContainer(env.CONTAINER,
      getContainerId(guard.session.bucket, guard.session.sessionId)) as unknown as OperatorContainerStub;
    const response = await source.fetch(new Request('http://container/internal/operator/approved-packet', {
      method: 'POST', signal: driveSignal, headers: { 'content-type': 'application/x-git-packed-objects',
        'x-codeflare-packet-input': encoded }, body: Uint8Array.from(pack),
    }));
    if (response.status !== 200 || response.headers.get('content-type') !== 'application/octet-stream') {
      throw new Error('Approved Host packet unavailable');
    }
    let bytes = await readBoundedResponse(response, maxOutputBytes, 'Approved Host packet', driveSignal);
    if (!bytes.byteLength || Date.now() >= deadline) throw new Error('Approved Host packet unavailable');
    if (rejectedFindings?.length) {
      const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as Record<string, unknown>;
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)
        || !packet.evidence || typeof packet.evidence !== 'object' || Array.isArray(packet.evidence))
        throw new Error('Approved packet evidence unavailable');
      bytes = new TextEncoder().encode(JSON.stringify({ ...packet,
        evidence: { ...packet.evidence as Record<string, unknown>, rejectedFindings,
          originalFindings: verifiedOriginalFindings } }));
      if (bytes.length > maxOutputBytes) throw new Error('Approved packet too large');
    }
    await current(true);
    const file = { name: `packet-${lane}.json`, mediaType: 'application/json', size: bytes.byteLength,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
        .map(byte => byte.toString(16).padStart(2, '0')).join(''),
      locator: `packet-${await digest(`${plan.activityId}:${preparationId}:${lane}`)}` };
    const previous = await currentAttachments();
    const prior = previous.files.find(item => item.name === file.name || item.locator === file.locator);
    if (prior && (prior.name !== file.name || prior.mediaType !== file.mediaType
      || prior.locator !== file.locator || prior.size !== file.size || prior.sha256 !== file.sha256)) {
      throw new Error('Approved packet conflict');
    }
    const projection = parseOperatorAttachmentProjection({ schemaVersion: 1, activityId: plan.activityId,
      files: prior ? previous.files : [...previous.files, file] });
    await persistApprovedPacketAttachment({ projection, file, bytes, ownerBucket, endpoint: bootstrap.r2Endpoint,
      fetcher: request => client.fetch(request), authorize: () => current(),
      isBucketMigrating: () => isBucketMigrating(env, ownerBucket),
      isSseDisabledForBucket: () => isR2SseDisabledForBucket(env, ownerBucket),
      sseKey: env.ENCRYPTION_KEY, signal: driveSignal });
    await current(true);
    const saved = await activity.saveApprovedPacketAttachment({ preparationId, driveGeneration: input.generation,
      lane, ...file, bytes });
    if (!saved.ok) throw new Error('Approved packet identity changed');
    await current();
    return { preparationId: saved.preparationId, attachment: saved.attachment, bytes: base64(bytes) };
  };
  const history = (() => {
    const reference = invocation.source.reference;
    if (invocation.source.kind !== 'session' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reference)
      || !env.OPERATOR_REGISTRY) return undefined;
    let transport: ReturnType<typeof createAuthenticatedHistoryTransport> | undefined;
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const current = async () => {
      await authorize();
      if (Date.now() >= input.driveDeadline) throw new Error('History drive expired');
      const guard = await registry.getBoundaryStartGuard(plan.activityId);
      if (!guard?.claimed || guard.session.bucket !== ownerBucket
        || guard.head !== invocation.revision.reference || !guard.runId || !guard.runAttempt
        || !await verifyCurrentClaimedBoundaryPacket(env, plan.activityId, reference)) {
        throw new Error('History boundary changed');
      }
      return guard;
    };
    return { read: async (request: Parameters<NonNullable<ReturnType<typeof createAuthenticatedHistoryTransport>>['read']>[0]) => {
      try {
        const guard = await current();
        if (!transport) {
          const token = await getValidGithubToken(env, ownerBucket);
          if (!token) throw new Error('History credential unavailable');
          const frozen = { repositoryId: guard.repositoryId, pullRequest: guard.pullRequest,
            head: guard.head, base: guard.base, contextDigest: guard.contextDigest, runId: guard.runId,
            runAttempt: guard.runAttempt, workflowSha: guard.workflowSha, generation: guard.generation };
          transport = createAuthenticatedHistoryTransport({ repository: reference,
            repositoryId: frozen.repositoryId, pullRequest: frozen.pullRequest, head: frozen.head,
            base: frozen.base, token, fetch: request => fetch(request), current: async () => {
              const next = await current();
              if (Object.entries(frozen).some(([key, value]) => (next as unknown as Record<string, unknown>)[key] !== value))
                throw new Error('History claim changed');
            } });
        }
        const result = await transport.read(request);
        await current();
        return result;
      } catch { return { complete: false }; }
    } };
  })();
  const capability = new OperatorConductorCapability({ current: async () => { await authorize(); },
    ...(history ? { history } : {}),
    packets: { prepare: preparePacket },
    session: { ensure: async request => ({ status: (await ensure(request)).status }),
      stop: async () => ({ status: (await stop()).status }) },
    attachments: { restore: async request => resolveOperatorAttachment(await currentAttachments(), request) },
    pi: {
      ensure: async () => {
        await bindNativeHost();
        const response = await host('/internal/operator/pi/ensure', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: '{}' });
        const value = await readPiResult(response);
        if (!response.ok) throw new Error('Pi unavailable');
        return value as { ready: true; conversationId: string };
      },
      task: async task => {
        await bindNativeHost();
        // The parent capability envelope has schemaVersion; the authenticated
        // Host Pi task endpoint accepts only its narrower task fields.
        const hostTask = task.mode === 'tool'
          ? { taskId: task.taskId, digest: task.digest, mode: task.mode,
            toolName: task.toolName, arguments: task.arguments }
          : { taskId: task.taskId, digest: task.digest, mode: task.mode, text: task.text };
        const response = await host('/internal/operator/pi/tasks', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(hostTask) });
        const value = await readPiResult(response);
        if (!response.ok) throw new Error('Pi task unavailable');
        return value as { taskId: string; status: string; authFailure?: SafePiAuthFailure };
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
