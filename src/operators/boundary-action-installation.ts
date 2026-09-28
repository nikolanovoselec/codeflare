import { parseDocument } from 'yaml';
import type { Env } from '../types';
import type { OperatorRegistry } from './registry';
import { getValidGithubToken } from '../lib/github-token';
import { readBoundedResponse } from '../lib/bounded-stream';
import { AppError, ValidationError } from '../lib/error-types';

const runtimeRepository = 'nikolanovoselec/codeflare';
const runtimeWorkflow = '.github/workflows/boundary-runtime.yml';
const installedPath = '.github/workflows/boundary-reviews.yml';
const sha = /^[a-f0-9]{40}$/i;
const names = /^[A-Za-z0-9_.-]+$/;
const httpsOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch { return false; }
};

export type EnrollmentTarget = { repositoryUrl: string; protectedRef: 'refs/heads/main' | 'refs/heads/develop' | 'refs/heads/master'; installationId: string };
export type EnrollmentContext = { env: Env; registry: DurableObjectStub<OperatorRegistry>; bucket: string;
  reauthorize: () => Promise<{ email: string; expiresAt: number }> };

function settings(env: Env) {
  let origins: unknown;
  try { origins = JSON.parse(env.OPERATOR_REVIEW_ORIGINS ?? ''); } catch { throw new AppError('UNAVAILABLE', 503, 'Review enrollment unavailable'); }
  const value = origins as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'dev,integration,production'
    || !httpsOrigin(value.dev) || !httpsOrigin(value.integration) || !httpsOrigin(value.production)
    || new Set([value.dev, value.integration, value.production]).size !== 3
    || !sha.test(env.OPERATOR_REVIEW_EXECUTABLE_SHA ?? '')) {
    throw new AppError('UNAVAILABLE', 503, 'Review enrollment unavailable');
  }
  return { origins: value as { dev: string; integration: string; production: string }, commit: env.OPERATOR_REVIEW_EXECUTABLE_SHA! };
}

function repositoryParts(input: EnrollmentTarget) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(input.repositoryUrl);
  if (!match || !names.test(match[1]) || !names.test(match[2]) || match[2] === '.' || match[2] === '..'
    || !/^refs\/heads\/(main|master|develop)$/.test(input.protectedRef)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(input.installationId)) throw new ValidationError('Invalid Review enrollment target');
  return { owner: match[1], repo: match[2], base: input.protectedRef.slice('refs/heads/'.length) };
}

function workflow(commit: string, origins: { dev: string; integration: string; production: string }): string {
  // All values originate from installer-owned configuration, never target-repository input.
  return `name: Boundary Reviews\non:\n  pull_request_target:\n    branches: [develop, master, main]\n    types: [opened, reopened, synchronize, ready_for_review]\npermissions:\n  contents: read\n  actions: read\n  pull-requests: read\n  issues: write\n  checks: write\n  id-token: write\njobs:\n  review:\n    uses: ${runtimeRepository}/${runtimeWorkflow}@${commit}\n    with:\n      runtime_sha: ${commit}\n      dev_origin: ${origins.dev}\n      integration_origin: ${origins.integration}\n      production_origin: ${origins.production}\n`;
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function gitHub(token: string) {
  return async function request(path: string, method = 'GET', body?: unknown,
    expected: number | number[] = 200): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new ValidationError('Invalid GitHub path');
    const url = `https://api.github.com${path}`;
    const signal = AbortSignal.timeout(10_000);
    const response = await fetch(new Request(url, { method, redirect: 'manual', signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (!(Array.isArray(expected) ? expected.includes(response.status) : response.status === expected)
      || response.redirected || (response.url && response.url !== url)) {
      throw new AppError('CONFLICT', 409, 'Review enrollment GitHub evidence unavailable');
    }
    if (response.status === 404 || response.status === 422) return null;
    const bytes = await readBoundedResponse(response, 128 * 1024, 'Review enrollment GitHub response', signal);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  };
}

function reviewRuntimeAvailable(encoded: string): boolean {
  try {
    const document = parseDocument(atob(encoded.replace(/\s/g, '')), { uniqueKeys: true });
    if (document.errors.length) return false;
    const runtime = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    const called = (runtime?.on as Record<string, unknown>)?.workflow_call as Record<string, unknown> | undefined;
    const inputs = called?.inputs as Record<string, unknown> | undefined;
    const jobs = runtime?.jobs as Record<string, Record<string, unknown>> | undefined;
    if (!inputs || !jobs || !['runtime_sha', 'dev_origin', 'integration_origin', 'production_origin']
      .every(name => (inputs[name] as { required?: boolean; type?: string })?.required === true
        && (inputs[name] as { type?: string })?.type === 'string')) return false;
    const collect = jobs.collect;
    const publish = jobs.publish;
    const collector = collect?.permissions as Record<string, string> | undefined;
    const publisher = publish?.permissions as Record<string, string> | undefined;
    return !!collector && !!publisher && collector['id-token'] === 'write'
      && collector.issues !== 'write'
      && publisher['id-token'] === 'write'
      && publisher.issues === 'write' && publisher.checks === 'write'
      && Array.isArray(collect?.steps) && collect.steps.length > 0
      && Array.isArray(publish?.steps) && publish.steps.length > 0;
  } catch { return false; }
}

async function context(input: EnrollmentTarget, ctx: EnrollmentContext) {
  const config = settings(ctx.env);
  const target = repositoryParts(input);
  const selected = await ctx.registry.resolveManagementExecution(input.installationId);
  if (!selected.ok || selected.value.operator.profile !== 'conductor') {
    throw new AppError('CONFLICT', 409, 'Eligible Review installation unavailable');
  }
  const pinned = { controlsRevision: selected.value.controlsRevision,
    installationRevision: selected.value.installation.revision,
    operatorRevision: selected.value.operator.revision,
    releaseId: selected.value.release.id };
  const token = await getValidGithubToken(ctx.env, ctx.bucket);
  if (!token) throw new AppError('UNAVAILABLE', 503, 'GitHub connection unavailable');
  const api = gitHub(token);
  const root = `/repos/${target.owner}/${target.repo}`;
  const user = await api('/user') as { login?: string };
  if (!user?.login || !names.test(user.login)) throw new AppError('CONFLICT', 409, 'GitHub identity unavailable');
  const permission = await api(`${root}/collaborators/${user.login}/permission`) as { permission?: string };
  if (permission?.permission !== 'admin') throw new AppError('CONFLICT', 409, 'Workflow-write authorization unavailable');
  const repository = await api(root) as { id?: number; full_name?: string };
  if (!Number.isSafeInteger(repository?.id) || repository.id! < 1
    || repository.full_name?.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) {
    throw new AppError('CONFLICT', 409, 'Review repository unavailable');
  }
  const branchPath = `${root}/branches/${encodeURIComponent(target.base)}`;
  const branch = await api(branchPath) as { name?: string; protected?: boolean; commit?: { sha?: string } };
  const head = branch?.commit?.sha;
  if (branch?.name !== target.base || !branch.protected || !sha.test(head ?? '')) {
    throw new AppError('CONFLICT', 409, 'Protected Review base unavailable');
  }
  const sdd = await api(`${root}/contents/sdd?ref=${head}`);
  if (!Array.isArray(sdd) || sdd.length === 0) throw new AppError('CONFLICT', 409, 'Protected sdd unavailable');
  const available = await api(`/repos/${runtimeRepository}/contents/${runtimeWorkflow}?ref=${config.commit}`) as {
    type?: string; encoding?: string; content?: string;
  };
  if (available?.type !== 'file' || available.encoding !== 'base64' || !available.content
    || available.content.length > 128 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(available.content)
    || !reviewRuntimeAvailable(available.content)) {
    throw new AppError('CONFLICT', 409, 'Pinned Review runtime unavailable');
  }
  return { ...target, installationId: input.installationId, root, branchPath, head: head!, repositoryId: repository.id!, api, config,
    pinned, contents: workflow(config.commit, config.origins) };
}

async function unchanged(value: Awaited<ReturnType<typeof context>>, ctx: EnrollmentContext) {
  const selected = await ctx.registry.resolveManagementExecution(value.installationId);
  if (!selected.ok || selected.value.operator.profile !== 'conductor'
    || selected.value.controlsRevision !== value.pinned.controlsRevision
    || selected.value.installation.revision !== value.pinned.installationRevision
    || selected.value.operator.revision !== value.pinned.operatorRevision
    || selected.value.release.id !== value.pinned.releaseId) {
    throw new AppError('CONFLICT', 409, 'Review installation moved');
  }
  const current = await value.api(value.branchPath) as { name?: string; protected?: boolean; commit?: { sha?: string } };
  if (current.name !== value.base || !current.protected || current.commit?.sha !== value.head) {
    throw new AppError('CONFLICT', 409, 'Protected Review base moved');
  }
}

/** A proposal is a normal target-repository PR; never write through branch protection or activate Review. */
export async function proposeBoundaryWorkflow(input: EnrollmentTarget, ctx: EnrollmentContext) {
  await ctx.reauthorize();
  const value = await context(input, ctx);
  await unchanged(value, ctx);
  const installed = await value.api(`${value.root}/contents/${installedPath}?ref=${value.head}`, 'GET', undefined,
    [200, 404]) as { type?: string; path?: string; encoding?: string; content?: string; sha?: string } | null;
  if (installed) {
    const controls = await ctx.registry.getManagementControls();
    const binding = controls.boundaryActions?.find(action => action.repositoryId === value.repositoryId
      && action.protectedRef === input.protectedRef);
    if (installed.type !== 'file' || installed.path !== installedPath || installed.encoding !== 'base64'
      || !installed.content || installed.content.length > 128 * 1024 || !sha.test(installed.sha ?? '')
      || !binding?.verified || binding.enabled !== false || binding.workflowPath !== installedPath
      || binding.workflowDigest !== await digest(atob(installed.content.replace(/\s/g, '')))) {
      throw new AppError('CONFLICT', 409, 'Existing Review workflow is not installer-managed');
    }
  }
  const branch = `codeflare-review-install-${(await digest(`${value.repositoryId}:${value.base}:${value.head}:${value.contents}`)).slice(0, 12)}`;
  await ctx.reauthorize();
  try {
    await value.api(`${value.root}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: value.head }, [201, 422]);
  } catch (error) { if (error instanceof AppError) throw error; } // A lost response may have created the ref.
  const branchRef = await value.api(`${value.root}/git/ref/heads/${branch}`) as { ref?: string; object?: { sha?: string } };
  if (branchRef.ref !== `refs/heads/${branch}` || !sha.test(branchRef.object?.sha ?? '')) {
    throw new AppError('CONFLICT', 409, 'Review proposal branch moved');
  }
  if (branchRef.object!.sha !== value.head) {
    const compared = await value.api(`${value.root}/compare/${value.head}...${branchRef.object!.sha}`) as {
      merge_base_commit?: { sha?: string };
    };
    if (compared.merge_base_commit?.sha !== value.head) {
      throw new AppError('CONFLICT', 409, 'Review proposal branch diverged');
    }
  }
  await unchanged(value, ctx);
  await ctx.reauthorize();
  const existingProposal = await value.api(`${value.root}/contents/${installedPath}?ref=${branch}`, 'GET', undefined,
    [200, 404]) as { content?: string; encoding?: string; sha?: string } | null;
  const sameProposal = existingProposal?.encoding === 'base64'
    && atob(existingProposal.content?.replace(/\s/g, '') ?? '') === value.contents;
  if (!sameProposal) {
    try {
      await value.api(`${value.root}/contents/${installedPath}`, 'PUT', {
        message: 'Install protected Codeflare Review workflow', branch, content: btoa(value.contents),
        ...(existingProposal?.sha ? { sha: existingProposal.sha } : installed ? { sha: installed.sha } : {}),
      }, [200, 201, 422]);
    } catch (error) { if (error instanceof AppError) throw error; }
  }
  const proposal = await value.api(`${value.root}/contents/${installedPath}?ref=${branch}`) as {
    content?: string; encoding?: string;
  };
  if (proposal.encoding !== 'base64' || atob(proposal.content?.replace(/\s/g, '') ?? '') !== value.contents) {
    throw new AppError('CONFLICT', 409, 'Review proposal bytes unavailable');
  }
  await unchanged(value, ctx);
  await ctx.reauthorize();
  let pr: { number?: number; state?: string; base?: { ref?: string } } | null;
  try {
    pr = await value.api(`${value.root}/pulls`, 'POST', {
      title: 'Install protected Codeflare Review workflow', head: branch, base: value.base,
      body: 'Review the pinned, installer-controlled workflow before merging. Enrollment remains inactive.',
    }, [201, 422]) as typeof pr;
  } catch (error) { if (error instanceof AppError) throw error; pr = null; }
  if (!pr) {
    const pulls = await value.api(`${value.root}/pulls?state=open&head=${encodeURIComponent(`${value.owner}:${branch}`)}&base=${value.base}&per_page=2`) as Array<NonNullable<typeof pr>>;
    if (!Array.isArray(pulls) || pulls.length !== 1) throw new AppError('CONFLICT', 409, 'Review proposal uncertain');
    pr = pulls[0];
  }
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number! < 1
    || pr.state !== 'open' || pr.base?.ref !== value.base) {
    throw new AppError('CONFLICT', 409, 'Review installation proposal unavailable');
  }
  return { status: 'pending' as const, pullRequest: pr.number };
}

/** Only actual protected-base bytes and workflow identity may enter inactive Registry trust. */
export async function verifyBoundaryWorkflow(input: EnrollmentTarget, ctx: EnrollmentContext) {
  await ctx.reauthorize();
  const value = await context(input, ctx);
  const observed = await value.api(`${value.root}/contents/${installedPath}?ref=${value.head}`) as {
    type?: string; path?: string; encoding?: string; content?: string;
  };
  if (observed?.type !== 'file' || observed.path !== installedPath || observed.encoding !== 'base64'
    || !observed.content || observed.content.length > 128 * 1024
    || !/^[A-Za-z0-9+/=\r\n]+$/.test(observed.content)
    || atob(observed.content.replace(/\s/g, '')) !== value.contents) {
    throw new AppError('CONFLICT', 409, 'Protected Review workflow bytes unavailable');
  }
  const workflowRecord = await value.api(`${value.root}/actions/workflows/boundary-reviews.yml`) as {
    id?: number; path?: string; state?: string;
  };
  if (!Number.isSafeInteger(workflowRecord?.id) || workflowRecord.id! < 1
    || workflowRecord.path !== installedPath || workflowRecord.state !== 'active') {
    throw new AppError('CONFLICT', 409, 'Protected Review workflow identity unavailable');
  }
  await unchanged(value, ctx);
  await ctx.reauthorize();
  const controls = await ctx.registry.getManagementControls();
  const existing = controls.boundaryActions?.find(action => action.repositoryId === value.repositoryId
    && action.protectedRef === input.protectedRef);
  if (existing && existing.enabled !== false) throw new AppError('CONFLICT', 409, 'Active Review binding cannot be replaced');
  const binding = { repositoryId: value.repositoryId, installationId: input.installationId,
    workflowId: workflowRecord.id!, workflowPath: installedPath, protectedRef: input.protectedRef,
    workflowDigest: await digest(value.contents), events: ['pull_request_target'],
    runtimeSha: value.config.commit, enabled: false, verified: true };
  await unchanged(value, ctx);
  const actor = await ctx.reauthorize();
  const installed = await ctx.registry.setManagementControls({ ...controls,
    boundaryActions: [...(controls.boundaryActions ?? []).filter(action => action.repositoryId !== value.repositoryId
      || action.protectedRef !== input.protectedRef), binding] },
  actor, true);
  if (!installed.ok) throw new AppError('CONFLICT', 409, 'Review registration moved');
  return { status: 'installed' as const, enabled: false, workflowId: workflowRecord.id };
}
