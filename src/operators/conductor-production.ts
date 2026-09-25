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
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

/** Profile-neutral managed Conductor composition over existing enterprise owners. */
export async function createConductorProductionCapability(input: { env: Env; plan: OperatorRuntimePlan;
  activity: OperatorActivityStub; generation: number; driveDeadline: number }): Promise<{ capability: Fetcher }> {
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
      reasoningLevels: routes.defaultReasoning ? [routes.defaultReasoning] : [],
      defaultReasoningLevel: routes.defaultReasoning || null, inheritUserDefaults: false } });
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
  const admittedAttachments = projectOperatorAttachments(invocation);
  const packageResources = await activity.getPackageResources();
  const currentAttachments = async () => {
    const prepared = await activity.readApprovedPacketAttachments();
    if (prepared.files.length && prepared.activityId !== plan.activityId) throw new Error('Packet attachment owner changed');
    return parseOperatorAttachmentProjection({ schemaVersion: 1, activityId: plan.activityId,
      files: [...admittedAttachments.files, ...prepared.files] });
  };
  const service = (attachments: typeof admittedAttachments) => new OwnedOperatorSessionService(
    operatorActivitySessionStore(activity), new ContainerOwnedSessionRuntime({ activityId: plan.activityId,
      ownerBucket, sessionId, userEmail: admitted.authority.human.email.toLowerCase(), userGroups: groups,
      routes, bootstrap, packageResources, attachments,
      resolve: containerId => getContainer(env.CONTAINER, containerId) as unknown as OperatorContainerStub }));
  const ensure = async (request: { initialization?: unknown }) => {
    const attachments = await currentAttachments();
    const prepared = await activity.readApprovedPacketAttachments();
    if (prepared.files.length && request.initialization === undefined) throw new Error('Approved input initialization required');
    const initialization = request.initialization === undefined ? undefined
      : parseOperatorPiInitialization(request.initialization, {
        profileId: installationPolicy.resourceProfileId!, attachments, resources: packageResources,
      });
    if (prepared.files.length) {
      const checkpoint = await activity.getCurrentDriveCheckpoint(input.generation);
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
    return service(attachments).ensure({ requestId: 'conductor-session-v1', requestDigest,
      activityId: plan.activityId, ownerBucket, profile: sessionProfile, authority: admitted.authority });
  };
  const stop = () => service(admittedAttachments).stop({ activityId: plan.activityId, ownerBucket, drain: false });
  const container = getContainer(env.CONTAINER, `${ownerBucket}-${sessionId}`) as unknown as OperatorContainerStub;
  const reader = await createOperatorSyncReader(env, ownerBucket, bootstrap);
  const host = (path: string, init: RequestInit) => container.fetch(new Request(`http://container${path}`, init));
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
    const bytes = await readBoundedResponse(response, maxOutputBytes, 'Approved Host packet', driveSignal);
    if (!bytes.byteLength || Date.now() >= deadline) throw new Error('Approved Host packet unavailable');
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
  const capability = new OperatorConductorCapability({ current: async () => { await authorize(); },
    packets: { prepare: preparePacket },
    session: { ensure: async request => ({ status: (await ensure(request)).status }),
      stop: async () => ({ status: (await stop()).status }) },
    attachments: { restore: async request => resolveOperatorAttachment(await currentAttachments(), request) },
    pi: {
      ensure: async () => {
        const response = await host('/internal/operator/pi/ensure', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('Pi unavailable');
        return await response.json() as { ready: true; conversationId: string };
      },
      task: async task => {
        // The parent capability envelope has schemaVersion; the authenticated
        // Host Pi task endpoint accepts only its narrower task fields.
        const hostTask = task.mode === 'tool'
          ? { taskId: task.taskId, digest: task.digest, mode: task.mode,
            toolName: task.toolName, arguments: task.arguments }
          : { taskId: task.taskId, digest: task.digest, mode: task.mode, text: task.text };
        const response = await host('/internal/operator/pi/tasks', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(hostTask) });
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
