/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** T01: real Access/Action JWT verification, live identity, Registry and Activity authorization.
 * Only the already-authenticated platform role middleware and external transports are fixtures. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../../index';
import type { Env } from '../../types';
import { resetAuthConfigCache, requireOperatorHumanContext } from '../../lib/access';
import { resetJWKSCache } from '../../lib/jwt';
import { setLogLevel } from '../../lib/logger';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { D1SessionRepository } from '../../lib/session-repository';
import { storeGithubConnection } from '../../lib/github-token';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity } from '../../operators/activity';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { prepareOperatorActivity } from '../../operators/orchestrator';
import { claimVerifiedBoundaryAction, discoverVerifiedBoundaryAction } from '../../operators/review-boundary-claim';
import { createMockKV } from '../helpers/mock-kv';
// @ts-expect-error Workers test loader supports raw SQL fixtures.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Workers test loader supports raw SQL fixtures.
import boundaryMigration from '../../../migrations/usage/0004_boundary_activity.sql?raw';

const actor = vi.hoisted(() => ({ role: 'user' }));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: 'manager@example.test', role: actor.role, authenticated: true });
    return next();
  },
}));
const domain = 'live-identity.cloudflareaccess.com', issuer = `https://${domain}`;
const email = 'manager@example.test', subject = 'manager-subject', audience = 'operators-live-identity';
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeBase = 'c'.repeat(40), workflowSha = 'd'.repeat(40);
const workflowSource = 'name: Boundary Reviews\non: pull_request_target\njobs: {}\n';
const workflowDigest = '5d25cbe537cab5e78efad44b51b472c4e278ca6510342b3eb34914dc6ee4e95d';
const request = { repositoryId: 138, pullRequest: 34, head, base, mergeBase, runId: 87, runAttempt: 1 };
const session = { bucket: 'owner-bucket', sessionId: 'session01', generation: 1 };
const browserSummary = { activityId: 'owned-browser-activity', operatorId: 'review-operator',
  operatorName: 'Identity fixture', context: 'Read-only browser fixture', executionStatus: 'completed' as const,
  cleanupStatus: 'stopped' as const, collectionStatus: 'ready' as const, attention: false,
  sessionId: null, source: null, updatedAt: 1_790_000_000_000 };
const db = (env as unknown as { USAGE_DB: D1Database }).USAGE_DB;
let keys: CryptoKeyPair, jwk: JsonWebKey & { kid: string };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(payload: Record<string, unknown>) {
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'live-identity-key' })));
  const body = encode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.${encode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey,
    new TextEncoder().encode(`${header}.${body}`))))}`;
}
const validIdentity = () => ({ user_uuid: subject, email }); // Canonical Cloudflare subject; groups may be absent.
const faults = ['revoked', 'unavailable', 'transport-error', 'redirect', 'malformed-json', 'bodyless', 'oversized',
  'non-object', 'subject-mismatch', 'email-mismatch', 'uuid-mismatch', 'malformed-groups', 'name-only-group'] as const;
type Fault = typeof faults[number] | 'valid' | 'extra-id' | 'null-id' | 'number-id';
function identityResponse(fault: Fault): Response {
  if (fault === 'revoked') return new Response(null, { status: 401 });
  if (fault === 'unavailable') return new Response(null, { status: 503 });
  if (fault === 'transport-error') throw Error('Identity transport unavailable');
  if (fault === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/identity' } });
  if (fault === 'malformed-json') return new Response('{');
  if (fault === 'bodyless') return new Response(null);
  if (fault === 'oversized') return new Response('x'.repeat(65537));
  if (fault === 'non-object') return Response.json([]);
  const changes: Partial<Record<Fault, unknown>> = {
    'subject-mismatch': { id: 'another-subject', email },
    'email-mismatch': { id: subject, email: 'another@example.test' },
    'uuid-mismatch': { id: subject, user_uuid: 'another-subject', email },
    'malformed-groups': { ...validIdentity(), groups: null },
    'name-only-group': { ...validIdentity(), groups: [{ name: 'Operators' }] },
    'extra-id': { ...validIdentity(), id: 'unrelated-identity-metadata' },
    'null-id': { ...validIdentity(), id: null },
    'number-id': { ...validIdentity(), id: 42 },
  };
  return Response.json(changes[fault] ?? validIdentity());
}

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey), kid: 'live-identity-key', alg: 'RS256', use: 'sig' };
  for (const sql of `${migration};${boundaryMigration}`.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(sql).run();
});
beforeEach(async () => {
  actor.role = 'user'; resetAuthConfigCache(); resetJWKSCache();
  await db.prepare('DELETE FROM runtime_sessions').run();
  await db.prepare("UPDATE session_cutover SET state='complete' WHERE id=1").run();
  await db.prepare(`INSERT INTO runtime_sessions (owner_key,session_id,name,created_at,last_accessed_at,workspace,
    terminal_mode,lifecycle_state,lifecycle_generation,response_revision,observation_sequence,editor_ready,
    editor_ready_error,transitioned_at) VALUES ('owner-bucket','session01','Review','2027-01-01','2027-01-01',
    'terminal','classic','running',1,0,-1,0,0,'2027-01-01')`).run();
});
afterEach(() => { vi.restoreAllMocks(); resetAuthConfigCache(); resetJWKSCache(); setLogLevel('silent'); });

async function fixture(test: (f: {
  setFault: (fault: Fault) => void; setToken: (token: string) => void; token: string;
  request: (path: string, body?: unknown) => Promise<Response>; registry: OperatorRegistry;
  kv: ReturnType<typeof createMockKV>;
  claim: () => Promise<unknown>; discover: () => Promise<unknown>; activityId: string; startCapability: string;
  redirectTransport: (target: 'jwks' | 'github' | null) => void;
}) => Promise<void>, logLevel?: 'warn') {
  const kv = createMockKV();
  await kv.put(SETUP_KEYS.AUTH_DOMAIN, domain); await kv.put(SETUP_KEYS.ACCESS_AUD, audience);
  await kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'enterprise.example.test');
  // Fresh mutation reauthentication uses the real base authenticator/KV role.
  await kv.put(`user:${email}`, JSON.stringify({ role: actor.role }));
  const now = Math.floor(Date.now() / 1000);
  let accessJwt = await sign({ type: 'app', sub: subject, email, iss: issuer, aud: [audience],
    iat: now - 10, exp: now + 300, groups: ['stale-signed-group'] });
  const initialToken = accessJwt;
  let fault: Fault = 'valid';
  let redirected: 'jwks' | 'github' | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url), path = url.pathname;
    if (req.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (req.url === 'https://token.actions.githubusercontent.com/.well-known/jwks') {
      // Native transport contract: never follow a signing-key redirect.
      expect(req.redirect).toBe('manual');
      return redirected === 'jwks' ? Response.redirect('https://untrusted.example/jwks', 302)
        : Response.json({ keys: [jwk] });
    }
    if (req.url === `${issuer}/cdn-cgi/access/get-identity`) {
      if (req.headers.get('cookie') !== `CF_Authorization=${accessJwt}` || req.redirect !== 'manual') return new Response(null, { status: 401 });
      return identityResponse(fault);
    }
    if (url.origin !== 'https://api.github.com' || req.headers.get('authorization') !== 'Bearer parent-github-token'
      || req.headers.has('cookie') || req.headers.has('cf-access-jwt-assertion')) throw Error('Unexpected credential destination');
    // Native transport contract: parent GitHub credentials never follow redirects.
    expect(req.redirect).toBe('manual');
    if (redirected === 'github') return Response.redirect('https://untrusted.example/github', 302);
    if (path === '/repos/owner/repo') return Response.json({ id: 138, full_name: 'owner/repo' });
    if (path.endsWith('/pulls/34')) return Response.json({ number: 34, state: 'open',
      head: { sha: head, ref: 'feature', repo: { id: 138 } }, base: { sha: base, ref: 'main', repo: { id: 138 } } });
    if (path.endsWith('/pulls')) return Response.json([{ number: 34, state: 'open', head: { sha: head } }]);
    if (path.includes('/compare/')) return Response.json({ merge_base_commit: { sha: mergeBase } });
    if (path.endsWith('/actions/runs/87/attempts/1')) return Response.json({ id: 87, run_attempt: 1,
      workflow_id: 531, event: 'pull_request_target', path: '.github/workflows/boundary-reviews.yml',
      repository: { id: 138 }, pull_requests: [{ number: 34 }] });
    if (path.endsWith('/actions/workflows/531')) return Response.json({ id: 531, state: 'active', path: '.github/workflows/boundary-reviews.yml' });
    if (path.endsWith('/branches/main')) return Response.json({ name: 'main', protected: true, commit: { sha: workflowSha } });
    if (path.endsWith('/contents/.github/workflows/boundary-reviews.yml')) return Response.json({ encoding: 'base64', content: btoa(workflowSource) });
    throw Error(`Unexpected external fixture path: ${path}`);
  });
  const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  const registryName = `live-identity-${crypto.randomUUID()}`;
  const protectedEnv = { ...env, ...(logLevel ? { LOG_LEVEL: logLevel } : {}),
    KV: kv, ENTERPRISE_MODE: 'active' as const, ENCRYPTION_KEY: btoa('k'.repeat(32)) };
  // RPC-like forwarding into the real owner: no authorization method is replaced.
  const inRegistry = <T>(call: (owner: OperatorRegistry) => Promise<T>) => runInDurableObject(
    registryNamespace.getByName(registryName), (_instance, ctx) => call(new OperatorRegistry(ctx, protectedEnv)));
  const registry = new Proxy({} as OperatorRegistry, { get: (_target, method) => (...args: unknown[]) => inRegistry(owner =>
    (owner[method as keyof OperatorRegistry] as (...input: unknown[]) => Promise<unknown>).apply(owner, args)) });
  const humanContext = await requireOperatorHumanContext(new Request('https://enterprise.example.test/', {
    headers: { 'cf-access-jwt-assertion': accessJwt },
  }), protectedEnv as unknown as Env, email);
  expect(humanContext.human.groups).toEqual([]); // Live absence replaces stale signed groups.
  let activityId!: string;
  await runInDurableObject(registryNamespace.getByName(registryName), async (_instance, ctx) => {
    const owner = new OperatorRegistry(ctx, protectedEnv), policy = { capabilities: [], resourceProfileId: null };
    expect(await owner.setManagementControls({ revision: 0, managers: { users: [email], groups: [] },
      ceiling: { capabilities: ['fetch'], resourceProfileIds: [] }, boundaryActions: [{ repositoryId: 138,
        installationId: 'review-install', workflowId: 531, workflowPath: '.github/workflows/boundary-reviews.yml',
        protectedRef: 'refs/heads/main', workflowDigest, events: ['pull_request_target'] }] },
    { email, expiresAt: Date.now() + 300_000 })).toMatchObject({ ok: true });
    ctx.storage.sql.exec('INSERT INTO operator_catalog VALUES(?,?,?,?,?,?)', 'review-operator', 'conductor', 'internal', 1,
      'review-operator', JSON.stringify({ id: 'review-operator', revision: 1, sourceRevision: 1, profile: 'conductor',
        realm: 'internal', repositoryId: 138, repositoryUrl: 'https://github.com/owner/repo',
        managers: { users: [email], groups: [] }, invokers: { users: [email], groups: [] }, policy,
        approvedWorkflow: { id: 531, ref: 'refs/heads/main' } }));
    ctx.storage.sql.exec('INSERT INTO operator_acl VALUES(?,?)', `u:${email}`, 'review-operator');
    ctx.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', 'review-release', 'review-operator',
      JSON.stringify({ id: 'review-release', bundleDigest: 'e'.repeat(64), approved: true }),
      JSON.stringify({ name: 'Review fixture', description: 'Immutable identity authorization fixture' }));
    ctx.storage.sql.exec('INSERT INTO operator_installations VALUES(?,?,?,?,?)', 'review-install', 'review-operator',
      'review-install', 1, JSON.stringify({ id: 'review-install', operatorId: 'review-operator', name: 'review-install',
        releaseId: 'review-release', revision: 1, enabled: true, policy, configurationJson: '{}', approvedSourceRevision: 1 }));
    const reserved = await owner.reserveBoundaryPreparation({ repositoryId: 138, pullRequest: 34, contextDigest: 'f'.repeat(64),
      ownerKey: await operatorOwnerKey(humanContext.human), installationId: 'review-install', deadline: Date.now() + 300_000,
      controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'review-release', bundleDigest: 'e'.repeat(64),
      workflowId: 531, workflowDigest, session, operatorId: 'review-operator', revision: { head, base, mergeBase },
      protectedRef: 'refs/heads/main', roundGeneration: 1 });
    if (!reserved.ok) throw Error('Real Registry reservation failed');
    activityId = reserved.value.activityId;
  });
  await storeGithubConnection(protectedEnv as unknown as Env, session.bucket, { accessToken: 'parent-github-token', source: 'pat' });
  const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(activityNamespace.get(activityNamespace.newUniqueId()), async (_instance, ctx) => {
    const activityEnv = { ...protectedEnv, OPERATOR_REGISTRY: { getByName: () => registry } };
    const activity = new OperatorActivity(ctx, activityEnv as unknown as Env);
    const actionEnv = { ...activityEnv, OPERATOR_ACTIVITY: { getByName: () => activity }, USAGE_DB: db,
      CONTAINER: { getByName: () => ({ openReviewHuman: async () => ({ human: humanContext.human, accessJwt }) }) } } as unknown as Env;
    const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews', activityId,
      operatorId: 'review-operator', runId: activityId, source: { kind: 'session', reference: 'owner/repo' },
      revision: { reference: head, digest: 'f'.repeat(64) }, inputDigest: 'd'.repeat(64),
      input: { context: { repositoryId: 138, pullRequest: 34, head, base, mergeBase }, acknowledgedHead: null, evidence: {} },
      attachments: [], resources: { inference: null, session: null, storage: { scopeId: activityId } } };
    const prepared = await prepareOperatorActivity({ installationId: 'review-install', invocation }, humanContext, actionEnv,
      { activityId, expectedManagement: { controlsRevision: 1, installationRevision: 1, operatorRevision: 1,
        releaseId: 'review-release', bundleDigest: 'e'.repeat(64) }, boundary: { repositoryId: 138, pullRequest: 34,
        contextDigest: 'f'.repeat(64), session } });
    expect(await registry.markBoundaryPrepared(138, 34, activityId, 'f'.repeat(64), prepared.startCapability, prepared.startExpiresAt)).toBe(true);
    await registry.upsertOwnedActivity(await operatorOwnerKey(humanContext.human), browserSummary);
    await registry.upsertOwnedActivity(await operatorOwnerKey({ ...humanContext.human, subject: 'foreign-owner' }),
      { ...browserSummary, activityId: 'foreign-browser-activity' });
    const actionToken = (operation: string) => sign({ iss: 'https://token.actions.githubusercontent.com',
      aud: `https://enterprise.example.test/operator-webhook/v1/activities/claims/${operation}`,
      iat: now - 10, nbf: now - 10, exp: now + 300, repository: 'owner/repo', repository_id: '138',
      event_name: 'pull_request_target', workflow_ref: 'owner/repo/.github/workflows/boundary-reviews.yml@refs/heads/main',
      workflow_sha: workflowSha, run_id: '87', run_attempt: '1' });
    await test({ setFault: value => { fault = value; }, setToken: value => { accessJwt = value; }, token: initialToken, registry, kv,
      activityId, startCapability: prepared.startCapability,
      redirectTransport: target => { redirected = target; },
      claim: async () => claimVerifiedBoundaryAction(actionEnv, await actionToken('boundary'), request),
      discover: async () => discoverVerifiedBoundaryAction(actionEnv, await actionToken('discovery'), request),
      request: async (path, body) => {
        await kv.put(`user:${email}`, JSON.stringify({ role: actor.role }));
        const route = path.startsWith('/api/') ? path : `/api/operator-management${path}`;
        return worker.fetch(new Request(`https://enterprise.example.test${route}`, {
          method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-jwt-assertion': accessJwt,
            'cf-access-authenticated-user-email': email,
            'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), actionEnv, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
      },
    });
  });
}

describe('REQ-OPERATOR-045 AC3 / T01: invalid live identity never becomes empty-group authority', () => {
  it.each(['extra-id', 'null-id', 'number-id'] as const)(
    'REQ-OPERATOR-045/027: canonical UUID with %s admits catalog and only the verified owner activity page',
    async fault => fixture(async f => {
      f.setFault(fault);
      for (const role of ['user', 'admin']) {
        actor.role = role;
        const catalog = await f.request('/operators');
        expect(catalog.status).toBe(200);
        expect(await catalog.json()).toMatchObject({ items: [{ id: 'review-operator' }] });
        const activities = await f.request('/api/operator-activities?limit=5');
        expect(activities.status).toBe(200);
        expect(await activities.json()).toMatchObject({ items: [browserSummary], nextCursor: null });
      }
    }),
  );

  it.each(['subject-mismatch', 'uuid-mismatch', 'email-mismatch'] as const)(
    'REQ-OPERATOR-045/027: foreign %s denies both browser surfaces even for a platform admin',
    async fault => fixture(async f => {
      actor.role = 'admin'; f.setFault(fault);
      for (const path of ['/operators', '/api/operator-activities?limit=5']) {
        const response = await f.request(path);
        expect(response.status).toBe(403);
        expect(await response.json()).not.toHaveProperty('items');
      }
    }),
  );

  it('REQ-OPERATOR-045: denied live identity reports only closed diagnostic outcomes, never credentials or identity data',
    async () => fixture(async f => {
      const warnings: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((output: unknown) => { warnings.push(String(output)); });
      setLogLevel('warn');
      const outcomes: Array<[Fault, string, number?]> = [
        ['revoked', 'http', 401], ['unavailable', 'http', 503], ['redirect', 'http', 302],
        ['transport-error', 'transport'], ['malformed-json', 'response'],
        ['bodyless', 'response'], ['oversized', 'response'], ['non-object', 'response'],
        ['subject-mismatch', 'subject'], ['uuid-mismatch', 'subject'], ['email-mismatch', 'email'],
        ['malformed-groups', 'groups'], ['name-only-group', 'groups'],
      ];
      for (const [fault, reason, status] of outcomes) {
        warnings.length = 0; f.setFault(fault);
        expect((await f.request('/operators')).status).toBe(403);
        const diagnostics = warnings.map(value => JSON.parse(value) as { message: string; data: unknown })
          .filter(value => value.message === 'Operator human authentication denied');
        // Intentional diagnostic wire contract: only stage, closed reason and HTTP status are observable.
        expect(diagnostics.map(value => value.data)).toEqual([
          { stage: 'identity', reason, ...(status === undefined ? {} : { status }) },
        ]);
        const serialized = JSON.stringify(diagnostics);
        for (const privateValue of [f.token, email, subject, issuer, 'unrelated-identity-metadata']) {
          expect(serialized).not.toContain(privateValue);
        }
      }
    }, 'warn'),
  );

  it('REQ-OPERATOR-045: distinguishes missing credential/configuration, invalid JWT and mismatched verified principal without revealing them',
    async () => fixture(async f => {
      const warnings: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((output: unknown) => { warnings.push(String(output)); });
      setLogLevel('warn');
      let submittedToken = f.token;
      const submitToken = (token: string) => { submittedToken = token; f.setToken(token); };
      const deniedOutcome = async (stage: string, reason: string) => {
        warnings.length = 0;
        const response = await f.request('/operators');
        expect(response.status).toBe(403);
        const publicResponse: unknown = await response.json();
        // Intentional public denial wire contract: no internal reason or identity fields.
        expect(publicResponse).toEqual({ error: 'Access denied', code: 'FORBIDDEN' });
        const diagnostics = warnings.map(value => JSON.parse(value) as { message: string; data: unknown })
          .filter(value => value.message === 'Operator human authentication denied');
        expect(diagnostics.map(value => value.data)).toEqual([{ stage, reason }]);
        const serialized = JSON.stringify({ diagnostics, publicResponse });
        for (const privateValue of [submittedToken, f.token, email, 'foreign@example.test', subject, issuer, audience, domain].filter(Boolean)) {
          expect(serialized).not.toContain(privateValue);
        }
      };
      submitToken(''); await deniedOutcome('credential', 'missing');
      submitToken(f.token);
      await f.kv.delete(SETUP_KEYS.AUTH_DOMAIN); resetAuthConfigCache();
      await deniedOutcome('configuration', 'missing');
      await f.kv.put(SETUP_KEYS.AUTH_DOMAIN, domain); resetAuthConfigCache();
      const [header, payload, signature] = f.token.split('.');
      submitToken(`${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`);
      await deniedOutcome('jwt', 'invalid');
      const now = Math.floor(Date.now() / 1000);
      submitToken(await sign({ type: 'app', sub: subject, email: 'foreign@example.test', iss: issuer,
        aud: [audience], iat: now - 10, exp: now + 300 }));
      await deniedOutcome('principal', 'email');
    }, 'warn'),
  );
  it.each(faults)('denies email manager and platform admin management for %s without changing Registry state', async fault => fixture(async f => {
    for (const role of ['user', 'admin']) {
      actor.role = role;
      const visible = await f.request('/operators');
      expect(visible.status).toBe(200);
      expect(await visible.json()).toMatchObject({ items: [{ id: 'review-operator' }] });
      const before = await f.registry.getManagementOperator('review-operator');
      const controls = await f.registry.getManagementControls();
      f.setFault(fault);
      expect((await f.request('/operators')).status).toBe(403);
      expect((await f.request('/operators/review-operator/capabilities', { revision: 1, capabilities: ['fetch'] })).status).toBe(403);
      if (role === 'admin') expect((await f.request('/access', { revision: controls.revision, managers: { users: [], groups: [] },
        ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(403);
      expect(await f.registry.getManagementOperator('review-operator')).toEqual(before);
      expect(await f.registry.getManagementControls()).toEqual(controls);
      f.setFault('valid');
    }
  }));
  it.each(faults)('denies protected discovery and claim for an explicitly granted email invoker with %s, leaving the handoff usable', async fault => fixture(async f => {
    expect(await f.discover()).toEqual({ status: 'match', contextDigest: 'f'.repeat(64) });
    f.setFault(fault);
    expect(await f.discover()).toEqual({ status: 'unavailable' });
    expect(await f.claim()).not.toHaveProperty('startCapability');
    expect(await f.registry.getBoundaryPreparation(138, 34)).toMatchObject({ phase: 'prepared', activityId: f.activityId });
    expect(await new D1SessionRepository(db).getSession(session.bucket, session.sessionId)).toMatchObject({ boundaryActivityId: undefined });
    f.setFault('valid');
    expect(await f.claim()).toMatchObject({ activityId: f.activityId, startCapability: f.startCapability });
  }));
  it.each(['jwks', 'github'] as const)('rejects redirected %s transport without consuming the protected handoff', async target => fixture(async f => {
    expect(await f.discover()).toEqual({ status: 'match', contextDigest: 'f'.repeat(64) });
    f.redirectTransport(target);
    expect(await f.discover()).toEqual({ status: 'unavailable' });
    expect(await f.claim()).not.toHaveProperty('startCapability');
    expect(await f.registry.getBoundaryPreparation(138, 34)).toMatchObject({ phase: 'prepared', activityId: f.activityId });
    expect(await new D1SessionRepository(db).getSession(session.bucket, session.sessionId)).toMatchObject({ boundaryActivityId: undefined });
    f.redirectTransport(null);
    expect(await f.claim()).toMatchObject({ activityId: f.activityId, startCapability: f.startCapability });
  }));
  it('allows verified absent groups for email management and admin mutation and for protected discovery/claim', async () => fixture(async f => {
    expect((await f.request('/operators')).status).toBe(200);
    expect(await f.discover()).toEqual({ status: 'match', contextDigest: 'f'.repeat(64) });
    expect(await f.claim()).toMatchObject({ activityId: f.activityId, startCapability: f.startCapability });
    expect((await f.request('/operators/review-operator/capabilities', { revision: 1, capabilities: ['fetch'] })).status).toBe(200);
    actor.role = 'admin';
    const controls = await f.registry.getManagementControls();
    expect((await f.request('/access', { revision: controls.revision, managers: controls.managers,
      ceiling: controls.ceiling })).status).toBe(200);
  }));
  it('does not let a trusted admin role or valid identity response rescue a forged Access assertion', async () => fixture(async f => {
    actor.role = 'admin';
    const [header, payload, signature] = f.token.split('.');
    f.setToken(`${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`);
    expect((await f.request('/operators')).status).toBe(403);
    expect(await f.discover()).toEqual({ status: 'unavailable' });
    expect(await f.claim()).not.toHaveProperty('startCapability');
    expect(await f.registry.getBoundaryPreparation(138, 34)).toMatchObject({ phase: 'prepared' });
  }));
});
