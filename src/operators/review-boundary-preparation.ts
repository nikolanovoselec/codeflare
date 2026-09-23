import type { Env } from '../types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { canInvokeOperator, requireOperatorHumanContext } from '../lib/access';
import { readBoundedResponse } from '../lib/bounded-stream';
import { operatorOwnerKey } from './browser-activity';
import { parseBoundedBoundaryInput, verifyBoundedBoundaryInput } from './boundary-input';
import { resolveBoundaryAction } from './boundary-action-trust';
import { verifyGithubPrBoundary } from './github-pr-boundary';
import { prepareOperatorActivity } from './orchestrator';

export interface ReadyBoundary {
  generation: number;
  input: unknown;
  creation?: { repositoryNodeId: string; pullRequestNodeId: string;
    headRefName: string; baseRefName: string };
  push: { owner: string; repository: string; ref: string; head: string };
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Applicability selection reads trusted bindings; the interceptor separately stages input on remote selection. */
export async function selectVerifiedBoundaryAction(
  env: Env,
  authority: VerifiedHumanAccessClaims,
  target: { owner: string; repository: string; repositoryId: number },
  api: (path: string) => Promise<Response>,
): Promise<'local' | 'remote' | 'unavailable'> {
  if (!env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY
    || !/^[A-Za-z0-9_.-]+$/.test(target.owner) || !/^[A-Za-z0-9_.-]+$/.test(target.repository)
    || !Number.isSafeInteger(target.repositoryId) || target.repositoryId < 1
    || authority.expiresAt * 1000 <= Date.now()) return 'unavailable';
  const registry = env.OPERATOR_REGISTRY.getByName('registry');
  const root = `/repos/${target.owner}/${target.repository}`;
  async function json(path: string): Promise<unknown> {
    const response = await api(path);
    if (response.status !== 200) throw Error('Boundary Action status unavailable');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await readBoundedResponse(response, 128 * 1024, 'Action selection metadata'))) as unknown;
  }
  try {
    const repository = await json(root) as { id: number; full_name: string; default_branch: string };
    if (repository?.id !== target.repositoryId
      || repository.full_name?.toLowerCase() !== `${target.owner}/${target.repository}`.toLowerCase()) {
      return 'unavailable';
    }
    const action = await registry.getBoundaryAction(repository.id);
    if (!action) {
      // A 404 alone can conceal missing permissions. Require a readable parent listing
      // establishing that the protected workflow file is genuinely absent.
      for (const [directory, next] of [
        ['.github/workflows', 'boundary-reviews.yml'], ['.github', 'workflows'], ['', '.github'],
      ] as const) {
        const path = `${root}/contents${directory ? `/${directory}` : ''}?ref=${encodeURIComponent(repository.default_branch)}`;
        const response = await api(path);
        if (response.status === 404) continue;
        if (response.status !== 200) return 'unavailable';
        const entries = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          await readBoundedResponse(response, 128 * 1024, 'Action absence listing'))) as unknown;
        if (!Array.isArray(entries) || entries.length >= 1000) return 'unavailable';
        if (entries.some(entry => entry?.name === next
          || (next === 'boundary-reviews.yml' && entry?.name === 'boundary-reviews.yaml'))) return 'unavailable';
        return 'local';
      }
      return 'unavailable';
    }
    const branchPath = `${root}/branches/${encodeURIComponent(action.protectedRef.slice('refs/heads/'.length))}`;
    const [workflow, branch] = await Promise.all([
      json(`${root}/actions/workflows/${action.workflowId}`), json(branchPath),
    ]) as [{ id: number; path: string; state: string },
      { name: string; protected: boolean; commit: { sha: string } }];
    if (!/^[a-f0-9]{40}$/i.test(branch?.commit?.sha ?? '')) return 'unavailable';
    const contents = await json(`${root}/contents/${action.workflowPath}?ref=${branch.commit.sha}`) as {
      content: string; encoding: string;
    };
    const decision = await resolveBoundaryAction({ action, repository, workflow, branch, contents,
      event: 'pull_request' });
    if (decision.selection !== 'remote') return 'unavailable';
    const installed = await registry.resolveManagementExecution(decision.installationId);
    return installed.ok && installed.value.controlsRevision === decision.controlsRevision
      && installed.value.operator.profile === 'conductor'
      && canInvokeOperator(authority, installed.value.operator) ? 'remote' : 'unavailable';
  } catch { return 'unavailable'; }
}

/** One confirmed boundary, no workflow dispatch and no execution start. */
export async function prepareVerifiedBoundary(
  ready: ReadyBoundary,
  authority: { human: VerifiedHumanAccessClaims; accessJwt: string },
  env: Env,
  api: (path: string) => Promise<Response>,
  session: { bucket: string; sessionId: string },
  checkLifecycle: () => Promise<void>,
): Promise<void> {
  await checkLifecycle();
  const input = parseBoundedBoundaryInput(ready.input);
  const { owner, repository, ref, head } = ready.push;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || head !== input.targetHead
    || authority.human.expiresAt * 1000 <= Date.now()) throw Error('Boundary authority unavailable');
  if (!env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY) throw Error('Operator owner unavailable');
  const registry = env.OPERATOR_REGISTRY.getByName('registry');
  const original = await registry.getBoundaryPreparation(input.repositoryId, input.pullRequest);
  const root = `/repos/${owner}/${repository}`;
  async function json(path: string): Promise<unknown> {
    const response = await api(path);
    if (response.status !== 200) throw Error('GitHub context unavailable');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await readBoundedResponse(response, 128 * 1024, 'GitHub boundary metadata')));
  }
  const repo = await json(root) as { id: number; full_name: string; default_branch: string; node_id?: string };
  const pullRequest = await json(`${root}/pulls/${input.pullRequest}`) as {
    number: number; node_id: string; state: string; head: { sha: string; ref: string; repo: { id: number } };
    base: { sha: string; ref: string; repo: { id: number } };
  };
  if (!/^[a-f0-9]{40}$/i.test(pullRequest?.base?.sha ?? '')) throw Error('PR base unavailable');
  if (ready.creation && (repo?.node_id !== ready.creation.repositoryNodeId
    || pullRequest.node_id !== ready.creation.pullRequestNodeId
    || pullRequest.head.ref !== ready.creation.headRefName
    || pullRequest.base.ref !== ready.creation.baseRefName)) throw Error('PR creation repository or ref mismatch');
  const branch = ref.slice('refs/heads/'.length);
  const matchingPulls = await json(`${root}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=2`);
  const headPulls = await json(`${root}/commits/${head}/pulls?per_page=2`);
  if (!Array.isArray(matchingPulls) || matchingPulls.length !== 1
    || !Array.isArray(headPulls) || headPulls.length !== 1
    || headPulls[0]?.number !== input.pullRequest || headPulls[0]?.state !== 'open'
    || headPulls[0]?.head?.sha !== head) throw Error('Ambiguous PR');
  const compared = await json(`${root}/compare/${pullRequest.base.sha}...${head}`) as {
    merge_base_commit: { sha: string };
  };
  const evidence = { repository: repo, pullRequest, compare: compared,
    matchingPulls: matchingPulls.map((pr: { number?: unknown }) => pr?.number) as number[] };
  const context = verifyGithubPrBoundary({ owner, repository, ref, head, pullRequest: input.pullRequest }, evidence);
  const accepted = await verifyBoundedBoundaryInput(input, context, async (ack, target) => {
    const ancestry = await json(`${root}/compare/${ack}...${target}`) as { merge_base_commit?: { sha?: string } };
    return ancestry?.merge_base_commit?.sha === ack;
  });
  const action = await registry.getBoundaryAction(context.repositoryId);
  if (!action) throw Error('Protected Action not configured');
  const branchPath = `${root}/branches/${encodeURIComponent(action.protectedRef.slice('refs/heads/'.length))}`;
  const [workflow, protectedBranch] = await Promise.all([
    json(`${root}/actions/workflows/${action.workflowId}`), json(branchPath),
  ]) as [{ id: number; path: string; state: string },
    { name: string; protected: boolean; commit: { sha: string } }];
  if (!/^[a-f0-9]{40}$/i.test(protectedBranch?.commit?.sha ?? '')) throw Error('Protected Action ref unavailable');
  const contents = await json(`${root}/contents/${action.workflowPath}?ref=${protectedBranch.commit.sha}`) as {
    content: string; encoding: string;
  };
  const selected = await resolveBoundaryAction({ action, repository: repo, workflow, branch: protectedBranch,
    contents, event: 'pull_request' });
  if (selected.selection !== 'remote') throw Error('Protected Action unavailable');
  const installation = await registry.resolveManagementExecution(selected.installationId);
  if (!installation.ok || installation.value.controlsRevision !== selected.controlsRevision
    || installation.value.installation.id !== selected.installationId
    || installation.value.operator.profile !== 'conductor'
    || !canInvokeOperator(authority.human, installation.value.operator)) throw Error('Operator installation unavailable');
  // Recheck both mutable GitHub contexts immediately before the durable CAS.
  const [currentPr, currentBranch, currentWorkflow, currentHeadPulls, currentBranchPulls] = await Promise.all([
    json(`${root}/pulls/${input.pullRequest}`), json(branchPath),
    json(`${root}/actions/workflows/${action.workflowId}`),
    json(`${root}/commits/${head}/pulls?per_page=2`),
    json(`${root}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=2`),
  ]) as [typeof pullRequest, typeof protectedBranch, typeof workflow,
    Array<{ number: number; state: string; head: { sha: string } }>, Array<{ number: number }>];
  verifyGithubPrBoundary({ owner, repository, ref, head, pullRequest: input.pullRequest },
    { ...evidence, pullRequest: currentPr });
  if (currentPr.node_id !== pullRequest.node_id
    || currentPr.base.sha !== pullRequest.base.sha || currentPr.base.ref !== pullRequest.base.ref
    || currentPr.base.repo.id !== pullRequest.base.repo.id
    || currentPr.head.sha !== pullRequest.head.sha || currentPr.head.ref !== pullRequest.head.ref
    || currentPr.head.repo.id !== pullRequest.head.repo.id
    || currentBranch?.commit?.sha !== protectedBranch.commit.sha || !currentBranch.protected
    || currentBranch.name !== protectedBranch.name
    || currentWorkflow?.id !== workflow.id || currentWorkflow.path !== workflow.path
    || currentWorkflow.state !== 'active' || !Array.isArray(currentHeadPulls)
    || currentHeadPulls.length !== 1 || currentHeadPulls[0]?.number !== input.pullRequest
    || currentHeadPulls[0]?.state !== 'open' || currentHeadPulls[0]?.head?.sha !== head
    || !Array.isArray(currentBranchPulls) || currentBranchPulls.length !== 1
    || currentBranchPulls[0]?.number !== input.pullRequest) throw Error('PR or Action revision moved');
  const currentAuthority = await requireOperatorHumanContext(new Request('https://codeflare.invalid/', {
    headers: { 'cf-access-jwt-assertion': authority.accessJwt },
  }), env, authority.human.email);
  if (currentAuthority.human.subject !== authority.human.subject
    || currentAuthority.human.issuer !== authority.human.issuer
    || JSON.stringify(currentAuthority.human.audiences) !== JSON.stringify(authority.human.audiences)
    || currentAuthority.human.expiresAt * 1000 <= Date.now()
    || !canInvokeOperator(currentAuthority.human, installation.value.operator)) throw Error('Human authority changed');
  await checkLifecycle();
  const pinned = { controlsRevision: selected.controlsRevision,
    installationRevision: installation.value.installation.revision,
    operatorRevision: installation.value.operator.revision, releaseId: installation.value.release.id,
    bundleDigest: installation.value.release.bundleDigest, workflowId: action.workflowId,
    workflowDigest: action.workflowDigest };
  const sessionBinding = { ...session, generation: ready.generation };
  const contextDigest = await digest({ context, accepted, action, pinned, sessionBinding });
  const ownerKey = await operatorOwnerKey(currentAuthority.human);
  const reservation = await registry.reserveBoundaryPreparation({ repositoryId: context.repositoryId,
    pullRequest: context.pullRequest, contextDigest, ownerKey, installationId: selected.installationId,
    operatorId: installation.value.operator.operatorId,
    revision: { head: context.head, base: context.base, mergeBase: context.mergeBase },
    deadline: currentAuthority.human.expiresAt * 1000, expectedContextDigest: original?.contextDigest ?? null,
    session: sessionBinding, ...pinned });
  if (!reservation.ok || !reservation.value.created) return; // Reconcile only: no new capability on ambiguity.
  const activityId = reservation.value.activityId;
  const operatorId = installation.value.operator.operatorId;
  const summary = { activityId, operatorId, executionStatus: 'unknown' as const,
    cleanupStatus: 'pending' as const, collectionStatus: 'unavailable' as const,
    attention: true, sessionId: null, source: 'pr-boundary', updatedAt: Date.now() };
  // A crash after the durable reservation remains visible as uncertain, not queued work.
  await registry.upsertOwnedActivity(ownerKey, summary);
  const consumerInput = { context, acknowledgedHead: accepted.acknowledgedHead, evidence: accepted.payload };
  const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
    activityId, operatorId, runId: activityId, source: { kind: 'session', reference: `${owner}/${repository}` },
    revision: { reference: head, digest: contextDigest }, inputDigest: await digest(consumerInput),
    input: consumerInput,
    attachments: [], resources: { inference: null,
      session: installation.value.installation.policy.resourceProfileId
        ? { profileId: installation.value.installation.policy.resourceProfileId } : null,
      storage: { scopeId: activityId } } };
  await checkLifecycle();
  const prepared = await prepareOperatorActivity({ installationId: selected.installationId, invocation },
    currentAuthority, env, { activityId, expectedManagement: pinned });
  await checkLifecycle();
  if (!await registry.markBoundaryPrepared(context.repositoryId, context.pullRequest, activityId,
    contextDigest, prepared.startCapability, prepared.startExpiresAt)) throw Error('Boundary preparation uncertain');
  await registry.upsertOwnedActivity(ownerKey, { ...summary, executionStatus: 'queued',
    attention: false, updatedAt: Date.now() });
}
