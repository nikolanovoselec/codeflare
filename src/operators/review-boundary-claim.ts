import type { Env } from '../types';
import { getContainerId } from '../lib/container-helpers';
import { readBoundedResponse } from '../lib/bounded-stream';
import { getValidGithubToken } from '../lib/github-token';
import { canInvokeOperator, requireOperatorHumanContext } from '../lib/access';
import { SETUP_KEYS } from '../lib/kv-keys';
import { D1SessionRepository } from '../lib/session-repository';
import { isEnterpriseMode } from '../lib/subscription';
import { operatorOwnerKey } from './browser-activity';
import { resolveBoundaryAction, type BoundaryActionBinding } from './boundary-action-trust';
import { verifyBoundaryActionOidc, type BoundaryActionIdentity } from './boundary-action-oidc';
import type { BoundaryPreparation, BoundaryPublicationInput } from './registry';
import { parseOperatorPiInitialization } from './session-initialization';
import { parseOperatorAttachmentProjection } from './attachments';
import { verifyOperatorPackageResourceProjection } from './package-resources';

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLAIM_PATH = '/operator-webhook/v1/activities/claims/boundary';
const PUBLICATION_PATH = '/operator-webhook/v1/activities/claims/publication';
const PREPARATION_PATH = '/operator-webhook/v1/activities/claims/publication-preparation';
export interface BoundaryActionClaimRequest {
  repositoryId: number; pullRequest: number; head: string; base: string; mergeBase: string;
  runId: number; runAttempt: number;
}
export interface BoundaryActionClaimContext extends BoundaryActionClaimRequest { workflowId: number }
function sameClaim(verified: BoundaryActionClaimContext, input: BoundaryActionClaimRequest, workflowId: number): boolean {
  return verified.repositoryId === input.repositoryId && verified.pullRequest === input.pullRequest
    && verified.head === input.head && verified.base === input.base && verified.mergeBase === input.mergeBase
    && verified.runId === input.runId && verified.runAttempt === input.runAttempt && verified.workflowId === workflowId;
}

/** Read untrusted signed-payload hints only to choose expected claims; they grant no I/O or principal. */
function tokenHints(token: string): { repository: string; workflowSha: string } | null {
  if (typeof token !== 'string' || token.length > 8_192) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')
        + '='.repeat((4 - parts[1].length % 4) % 4)), char => char.charCodeAt(0)))) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const hint = payload as Record<string, unknown>;
    return typeof hint.repository === 'string' && REPOSITORY.test(hint.repository)
      && typeof hint.workflow_sha === 'string' && SHA.test(hint.workflow_sha)
      ? { repository: hint.repository, workflowSha: hint.workflow_sha } : null;
  } catch { return null; }
}

/** No caller-provided GitHub identity, event metadata or prepared actor is authoritative. */
export function verifyBoundaryActionRun(input: {
  prepared: Pick<BoundaryPreparation, 'repositoryId' | 'pullRequest' | 'revision' | 'workflowId'>;
  oidc: Omit<BoundaryActionIdentity, 'eventName'> & { eventName: string };
  action: { repositoryId: number; workflowId: number; workflowPath: string; protectedRef: string;
    branchSha: string; applicable: boolean };
  github: { repository: { id: number; full_name: string };
    run: { id: number; run_attempt: number; workflow_id: number; event: string; path: string;
      repository: { id: number }; pull_requests: Array<{ number: number }> };
    pullRequest: { number: number; state: string; head: { sha: string; repo: { id: number } };
      base: { sha: string; repo: { id: number } } };
    compare: { merge_base_commit: { sha: string } };
    headPullRequests: number[]; matchingPullRequests: number[] };
}): BoundaryActionClaimContext | null {
  try {
    const { prepared: p, oidc, action, github: g } = input;
    const r = p.revision;
    if (!action.applicable || p.repositoryId !== action.repositoryId || p.workflowId !== action.workflowId
      || oidc.repositoryId !== p.repositoryId || oidc.eventName !== 'pull_request_target'
      || oidc.workflowSha !== action.branchSha
      || oidc.workflowRef !== `${oidc.repository}/${action.workflowPath}@${action.protectedRef}`
      || g.repository.id !== p.repositoryId || g.repository.full_name !== oidc.repository
      || g.run.id !== oidc.runId || g.run.run_attempt !== oidc.runAttempt
      || g.run.workflow_id !== action.workflowId || g.run.event !== 'pull_request_target'
      || g.run.path !== action.workflowPath || g.run.repository.id !== p.repositoryId
      || !Array.isArray(g.run.pull_requests) || g.run.pull_requests.length !== 1
      || g.run.pull_requests[0].number !== p.pullRequest
      || g.pullRequest.number !== p.pullRequest || g.pullRequest.state !== 'open'
      || g.pullRequest.head.repo.id !== p.repositoryId || g.pullRequest.base.repo.id !== p.repositoryId
      || g.pullRequest.head.sha !== r.head || g.pullRequest.base.sha !== r.base
      || g.compare.merge_base_commit.sha !== r.mergeBase
      || g.headPullRequests.length !== 1 || g.headPullRequests[0] !== p.pullRequest
      || g.matchingPullRequests.length !== 1 || g.matchingPullRequests[0] !== p.pullRequest
      || ![r.head, r.base, r.mergeBase, action.branchSha].every(value => SHA.test(value))) return null;
    return { repositoryId: p.repositoryId, pullRequest: p.pullRequest, head: r.head, base: r.base,
      mergeBase: r.mergeBase, workflowId: action.workflowId, runId: oidc.runId, runAttempt: oidc.runAttempt };
  } catch { return null; }
}

/** Authenticated GitHub and protected workflow bytes must still match the exact current PR. */
async function verifyCurrentBoundaryAction(prepared: BoundaryPreparation, action: BoundaryActionBinding,
  identity: BoundaryActionIdentity, input: BoundaryActionClaimRequest, githubToken: string): Promise<BoundaryActionClaimContext | null> {
  const [repoOwner, repoName] = identity.repository.split('/');
  const root = `/repos/${repoOwner}/${repoName}`;
  async function github(path: string): Promise<unknown> {
    const response = await fetch(`https://api.github.com${path}`, { redirect: 'error',
      headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw Error('GitHub context unavailable');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await readBoundedResponse(response, 128 * 1024, 'Action claim GitHub context'))) as unknown;
  }
  const repo = await github(root) as { id: number; full_name: string; default_branch: string };
  const branchPath = `${root}/branches/${encodeURIComponent(action.protectedRef.slice('refs/heads/'.length))}`;
  const [workflow, branch, pr, run] = await Promise.all([
    github(`${root}/actions/workflows/${action.workflowId}`), github(branchPath),
    github(`${root}/pulls/${input.pullRequest}`),
    github(`${root}/actions/runs/${input.runId}/attempts/${input.runAttempt}`),
  ]) as [{ id: number; path: string; state: string },
    { name: string; protected: boolean; commit: { sha: string } },
    { number: number; state: string; head: { sha: string; ref: string; repo: { id: number } };
      base: { sha: string; ref: string; repo: { id: number } } }, unknown];
  if (!branch?.commit?.sha || !SHA.test(branch.commit.sha) || pr?.head?.ref?.includes(':')) return null;
  const [contents, headPulls, matchingPulls, compared] = await Promise.all([
    github(`${root}/contents/${action.workflowPath}?ref=${branch.commit.sha}`),
    github(`${root}/commits/${prepared.revision.head}/pulls?per_page=2`),
    github(`${root}/pulls?state=open&head=${encodeURIComponent(`${repoOwner}:${pr.head.ref}`)}&per_page=2`),
    github(`${root}/compare/${prepared.revision.base}...${prepared.revision.head}`),
  ]) as [{ content: string; encoding: string }, Array<{ number: number }>,
    Array<{ number: number }>, { merge_base_commit: { sha: string } }];
  const applicable = (await resolveBoundaryAction({ action, repository: repo,
    workflow, branch, contents, event: 'pull_request_target' })).selection === 'remote';
  return verifyBoundaryActionRun({ prepared, oidc: identity, action: {
    repositoryId: action.repositoryId, workflowId: action.workflowId,
    workflowPath: action.workflowPath, protectedRef: action.protectedRef,
    branchSha: branch.commit.sha, applicable }, github: { repository: repo,
    run: run as Parameters<typeof verifyBoundaryActionRun>[0]['github']['run'],
    pullRequest: pr, compare: compared,
    headPullRequests: headPulls.map(pull => pull.number),
    matchingPullRequests: matchingPulls.map(pull => pull.number) } });
}

/** Parent-only claim: GitHub authenticates the job; sealed Access authenticates the human. */
export async function claimVerifiedBoundaryAction(env: Env, oidcToken: string,
  input: BoundaryActionClaimRequest): Promise<{ status: string } | (BoundaryActionClaimContext & {
    activityId: string; origin: string; startCapability: string; generation: number; contextDigest: string })> {
  if (!isEnterpriseMode(env) || !env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY || !env.CONTAINER || !env.USAGE_DB
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0
    || !Number.isSafeInteger(input.runId) || input.runId <= 0
    || !Number.isSafeInteger(input.runAttempt) || input.runAttempt <= 0
    || ![input.head, input.base, input.mergeBase].every(sha => SHA.test(sha))) return { status: 'denied' };
  const hints = tokenHints(oidcToken);
  if (!hints) return { status: 'denied' };
  const registry = env.OPERATOR_REGISTRY.getByName('registry');
  try {
    const prepared = await registry.getBoundaryPreparation(input.repositoryId, input.pullRequest);
    if (!prepared || prepared.phase !== 'prepared' || prepared.deadline <= Date.now()
      || prepared.revision.head !== input.head || prepared.revision.base !== input.base
      || prepared.revision.mergeBase !== input.mergeBase) return { status: 'missing-handoff' };
    const action = await registry.getBoundaryAction(input.repositoryId);
    if (!action || action.workflowId !== prepared.workflowId || action.workflowDigest !== prepared.workflowDigest
      || action.controlsRevision !== prepared.controlsRevision
      || !action.events.includes('pull_request_target')) return { status: 'stale' };
    // The deployment audience comes only from the validated managed domain, never Host or payload.
    const domain = await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
    if (!domain || !/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(domain)) {
      return { status: 'denied' };
    }
    const origin = `https://${domain}`;
    const signed = await verifyBoundaryActionOidc(oidcToken, { audience: `${origin}${CLAIM_PATH}`,
      repositoryId: input.repositoryId, repository: hints.repository,
      workflowPath: action.workflowPath, protectedRef: action.protectedRef,
      workflowSha: hints.workflowSha, runId: input.runId, runAttempt: input.runAttempt });
    if (!signed) return { status: 'denied' };
    const identity = signed;
    const activity = env.OPERATOR_ACTIVITY.getByName(prepared.activityId);
    const owner = await activity.getExecutionContext();
    if (!owner || owner.activityId !== prepared.activityId || owner.operatorId !== prepared.operatorId) return { status: 'stale' };
    const container = env.CONTAINER.getByName(getContainerId(prepared.session.bucket,
      prepared.session.sessionId)) as unknown as { openReviewHuman(input: {
        bucket: string; sessionId: string; email: string;
      }): Promise<{ human: import('../lib/jwt').VerifiedHumanAccessClaims; accessJwt: string }> };
    async function human() {
      const sealed = await container.openReviewHuman({ bucket: prepared!.session.bucket,
        sessionId: prepared!.session.sessionId, email: owner!.owner.email });
      const current = await requireOperatorHumanContext(new Request(`${origin}/`, {
        headers: { 'cf-access-jwt-assertion': sealed.accessJwt },
      }), env, sealed.human.email);
      if (current.human.subject !== sealed.human.subject || current.human.issuer !== sealed.human.issuer
        || current.human.email.toLowerCase() !== sealed.human.email.toLowerCase()
        || JSON.stringify(current.human.audiences) !== JSON.stringify(sealed.human.audiences)
        || current.human.expiresAt * 1000 <= Date.now()
        || await operatorOwnerKey(current.human) !== prepared!.ownerKey) throw Error('Human changed');
      const selection = await registry.resolveManagementExecution(prepared!.installationId);
      if (!selection.ok || selection.value.operator.operatorId !== prepared!.operatorId
        || selection.value.installation.revision !== prepared!.installationRevision
        || selection.value.operator.revision !== prepared!.operatorRevision
        || selection.value.controlsRevision !== prepared!.controlsRevision
        || selection.value.release.id !== prepared!.releaseId
        || selection.value.release.bundleDigest !== prepared!.bundleDigest
        || !canInvokeOperator(current.human, selection.value.operator)) throw Error('Invoker changed');
      return current;
    }
    await human();
    // No GH credential leaves the parent Worker or reaches the OIDC issuer/Action response.
    if (env.GITHUB_HOST && env.GITHUB_HOST !== 'github.com'
      || env.GITHUB_API_HOST && env.GITHUB_API_HOST !== 'api.github.com') return { status: 'unavailable' };
    const githubToken = await getValidGithubToken(env, prepared.session.bucket);
    if (!githubToken) return { status: 'unavailable' };
    const current = () => verifyCurrentBoundaryAction(prepared, action, identity, input, githubToken);
    let verified = await current();
    if (!verified || !sameClaim(verified, input, action.workflowId)) return { status: 'stale' };
    const sessionRepo = new D1SessionRepository(env.USAGE_DB);
    if (!await sessionRepo.recordBoundaryActionStart(prepared.session.bucket,
      prepared.session.sessionId, prepared.session.generation, prepared.activityId)) {
      return { status: 'stale' };
    }
    await human();
    verified = await current();
    if (!verified || !sameClaim(verified, input, action.workflowId)) return { status: 'stale' };
    const won = await registry.claimBoundaryPreparation({ ...verified, workflowSha: identity.workflowSha });
    if (!won.ok) return { status: 'stale' };
    const live = await sessionRepo.getSession(prepared.session.bucket, prepared.session.sessionId);
    if (!live || live.lifecycleState !== 'running' || live.lifecycleGeneration !== prepared.session.generation
      || live.boundaryActivityId !== prepared.activityId) return { status: 'stale' };
    // The claimed credential is not replayable even when this response is lost.
    return { ...verified, activityId: prepared.activityId, startCapability: won.value.startCapability,
      generation: prepared.session.generation, contextDigest: prepared.contextDigest, origin };
  } catch { return { status: 'unknown' }; }
}

/** Parent-only fresh PR/Action proof for a claimed packet effect. The signed Action claim is
 * already retained by Registry; this check grants no new Action or child authority. */
export async function verifyCurrentClaimedBoundaryPacket(env: Env, activityId: string,
  repository: string): Promise<boolean> {
  if (!isEnterpriseMode(env) || !env.OPERATOR_REGISTRY || !REPOSITORY.test(repository)) return false;
  try {
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const guard = await registry.getBoundaryStartGuard(activityId);
    if (!guard?.claimed) return false;
    const prepared = await registry.getBoundaryPreparation(guard.repositoryId, guard.pullRequest);
    const action = await registry.getBoundaryAction(guard.repositoryId);
    if (!prepared || prepared.phase !== 'claimed' || prepared.activityId !== activityId
      || prepared.contextDigest !== guard.contextDigest || !guard.workflowSha || !SHA.test(guard.workflowSha)
      || prepared.claimedWorkflowSha !== guard.workflowSha || !action
      || action.workflowId !== prepared.workflowId || action.workflowDigest !== prepared.workflowDigest
      || action.controlsRevision !== prepared.controlsRevision) return false;
    const token = await getValidGithubToken(env, guard.session.bucket);
    if (!token) return false;
    const root = `/repos/${repository}`;
    const branch = await fetch(`https://api.github.com${root}/branches/${encodeURIComponent(
      action.protectedRef.slice('refs/heads/'.length))}`, { redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28' } });
    if (!branch.ok) return false;
    const branchData = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await readBoundedResponse(branch, 128 * 1024, 'Current protected branch'))) as { commit?: { sha?: string } };
    if (!branchData.commit?.sha || branchData.commit.sha !== guard.workflowSha) return false;
    const identity: BoundaryActionIdentity = { repositoryId: guard.repositoryId, repository,
      workflowRef: `${repository}/${action.workflowPath}@${action.protectedRef}`,
      workflowSha: guard.workflowSha, eventName: 'pull_request_target',
      runId: guard.runId, runAttempt: guard.runAttempt };
    const expected = { repositoryId: guard.repositoryId, pullRequest: guard.pullRequest,
      head: guard.head, base: guard.base, mergeBase: guard.mergeBase,
      runId: guard.runId, runAttempt: guard.runAttempt };
    const current = await verifyCurrentBoundaryAction(prepared, action, identity, expected, token);
    return !!current && sameClaim(current, expected, action.workflowId)
      && (await registry.getBoundaryStartGuard(activityId))?.claimed === true;
  } catch { return false; }
}

export type BoundaryPublicationPreparationInput = Omit<BoundaryPublicationInput, 'effect' | 'digest'> & {
  resultDigest: string;
};

/** The protected Action receives only a bounded, credential-free projection of frozen owner evidence. */
export async function prepareBoundaryPublication(env: Env, oidcToken: string,
  input: BoundaryPublicationPreparationInput): Promise<{ status: 'ready'; projection: unknown } | {
    status: 'stale' | 'denied' | 'unknown' }> {
  if (!isEnterpriseMode(env) || !env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY || !env.USAGE_DB || !env.KV
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1
    || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1
    || ![input.workflowId, input.runId, input.runAttempt, input.sessionGeneration, input.activityGeneration]
      .every(value => Number.isSafeInteger(value) && value > 0)
    || ![input.head, input.base, input.mergeBase].every(value => typeof value === 'string' && SHA.test(value))
    || ![input.contextDigest, input.resultDigest].every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
    || typeof input.activityId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.activityId)) return { status: 'denied' };
  const hints = tokenHints(oidcToken);
  if (!hints) return { status: 'denied' };
  try {
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const prepared = await registry.getBoundaryPreparation(input.repositoryId, input.pullRequest);
    if (!prepared || prepared.phase !== 'claimed' || prepared.roundGeneration !== 1
      || prepared.deadline <= Date.now() || prepared.activityId !== input.activityId
      || prepared.contextDigest !== input.contextDigest || prepared.session.generation !== input.sessionGeneration
      || prepared.revision.head !== input.head || prepared.revision.base !== input.base
      || prepared.revision.mergeBase !== input.mergeBase || prepared.workflowId !== input.workflowId) return { status: 'stale' };
    const action = await registry.getBoundaryAction(input.repositoryId);
    if (!action || action.workflowId !== input.workflowId || action.workflowDigest !== prepared.workflowDigest
      || action.controlsRevision !== prepared.controlsRevision || !action.events.includes('pull_request_target')) return { status: 'stale' };
    const domain = await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
    if (!domain || !/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(domain)) return { status: 'denied' };
    const signed = await verifyBoundaryActionOidc(oidcToken, { audience: `https://${domain}${PREPARATION_PATH}`,
      repositoryId: input.repositoryId, repository: hints.repository, workflowPath: action.workflowPath,
      protectedRef: action.protectedRef, workflowSha: hints.workflowSha,
      runId: input.runId, runAttempt: input.runAttempt });
    if (!signed) return { status: 'denied' };
    const activity = env.OPERATOR_ACTIVITY.getByName(input.activityId);
    async function currentOwners(): Promise<boolean> {
      const guard = await registry.getBoundaryStartGuard(input.activityId);
      const terminal = await activity.getBoundaryPublicationState(input.activityId);
      const live = await new D1SessionRepository(env.USAGE_DB!).getSession(prepared!.session.bucket, prepared!.session.sessionId);
      return !!guard?.claimed && guard.repositoryId === input.repositoryId && guard.pullRequest === input.pullRequest
        && guard.head === input.head && guard.base === input.base && guard.mergeBase === input.mergeBase
        && guard.workflowId === input.workflowId && guard.runId === input.runId && guard.runAttempt === input.runAttempt
        && guard.contextDigest === input.contextDigest && guard.generation === input.sessionGeneration
        && guard.workflowSha === signed!.workflowSha
        && !!terminal?.collected && terminal.generation === input.activityGeneration
        && terminal.binding.repositoryId === input.repositoryId && terminal.binding.pullRequest === input.pullRequest
        && terminal.binding.contextDigest === input.contextDigest
        && JSON.stringify(terminal.binding.session) === JSON.stringify(prepared!.session)
        && live?.lifecycleState === 'running' && live.lifecycleGeneration === input.sessionGeneration
        && (live.boundaryActivityId === input.activityId || live.boundaryActivityId == null);
    }
    if (!await currentOwners()) return { status: 'stale' };
    if (env.GITHUB_HOST && env.GITHUB_HOST !== 'github.com'
      || env.GITHUB_API_HOST && env.GITHUB_API_HOST !== 'api.github.com') return { status: 'unknown' };
    const githubToken = await getValidGithubToken(env, prepared.session.bucket);
    if (!githubToken) return { status: 'unknown' };
    const current = async () => {
      const verified = await verifyCurrentBoundaryAction(prepared, action, signed, input, githubToken);
      return !!verified && sameClaim(verified, input, input.workflowId);
    };
    if (!await current() || !await currentOwners()) return { status: 'stale' };
    const [evidence, owned, resources] = await Promise.all([
      activity.getBoundaryPublicationEvidence(input.activityId), activity.getOwnedSession(),
      activity.getPackageResources(),
    ]);
    if (!evidence || !owned || owned.status !== 'stopped'
      || owned.activityId !== input.activityId
      || owned.ownerBucket !== prepared.session.bucket || owned.profile.activityId !== input.activityId
      || owned.profile.policyDigest !== evidence.policyDigest || evidence.resultDigest !== input.resultDigest
      || evidence.packageDigest !== prepared.bundleDigest || evidence.context.repositoryId !== input.repositoryId
      || evidence.context.pullRequest !== input.pullRequest || evidence.context.head !== input.head
      || evidence.context.base !== input.base || evidence.context.mergeBase !== input.mergeBase
      || !resources) return { status: 'stale' };
    const packets = evidence.packets;
    if (!packets.length || new Set(packets.map(packet => packet.lane)).size !== packets.length) {
      return { status: 'stale' };
    }
    const attachments = parseOperatorAttachmentProjection({ schemaVersion: 1, activityId: input.activityId,
      files: packets.map(({ lane: _lane, ...attachment }) => attachment) });
    const resourceProjection = await verifyOperatorPackageResourceProjection(resources);
    if (resourceProjection.artifactDigest !== evidence.packageDigest) return { status: 'stale' };
    const initialization = parseOperatorPiInitialization(owned.profile.piProfile.initialization, {
      profileId: owned.profile.piProfile.initialization!.profileId, attachments, resources: resourceProjection,
    });
    if (JSON.stringify(initialization.inputs.filter(item => item.kind === 'attachment').map(item => item.reference))
      !== JSON.stringify(packets.map(packet => packet.name))) return { status: 'stale' };
    const resourceDescriptors = resourceProjection.files.map(({ destination, sha256, size }) => ({ destination, sha256, size }));
    const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(value))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (owned.requestDigest !== await hash({ invocationJson: evidence.invocationJson,
      attachments, initialization })) return { status: 'stale' };
    const projection = { schemaVersion: 1, admission: { repositoryId: input.repositoryId,
      pullRequest: input.pullRequest, activityId: input.activityId, roundGeneration: prepared.roundGeneration,
      inputDigest: evidence.inputDigest, packageDigest: evidence.packageDigest,
      resourceDigest: await hash(resourceDescriptors), policyDigest: evidence.policyDigest,
      workflowId: input.workflowId, runId: input.runId, runAttempt: input.runAttempt,
      acknowledgedHead: evidence.acknowledgedHead },
    context: { ...evidence.context, headPullRequests: [input.pullRequest], mergeQueue: false },
    contextDigest: input.contextDigest, resources: resourceDescriptors, packets, initialization,
    packetDigest: await hash({ contextDigest: input.contextDigest,
      packets: packets.map(packet => ({ lane: packet.lane, digest: packet.sha256 })) }),
    resultDigest: input.resultDigest, activityGeneration: input.activityGeneration };
    if (new TextEncoder().encode(JSON.stringify({ status: 'ready', projection })).byteLength > 64 * 1024
      || !await current() || !await currentOwners()) return { status: 'stale' };
    const observed = await registry.getBoundaryPreparation(input.repositoryId, input.pullRequest);
    return observed?.activityId === input.activityId && observed.contextDigest === input.contextDigest
      && observed.roundGeneration === 1 && observed.deadline > Date.now()
      ? { status: 'ready', projection } : { status: 'stale' };
  } catch { return { status: 'unknown' }; }
}

export type BoundaryPublicationRequest = BoundaryPublicationInput & {
  operation: 'begin' | 'read' | 'complete'; externalId?: number;
};

/** The protected Action may reconcile opaque journal effects only after the parent independently
 * re-verifies its run, exact PR and the already-collected terminal Activity generation. */
export async function operateBoundaryPublication(env: Env, oidcToken: string,
  input: BoundaryPublicationRequest): Promise<{ status: 'new' | 'pending' | 'published' | 'stale' | 'conflict' | 'denied' | 'unknown';
    externalId?: number }> {
  if (!isEnterpriseMode(env) || !env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY || !env.KV
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1
    || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1
    || ![input.runId, input.runAttempt, input.sessionGeneration, input.activityGeneration]
      .every(value => Number.isSafeInteger(value) && value > 0)
    || !['begin', 'read', 'complete'].includes(input.operation)
    || (input.operation === 'complete' ? !Number.isSafeInteger(input.externalId) || input.externalId! < 1
      : input.externalId !== undefined)) return { status: 'denied' };
  const hints = tokenHints(oidcToken);
  if (!hints) return { status: 'denied' };
  try {
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const prepared = await registry.getBoundaryPreparation(input.repositoryId, input.pullRequest);
    if (!prepared || prepared.phase !== 'claimed' || prepared.activityId !== input.activityId
      || prepared.contextDigest !== input.contextDigest
      || prepared.session.generation !== input.sessionGeneration
      || prepared.revision.head !== input.head || prepared.revision.base !== input.base
      || prepared.revision.mergeBase !== input.mergeBase) return { status: 'stale' };
    const action = await registry.getBoundaryAction(input.repositoryId);
    if (!action || action.workflowId !== input.workflowId || action.workflowDigest !== prepared.workflowDigest
      || action.controlsRevision !== prepared.controlsRevision || !action.events.includes('pull_request_target')) {
      return { status: 'stale' };
    }
    const domain = await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
    if (!domain || !/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(domain)) {
      return { status: 'denied' };
    }
    const signed = await verifyBoundaryActionOidc(oidcToken, { audience: `https://${domain}${PUBLICATION_PATH}`,
      repositoryId: input.repositoryId, repository: hints.repository,
      workflowPath: action.workflowPath, protectedRef: action.protectedRef,
      workflowSha: hints.workflowSha, runId: input.runId, runAttempt: input.runAttempt });
    if (!signed) return { status: 'denied' };
    const activity = env.OPERATOR_ACTIVITY.getByName(input.activityId);
    async function admissionCurrent(): Promise<boolean> {
      const guard = await registry.getBoundaryPublicationGuard(input.activityId);
      if (!guard?.claimed || guard.repositoryId !== input.repositoryId || guard.pullRequest !== input.pullRequest
        || guard.workflowId !== action!.workflowId || guard.runId !== input.runId
        || guard.runAttempt !== input.runAttempt || guard.contextDigest !== input.contextDigest
        || guard.sessionGeneration !== input.sessionGeneration) return false;
      const terminal = await activity.getBoundaryPublicationState(input.activityId);
      return !!terminal?.collected && terminal.generation === input.activityGeneration
        && terminal.binding.repositoryId === input.repositoryId
        && terminal.binding.pullRequest === input.pullRequest
        && terminal.binding.contextDigest === input.contextDigest
        && JSON.stringify(terminal.binding.session) === JSON.stringify(prepared!.session);
    }
    if (!await admissionCurrent()) return { status: 'stale' };
    if (env.GITHUB_HOST && env.GITHUB_HOST !== 'github.com'
      || env.GITHUB_API_HOST && env.GITHUB_API_HOST !== 'api.github.com') return { status: 'unknown' };
    const githubToken = await getValidGithubToken(env, prepared.session.bucket);
    if (!githubToken) return { status: 'unknown' };
    const current = () => verifyCurrentBoundaryAction(prepared, action, signed, input, githubToken);
    if (!await current() || !await admissionCurrent()) return { status: 'stale' };
    const result = input.operation === 'begin' ? await registry.beginBoundaryPublication(input)
      : input.operation === 'complete' ? await registry.completeBoundaryPublication({ ...input, externalId: input.externalId! })
        : await registry.getBoundaryPublication(input) ?? { status: 'stale' as const };
    if (!await current() || !await admissionCurrent()) return { status: 'stale' };
    const observed = await registry.getBoundaryPreparation(input.repositoryId, input.pullRequest);
    return observed?.activityId === input.activityId && observed.contextDigest === input.contextDigest
      ? result : { status: 'stale' };
  } catch { return { status: 'unknown' }; }
}
