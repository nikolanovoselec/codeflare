import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { GitHubInterceptor } from '../../github-interceptor';

vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'human-token' }));
vi.mock('../../lib/access', async (original) => {
  const access = await original<typeof import('../../lib/access')>();
  return { ...access, requireOperatorHumanContext: async (request: Request) => {
    const bob = request.headers.get('cf-access-jwt-assertion') === 'bob.jwt';
    return { human: { subject: bob ? 'bob' : 'alice', email: bob ? 'bob@example.test' : 'alice@example.test',
      issuer: 'https://team.cloudflareaccess.com', audiences: ['aud'], issuedAt: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: bob ? 'bob.jwt' : 'alice.jwt' };
  } };
});
vi.mock('../../operators/review-history-transport', async (original) => ({
  ...await original<typeof import('../../operators/review-history-transport')>(),
  readPublishedReview: async (input: any) =>
  input.repositoryId === 138 && input.pullRequest === 34 && input.activityId === 'review-activity'
    && input.currentHead === 'b'.repeat(40)
    ? { schemaVersion: 1, status: 'published', repository: 'owner/repo', repositoryId: 138,
      pullRequest: 34, activityId: 'review-activity', head: 'a'.repeat(40), round: 2,
      artifactDigest: 'f'.repeat(64), findings: [{ id: 'code-reviewer-guard', lane: 'code-reviewer',
        severity: 'HIGH', path: 'src/guard.ts', line: 12, message: 'Missing authorization check',
        evidence: 'Write occurs before the guard.' }] }
    : { status: 'unavailable' } }));
afterEach(() => vi.restoreAllMocks());

const currentHead = 'b'.repeat(40), priorHead = 'a'.repeat(40);
function fixture(options: { user?: 'alice' | 'bob'; lifecycleChange?: boolean;
  denied?: boolean; wrongPublisher?: boolean } = {}) {
  const user = options.user ?? 'alice';
  const email = `${user}@example.test`;
  const session = { getReviewLifecycleGeneration: async () => options.lifecycleChange ? 2 : 1,
    openReviewHuman: async () => ({ human: { subject: user, email,
      issuer: 'https://team.cloudflareaccess.com', audiences: ['aud'], issuedAt: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: `${user}.jwt` }),
    stageBoundaryInput: async () => { throw Error('Read-only request staged boundary input'); } };
  const env = { ENTERPRISE_MODE: 'active', CONTAINER: { getByName: () => session },
    OPERATOR_ACTIVITY: { getByName: () => { throw Error('Read-only request opened a private Activity'); } },
    OPERATOR_REGISTRY: { getByName: () => ({
      getBoundaryAction: async (id: number, ref: string) => id === 138 && ref === 'refs/heads/main'
        ? { repositoryId: 138, workflowId: 531, protectedRef: ref } : null,
      getBoundaryPreparation: async () => { throw Error('Read-only request selected private preparation'); },
      reserveBoundaryPreparation: async () => { throw Error('Read-only request reserved a Review'); },
    }) },
  } as unknown as Env;
  const client = new GitHubInterceptor({ props: { user: email, bucket: 'review-owner',
    sessionId: 'review1234', lifecycleGeneration: 1 } } as unknown as ExecutionContext, env);
  const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const path = new URL((request as Request).url).pathname;
    if (options.denied) return Response.json({ message: 'Forbidden' }, { status: 403 });
    if (path === '/users/github-actions%5Bbot%5D') return Response.json({ login: 'github-actions[bot]', type: 'Bot', id: 777 });
    if (path === '/apps/github-actions') return Response.json({
      slug: options.wrongPublisher ? 'untrusted' : 'github-actions', id: 888 });
    if (path === '/repos/owner/repo') return Response.json({ id: 138, permissions: { pull: true } });
    if (path === '/repos/owner/repo/pulls/34') return Response.json({ number: 34, state: 'open',
      head: { sha: currentHead, repo: { id: 138 } }, base: { sha: 'c'.repeat(40), ref: 'main', repo: { id: 138 } } });
    return new Response('missing', { status: 404 });
  });
  const read = (path = '/repos/owner/repo/pulls/34', activity = 'review-activity') => client.fetch(new Request(
    `https://api.github.com${path}`, { headers: { 'x-codeflare-operator-boundary-result': activity } }));
  return { read, upstream };
}

describe('REQ-OPERATOR-053/056: read-only authenticated Review publication projection', () => {
  it('returns a bounded published prior round from the actual intercepted GitHub PR read without staging or starting a Review', async () => {
    const { read, upstream } = fixture();
    const response = await read();
    expect(await response.json()).toMatchObject({ schemaVersion: 1, status: 'published',
      repositoryId: 138, pullRequest: 34, head: priorHead, activityId: 'review-activity',
      findings: [{ id: 'code-reviewer-guard' }] });
    for (const [request] of upstream.mock.calls) {
      expect((request as Request).headers.has('x-codeflare-operator-boundary-result')).toBe(false);
      expect((request as Request).headers.has('cf-access-jwt-assertion')).toBe(false);
    }
  });

  it('permits Bob to inspect the PR-wide published report with his own authorized session, not Alice private Activity', async () => {
    expect(await (await fixture({ user: 'bob' }).read()).json()).toMatchObject({ status: 'published',
      findings: [{ id: 'code-reviewer-guard' }] });
  });

  it.each([
    ['foreign PR', '/repos/owner/repo/pulls/35', 'review-activity'],
    ['foreign repository', '/repos/other/repo/pulls/34', 'review-activity'],
    ['wrong activity', '/repos/owner/repo/pulls/34', 'foreign-activity'],
  ])('returns no private finding for %s', async (_name, path, activity) => {
    const response = await fixture().read(path, activity);
    expect(await response.json()).not.toMatchObject({ status: 'published' });
  });
  it('does not treat expired session generation or denied GitHub repository access as published evidence', async () => {
    for (const options of [{ lifecycleChange: true }, { denied: true }, { wrongPublisher: true }]) {
      const response = await fixture(options).read();
      expect(await response.json()).not.toMatchObject({ status: 'published' });
    }
  });
});
