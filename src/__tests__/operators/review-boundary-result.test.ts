import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { GitHubInterceptor } from '../../github-interceptor';
import { resetAuthConfigCache } from '../../lib/access';
import { resetJWKSCache } from '../../lib/jwt';
import { storeGithubConnection } from '../../lib/github-token';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createMockKV } from '../helpers/mock-kv';
import { createReviewPublicationGitHubFixture, reviewPublicationFaults,
  type ReviewPublicationFault } from '../helpers/review-publication-github-fixture';

let keys: CryptoKeyPair;
let publicJwk: JsonWebKey;
beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey;
});
beforeEach(() => { resetAuthConfigCache(); resetJWKSCache(); });
afterEach(() => { vi.restoreAllMocks(); resetAuthConfigCache(); resetJWKSCache(); });

const currentHead = 'b'.repeat(40), priorHead = 'a'.repeat(40);
const finding = { id: 'code-reviewer-guard', severity: 'HIGH', path: 'src/guard.ts', line: 12,
  message: 'Missing authorization check', evidence: 'Write occurs before the guard.' };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function fixture(options: { user?: 'alice' | 'bob'; lifecycleChange?: boolean;
  invalidJwt?: boolean; revokedIdentity?: boolean; fault?: ReviewPublicationFault } = {}) {
  const user = options.user ?? 'alice';
  const email = `${user}@example.test`, issuer = 'https://team.cloudflareaccess.com';
  const now = Math.floor(Date.now() / 1000);
  const human = { subject: user, email, issuer, audiences: ['aud'], issuedAt: now - 10, expiresAt: now + 300 };
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'review-key', typ: 'JWT' })));
  const payload = encode(new TextEncoder().encode(JSON.stringify({ type: 'app', sub: user, email,
    iss: issuer, aud: ['aud'], iat: human.issuedAt, exp: human.expiresAt })));
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)));
  if (options.invalidJwt) signature[0] ^= 1;
  const accessJwt = `${header}.${payload}.${encode(signature)}`;
  const session = { getReviewLifecycleGeneration: async () => options.lifecycleChange ? 2 : 1,
    openReviewHuman: async () => ({ human, accessJwt }),
    stageBoundaryInput: async () => { throw Error('Read-only request staged boundary input'); } };
  const kv = createMockKV();
  kv._store.set(SETUP_KEYS.AUTH_DOMAIN, 'team.cloudflareaccess.com');
  kv._store.set(SETUP_KEYS.ACCESS_AUD, 'aud');
  const env = { ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('r'.repeat(32)), KV: kv,
    CONTAINER: { getByName: () => session },
    OPERATOR_ACTIVITY: { getByName: () => { throw Error('Read-only request opened a private Activity'); } },
    OPERATOR_REGISTRY: { getByName: () => ({
      getBoundaryAction: async (id: number, ref: string) => id === 138 && ref === 'refs/heads/main'
        ? { repositoryId: 138, workflowId: 531, protectedRef: ref } : null,
      getBoundaryPreparation: async () => { throw Error('Read-only request selected private preparation'); },
      reserveBoundaryPreparation: async () => { throw Error('Read-only request reserved a Review'); },
    }) },
  } as unknown as Env;
  await storeGithubConnection(env, 'review-owner', { accessToken: 'human-token', source: 'pat' });
  const github = createReviewPublicationGitHubFixture({ currentHead, priorHead,
    activityId: 'review-activity', round: 2, token: 'human-token', finding });
  github.setFault(options.fault);
  const client = new GitHubInterceptor({ props: { user: email, bucket: 'review-owner',
    sessionId: 'review1234', lifecycleGeneration: 1 } } as unknown as ExecutionContext, env);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.href === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [{ ...publicJwk,
      kid: 'review-key', alg: 'RS256', use: 'sig' }] });
    if (url.href === `${issuer}/cdn-cgi/access/get-identity`) {
      if (options.revokedIdentity || request.headers.get('cookie') !== `CF_Authorization=${accessJwt}`)
        return new Response(null, { status: 401 });
      return Response.json({ id: user, email, groups: [] });
    }
    return github.fetcher(request);
  });
  const read = (path = '/repos/owner/repo/pulls/34', activity = 'review-activity') => client.fetch(new Request(
    `https://api.github.com${path}`, { headers: { 'x-codeflare-operator-boundary-result': activity,
      'cf-access-jwt-assertion': 'must-not-leak', 'x-codeflare-operator-boundary-input': 'must-not-stage' } }));
  return { read, github, accessJwt };
}

// Q14 maps to REQ-OPERATOR-065 AC1/2 (authentic read-only evidence), with
// OPERATOR-053/056's original published artifact/comment/check contracts retained.
describe('REQ-OPERATOR-053/056: read-only authenticated Review publication projection', () => {
  it('REQ-OPERATOR-065: returns a bounded published prior round from the actual intercepted GitHub PR read without staging or starting a Review', async () => {
    const { read, github, accessJwt } = await fixture();
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ schemaVersion: 1, status: 'published', repository: 'owner/repo',
      repositoryId: 138, pullRequest: 34, head: priorHead, activityId: 'review-activity',
      round: 2, artifactDigest: github.digest, omittedFindings: 0,
      findings: [{ ...finding, lane: 'code-reviewer' }] });
    expect(JSON.stringify(body)).not.toContain(accessJwt);
    expect(JSON.stringify(body)).not.toContain('human-token');
    // External header/privacy contract applies to every API and signed archive request.
    for (const request of github.requests) {
      expect(request.headers.has('x-codeflare-operator-boundary-result')).toBe(false);
      expect(request.headers.has('x-codeflare-operator-boundary-input')).toBe(false);
      expect(request.headers.has('cf-access-jwt-assertion')).toBe(false);
      expect(request.headers.has('cookie')).toBe(false);
      if (new URL(request.url).hostname === 'objects.actions.githubusercontent.com')
        expect(request.headers.has('authorization')).toBe(false);
    }
  });

  it('REQ-OPERATOR-065: permits Bob to inspect the PR-wide published report with his own authorized session, not Alice private Activity', async () => {
    const { read } = await fixture({ user: 'bob' });
    expect(await (await read()).json()).toMatchObject({ status: 'published',
      findings: [{ ...finding, lane: 'code-reviewer' }] });
  });

  it.each([
    ['foreign PR', '/repos/owner/repo/pulls/35', 'review-activity'],
    ['foreign repository', '/repos/other/repo/pulls/34', 'review-activity'],
    ['wrong activity', '/repos/owner/repo/pulls/34', 'foreign-activity'],
  ])('REQ-OPERATOR-065: returns no private finding for %s', async (_name, path, activity) => {
    const { read } = await fixture();
    expect(await (await read(path, activity)).json()).toEqual({ status: 'unavailable' });
  });

  it.each(reviewPublicationFaults)('REQ-OPERATOR-065: forged or unavailable %s publication cannot expose findings', async fault => {
    const { read } = await fixture({ fault });
    expect(await (await read()).json()).toEqual({ status: 'unavailable' });
  });
  it.each([
    { lifecycleChange: true }, { invalidJwt: true }, { revokedIdentity: true },
  ])('REQ-OPERATOR-065: denies expired session generation or invalid live human authority (%j)', async options => {
    const { read } = await fixture(options);
    expect(await (await read()).json()).toEqual({ status: 'unavailable' });
  });
});
