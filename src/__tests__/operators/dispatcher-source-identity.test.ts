import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { operatorAccessSessionCurrent, resolveOperatorGroupIdentity } from '../../lib/access';
import * as access from '../../lib/access';
import * as aig from '../../lib/aig-config';
import type { OperatorPolicy } from '../../operators/policy';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { authorizeDispatcherPlan, createDispatcherOperation, parseDispatcherOperation } from '../../operators/operator-runtime-capability';
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
  options: { sourceResponseBytes?: number; sourceBody?: string;
    inferencePolicies?: { operator?: OperatorPolicy['inference']; installation?: OperatorPolicy['inference'] } } = {}) {
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
  const policy = { capabilities: options.inferencePolicies ? ['fetch', 'inference'] : ['fetch'], resourceProfileId: null,
    ...(options.sourceResponseBytes === undefined ? {} : { sourceResponseBytes: options.sourceResponseBytes }) };
  const selection = { controlsRevision: 1,
    installation: { id: 'installation', revision: 1,
      policy: { ...policy, inference: options.inferencePolicies?.installation } },
    operator: { profile: 'dispatcher', revision: 1,
      policy: { ...policy, inference: options.inferencePolicies?.operator }, invokers: {
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
    invocationJson: JSON.stringify({ repository: 'owner/project' }), receipt: { selection: structuredClone(selection) } } as unknown as OperatorRuntimePlan;
  const operation = await parseDispatcherOperation(new Request('https://operator.internal/v1/dispatcher/source', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'source-read', method: 'GET', url: sourceUrl }),
  }));
  const inferenceRequests: Array<{ body: unknown; inference: unknown }> = [];
  const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
    expect(request.url).toBe(sourceUrl);
    expect(request.method).toBe('GET');
    return new Response(options.sourceBody ?? JSON.stringify({ full_name: 'owner/project' }),
      { headers: { 'content-type': 'application/json', etag: '"source-version"' } });
  } }), LlmInterceptor: ({ props }: { props: Record<string, unknown> }) => ({ fetch: async (request: Request) => {
    inferenceRequests.push({ body: await request.json(), inference: props.operatorInference });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }) } as unknown as Parameters<typeof createDispatcherOperation>[0]['exports'];
  const prepare = () => createDispatcherOperation({ plan, env: environment, operation, exports, current: async () => true });
  const prepareInference = async () => {
    vi.spyOn(access, 'resolveSessionAccessGroup').mockResolvedValue([]);
    vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ routeCatalog: ['approved', 'other-route'],
      defaultRoute: 'approved', defaultReasoning: 'off', routeContextWindows: {}, routeReasoningLevels: {}, modelDisplayNames: {} });
    vi.spyOn(aig, 'getAigConfig').mockResolvedValue({ gatewayUrl: 'https://gateway.example.test',
      gatewayId: undefined, token: 'synthetic-parent-only' });
    const inferenceOperation = await parseDispatcherOperation(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'managed-inference', input: { messages: [{ role: 'user', content: 'approved input' }] } }),
    }));
    return createDispatcherOperation({ plan, env: environment, operation: inferenceOperation, exports, current: async () => true });
  };
  return { human, prepare, prepareInference, inferenceRequests,
    restrictInference: (role: 'operator' | 'installation', inference: OperatorPolicy['inference']) => {
      selection[role].policy = { ...selection[role].policy, inference };
    },
    authorize: () => authorizeDispatcherPlan(plan, environment),
    execute: async () => (await prepare())(),
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

  it.each(['unrelated-id', null, 42])('REQ-OPERATOR-045: documented user_uuid authorizes an email invoker despite unrelated extra id %s', async id => {
    const f = await fixture(() => Response.json({ ...documentedIdentity, id }));
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(true);
    await expectSourceReceipt(await f.execute());
  });

  it('REQ-OPERATOR-045: preserves legacy id-only identity while a supplied foreign UUID still denies', async () => {
    const f = await fixture(() => Response.json({ id: subject, email }));
    await expectSourceReceipt(await f.execute());
    f.replaceIdentity(() => Response.json({ id: subject, user_uuid: 'another-human', email }));
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(false);
    await expect(f.execute()).rejects.toThrow();
  });

  it('denies a group-only invoker when current identity omits groups despite cached signed membership', async () => {
    const f = await fixture(() => Response.json(documentedIdentity), true);
    expect((await resolveOperatorGroupIdentity(f.human, accessJwt)).groups).toEqual([]);
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(true);
    await expect(f.execute()).rejects.toThrow();
  });

  it.each([
    { groups: [stableGroup.id] }, { groups: [{ name: stableGroup.id }] }, { groups: [{ email: stableGroup.id }] },
  ])('REQ-OPERATOR-045/047: label-only memberships %j preserve email invocation but cannot authorize a group-only source receipt', async ({ groups }) => {
    const identity = () => Response.json({ ...documentedIdentity, groups });
    const emailInvoker = await fixture(identity);
    await expectSourceReceipt(await emailInvoker.execute());
    const groupInvoker = await fixture(identity, true);
    expect(await operatorAccessSessionCurrent(groupInvoker.human, accessJwt)).toBe(true);
    await expect(groupInvoker.execute()).rejects.toThrow();
  });

  it('returns a source receipt for current stable group membership bound to the grant issuer even alongside labels', async () => {
    const f = await fixture(() => Response.json({ ...documentedIdentity,
      groups: ['Engineering', { name: 'Other' }, { id: stableGroup.id, name: 'Engineering' }, { id: stableGroup.id }] }), true);
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
    ['null groups', () => Response.json({ ...documentedIdentity, groups: null })],
    ['string groups', () => Response.json({ ...documentedIdentity, groups: stableGroup.id })],
    ['object groups', () => Response.json({ ...documentedIdentity, groups: { id: stableGroup.id } })],
    ['null group entry', () => Response.json({ ...documentedIdentity, groups: [null] })],
    ['empty string label', () => Response.json({ ...documentedIdentity, groups: [''] })],
    ['blank string label', () => Response.json({ ...documentedIdentity, groups: ['   '] })],
    ['oversized string label', () => Response.json({ ...documentedIdentity, groups: ['g'.repeat(257)] })],
    ['empty name label', () => Response.json({ ...documentedIdentity, groups: [{ name: '' }] })],
    ['non-string name label', () => Response.json({ ...documentedIdentity, groups: [{ name: 42 }] })],
    ['oversized name label', () => Response.json({ ...documentedIdentity, groups: [{ name: 'g'.repeat(257) }] })],
    ['empty email label', () => Response.json({ ...documentedIdentity, groups: [{ email: '' }] })],
    ['oversized email label', () => Response.json({ ...documentedIdentity, groups: [{ email: 'g'.repeat(257) }] })],
    ['group without identifier or label', () => Response.json({ ...documentedIdentity, groups: [{}] })],
    ['null group id with name', () => Response.json({ ...documentedIdentity, groups: [{ id: null, name: 'Engineering' }] })],
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
  ])('REQ-OPERATOR-047: failed live identity %s cannot become an email-granted Dispatcher authority or source receipt', async (_name, identity) => {
    const f = await fixture(identity);
    // Intentional authority contract: failure is not a verified session with zero memberships.
    await expect(resolveOperatorGroupIdentity(f.human, accessJwt)).rejects.toThrow();
    await expect(f.authorize()).rejects.toThrow();
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(false);
    await expect(f.execute()).rejects.toThrow();
  });

  it.each<[string, IdentityResponse]>([
    ['unavailable identity transport', () => { throw new Error('Identity transport unavailable'); }],
    ['unavailable identity service', () => new Response(null, { status: 503 })],
    ['revoked identity', () => new Response(null, { status: 401 })],
  ])('REQ-OPERATOR-047: %s denies the current Dispatcher authorization without poisoning later verified no-group work', async (_name, identity) => {
    const f = await fixture(identity);
    await expect(f.authorize()).rejects.toThrow();
    f.replaceIdentity(() => Response.json(documentedIdentity));
    const authorized = await f.authorize();
    expect(authorized.authority.human).toMatchObject({ subject, email, groups: [] });
    expect(authorized.parent).toEqual({ repository: 'owner/project' });
    await expectSourceReceipt(await f.execute());
  });

  it('denies source execution when the current identity is revoked after preparation', async () => {
    const f = await fixture(() => Response.json(documentedIdentity));
    const perform = await f.prepare();
    f.replaceIdentity(() => new Response('Unauthorized', { status: 401 }));
    await expect(perform()).rejects.toThrow();
  });

  it('REQ-OPERATOR-047: expired live identity cannot become empty-group authority or execute a prepared source', async () => {
    const f = await fixture(() => Response.json(documentedIdentity));
    const perform = await f.prepare();
    vi.spyOn(Date, 'now').mockReturnValue((f.human.expiresAt + 1) * 1000);
    await expect(resolveOperatorGroupIdentity(f.human, accessJwt)).rejects.toThrow();
    expect(await operatorAccessSessionCurrent(f.human, accessJwt)).toBe(false);
    await expect(perform()).rejects.toThrow();
  });
});


describe('REQ-OPERATOR-047: real Access source response allowance', () => {
  it('REQ-OPERATOR-047: rejects a 100 KiB source under an explicitly saved 64 KiB allowance', async () => {
    const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
      { sourceResponseBytes: 65536, sourceBody: 'x'.repeat(100 * 1024) });
    const response = await f.execute();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
  });

  it('REQ-OPERATOR-047: absent source allowance accepts an exact 1 MiB envelope and rejects one extra byte', async () => {
    const headers = { 'content-type': 'application/json', etag: '"source-version"' };
    const overhead = new TextEncoder().encode(JSON.stringify({ url: sourceUrl, status: 200, headers, body: '' })).byteLength;
    const body = 'x'.repeat(1048576 - overhead);
    const valid = await fixture(() => Response.json(documentedIdentity), false, issuer, { sourceBody: body });
    const response = await valid.execute();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: sourceUrl, status: 200, headers, body });
    const oversized = await fixture(() => Response.json(documentedIdentity), false, issuer, { sourceBody: body + 'x' });
    const denied = await oversized.execute();
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
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


describe('REQ-OPERATOR-007/047: managed Dispatcher installed inference intersection', () => {
  const approved: OperatorPolicy['inference'] = { allowedSources: ['managed'], routeIds: ['approved'],
    defaultRouteId: 'approved', reasoningLevels: ['off'], defaultReasoningLevel: 'off', inheritUserDefaults: false };
  const restrictions: Array<[string, OperatorPolicy['inference']]> = [
    ['source', { ...approved, allowedSources: ['pi-native'] }],
    ['route', { ...approved, routeIds: ['other-route'], defaultRouteId: 'other-route' }],
    ['reasoning', { ...approved, reasoningLevels: ['high'], defaultReasoningLevel: 'high' }],
  ];
  for (const role of ['operator', 'installation'] as const) {
    it.each(restrictions)(`${role} %s refuses preparation without a substituted upstream request`, async (_name, restriction) => {
      const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
        { inferencePolicies: { [role]: restriction } });
      await expect(f.prepareInference()).rejects.toThrow();
      expect(f.inferenceRequests).toEqual([]);
    });

    it.each(restrictions)(`${role} %s is rechecked at send after preparation`, async (_name, restriction) => {
      const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
        { inferencePolicies: { operator: approved, installation: approved } });
      const perform = await f.prepareInference();
      f.restrictInference(role, restriction);
      await expect(perform()).rejects.toThrow();
      expect(f.inferenceRequests).toEqual([]);
    });
  }

  it.each([false, true])('retains the exact human selection for allowed managed policies; legacy omission=%s', async legacy => {
    const f = await fixture(() => Response.json(documentedIdentity), false, issuer,
      { inferencePolicies: legacy ? {} : { operator: approved, installation: approved } });
    const response = await (await f.prepareInference())();
    expect(response.status).toBe(200);
    expect(f.inferenceRequests).toEqual([{ body: expect.objectContaining({ model: 'approved' }),
      inference: expect.objectContaining({ trusted: { routeId: 'approved', reasoningLevel: 'off' },
        policy: expect.objectContaining({ inference: expect.objectContaining({ routeIds: ['approved'], reasoningLevels: ['off'] }) }) }) }]);
  });
});
