import { z } from 'zod';
import type { Env } from '../types';
import { readDispatcherBody } from './operator-runtime-capability';
import { parseOperatorPolicy } from './policy';

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const discoveredPull = z.object({ number: z.number().safe().int().positive(), state: z.literal('open'),
  created_at: z.string().datetime({ offset: true }),
  user: z.object({ id: z.number().safe().int(), login: z.string(), type: z.string() }),
  head: z.object({ sha: commit }), base: z.object({ repo: z.object({ full_name: z.string() }) }) });

/** Fixed GitHub App account identity, not a model-supplied bot label. */
export function eligibleRenovatePull(value: unknown, repository: string, now = Date.now()) {
  const pr = discoveredPull.parse(value);
  const created = Date.parse(pr.created_at);
  if (pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase()
    || pr.user.id !== 29139614 || pr.user.login !== 'renovate[bot]' || pr.user.type !== 'Bot'
    || created < now - 14 * 24 * 60 * 60 * 1000 || created > now) return null;
  return { pullRequest: pr.number, headSha: pr.head.sha, createdAt: new Date(created).toISOString() };
}

/** Never follows GitHub-provided URLs; bounds pages and returns truthful incompleteness. */
export async function discoverRenovatePulls(repository: string, get: (path: string) => Promise<Response>, now = Date.now()) {
  const found: Array<NonNullable<ReturnType<typeof eligibleRenovatePull>>> = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const response = await get(`/pulls?state=open&sort=created&direction=desc&per_page=10&page=${page}`);
    if (response.status !== 200 || response.redirected) throw new Error('Pull request discovery unavailable');
    const rows = z.array(discoveredPull).max(10).parse(JSON.parse(await readDispatcherBody(response)));
    for (const row of rows) {
      if (seen.has(row.number)) throw new Error('Pull request discovery changed');
      seen.add(row.number);
      const eligible = eligibleRenovatePull(row, repository, now);
      if (eligible) found.push(eligible);
    }
    const more = /rel="next"/.test(response.headers.get('link') ?? '');
    if (!more) return { repository, pullRequests: found, truncated: false };
    if (rows.length !== 10) throw new Error('Pull request discovery incomplete');
  }
  return { repository, pullRequests: found, truncated: true };
}
const id = z.number().int().positive().safe();
const citation = z.union([
  z.object({ kind: z.literal('release'), source: z.string().max(512), quote: z.string().max(1000) }),
  z.object({ kind: z.literal('guide'), source: z.string().max(512), quote: z.string().max(1000) }),
  z.object({ kind: z.literal('config'), ref: z.string().max(128) }),
]);
const assessmentSchema = z.object({ classification: z.enum(['safe', 'unsafe', 'unknown']),
  observedHead: commit, baseSha: commit, reasons: z.array(z.string().min(1).max(500)).min(1).max(5),
  compatibility: z.string().min(1).max(1000), citations: z.array(citation).max(42),
  gaps: z.array(z.string().max(300)).max(10),
  checks: z.object({ state: z.string(), observedHead: commit.nullable() }),
});
export type RenovateAssessment = z.infer<typeof assessmentSchema>;
export function parsePublishableAssessment(value: unknown, target?: { repository: string; pullRequest: number }): RenovateAssessment {
  const envelope = z.object({ repository: z.string().min(1), pullRequest: id,
    observedHead: commit, readOnly: z.literal(true), assessment: assessmentSchema }).parse(value);
  if (Object.prototype.hasOwnProperty.call(value, 'classification')
    || envelope.observedHead !== envelope.assessment.observedHead
    || (target && (envelope.repository !== target.repository || envelope.pullRequest !== target.pullRequest))) {
    throw new Error('Contradictory Dispatcher assessment');
  }
  const result = envelope.assessment;
  // The compiled Dispatcher owns citation semantics; the parent only rejects
  // an uncited or explicitly gapped positive result before granting an effect.
  if (result.classification === 'safe' && (result.gaps.length > 0 || result.citations.length === 0)) {
    throw new Error('Cited assessment unavailable');
  }
  return result;
}

/** Parent-only, repository-scoped credentialed GitHub transport; never passed to the child. */
export function renovateGithub(input: { env: Env; exports: Record<string, (input: { props: Record<string, unknown> }) => { fetch(request: Request): Promise<Response> }>;
  user: string; bucket: string; repository: string; pullRequest: number; current: () => Promise<void>;
  prospective: boolean; prospectiveCreatedAt?: string; repositoryDiscovery?: boolean }) {
  const { env, exports, repository, pullRequest, current } = input;
  if (!exports.GitHubInterceptor) throw new Error('GitHub transport unavailable');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !id.safeParse(pullRequest).success) {
    throw new Error('Publication target unavailable');
  }
  const host = env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw new Error('GitHub host invalid');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [repository.toLowerCase()], methods: ['GET', 'POST', 'PUT'] },
    storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
      reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
  const transport = exports.GitHubInterceptor({ props: { user: input.user, bucket: input.bucket, strict: true, operatorPolicy: policy } });
  // /user is outside repository policy; only this fixed parent read uses an
  // unscoped transport, never handed to an agent or used for mutation.
  const identityTransport = exports.GitHubInterceptor({ props: { user: input.user, bucket: input.bucket, strict: true } });
  async function publisherIdentity() {
    await current();
    const response = await identityTransport.fetch(new Request(`https://${host}/user`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { accept: 'application/vnd.github+json',
        'user-agent': 'Codeflare-Operator-Renovate' },
    }));
    if (response.status !== 200 || response.redirected) throw new Error('Publisher identity unavailable');
    return z.object({ id, login: z.string().min(1).max(128) }).parse(JSON.parse(await readDispatcherBody(response)));
  }
  const prefix = `/repos/${repository}`;
  async function request(path: string, method = 'GET', body?: object): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('GitHub route invalid');
    await current();
    return transport.fetch(new Request(`https://${host}${prefix}${path}`, { method, redirect: 'manual',
      signal: AbortSignal.timeout(8000), headers: { accept: 'application/vnd.github+json',
        'user-agent': 'Codeflare-Operator-Renovate', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
  }
  async function json(path: string) {
    const response = await request(path);
    if (response.status !== 200 || response.redirected || /rel="next"/.test(response.headers.get('link') ?? '')) {
      throw new Error('Incomplete GitHub observation');
    }
    return JSON.parse(await readDispatcherBody(response)) as unknown;
  }
  async function observe(assessment: RenovateAssessment, kind: 'comment' | 'approval' | 'merge'): Promise<void> {
    // One-off #1299 remains distinct; other targets need current Registry proof.
    if (!input.repositoryDiscovery && (repository.toLowerCase() !== 'nikolanovoselec/komodo'
      || (pullRequest !== 1299 && !input.prospective))) {
      throw new Error('Renovate publication not authorized for this target');
    }
    const repo = z.object({ id: id, full_name: z.string(), default_branch: z.string(),
      permissions: z.object({ admin: z.literal(true) }) }).parse(await json('/'));
    if ((!input.repositoryDiscovery && repo.id !== 973175879) || repo.full_name.toLowerCase() !== repository.toLowerCase() || repo.default_branch !== 'main') {
      throw new Error('Repository identity changed');
    }
    const observePr = async () => {
      const pr = z.object({ number: id, state: z.literal('open'), created_at: z.string().optional(),
        mergeable: z.boolean().nullable(),
        mergeable_state: z.string(), user: z.object({ id, login: z.string(), type: z.string() }),
        head: z.object({ sha: commit }), base: z.object({ sha: commit, ref: z.literal('main') }) })
        .parse(await json(`/pulls/${pullRequest}`));
      if (input.repositoryDiscovery && (!pr.created_at || Date.parse(pr.created_at) < Date.now() - 14 * 86400000
        || Date.parse(pr.created_at) > Date.now() || !Number.isFinite(Date.parse(pr.created_at)))) {
        throw new Error('Pull request outside discovery window');
      }
      if (input.prospective && (!pr.created_at
        || new Date(pr.created_at).toISOString() !== input.prospectiveCreatedAt)) {
        throw new Error('Prospective pull request age changed');
      }
      if (pr.number !== pullRequest || pr.user.id !== 29139614 || pr.user.login !== 'renovate[bot]'
        || pr.user.type !== 'Bot' || pr.head.sha !== assessment.observedHead || pr.base.sha !== assessment.baseSha) {
        throw new Error('Pull request revision or author changed');
      }
      return pr;
    };
    const pr = await observePr();
    if (kind === 'comment') { await observePr(); await current(); return; }
    if (pr.mergeable !== true || pr.mergeable_state !== 'clean') throw new Error('Pull request mergeability unavailable');
    const branch = await request('/branches/main/protection');
    let requiredChecks: string[] = [];
    let requiredApprovals = 0;
    if (branch.status === 200 && !branch.redirected) {
      const protection = z.object({ required_status_checks: z.object({ contexts: z.array(z.string()) }).nullable().optional(),
        required_pull_request_reviews: z.object({ required_approving_review_count: z.number().int().nonnegative() }).nullable().optional(),
        required_conversation_resolution: z.object({ enabled: z.boolean() }).nullable().optional() })
        .parse(JSON.parse(await readDispatcherBody(branch)));
      requiredChecks = protection.required_status_checks?.contexts ?? [];
      requiredApprovals = protection.required_pull_request_reviews?.required_approving_review_count ?? 0;
      if (protection.required_conversation_resolution?.enabled) throw new Error('Conversation resolution requires independent verification');
    } else if (branch.status !== 404) throw new Error('Branch policy unavailable');
    const rulesets = z.array(z.object({ id, enforcement: z.string(), target: z.string() })).max(20)
      .parse(await json('/rulesets?includes_parents=true'));
    for (const rule of rulesets) {
      if (rule.enforcement !== 'active') continue;
      if (rule.target !== 'branch') throw new Error('Unknown active repository rule');
      const detail = z.object({ enforcement: z.literal('active'), rules: z.array(z.object({ type: z.string() })).max(20),
        conditions: z.object({ ref_name: z.object({ include: z.array(z.string()), exclude: z.array(z.string()) }) }) })
        .parse(await json(`/rulesets/${rule.id}`));
      // This exact active Komodo rule only prevents force pushes. Other rules
      // must be interpreted before this publisher may assume merge readiness.
      if (detail.conditions.ref_name.include.join(',') !== '~ALL'
        || detail.conditions.ref_name.exclude.some(value => value !== 'refs/heads/renovate/**')
        || detail.rules.some(value => value.type !== 'non_fast_forward')) throw new Error('Unsupported repository rules');
    }
    const checks = z.object({ total_count: z.number().int().nonnegative().max(100), check_runs: z.array(z.object({
      name: z.string(), status: z.string(), conclusion: z.string().nullable(),
    })).max(100) }).parse(await json(`/commits/${pr.head.sha}/check-runs?per_page=100`));
    if (checks.check_runs.length !== checks.total_count || checks.check_runs.some(run =>
      run.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(run.conclusion ?? ''))
      || requiredChecks.some(name => !checks.check_runs.some(run => run.name === name && run.conclusion === 'success'))) {
      throw new Error('Checks incomplete or failing');
    }
    const statuses = z.object({ statuses: z.array(z.object({ context: z.string(), state: z.string() })).max(100) })
      .parse(await json(`/commits/${pr.head.sha}/status?per_page=100`));
    if (statuses.statuses.some(status => status.state !== 'success')
      || requiredChecks.some(name => !statuses.statuses.some(status => status.context === name && status.state === 'success')
        && !checks.check_runs.some(run => run.name === name && run.conclusion === 'success'))) {
      throw new Error('Commit statuses incomplete or failing');
    }
    const reviews = z.array(z.object({ state: z.string(), user: z.object({ login: z.string() }).optional() })).max(100)
      .parse(await json(`/pulls/${pullRequest}/reviews?per_page=100`));
    const latest = new Map<string, string>();
    for (const review of reviews) {
      if (!review.user?.login) throw new Error('Review identity unavailable');
      latest.set(review.user.login.toLowerCase(), review.state);
    }
    if ([...latest.values()].some(value => value === 'CHANGES_REQUESTED')
      || (kind === 'merge' && [...latest.values()].filter(value => value === 'APPROVED').length < requiredApprovals)) {
      throw new Error('Required review unavailable');
    }
    // The intervening policy/check/review reads may race the PR. GitHub has
    // no base-sha CAS; reread both revisions immediately before each effect.
    const last = await observePr();
    if (last.mergeable !== true || last.mergeable_state !== 'clean') throw new Error('Pull request mergeability changed');
    await current();
  }
  return { observe, request, json, publisherIdentity, pullRequest };
}

/** Separate durable operations; the merge phase verifies the paired comment, never publishes it. */
export async function executeRenovateDecision(input: {
  github: ReturnType<typeof renovateGithub>; activityId: string; reconcileOnly: boolean; phase: 'comment' | 'merge';
  value: { operationId: string; target: { pullRequest: number; headSha: string };
    decision: 'MERGE' | 'DO_NOT_MERGE'; comment: string };
  observed: { base: { sha: string } };
}): Promise<Response> {
  const { github, value, phase } = input;
  const { pullRequest, headSha } = value.target;
  if (github.pullRequest !== pullRequest || !value.operationId.endsWith(`-${phase}`)
    || value.operationId.length <= phase.length + 1 || (phase === 'merge' && value.decision !== 'MERGE')) {
    throw new Error('Dispatcher effect binding denied');
  }
  const commentOperationId = phase === 'comment' ? value.operationId : value.operationId.slice(0, -6) + '-comment';
  const marker = `<!-- Codeflare Dispatcher ${input.activityId}:${commentOperationId}:${pullRequest}:${headSha}:${value.decision} -->`;
  const body = `${marker}\n${value.comment}`;
  const result = { pullRequest, headSha, decision: value.decision, comment: value.comment };
  const assessment: RenovateAssessment = { classification: value.decision === 'MERGE' ? 'safe' : 'unknown',
    observedHead: headSha, baseSha: commit.parse(input.observed.base.sha), reasons: ['Agent decision'],
    compatibility: value.comment, citations: [], gaps: [], checks: { state: 'unknown', observedHead: headSha } };
  const readComment = async () => {
    const publisher = await github.publisherIdentity();
    const rows = z.array(z.object({ id, body: z.string(), user: z.object({ id, login: z.string() }) })).max(100)
      .parse(await github.json(`/issues/${pullRequest}/comments?per_page=100`));
    const matches = rows.filter(row => row.body === body && row.user.id === publisher.id && row.user.login === publisher.login);
    if (matches.length > 1) throw new Error('Ambiguous comment receipt');
    return matches[0]?.id ?? null;
  };
  if (phase === 'comment') {
    if (!input.reconcileOnly) await github.observe(assessment, 'comment');
    let commentId = await readComment();
    if (!commentId && !input.reconcileOnly) {
      // Revalidate after receipt discovery, immediately before the only attempted write.
      await github.observe(assessment, 'comment');
      try {
        const response = await github.request(`/issues/${pullRequest}/comments`, 'POST', { body });
        if (response.status === 201 && !response.redirected) {
          z.object({ id, body: z.literal(body) }).parse(JSON.parse(await readDispatcherBody(response)));
        } else { await response.body?.cancel(); }
      } catch { /* Lost or ambiguous response: read back, never replay. */ }
      commentId = await readComment();
    }
    if (!commentId) throw new Error('Dispatcher comment receipt unavailable');
    return Response.json({ ...result, posted: true, commentId });
  }
  const failed = () => Response.json({ ...result, outcome: 'EXECUTION_FAILED' });
  const merged = () => Response.json({ ...result, outcome: 'MERGED' });
  const commentId = await readComment();
  if (!commentId) return failed();
  const mergeReceipt = async () => {
    const response = await github.request(`/pulls/${pullRequest}/merge`);
    if (response.status === 404 && !response.redirected) return false;
    if (response.status !== 204 || response.redirected) throw new Error('Merge receipt unavailable');
    // A merged status alone does not prove the exact expected head was merged.
    const pr = z.object({ number: id, merged: z.literal(true), head: z.object({ sha: commit }) })
      .parse(await github.json(`/pulls/${pullRequest}`));
    if (pr.number !== pullRequest || pr.head.sha !== headSha) throw new Error('Merged revision unverified');
    return true;
  };
  if (await mergeReceipt()) return merged();
  if (input.reconcileOnly) return failed();
  try {
    await github.observe(assessment, 'merge');
    if (await readComment() !== commentId) return failed();
  } catch { return failed(); }
  try {
    // GitHub supplies head CAS, not base CAS; observe rechecks the base but cannot freeze it.
    const response = await github.request(`/pulls/${pullRequest}/merge`, 'PUT', { sha: headSha });
    if (response.status === 200 && !response.redirected) {
      z.object({ merged: z.literal(true), sha: commit }).parse(JSON.parse(await readDispatcherBody(response)));
      return merged();
    }
    await response.body?.cancel();
  } catch { /* Uncertain merge is observed once, never retried. */ }
  return await mergeReceipt() ? merged() : failed();
}
