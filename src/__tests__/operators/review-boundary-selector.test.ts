import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectOperatorReviewApplicability } from '../../../preseed/agents/pi/extensions/operator-review-selector';
import type { Env } from '../../types';
import { getBucketName } from '../../lib/access';
import { GitHubInterceptor } from '../../github-interceptor';
import { selectReviewEnrollment } from '../../operators/review-enrollment';

// Only the platform base and unused owner ports are replaced. The native Pi
// selector, interceptor and protected Action applicability path remain real.
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(public ctx: ExecutionContext, public env: Env) {}
  },
  DurableObject: class {}, RpcTarget: class {},
}));
vi.mock('agents', () => ({ Agent: class {} }));
vi.mock('@cloudflare/containers', () => ({ getContainer: () => { throw Error('Unexpected container execution'); } }));
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
const head = 'b'.repeat(40), base = 'c'.repeat(40);
const workflowSource = 'name: Boundary Reviews\non: pull_request_target\njobs: {}\n';
const workflowDigest = '5d25cbe537cab5e78efad44b51b472c4e278ca6510342b3eb34914dc6ee4e95d';

function fixture(options: { denied?: boolean; inactiveAction?: boolean; execution?: 'not-found' | 'disabled'; piFirst: true;
  missingGeneration: true; noAuthority: true; missingActivity: true; unavailableSession: true }) {
  let stagedInput: unknown = null;
  let prepared: { activityId: string; contextDigest: string } | null = null;
  let visible: unknown = null;
  const binding = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
    workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main', workflowDigest,
    events: ['pull_request_target'], enabled: true, controlsRevision: 4 };
  const registry = {
    resolveManagementExecution: async () => options.execution ? { ok: false, reason: options.execution } : { ok: true, value: {
      installation: { id: 'review-install', operatorId: 'conductor-operator', revision: 2, enabled: true,
        policy: { capabilities: [], resourceProfileId: 'review-profile' }, configurationJson: '{}' },
      operator: { operatorId: 'conductor-operator', revision: 3, profile: 'conductor', enabled: true,
        policy: { capabilities: [], resourceProfileId: 'review-profile' },
        invokers: { users: ['owner@example.test'], groups: [] } },
      release: { id: 'review-release', bundleDigest: 'e'.repeat(64) }, controlsRevision: 4,
    } },
    getManagementControls: async () => ({ boundaryActions: options.inactiveAction ? [{ ...binding, enabled: false }]
      : options.denied ? [] : [binding] }),
    getBoundaryAction: async (repositoryId: number, protectedRef: string): Promise<typeof binding | null> => {
      const controls = await registry.getManagementControls();
      const matches = controls.boundaryActions.filter(action => action.repositoryId === repositoryId
        && action.protectedRef === protectedRef && action.enabled !== false);
      return matches.length === 1 ? matches[0]! : null;
    },
    reserveBoundaryPreparation: async (request: { contextDigest: string }) => {
      prepared = { activityId: 'reserved-activity', contextDigest: request.contextDigest };
      return { ok: true, value: { activityId: prepared.activityId, created: true } };
    },
    getBoundaryPreparation: async () => prepared,
    upsertOwnedActivity: async (_owner: string, summary: unknown) => { visible = summary; },
    getOwnedActivity: async () => visible,
  };
  const container = {
    getBoundaryInput: async () => stagedInput,
    stageBoundaryInput: async (request: { input: unknown }) => { stagedInput = request.input; return null; },
  };
  const env = { ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)),
    CONTAINER: { getByName: () => { throw Error('Remote Review session unavailable'); },
      idFromName: (name: string) => name,
      get: (id: string) => ({ claimBucketOwner: async (email: string) =>
        id === `bucket-owner:${ownerBucket}` && email === 'owner@example.test' ? 'owned' : 'conflict' }) },
    OPERATOR_REGISTRY: { getByName: () => registry },
  } as unknown as Env;
  const waiting: Promise<unknown>[] = [];
  const client = new GitHubInterceptor({ props: { user: 'owner@example.test', bucket: ownerBucket,
    sessionId: 'review1234', lifecycleGeneration: undefined },
    waitUntil: (work: Promise<unknown>) => { waiting.push(work); } } as unknown as ExecutionContext, env);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const next = request as Request;
    const path = new URL(next.url).pathname;
    if (path === '/repos/owner/repo') return Response.json({ id: 138,
      node_id: 'trusted-graphql-node', full_name: 'owner/repo', default_branch: 'main' });
    if (path === '/repos/owner/repo/pulls/34') return Response.json({ number: 34,
      node_id: 'PR_node_34', state: 'open',
      head: { sha: head, ref: 'feature', repo: { id: 138 } },
      base: { sha: base, ref: 'main', repo: { id: 138 } } });
    if (path.includes('/actions/workflows/')) return Response.json({ id: 531,
      path: binding.workflowPath, state: 'active' });
    if (path.endsWith('/contents/.github/workflows')) return Response.json([]);
    if (path.includes('/contents/')) return new URL(next.url).searchParams.get('ref') === 'e'.repeat(40)
      ? Response.json({ encoding: 'base64', content: btoa(workflowSource) })
      : new Response('unresolved workflow ref', { status: 404 });
    if (path.endsWith('/branches/main')) return Response.json({ name: 'main', protected: true,
      commit: { sha: 'e'.repeat(40) } });
    return new Response('unknown GitHub request', { status: 404 });
  });
  return { client, registry, container, waiting, env };
}

describe('REQ-OPERATOR-053: authenticated Git push prepares exactly one visible boundary reservation', () => {
  it.each([
    { name: 'absent Action', options: { denied: true }, expected: 'local' },
    { name: 'inactive Action', options: { inactiveAction: true }, expected: 'local' },
    { name: 'active Action without installed Conductor', options: { execution: 'not-found' as const }, expected: 'local' },
    { name: 'active Action with disabled Conductor', options: { execution: 'disabled' as const }, expected: 'local' },
    { name: 'eligible Action and Conductor without authority', options: {}, expected: 'unavailable' },
  ])('REQ-OPERATOR-053: packaged Pi selection preserves $name through the real interceptor', async ({ options, expected }) => {
    vi.stubEnv('ENTERPRISE_MODE', 'active');
    const repo = mkdtempSync(join(tmpdir(), 'review-packaged-applicability-'));
    try {
      mkdirSync(join(repo, '.git'));
      mkdirSync(join(repo, 'sdd'));
      writeFileSync(join(repo, 'sdd/README.md'), 'requirements');
      const { client, registry, container, waiting, env } = fixture({ ...options, piFirst: true,
        missingGeneration: true, noAuthority: true, missingActivity: true, unavailableSession: true });
      const runner = (async (_program: string, args: string[]) => {
        if (_program === 'git') return { stdout: args[0] === 'config' ? '' : 'origin\thttps://github.com/owner/repo.git (fetch)\n' };
        if (args[0] === 'pr') return { stdout: JSON.stringify({ number: 34, state: 'OPEN',
          baseRefName: 'main', headRefOid: head, url: 'https://github.com/owner/repo/pull/34' }) };
        if (args[0] === 'repo') return { stdout: JSON.stringify({ nameWithOwner: 'owner/repo',
          url: 'https://github.com/owner/repo' }) };
        if (!args.includes('--include')) return { stdout: '138' };
        const headers = new Headers();
        for (let index = 0; index < args.length - 1; index += 1) {
          if (args[index] !== '-H') continue;
          const header = args[++index]!;
          const separator = header.indexOf(':');
          headers.set(header.slice(0, separator), header.slice(separator + 1).trim());
        }
        const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', { headers }));
        const responseHeaders = [...response.headers].map(([key, value]) => `${key}: ${value}`).join('\n');
        return { stdout: `HTTP/2 ${response.status}\n${responseHeaders}\n\n${await response.text()}` };
      }) as never;
      expect(await selectOperatorReviewApplicability({ type: 'session_start' }, { cwd: repo }, runner, () => selectReviewEnrollment(env, 'owner/repo'))).toBe(expected);
      await Promise.all(waiting);
      expect(await container.getBoundaryInput()).toBeNull();
      expect(await registry.getBoundaryPreparation()).toBeNull();
      expect(await registry.getOwnedActivity()).toBeNull();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
