import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { operatorAccessSessionCurrent, resolveOperatorGroupIdentity } from '../../lib/access';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { createDispatcherOperation, parseDispatcherOperation } from '../../operators/operator-runtime-capability';
import type { OperatorRuntimePlan } from '../../operators/activity';
import type { Env } from '../../types';

const issuer = 'https://source-identity.cloudflareaccess.com';
const email = 'invoker@example.test';
const subject = 'human-uuid';
const accessJwt = 'synthetic-parent-only-access-assertion';
const sourceUrl = 'https://api.github.com/repos/owner/project';
const documentedIdentity = { user_uuid: subject, email, idp: { id: 'identity-provider', type: 'oidc' } };
const stableGroup = { issuer, id: 'stable-engineering-id' };
type IdentityResponse = () => Response;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(identityResponse: IdentityResponse, groupGrant = false, grantIssuer = issuer,
  options: { sourceResponseBytes?: number; sourceBody?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const human: VerifiedHumanAccessClaims = { subject, email, issuer, audiences: ['operator-audience'],
    issuedAt: now - 1, expiresAt: now + 300, groups: [stableGroup.id] };
  let identity = identityResponse;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== `${issuer}/cdn-cgi/access/get-identity`) throw new Error('Unexpected public HTTP destination');
    // Credential destination and manual redirect handling are public transport contracts.
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('cookie')).toBe(`CF_Authorization=${accessJwt}`);
    return identity();
  });
  const policy = { capabilities: ['fetch'], resourceProfileId: null,
    ...(options.sourceResponseBytes === undefined ? {} : { sourceResponseBytes: options.sourceResponseBytes }) };
  const selection = { controlsRevision: 1,
    installation: { id: 'installation', revision: 1, policy },
    operator: { profile: 'dispatcher', revision: 1, invokers: {
      users: groupGrant ? [] : [email], groups: groupGrant ? [{ ...stableGroup, issuer: grantIssuer }] : [],
    } }, release: { bundleDigest: 'a'.repeat(64) } };
  const environment = {
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    OPERATOR_REGISTRY: { getByName: () => ({ resolveManagementExecution: async () => ({ ok: true, value: selection }) }) },
    CONTAINER: { idFromName: (name: string) => name,
      get: () => ({ claimBucketOwner: async () => 'owned' }) },
  } as unknown as Env;
  const activityId = 'source-identity-activity';
  const executionContext = await createOperatorExecutionContext({ activityId, operatorId: 'operator',
    artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), human, accessJwt }, environment);
  const plan = { activityId, deadline: (now + 600) * 1000, executionContext,
    invocationJson: JSON.stringify({ repository: 'owner/project' }), receipt: { selection } } as unknown as OperatorRuntimePlan;
  const operation = await parseDispatcherOperation(new Request('https://operator.internal/v1/dispatcher/source', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'source-read', method: 'GET', url: sourceUrl }),
  }));
  const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
    expect(request.url).toBe(sourceUrl);
    expect(request.method).toBe('GET');
    return new Response(options.sourceBody ?? JSON.stringify({ full_name: 'owner/project' }),
      { headers: { 'content-type': 'application/json', etag: '"source-version"' } });
  } }) } as unknown as Parameters<typeof createDispatcherOperation>[0]['exports'];
  const prepare = () => createDispatcherOperation({ plan, env: environment, operation, exports, current: async () => true });
  return { human, prepare, execute: async () => (await prepare())(),
    replaceIdentity: (value: IdentityResponse) => { identity = value; } };
}

async function expectSourceReceipt(response: Response) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: sourceUrl, status: 200,
    headers: { 'content-type': 'application/json', etag: '"source-version"' },
    body: JSON.stringify({ full_name: 'owner/project' }) });
}

describe('REQ-OPERATOR-045/047: current Access identity gates Dispatcher GET source receipts', () => {
  it('returns a source receipt for an email invoker when documented Cloudflare identity omits groups', async () => {
    const f = await fixture(() => Response.json(documentedIdentity));
    expect((await resolveOperatorGroupIdentity(f.human, accessJwt)).groups).toEqual([]);
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(true);
    await expectSourceReceipt(await f.execute());
  });

  it('denies a group-only invoker when current identity omits groups despite cached signed membership', async () => {
    const f = await fixture(() => Response.json(documentedIdentity), true);
    expect((await resolveOperatorGroupIdentity(f.human, accessJwt)).groups).toEqual([]);
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(true);
    await expect(f.execute()).rejects.toThrow();
  });

  it('returns a source receipt for current stable group membership bound to the grant issuer', async () => {
    const f = await fixture(() => Response.json({ ...documentedIdentity,
      groups: [{ id: stableGroup.id, name: 'Engineering' }, { id: stableGroup.id }] }), true);
    expect((await resolveOperatorGroupIdentity(f.human, accessJwt)).groups).toEqual([stableGroup.id]);
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(true);
    await expectSourceReceipt(await f.execute());
  });

  it('denies the same stable group ID when the grant is bound to another issuer', async () => {
    const f = await fixture(() => Response.json({ ...documentedIdentity, groups: [{ id: stableGroup.id }] }),
      true, 'https://other-team.cloudflareaccess.com');
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(true);
    await expect(f.execute()).rejects.toThrow();
  });

  it.each<[string, IdentityResponse]>([
    ['mismatched subject', () => Response.json({ ...documentedIdentity, user_uuid: 'another-human' })],
    ['mismatched email', () => Response.json({ ...documentedIdentity, email: 'other@example.test' })],
    ['conflicting additional id', () => Response.json({ ...documentedIdentity, id: 'another-human' })],
    ['null groups', () => Response.json({ ...documentedIdentity, groups: null })],
    ['string groups', () => Response.json({ ...documentedIdentity, groups: stableGroup.id })],
    ['object groups', () => Response.json({ ...documentedIdentity, groups: { id: stableGroup.id } })],
    ['bare string group entry', () => Response.json({ ...documentedIdentity, groups: [stableGroup.id] })],
    ['null group entry', () => Response.json({ ...documentedIdentity, groups: [null] })],
    ['display-name-only group entry', () => Response.json({ ...documentedIdentity, groups: [{ name: 'Engineering' }] })],
    ['empty group id', () => Response.json({ ...documentedIdentity, groups: [{ id: '' }] })],
    ['non-string group id', () => Response.json({ ...documentedIdentity, groups: [{ id: 42 }] })],
    ['whitespace-padded group id', () => Response.json({ ...documentedIdentity, groups: [{ id: ' padded ' }] })],
    ['oversized group id', () => Response.json({ ...documentedIdentity, groups: [{ id: 'g'.repeat(257) }] })],
    ['oversized groups array', () => Response.json({ ...documentedIdentity,
      groups: Array.from({ length: 1025 }, () => ({ id: stableGroup.id })) })],
    ['HTTP 401 identity', () => new Response('Unauthorized', { status: 401 })],
    ['redirected identity', () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/identity' } })],
    ['bodyless identity', () => new Response(null)],
    ['invalid JSON identity', () => new Response('{invalid')],
    ['oversized identity body', () => new Response('x'.repeat(65537))],
  ])('denies an email invoker and produces no source receipt for %s', async (_name, identity) => {
    const f = await fixture(identity);
    expect((await resolveOperatorGroupIdentity(f.human, accessJwt)).groups).toEqual([]);
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(false);
    await expect(f.execute()).rejects.toThrow();
  });

  it('denies source execution when the current identity is revoked after preparation', async () => {
    const f = await fixture(() => Response.json(documentedIdentity));
    const perform = await f.prepare();
    f.replaceIdentity(() => new Response('Unauthorized', { status: 401 }));
    await expect(perform()).rejects.toThrow();
  });

  it('denies source execution once protected human authority has expired', async () => {
    const f = await fixture(() => Response.json(documentedIdentity));
    const perform = await f.prepare();
    vi.spyOn(Date, 'now').mockReturnValue((f.human.expiresAt + 1) * 1000);
    expect((await resolveOperatorGroupIdentity(f.human, accessJwt)).groups).toEqual([]);
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(false);
    await expect(perform()).rejects.toThrow();
  });
});


describe('REQ-OPERATOR-047: real Access source response allowance', () => {
  it('REQ-OPERATOR-047: rejects a 100 KiB source under the default allowance', async () => {
    const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
      { sourceBody: 'x'.repeat(100 * 1024) });
    const response = await f.execute();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
  });

  it('REQ-OPERATOR-047: returns the exact large source envelope under approved 128 KiB', async () => {
    const body = 'x'.repeat(100 * 1024);
    const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
      { sourceResponseBytes: 131072, sourceBody: body });
    const response = await f.execute();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: sourceUrl, status: 200,
      headers: { 'content-type': 'application/json', etag: '"source-version"' }, body });
  });

  it('REQ-OPERATOR-047: bounds escaped UTF-8 envelope bytes even when raw source fits', async () => {
    // Raw UTF-8 fits 128 KiB, but newline escaping makes the envelope exceed it.
    const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
      { sourceResponseBytes: 131072, sourceBody: 'é\n'.repeat(33000) });
    const response = await f.execute();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
  });
});
