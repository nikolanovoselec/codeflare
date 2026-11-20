import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { getBucketName } from '../../lib/access';
import { GitHubInterceptor } from '../../github-interceptor';
import { parseOperatorConsumerInvocation } from '../../operators/consumer-contracts';
import type { BoundaryActivityBinding } from '../../operators/activity';

vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'user-github-token' }));
vi.mock('../../lib/access', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/access')>();
  return { ...original,
    resolveSessionAccessGroup: async () => [],
    loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['review.v1'], defaultRoute: 'review.v1',
      defaultReasoning: 'off', routeContextWindows: {}, routeReasoningLevels: {}, modelDisplayNames: {} }),
    requireOperatorHumanContext: async () => ({ human: {
    subject: 'human', email: 'owner@example.test', issuer: 'https://team.cloudflareaccess.com',
    audiences: ['aud'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300,
  }, accessJwt: 'private.jwt' }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const ownerBucket = getBucketName('owner@example.test');
const oldHead = 'a'.repeat(40), head = 'b'.repeat(40), base = 'c'.repeat(40), mergeBase = 'd'.repeat(40);
const packet = (text: string) => `${(new TextEncoder().encode(text).length + 4).toString(16).padStart(4, '0')}${text}`;
const upload = packet(`${oldHead} ${head} refs/heads/feature\0report-status side-band-64k\n`) + '0000';
const result = packet(`\u0001${packet('unpack ok\n')}${packet('ok refs/heads/feature\n')}0000`) + '0000';
const workflowSource = 'name: Boundary Reviews\non: pull_request_target\njobs: {}\n';
const workflowDigest = '5d25cbe537cab5e78efad44b51b472c4e278ca6510342b3eb34914dc6ee4e95d';
const boundaryInput = { repositoryId: 138, pullRequest: 34, acknowledgedHead: oldHead, targetHead: head,
  payload: { range: `${oldHead}..${head}`, rejectedFindings: [] } };

function fixture(options: { denied?: boolean; moved?: boolean; graphqlRejected?: boolean;
  missingInput?: boolean; noAuthority?: boolean; tamperedAction?: boolean;
  multipleHeadPulls?: boolean; lifecycleChange?: boolean; wrongCreationRepository?: boolean;
  actionUnprotectedMidflight?: boolean; handoffUncertain?: boolean;
  restartedBeforePush?: boolean; piFirst?: boolean; wrongOwnerBucket?: boolean;
  missingGeneration?: boolean; missingSessionId?: boolean; unavailableSession?: boolean;
  missingActivity?: boolean; inactiveAction?: boolean; customActionPath?: boolean; untrustedAction?: boolean;
  lookup?: 'forbidden' | 'malformed' | 'malformed-entry' | 'workflow-present';
  registryFailure?: 'missing' | 'unreadable' | 'malformed-controls' | 'ambiguous';
  execution?: 'not-found' | 'disabled' | 'other-profile' | 'installation-disabled' | 'operator-disabled'
    | 'other-invoker' | 'unreadable' | 'artifact-unapproved' | 'stale-controls';
  workflowLookup?: 'forbidden' | 'malformed';
  nonEnterprise?: boolean; requireUserAgent?: boolean } = {}) {
  let piEvidence = !options.piFirst;
  let stagedInput: unknown = options.missingInput || options.piFirst ? null : boundaryInput;
  const actionPath = options.customActionPath
    ? '.github/workflows/custom-review.yml' : '.github/workflows/boundary-reviews.yml';
  const binding = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
    workflowPath: actionPath, protectedRef: 'refs/heads/main', workflowDigest, enabled: true,
    events: options.untrustedAction ? ['pull_request'] : ['pull_request_target'], controlsRevision: 4 };
  let prepared: { activityId: string; contextDigest: string } | null = null;
  let activity: { activityId: string; phase: string } | null = null;
  let boundary: BoundaryActivityBinding | null = null;
  let admittedInvocation: unknown = null;
  let visible: { activityId: string; executionStatus: string; attention: boolean } | null = null;
  const registry = {
    resolveManagementExecution: async () => {
      if (options.execution === 'unreadable') throw Error('Registry execution lookup unavailable');
      if (options.execution === 'not-found' || options.execution === 'disabled' || options.execution === 'artifact-unapproved') {
        return { ok: false, reason: options.execution };
      }
      return { ok: true, value: {
        installation: { id: 'review-install', operatorId: 'conductor-operator', revision: 2,
          enabled: options.execution !== 'installation-disabled',
          policy: { capabilities: [], resourceProfileId: 'review-profile' }, configurationJson: '{}' },
        operator: { operatorId: 'conductor-operator', revision: 3,
          profile: options.execution === 'other-profile' ? 'dispatcher' : 'conductor',
          enabled: options.execution !== 'operator-disabled',
          policy: { capabilities: [], resourceProfileId: 'review-profile' },
          invokers: { users: [options.execution === 'other-invoker' ? 'other@example.test' : 'owner@example.test'], groups: [] } },
        release: { id: 'review-release', bundleDigest: 'e'.repeat(64) },
        controlsRevision: options.execution === 'stale-controls' ? 3 : 4,
      } };
    },
    getManagementControls: async () => {
      if (options.registryFailure === 'unreadable') throw Error('Registry unavailable');
      if (options.registryFailure === 'malformed-controls') return { boundaryActions: {} };
      return { boundaryActions: options.inactiveAction ? [{ ...binding, enabled: false }]
        : options.registryFailure === 'ambiguous' ? [{ ...binding, protectedRef: 'refs/heads/develop' }]
        : options.denied ? [] : [binding] };
    },
    getBoundaryAction: async (repositoryId: number, protectedRef: string): Promise<typeof binding | null> => {
      const controls = await registry.getManagementControls();
      if (!Array.isArray(controls.boundaryActions)) throw Error('Malformed Registry controls');
      const matches = controls.boundaryActions.filter(action => action.repositoryId === repositoryId
        && action.protectedRef === protectedRef && action.enabled !== false);
      return matches.length === 1 ? matches[0]! : null;
    },
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
    getBoundaryInput: async () => stagedInput,
    stageBoundaryInput: async (request: { input: unknown }) => {
      stagedInput = request.input; piEvidence = true; return null;
    },
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
  const operatorActivity = { prepareAuthorized: async (intent: { activityId: string },
    _executionContext: unknown, invocationJson: string, binding?: BoundaryActivityBinding) => {
    boundary = binding ?? null;
    admittedInvocation = parseOperatorConsumerInvocation(JSON.parse(invocationJson));
    activity = { activityId: intent.activityId, phase: 'prepared' }; return { ok: true, phase: 'prepared' };
  }, getBrowserDetail: async () => activity, getBoundaryStartBinding: async () => boundary,
    getPreparedInvocation: async () => admittedInvocation };
  const env = { ENTERPRISE_MODE: options.nonEnterprise ? undefined : 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)),
    CONTAINER: { getByName: () => {
      if (options.unavailableSession) throw Error('Remote Review session unavailable');
      return container;
    }, idFromName: (name: string) => name,
      get: (id: string) => ({ claimBucketOwner: async (email: string) =>
        id === `bucket-owner:${ownerBucket}` && email === 'owner@example.test' ? 'owned' : 'conflict' }) },
    OPERATOR_REGISTRY: options.registryFailure === 'missing' ? undefined : { getByName: () => registry },
    OPERATOR_ACTIVITY: options.missingActivity ? undefined : { getByName: () => operatorActivity } } as unknown as Env;
  const waiting: Promise<unknown>[] = [];
  let branchReads = 0;
  const client = new GitHubInterceptor({ props: { user: 'owner@example.test',
    bucket: options.wrongOwnerBucket ? 'another-owner-bucket' : ownerBucket,
    sessionId: options.missingSessionId ? undefined : 'review1234',
    lifecycleGeneration: options.missingGeneration ? undefined : 1 },
    waitUntil: (work: Promise<unknown>) => { waiting.push(work); } } as unknown as ExecutionContext, env);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const next = request as Request;
    const url = new URL(next.url);
    const path = url.pathname;
    if (options.requireUserAgent && url.hostname === 'api.github.com'
      && !next.headers.get('user-agent')?.trim()) {
      return new Response('Please make sure your request has a User-Agent header', { status: 403 });
    }
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
    if (path.includes('/actions/workflows/')) {
      if (options.workflowLookup === 'forbidden') return new Response('forbidden', { status: 403 });
      if (options.workflowLookup === 'malformed') return new Response('{');
      return Response.json({ id: 531, path: actionPath, state: 'active' });
    }
    if (path.endsWith('/contents/.github/workflows')) {
      if (options.lookup === 'forbidden') return new Response('forbidden', { status: 403 });
      if (options.lookup === 'malformed') return new Response('{');
      if (options.lookup === 'malformed-entry') return Response.json([{}]);
      return Response.json(options.lookup === 'workflow-present' ? [{ name: 'boundary-reviews.yml' }] : []);
    }
    if (path.includes('/contents/')) return new URL(next.url).searchParams.get('ref') === 'e'.repeat(40)
      ? Response.json({ encoding: 'base64',
        content: btoa(options.tamperedAction ? workflowSource.replace('Boundary Reviews', 'Tampered') : workflowSource) })
      : new Response('unresolved workflow ref', { status: 404 });
    if (path.endsWith('/branches/main')) return Response.json({ name: 'main',
      protected: !(options.actionUnprotectedMidflight && ++branchReads > 1),
      commit: { sha: 'e'.repeat(40) } });
    return new Response('unknown GitHub request', { status: 404 });
  });
  return { client, registry, operatorActivity, waiting, container };
}

describe('REQ-OPERATOR-053: authenticated Git push prepares exactly one visible boundary reservation', () => {
  it.each([
    { name: 'confirmed absent Action selects local', selection: 'local',
      options: { denied: true, noAuthority: true, missingGeneration: true, missingSessionId: true, missingActivity: true } },
    { name: 'trusted active Action selects remote', selection: 'remote', options: {} },
  ])('REQ-OPERATOR-053: $name when GitHub requires User-Agent, without staging on check', async ({ options, selection }) => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ ...options,
      requireUserAgent: true, piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'user-agent': 'GitHub CLI', 'x-codeflare-operator-boundary-select': 'check',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe(selection);
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    await Promise.all(waiting);
    expect(await container.getBoundaryInput()).toBeNull();
    expect(await registry.getBoundaryPreparation()).toBeNull();
    expect(await registry.getOwnedActivity()).toBeNull();
    expect(await operatorActivity.getBrowserDetail()).toBeNull();
  });
  it.each([
    { name: 'missing generation', options: { missingGeneration: true } },
    { name: 'unavailable or expired human', options: { noAuthority: true } },
    { name: 'unreachable remote session', options: { unavailableSession: true } },
    { name: 'missing Activity binding', options: { missingActivity: true } },
    { name: 'missing remote session identity', options: { missingSessionId: true } },
    { name: 'all remote prerequisites missing', options: { missingGeneration: true,
      noAuthority: true, unavailableSession: true, missingActivity: true, missingSessionId: true } },
  ])('REQ-OPERATOR-053: absent target Action stays local with $name without staging', async ({ options }) => {
    for (const mode of ['check', '1']) {
      const { client, registry, operatorActivity, container, waiting } = fixture({ ...options, denied: true, piFirst: true });
      const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
        headers: { 'x-codeflare-operator-boundary-select': mode,
          'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('local');
      expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
      await Promise.all(waiting);
      expect(await container.getBoundaryInput()).toBeNull();
      expect(await registry.getBoundaryPreparation()).toBeNull();
      expect(await registry.getOwnedActivity()).toBeNull();
      expect(await operatorActivity.getBrowserDetail()).toBeNull();
    }
  });
  it('REQ-OPERATOR-053: explicit inactive enrollment stays local with no remote prerequisites', async () => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ inactiveAction: true, piFirst: true,
      noAuthority: true, unavailableSession: true, missingGeneration: true, missingSessionId: true, missingActivity: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': '1',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('local');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    await Promise.all(waiting);
    expect(await container.getBoundaryInput()).toBeNull();
    expect(await registry.getBoundaryPreparation()).toBeNull();
    expect(await registry.getOwnedActivity()).toBeNull();
    expect(await operatorActivity.getBrowserDetail()).toBeNull();
  });
  it.each([
    { name: 'missing Registry', options: { registryFailure: 'missing' } },
    { name: 'unregistered workflow YAML', options: { denied: true, lookup: 'workflow-present' } },
    { name: 'binding on another protected base', options: { registryFailure: 'ambiguous' } },
    { name: 'Conductor not installed', options: { execution: 'not-found' } },
    { name: 'Conductor disabled', options: { execution: 'disabled' } },
    { name: 'non-Conductor installation', options: { execution: 'other-profile' } },
    { name: 'explicitly disabled installation', options: { execution: 'installation-disabled' } },
    { name: 'explicitly disabled operator', options: { execution: 'operator-disabled' } },
  ] as const)('REQ-OPERATOR-053: $name automatically retains local Review without remote prerequisites', async ({ options }) => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ ...options,
      missingGeneration: true, noAuthority: true, missingActivity: true, unavailableSession: true, piFirst: true });
    for (const mode of ['check', '1']) {
      const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
        headers: { 'x-codeflare-operator-boundary-select': mode,
          'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('local');
      expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
      await Promise.all(waiting);
      expect(await container.getBoundaryInput()).toBeNull();
      expect(await registry.getBoundaryPreparation()).toBeNull();
      expect(await registry.getOwnedActivity()).toBeNull();
      expect(await operatorActivity.getBrowserDetail()).toBeNull();
    }
  });
  it('REQ-OPERATOR-053: a current user outside Conductor invokers automatically retains local Review', async () => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ execution: 'other-invoker', piFirst: true });
    for (const mode of ['check', '1']) {
      const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
        headers: { 'x-codeflare-operator-boundary-select': mode,
          'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('local');
      expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
      await Promise.all(waiting);
      expect(await container.getBoundaryInput()).toBeNull();
      expect(await registry.getBoundaryPreparation()).toBeNull();
      expect(await registry.getOwnedActivity()).toBeNull();
      expect(await operatorActivity.getBrowserDetail()).toBeNull();
    }
  });
  it.each([
    { name: 'unreadable Registry controls', options: { registryFailure: 'unreadable' } },
    { name: 'malformed Registry controls', options: { registryFailure: 'malformed-controls' } },
    { name: 'failed Conductor lookup', options: { execution: 'unreadable' } },
    { name: 'unapproved Conductor artifact', options: { execution: 'artifact-unapproved' } },
    { name: 'changed controls revision', options: { execution: 'stale-controls' } },
    { name: 'forbidden active workflow read', options: { workflowLookup: 'forbidden' } },
    { name: 'malformed active workflow read', options: { workflowLookup: 'malformed' } },
  ] as const)('REQ-OPERATOR-053: $name stays unavailable rather than implying local eligibility', async ({ options }) => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ ...options, piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': '1',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('unavailable');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    await Promise.all(waiting);
    expect(await container.getBoundaryInput()).toBeNull();
    expect(await registry.getBoundaryPreparation()).toBeNull();
    expect(await registry.getOwnedActivity()).toBeNull();
    expect(await operatorActivity.getBrowserDetail()).toBeNull();
  });
  it.each([
    { name: 'invalid JSON', input: '{' },
    { name: 'invalid repository ID', input: JSON.stringify({ ...boundaryInput, repositoryId: 0 }) },
  ])('REQ-OPERATOR-053: $name remains unavailable even without a Registry binding', async ({ input }) => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ registryFailure: 'missing', piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': '1', 'x-codeflare-operator-boundary-input': btoa(input) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('unavailable');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    await Promise.all(waiting);
    expect(await container.getBoundaryInput()).toBeNull();
    expect(await registry.getBoundaryPreparation()).toBeNull();
    expect(await registry.getOwnedActivity()).toBeNull();
    expect(await operatorActivity.getBrowserDetail()).toBeNull();
  });
  it.each([
    { name: 'missing generation', options: { missingGeneration: true } },
    { name: 'unavailable or expired human', options: { noAuthority: true } },
    { name: 'unreachable remote session', options: { unavailableSession: true } },
    { name: 'missing Activity binding', options: { missingActivity: true } },
    { name: 'missing remote session identity', options: { missingSessionId: true } },
  ])('REQ-OPERATOR-053: active trusted Action with $name stays unavailable without staging', async ({ options }) => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ ...options, piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': '1',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('unavailable');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    await Promise.all(waiting);
    expect(await container.getBoundaryInput()).toBeNull();
    expect(await registry.getBoundaryPreparation()).toBeNull();
    expect(await registry.getOwnedActivity()).toBeNull();
    expect(await operatorActivity.getBrowserDetail()).toBeNull();
  });
  it.each([
    { name: 'verified custom workflow path', options: { customActionPath: true }, selection: 'remote' },
    { name: 'tampered custom workflow bytes', options: { customActionPath: true, tamperedAction: true }, selection: 'unavailable' },
    { name: 'untrusted active event metadata', options: { untrustedAction: true }, selection: 'unavailable' },
  ])('REQ-OPERATOR-053: $name preserves trusted selection and staging boundaries', async ({ options, selection }) => {
    const { client, registry, operatorActivity, container, waiting } = fixture({ ...options, piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': '1',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe(selection);
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    if (selection === 'remote') {
      expect(await container.getBoundaryInput()).toEqual(boundaryInput);
      const push = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
        method: 'POST', body: upload,
      }));
      expect(push.status).toBe(200);
      expect(await push.text()).toBe(result);
      await Promise.all(waiting);
      expect(await registry.getBoundaryPreparation()).toMatchObject({ activityId: 'reserved-activity' });
      expect(await operatorActivity.getBrowserDetail()).toEqual({ activityId: 'reserved-activity', phase: 'prepared' });
    } else {
      await Promise.all(waiting);
      expect(await container.getBoundaryInput()).toBeNull();
      expect(await registry.getBoundaryPreparation()).toBeNull();
      expect(await registry.getOwnedActivity()).toBeNull();
      expect(await operatorActivity.getBrowserDetail()).toBeNull();
    }
  });
  it.each([false, true])('REQ-OPERATOR-053: non-Enterprise interception cannot select Operator Review (absent=%s)', async denied => {
    const { client, registry, container, waiting } = fixture({ nonEnterprise: true, denied, piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': '1',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('unavailable');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    await Promise.all(waiting);
    expect(await container.getBoundaryInput()).toBeNull();
    expect(await registry.getBoundaryPreparation()).toBeNull();
  });
  it('checks protected applicability for manual local completion without staging Pi input', async () => {
    const { client, registry, waiting, container } = fixture({ piFirst: true });
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-select': 'check',
        'x-codeflare-operator-boundary-input': btoa(JSON.stringify(boundaryInput)) },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codeflare-operator-boundary-selection')).toBe('remote');
    expect(await response.json()).toMatchObject({ number: 34, head: { sha: head } });
    expect(await container.getBoundaryInput()).toBeNull();
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
    const reserved = await registry.getBoundaryPreparation();
    expect(reserved).toMatchObject({ activityId: 'reserved-activity' });
    expect(await operatorActivity.getBrowserDetail()).toEqual({ activityId: 'reserved-activity', phase: 'prepared' });
    expect(await operatorActivity.getPreparedInvocation()).toMatchObject({ resources: {
      inference: { routeId: 'review.v1', reasoningLevel: 'off' },
      session: { profileId: 'review-profile' }, storage: { scopeId: 'review-profile' },
    } });
    expect(await operatorActivity.getBoundaryStartBinding()).toMatchObject({ repositoryId: 138,
      pullRequest: 34, contextDigest: reserved?.contextDigest,
      session: { bucket: ownerBucket, sessionId: 'review1234', generation: 1 } });
  });
  it('rejects remote preparation when the verified owner bucket differs from the bound session', async () => {
    const { client, registry, operatorActivity, waiting } = fixture({ wrongOwnerBucket: true });
    const response = await client.fetch(new Request('https://github.com/owner/repo.git/git-receive-pack', {
      method: 'POST', body: upload,
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(result);
    await Promise.all(waiting);
    expect(await registry.getBoundaryPreparation()).toBeNull();
    expect(await registry.getOwnedActivity()).toBeNull();
    expect(await operatorActivity.getBrowserDetail()).toBeNull();
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
