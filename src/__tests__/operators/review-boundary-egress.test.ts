import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { GitHubInterceptor } from '../../github-interceptor';

vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'user-github-token' }));
vi.mock('../../lib/access', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/access')>();
  return { ...original, requireOperatorHumanContext: async () => ({ human: {
    subject: 'human', email: 'owner@example.test', issuer: 'https://team.cloudflareaccess.com',
    audiences: ['aud'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300,
  }, accessJwt: 'private.jwt' }) };
});
afterEach(() => vi.restoreAllMocks());
const oldHead = 'a'.repeat(40), head = 'b'.repeat(40), base = 'c'.repeat(40), mergeBase = 'd'.repeat(40);
const packet = (text: string) => `${(new TextEncoder().encode(text).length + 4).toString(16).padStart(4, '0')}${text}`;
const upload = packet(`${oldHead} ${head} refs/heads/feature\0report-status side-band-64k\n`) + '0000';
const result = packet(`\u0001${packet('unpack ok\n')}${packet('ok refs/heads/feature\n')}0000`) + '0000';
const workflowSource = 'name: Boundary Reviews\non: pull_request\njobs: {}\n';
const workflowDigest = '08758fded8a2aa973ac14c14171697eaf2057a53691ba4231dd2d11a8ca3e990';
const boundaryInput = { repositoryId: 138, pullRequest: 34, acknowledgedHead: oldHead, targetHead: head,
  payload: { range: `${oldHead}..${head}`, rejectedFindings: [] } };

function fixture(options: { denied?: boolean; moved?: boolean; graphqlRejected?: boolean;
  missingInput?: boolean; noAuthority?: boolean; tamperedAction?: boolean;
  multipleHeadPulls?: boolean; lifecycleChange?: boolean; wrongCreationRepository?: boolean;
  actionUnprotectedMidflight?: boolean; handoffUncertain?: boolean;
  restartedBeforePush?: boolean; piFirst?: boolean } = {}) {
  let piEvidence = !options.piFirst;
  let prepared: { activityId: string; contextDigest: string } | null = null;
  let activity: { activityId: string; phase: string } | null = null;
  let visible: { activityId: string; executionStatus: string; attention: boolean } | null = null;
  const registry = {
    resolveManagementExecution: async () => ({ ok: true, value: {
      installation: { id: 'review-install', operatorId: 'conductor-operator', revision: 2,
        policy: { capabilities: [], resourceProfileId: 'review-profile' }, configurationJson: '{}' },
      operator: { operatorId: 'conductor-operator', revision: 3, profile: 'conductor', enabled: true,
        invokers: { users: ['owner@example.test'], groups: [] } },
      release: { id: 'review-release', bundleDigest: 'e'.repeat(64) }, controlsRevision: 4,
    } }),
    getBoundaryAction: async () => options.denied ? null : ({ repositoryId: 138, installationId: 'review-install',
      workflowId: 531, workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
      workflowDigest, events: ['pull_request'], controlsRevision: 4 }),
    reserveBoundaryPreparation: async (request: { contextDigest: string }) => {
      prepared = { activityId: 'reserved-activity', contextDigest: request.contextDigest };
      return { ok: true, value: { activityId: prepared.activityId, created: true } };
    },
    getBoundaryPreparation: async () => prepared,
    upsertOwnedActivity: async (_owner: string, summary: typeof visible) => { visible = summary; },
    getOwnedActivity: async () => visible,
    markBoundaryPrepared: async () => !options.handoffUncertain,
  };
  let lifecycleReads = 0;
  const container = {
    getReviewLifecycleGeneration: async () => options.restartedBeforePush
      || options.lifecycleChange && ++lifecycleReads > 1 ? 2 : 1,
    openReviewHuman: async () => {
      if (options.noAuthority) throw Error('Human authority expired');
      return { human: { subject: 'human', email: 'owner@example.test',
      issuer: 'https://team.cloudflareaccess.com', audiences: ['aud'], issuedAt: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'private.jwt' };
    },
    getBoundaryInput: async () => options.missingInput ? null : boundaryInput,
    stageBoundaryInput: async () => { piEvidence = true; return null; },
    stagePushEvidence: async (push: { owner: string; repository: string; ref: string; head: string }) =>
      options.missingInput || !piEvidence ? null : { generation: 1, push, input: boundaryInput },
    stagePrCreationEvidence: async (evidence: { pullRequest: number; repositoryNodeId: string;
      pullRequestNodeId: string; headRefName: string; baseRefName: string; head: string;
      owner: string; repository: string }) =>
      evidence.pullRequest !== 34 || options.missingInput ? null : { generation: 1, input: boundaryInput,
        push: { owner: evidence.owner, repository: evidence.repository,
          ref: 'refs/heads/feature', head: evidence.head },
        creation: { repositoryNodeId: evidence.repositoryNodeId, pullRequestNodeId: evidence.pullRequestNodeId,
          headRefName: evidence.headRefName, baseRefName: evidence.baseRefName } },
  };
  const operatorActivity = { prepareAuthorized: async (intent: { activityId: string }) => {
    activity = { activityId: intent.activityId, phase: 'prepared' }; return { ok: true, phase: 'prepared' };
  }, getBrowserDetail: async () => activity };
  const env = { ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)),
    CONTAINER: { getByName: () => container }, OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => operatorActivity } } as unknown as Env;
  const waiting: Promise<unknown>[] = [];
  let branchReads = 0;
  const client = new GitHubInterceptor({ props: { user: 'owner@example.test', bucket: 'review-owner',
    sessionId: 'review1234', lifecycleGeneration: 1 },
    waitUntil: (work: Promise<unknown>) => { waiting.push(work); } } as unknown as ExecutionContext, env);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const next = request as Request;
    const path = new URL(next.url).pathname;
    if (path === '/graphql') {
      await next.text();
      return Response.json(options.graphqlRejected ? { errors: [{ message: 'PR creation rejected' }] } : {
        data: { createPullRequest: { pullRequest: { id: 'PR_node_34',
          url: 'https://github.com/owner/repo/pull/34' } } },
      });
    }
    if (path === '/owner/repo.git/git-receive-pack') {
      await next.text();
      return new Response(result, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
    }
    if (path === '/repos/owner/repo') return Response.json({ id: 138,
      node_id: options.wrongCreationRepository ? 'other-repository-node' : 'trusted-graphql-node',
      full_name: 'owner/repo', default_branch: 'main' });
    if (path === '/repos/owner/repo/pulls') return Response.json([{ number: 34 }]);
    if (path === `/repos/owner/repo/commits/${head}/pulls`) return Response.json([
      { number: 34, state: 'open', head: { sha: head } },
      ...(options.multipleHeadPulls ? [{ number: 35, state: 'open', head: { sha: head } }] : []),
    ]);
    if (path === '/repos/owner/repo/pulls/34') return Response.json({ number: 34,
      node_id: 'PR_node_34', state: 'open',
      head: { sha: options.moved ? 'f'.repeat(40) : head, ref: 'feature', repo: { id: 138 } },
      base: { sha: base, ref: 'main', repo: { id: 138 } } });
    if (path.includes('/compare/')) return Response.json({ merge_base_commit: {
      sha: path.includes(`/compare/${oldHead}...`) ? oldHead : mergeBase } });
    if (path.includes('/actions/workflows/')) return Response.json({ id: 531,
      path: '.github/workflows/boundary-reviews.yml', state: 'active' });
    if (path.endsWith('/contents/.github/workflows')) return Response.json([]);
    if (path.includes('/contents/')) return new URL(next.url).searchParams.get('ref') === 'e'.repeat(40)
      ? Response.json({ encoding: 'base64',
        content: btoa(options.tamperedAction ? workflowSource.replace('Boundary Reviews', 'Tampered') : workflowSource) })
      : new Response('unresolved workflow ref', { status: 404 });
    if (path.endsWith('/branches/main')) return Response.json({ name: 'main',
      protected: !(options.actionUnprotectedMidflight && ++branchReads > 1),
      commit: { sha: 'e'.repeat(40) } });
    return new Response('unknown GitHub request', { status: 404 });
  });
  return { client, registry, operatorActivity, waiting };
}

describe('REQ-OPERATOR-053: authenticated Git push prepares exactly one visible boundary reservation', () => {
  it('checks protected applicability for manual local completion without staging Pi input', async () => {
    const { client, registry, waiting } = fixture({ piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': 'check',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('remote');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    const push = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
      method: 'POST', body: upload,
    }));
    expect(await push.text()).toBe(result);
    await Promise.all(waiting);
    expect(await registry.getBoundaryPreparation()).toBeNull();
  });
  it('selects exclusive remote Review before the push while preserving an unchanged local path only for confirmed absence', async () => {
    for (const [options, expected] of [
      [{ piFirst: true }, 'remote'], [{ denied: true }, 'local'],
      [{ tamperedAction: true }, 'unavailable'], [{ noAuthority: true }, 'unavailable'],
    ] as const) {
      const { client, registry, waiting } = fixture(options);
      const evidence = btoa(JSON.stringify(boundaryInput));
      const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
        headers: { 'x-codeflare-operator-boundary-select': '1',
          'x-codeflare-operator-boundary-input': evidence },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe(expected);
      expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
      if (expected === 'remote') {
        const push = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
          method: 'POST', body: upload,
        }));
        expect(await push.text()).toBe(result);
        await Promise.all(waiting);
        expect(await registry.getBoundaryPreparation()).toMatchObject({ activityId: 'reserved-activity' });
      } else expect(await registry.getBoundaryPreparation()).toBeNull();
    }
  });
  it('preserves Git bytes and binds an acked head to independent PR and protected Action evidence', async () => {
    const { client, registry, operatorActivity, waiting } = fixture();
    const response = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
      method: 'POST', body: upload,
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(result);
    await Promise.all(waiting);
    expect(await registry.getBoundaryPreparation()).toMatchObject({ activityId: 'reserved-activity' });
    expect(await operatorActivity.getBrowserDetail()).toEqual({ activityId: 'reserved-activity', phase: 'prepared' });
  });
  it('accepts verified GraphQL PR creation only after independent exact-context lookup, not from HTTP 200', async () => {
    for (const graphqlRejected of [false, true]) {
      const { client, registry, waiting } = fixture({ graphqlRejected });
      const response = await client.fetch(new Request('https://api.github.com/graphql', { method: 'POST',
        body: JSON.stringify({ query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }',
          variables: { input: { repositoryId: 'trusted-graphql-node', headRefName: 'feature', baseRefName: 'main' } } }),
        headers: { 'content-type': 'application/json' },
      }));
      expect(response.status).toBe(200);
      await response.text();
      await Promise.all(waiting);
      expect((await registry.getBoundaryPreparation()) !== null).toBe(!graphqlRejected);
    }
  });
  it('exposes an uncertain reservation without claiming a usable Action handoff when commitment fails', async () => {
    const { client, registry, waiting } = fixture({ handoffUncertain: true });
    const response = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
      method: 'POST', body: upload,
    }));
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(waiting);
    expect(await registry.getBoundaryPreparation()).toMatchObject({ activityId: 'reserved-activity' });
    expect(await registry.getOwnedActivity()).toMatchObject({ activityId: 'reserved-activity',
      executionStatus: 'unknown', attention: true });
  });
  it('rejects a PR-creation response for a different repository node, even with the same PR number', async () => {
    const { client, registry, waiting } = fixture({ wrongCreationRepository: true });
    const response = await client.fetch(new Request('https://api.github.com/graphql', { method: 'POST',
      body: JSON.stringify({ query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }',
        variables: { input: { repositoryId: 'trusted-graphql-node', headRefName: 'feature', baseRefName: 'main' } } }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(waiting);
    expect(await registry.getBoundaryPreparation()).toBeNull();
  });
  it('does not prepare when the trusted Action is absent or the PR head changed', async () => {
    for (const options of [{ denied: true }, { moved: true }, { missingInput: true },
      { noAuthority: true }, { tamperedAction: true }, { multipleHeadPulls: true },
      { lifecycleChange: true }, { restartedBeforePush: true },
      { actionUnprotectedMidflight: true }]) {
      const { client, registry, waiting } = fixture(options);
      const response = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
        method: 'POST', body: upload,
      }));
      expect(response.status).toBe(200);
      await response.text();
      await Promise.all(waiting);
      expect(await registry.getBoundaryPreparation()).toBeNull();
    }
  });
});
