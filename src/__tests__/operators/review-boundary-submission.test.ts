import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { GitHubInterceptor } from '../../github-interceptor';

const state = vi.hoisted(() => ({ humanAvailable: true }));
vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'user-github-token' }));
vi.mock('../../lib/access', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/access')>();
  return { ...original, requireOperatorHumanContext: async () => {
    if (!state.humanAvailable) throw Error('No current human');
    return { human: { subject: 'owner', email: 'owner@example.test', issuer: 'https://team.cloudflareaccess.com',
      audiences: ['aud'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'private.jwt' };
  } };
});
afterEach(() => { vi.restoreAllMocks(); state.humanAvailable = true; });
const head = 'a'.repeat(40);
const input = { repositoryId: 138, pullRequest: 34, acknowledgedHead: 'b'.repeat(40), targetHead: head,
  payload: { range: `${'b'.repeat(40)}..${head}`, rejectedFindings: [{ id: 'prior',
    originalEvidenceRef: 'review-round-one:prior', rejectionReason: 'The previous rationale missed the owner check.' }] } };
const encoded = btoa(JSON.stringify(input));
function interceptor() {
  const staged: unknown[] = [];
  const stub = { getReviewLifecycleGeneration: async () => 1,
    openReviewHuman: async () => ({ human: { subject: 'owner', email: 'owner@example.test',
    issuer: 'https://team.cloudflareaccess.com', audiences: ['aud'], issuedAt: 1,
    expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'private.jwt' }),
    stageBoundaryInput: async (value: unknown) => { staged.push(value); } };
  const env = { ENTERPRISE_MODE: 'active', CONTAINER: { getByName: () => stub } } as unknown as Env;
  const waiting: Promise<unknown>[] = [];
  const ctx = { props: { user: 'owner@example.test', bucket: 'review-owner',
    sessionId: 'review1234', lifecycleGeneration: 1 },
    waitUntil: (promise: Promise<unknown>) => { waiting.push(promise); } } as unknown as ExecutionContext;
  return { client: new GitHubInterceptor(ctx, env), staged, waiting };
}

describe('REQ-OPERATOR-053: Pi boundary data travels through the existing session-bound GitHub transport', () => {
  it('submits bounded opaque evidence without forwarding its header or a browser assertion to GitHub', async () => {
    const { client, staged, waiting } = interceptor();
    let outbound: Request | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
      outbound = request as Request;
      return new Response(JSON.stringify({ number: 34, head: { sha: head } }), { status: 200 });
    });
    const result = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-input': encoded },
    }));
    expect(result.status).toBe(200);
    await result.text();
    await Promise.all(waiting);
    expect(outbound?.headers.has('x-codeflare-operator-boundary-input')).toBe(false);
    expect(outbound?.headers.has('cf-access-jwt-assertion')).toBe(false);
    expect(staged).toMatchObject([{ sessionId: 'review1234', input }]);
  });
  it('does not stage oversized, unmatched or failed GitHub reads', async () => {
    const { client, staged } = interceptor();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));
    const rejected = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-input': encoded },
    }));
    expect(rejected.status).toBe(502);
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('{}', { status: 200 }));
    const unrelated = await client.fetch(new Request('https://api.github.com/repos/owner/repo/issues/34', {
      headers: { 'x-codeflare-operator-boundary-input': encoded },
    }));
    expect(unrelated.status).toBe(200);
    const tooLarge = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-input': 'a'.repeat(16_000) },
    }));
    expect(tooLarge.status).toBe(200);
    expect(staged).toEqual([]);
  });
  it('does not stage session data from a bucket-only or expired human; ordinary GitHub reads still work', async () => {
    state.humanAvailable = false;
    const { client, staged } = interceptor();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ number: 34 }), { status: 200 }));
    const response = await client.fetch(new Request('https://api.github.com/repos/owner/repo/pulls/34', {
      headers: { 'x-codeflare-operator-boundary-input': encoded },
    }));
    expect(response.status).toBe(200);
    expect(staged).toEqual([]);
  });
});
