/**
 * REQ-GITHUB-003: GitHubInterceptor — the security core of enterprise GitHub auth.
 *
 * A WorkerEntrypoint the container DO wires into container egress for the GitHub
 * hosts. It resolves the per-user token from the deploy-keys KV entry (keyed by the
 * BOUND per-session bucket, never by anything in the request), strips the container's
 * placeholder auth, and stamps the real credential at the github.com boundary:
 * Basic x-access-token:<token> for git over HTTPS, Bearer <token> for the REST API.
 *
 * These tests assert behaviour/contract, never copy strings:
 *  - API host  -> Authorization: Bearer <real token>, placeholder gone, API version set.
 *  - git host  -> Authorization: Basic base64("x-access-token:" + real token).
 *  - fail closed (401, NO upstream fetch) when not connected or no bound session.
 *  - unmapped host -> 400, no fetch.
 *  - NO cross-user spoofing: the injected token is the bound bucket's token,
 *    regardless of the placeholder value or any token/identity the request claims.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import { createMockKV } from './helpers/mock-kv';
import { GitHubInterceptor, interceptedGithubHosts } from '../github-interceptor';
import { storeGithubConnection } from '../lib/github-token';

const BUCKET = 'codeflare-enterprise-u-example-com';
const SESSION_USER = 'u@example.com';

let mockKV: ReturnType<typeof createMockKV>;

function makeEnv(over: Partial<Env> = {}): Env {
  // No ENCRYPTION_KEY -> kv-crypto plaintext round-trip (encryption-at-rest is
  // covered in github-token.test.ts; here we exercise injection + scoping).
  return { KV: mockKV, ...over } as unknown as Env;
}

function makeInterceptor(
  env: Env = makeEnv(),
  props: { user: string; bucket: string } | undefined = { user: SESSION_USER, bucket: BUCKET },
): GitHubInterceptor {
  const ctx = { props } as unknown as ExecutionContext;
  return new GitHubInterceptor(ctx, env);
}

/** A captured record of the last upstream fetch the interceptor made. */
let lastFetch: { url: string; method: string; headers: Headers } | null;

beforeEach(() => {
  mockKV = createMockKV();
  lastFetch = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const req = input as Request;
    lastFetch = { url: req.url, method: req.method, headers: req.headers };
    return new Response('upstream-ok', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Store a valid (non-expiring) connection for BUCKET. */
async function connect(token: string, env: Env = makeEnv()): Promise<void> {
  await storeGithubConnection(env, BUCKET, { accessToken: token, source: 'oauth', login: 'octo' });
}

describe('REQ-GITHUB-003: REST API credential injection', () => {
  it('stamps Authorization: Bearer <real token> on api.github.com and removes the placeholder', async () => {
    await connect('gho_real_secret');
    const res = await makeInterceptor().fetch(
      new Request('https://api.github.com/user/repos?per_page=50', {
        headers: { Authorization: 'Basic codeflare-enterprise', 'x-api-key': 'codeflare-enterprise' },
      }),
    );
    expect(res.status).toBe(200);
    expect(lastFetch?.url).toBe('https://api.github.com/user/repos?per_page=50');
    expect(lastFetch?.headers.get('authorization')).toBe('Bearer gho_real_secret');
    expect(lastFetch?.headers.get('x-api-key')).toBeNull();
  });

  it('pins X-GitHub-Api-Version on the API host when the client did not set one', async () => {
    await connect('gho_x');
    await makeInterceptor().fetch(new Request('https://api.github.com/user'));
    expect(lastFetch?.headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('honours a client-pinned X-GitHub-Api-Version (does not overwrite it)', async () => {
    await connect('gho_x');
    await makeInterceptor().fetch(
      new Request('https://api.github.com/user', { headers: { 'X-GitHub-Api-Version': '2099-01-01' } }),
    );
    expect(lastFetch?.headers.get('x-github-api-version')).toBe('2099-01-01');
  });

  it('preserves method, path, query and unrelated headers', async () => {
    await connect('gho_x');
    await makeInterceptor().fetch(
      new Request('https://api.github.com/repos/octo/repo/pulls?state=open', {
        method: 'POST',
        headers: { 'X-Custom': 'keepme' },
        body: '{"title":"x"}',
      }),
    );
    expect(lastFetch?.method).toBe('POST');
    expect(lastFetch?.url).toBe('https://api.github.com/repos/octo/repo/pulls?state=open');
    expect(lastFetch?.headers.get('x-custom')).toBe('keepme');
  });
});

describe('REQ-GITHUB-003: git Smart-HTTP credential injection', () => {
  it('stamps Authorization: Basic x-access-token:<token> on github.com (git), not Bearer', async () => {
    await connect('gho_real_secret');
    await makeInterceptor().fetch(
      new Request('https://github.com/octo/repo.git/info/refs?service=git-upload-pack', {
        headers: { Authorization: `Basic ${btoa('x-access-token:codeflare-enterprise')}` },
      }),
    );
    expect(lastFetch?.headers.get('authorization')).toBe(`Basic ${btoa('x-access-token:gho_real_secret')}`);
    // git host must NOT get a Bearer header (that is the API-host format).
    expect(lastFetch?.headers.get('authorization')?.startsWith('Bearer ')).toBe(false);
    // the API version header is not relevant to the git host.
    expect(lastFetch?.headers.get('x-github-api-version')).toBeNull();
  });
});

describe('REQ-GITHUB-003: fail closed', () => {
  it('returns 401 and makes NO upstream fetch when the user is not connected', async () => {
    const res = await makeInterceptor().fetch(new Request('https://api.github.com/user'));
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).code).toBe('GITHUB_NOT_CONNECTED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 401 and makes NO upstream fetch when no per-session bucket is bound', async () => {
    await connect('gho_x'); // a token exists, but with no bound session it must NOT be reachable
    // No props at all -> ctx.props is undefined -> no bound bucket.
    const interceptor = new GitHubInterceptor({} as unknown as ExecutionContext, makeEnv());
    const res = await interceptor.fetch(new Request('https://api.github.com/user'));
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).code).toBe('GITHUB_NO_SESSION');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 and makes NO upstream fetch for an unmapped host', async () => {
    await connect('gho_x');
    const res = await makeInterceptor().fetch(new Request('https://evil.example.com/user'));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('REQ-GITHUB-003: security property — no cross-user token spoofing', () => {
  it('injects the BOUND bucket token regardless of a real token the request tries to pass through', async () => {
    const env = makeEnv();
    // Two users, two stored tokens.
    await storeGithubConnection(env, BUCKET, { accessToken: 'TOKEN_A', source: 'oauth' });
    await storeGithubConnection(env, 'other-bucket', { accessToken: 'TOKEN_B', source: 'oauth' });

    // Interceptor is bound to user A's bucket. An attacker-controlled request tries
    // to smuggle user B's token through the placeholder slot.
    await makeInterceptor(env, { user: SESSION_USER, bucket: BUCKET }).fetch(
      new Request('https://api.github.com/user', { headers: { Authorization: 'Bearer TOKEN_B' } }),
    );

    // The injected credential is ALWAYS the bound bucket's token; the request's
    // token never survives.
    expect(lastFetch?.headers.get('authorization')).toBe('Bearer TOKEN_A');
    expect(lastFetch?.headers.get('authorization')).not.toContain('TOKEN_B');
  });
});

describe('REQ-GITHUB-003: response hygiene', () => {
  it('strips set-cookie from the upstream response and forwards the status', async () => {
    await connect('gho_x');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('created', { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc' } }),
    );
    const res = await makeInterceptor().fetch(new Request('https://api.github.com/user'));
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('does not transparently follow upstream redirects (redirect: manual)', async () => {
    await connect('gho_x');
    let capturedRedirect: string | undefined;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async (input: RequestInfo | URL) => {
      capturedRedirect = (input as Request).redirect;
      return new Response('ok', { status: 200 });
    });
    await makeInterceptor().fetch(new Request('https://api.github.com/user'));
    expect(capturedRedirect).toBe('manual');
  });
});

describe('REQ-GITHUB-003: host configuration', () => {
  it('defaults to github.com + api.github.com', () => {
    expect(interceptedGithubHosts(makeEnv())).toEqual(['github.com', 'api.github.com']);
  });

  it('honours GITHUB_HOST / GITHUB_API_HOST overrides and applies Bearer on the overridden API host', async () => {
    const env = makeEnv({ GITHUB_HOST: 'git.example.com', GITHUB_API_HOST: 'api.example.com' } as Partial<Env>);
    expect(interceptedGithubHosts(env)).toEqual(['git.example.com', 'api.example.com']);
    await connect('gho_x', env);
    // The overridden API host gets the Bearer credential...
    await makeInterceptor(env).fetch(new Request('https://api.example.com/user'));
    expect(lastFetch?.headers.get('authorization')).toBe('Bearer gho_x');
    // ...and the now-unmapped default github.com fails closed before any fetch.
    lastFetch = null;
    const res = await makeInterceptor(env).fetch(new Request('https://github.com/user'));
    expect(res.status).toBe(400);
    expect(lastFetch).toBeNull();
  });
});
