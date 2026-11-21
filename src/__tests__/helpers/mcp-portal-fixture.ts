import { vi } from 'vitest';
import { createMockKV } from './mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import type { Env } from '../../types';
import { beginMcpPortalConnect, finishMcpPortalConnect, type PortalGrant } from '../../lib/mcp-portal-token';
import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { encryptForKV, getOrImportKey } from '../../lib/kv-crypto';

// Replace only the external SDK/process boundary. The production subclass still
// initializes its own fields and executes every owner method against native storage.
vi.mock('@cloudflare/containers', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/containers')>(),
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
  },
  getContainer: vi.fn(() => { throw new Error('Container allocation is forbidden in the MCP owner fixture'); }),
}));

// The approved internal wire contract, not a second implementation of the state
// machine. Calls below always reach the real container class and native storage.
interface McpFence { epoch: string; revision: number }
interface McpSnapshot { fence: McpFence; ciphertext: string | null; legacyImportEligible: boolean }
interface McpOwnerRpc {
  claimBucketOwner(email: string, initial: boolean): Promise<'owned' | 'conflict' | 'ambiguous'>;
  mcpPortalRead(owner: string, portalName: string): Promise<McpSnapshot>;
  mcpPortalImport(owner: string, portalName: string, expected: McpFence, ciphertext: string): Promise<McpSnapshot | null>;
  mcpPortalSavePending(owner: string, input: { state: string; portalName: string; expected: McpFence; expiresAt: number; ciphertext: string }): Promise<boolean>;
  mcpPortalConsumePending(owner: string, state: string): Promise<{ portalName: string; fence: McpFence; ciphertext: string } | null>;
  mcpPortalPublish(owner: string, portalName: string, expected: McpFence, ciphertext: string): Promise<McpSnapshot | null>;
  mcpPortalDisconnect(owner: string, portalName: string): Promise<{ previous: McpSnapshot; current: McpSnapshot }>;
  mcpPortalBeginOffboarding(owner: string, email: string): Promise<{ operationId: string; epoch: string }>;
  mcpPortalCompleteOffboarding(owner: string, operationId: string): Promise<boolean>;
  cleanupOwnedUser(owner: string, email: string): Promise<{ deletedSessions: number; bucketDeleted: boolean; tokenDeleted: boolean }>;
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export async function attachMcpOwners(env: Env, transport?: {
  before?: (method: PropertyKey) => void | Promise<void>;
  after?: (method: PropertyKey, result: unknown) => Promise<void>;
}) {
  // Borrow the existing non-container DO solely for its native identity/storage
  // and execution context. Using CONTAINER would construct the unsupported SDK
  // process owner before runInDurableObject can enter this callback.
  const namespace = (workerEnv as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const salt = crypto.randomUUID();
  const idFromName = (name: string) => namespace.idFromName(`${salt}:${name}`);
  type Container = import('../../container/index').container;
  const instances = new Map<string, Promise<Container>>();
  const invoke = async <T>(id: DurableObjectId, work: (instance: Container, native: DurableObjectState) => Promise<T>): Promise<T> => {
    return runInDurableObject(namespace.get(id), async (_platformInstance, native) => {
      let ready = instances.get(id.toString());
      if (!ready) {
        ready = (async () => {
          const { container } = await import('../../container/index');
          const initialization: Promise<unknown>[] = [];
          const block = native.blockConcurrencyWhile.bind(native);
          Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: <R>(callback: () => Promise<R>) => {
            const pending = block(callback); initialization.push(pending); return pending;
          } });
          try {
            const instance = new container(native as never, env);
            await Promise.all(initialization);
            return instance;
          } finally {
            Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: block });
          }
        })();
        instances.set(id.toString(), ready);
      }
      return work(await ready, native);
    });
  };
  const stub = (id: DurableObjectId): McpOwnerRpc => new Proxy({} as McpOwnerRpc, {
    get: (_target, method) => (...args: unknown[]) => invoke(id, async instance => {
      const implementation = Reflect.get(instance, method);
      // Missing RPCs are setup failures, never evidence of behavioral RED.
      if (typeof implementation !== 'function') throw new Error(`Owner RPC not implemented: ${String(method)}`);
      await transport?.before?.(method);
      const result: unknown = await Reflect.apply(implementation, instance, args);
      await transport?.after?.(method, result);
      return result;
    }),
  });
  env.CONTAINER = { idFromName, get: stub, getByName: (name: string) => stub(idFromName(name)) } as unknown as Env['CONTAINER'];
  const owner = (bucket: string) => stub(idFromName(`bucket-owner:${bucket}`));
  return {
    owner,
    async claim(bucket: string, email: string) { return owner(bucket).claimBucketOwner(email, true); },
    reconstruct(bucket: string) { instances.delete(idFromName(`bucket-owner:${bucket}`).toString()); },
    storage<T>(bucket: string, work: (storage: DurableObjectStorage) => Promise<T>) {
      return invoke(idFromName(`bucket-owner:${bucket}`), (_instance, native) => work(native.storage));
    },
  };
}

export const legacyConnectionKey = (owner = 'owner', name = 'fixture') => `mcp-portal:owner:${encodeURIComponent(owner)}:portal:${name}`;
export async function legacyCiphertext(env: Env, grant: PortalGrant, owner = grant.owner): Promise<string> {
  return encryptForKV(JSON.stringify({ id: grant.id, grant: { ...grant, owner } }), (await getOrImportKey(env))!,
    legacyConnectionKey(owner, grant.portal.name));
}

export const portal = { name: 'fixture', url: 'https://portal.example/mcp?codemode=search_and_execute' };
export const instance = 'https://instance.example';
export const access = 'SYNTHETIC-MCP-ACCESS', refresh = 'SYNTHETIC-MCP-REFRESH';
export async function mcpPortalFixture(overrides: Partial<Env> = {}, existingKv?: ReturnType<typeof createMockKV>) {
  const kv = existingKv ?? createMockKV();
  // Opaque encrypted read views model KV propagation without decrypting grants.
  const connectionKey = 'mcp-portal:owner:owner:portal:fixture';
  let connectionView: string | null | undefined;
  let beforeConnectionWrite: (() => Promise<void>) | undefined;
  let afterConnectionWrite: (() => Promise<void>) | undefined;
  let publicationFailure: Error | undefined;
  const beforePublication = async () => {
    if (publicationFailure) throw publicationFailure;
    const action = beforeConnectionWrite; beforeConnectionWrite = undefined;
    await action?.();
  };
  const get = kv.get.getMockImplementation()!;
  const put = kv.put.getMockImplementation()!;
  kv.get.mockImplementation(async (key, type) => key === connectionKey && connectionView !== undefined
    ? connectionView : get(key, type));
  kv.put.mockImplementation(async (key, value, opts) => {
    if (key.startsWith('mcp-portal:owner:')) await beforePublication();
    await put(key, value, opts);
    if (key.startsWith('mcp-portal:owner:') && afterConnectionWrite) {
      const action = afterConnectionWrite; afterConnectionWrite = undefined; await action();
    }
  });
  await kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([portal]));
  await kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'instance.example');
  const env = { KV: kv, ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    R2_ACCOUNT_ID: 'fixture-account', R2_ENDPOINT: 'https://r2.example.test', ...overrides } as unknown as Env;
  const owners = await attachMcpOwners(env, {
    async before(method) { if (method === 'mcpPortalPublish') await beforePublication(); },
    async after(method, result) {
      if (method === 'mcpPortalPublish' && result && afterConnectionWrite) {
        const action = afterConnectionWrite; afterConnectionWrite = undefined; await action();
      }
    },
  });
  await owners.claim('owner', 'owner@example.com');
  await owners.claim('other', 'other@example.com');
  await owners.claim('other-owner', 'other-owner@example.com');
  let authorization: URL | undefined, expiresIn = 3600, rejectRefresh = false, omitRefreshedToken = false, token = access;
  let resource = 'https://portal.example/mcp', issuer = 'https://portal.example', cimd = false, dcr = true;
  let beforeToken: (() => Promise<void>) | undefined;
  let beforeDiscovery: (() => Promise<void>) | undefined;
  let beforeRefreshRejection: (() => Promise<void>) | undefined;
  let rotatingRefresh = false, currentRefresh = refresh, noRefreshToken = false;
  const issuedByCode = new Map<string, { resource: string; clientId: string }>();
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'https://portal.example') throw new Error('Synthetic fixture prohibits external I/O');
    if (url.pathname === '/mcp') return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://portal.example/.well-known/oauth-protected-resource"' } });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const concurrentAction = beforeDiscovery; beforeDiscovery = undefined;
      if (concurrentAction) await concurrentAction();
      return Response.json({ resource, authorization_servers: ['https://portal.example'], scopes_supported: ['mcp'] });
    }
    if (url.pathname.startsWith('/.well-known/')) return Response.json({ issuer,
      authorization_endpoint: 'https://portal.example/authorize', token_endpoint: 'https://portal.example/token',
      ...(cimd ? { client_id_metadata_document_supported: true } : {}),
      ...(dcr ? { registration_endpoint: 'https://portal.example/register' } : {}), revocation_endpoint: 'https://portal.example/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') return Response.json({ ...await request.json() as object, client_id: 'synthetic-client', token_endpoint_auth_method: 'none' }, { status: 201 });
    if (url.pathname === '/revoke') return new Response(null, { status: 200 });
    if (url.pathname === '/token') {
      if (beforeToken) await beforeToken();
      const body = new URLSearchParams(await request.text());
      // With DCR available, model an issuer unable to fetch this Access-protected
      // application's metadata URI; its dynamically registered client still works.
      if (body.get('client_id') !== (dcr ? 'synthetic-client' : `${instance}/auth/mcp/client-metadata`)) return Response.json({ error: 'invalid_client' }, { status: 400 });
      if (body.get('resource') !== resource) return Response.json({ error: 'invalid_target' }, { status: 400 });
      if (body.get('grant_type') === 'refresh_token') {
        if (rejectRefresh || body.get('refresh_token') !== currentRefresh) {
          if (beforeRefreshRejection) await beforeRefreshRejection();
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        if (rotatingRefresh) currentRefresh += '-ROTATED';
        token = `${access}-ROTATED`;
      } else {
        if (!authorization || body.get('code') !== 'synthetic-code' || body.get('redirect_uri') !== `${instance}/auth/mcp/callback`) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!));
        const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        if (challenge !== authorization.searchParams.get('code_challenge')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        issuedByCode.set(body.get('code')!, { resource, clientId: body.get('client_id')! });
      }
      return Response.json({ access_token: token,
        ...(noRefreshToken || (body.get('grant_type') === 'refresh_token' && omitRefreshedToken) ? {} : { refresh_token: currentRefresh }),
        token_type: 'Bearer', expires_in: expiresIn });
    }
    throw new Error('Unexpected synthetic OAuth path');
  };
  const begin = async (owner = 'owner') => {
    authorization = new URL(await beginMcpPortalConnect(env, owner, portal, instance, send)); return authorization;
  };
  const finish = async (owner = 'owner') => {
    if (!authorization) throw new Error('Begin first');
    return finishMcpPortalConnect(env, owner, instance, authorization.searchParams.get('state')!, 'synthetic-code', undefined, send);
  };
  return { env, kv, send, begin, finish, owners,
    async connectionSnapshot() {
      // Keep pre-repair diagnostics runnable against the current KV owner. After
      // GREEN this snapshots real owner ciphertext, never a synthetic grant.
      const saved = await owners.storage('owner', async () => {
        const { container } = await import('../../container/index');
        return typeof Reflect.get(container.prototype, 'mcpPortalRead') === 'function';
      });
      return saved ? (await owners.owner('owner').mcpPortalRead('owner', portal.name)).ciphertext! : await get(connectionKey) as string;
    },
    readConnection(value: string | null | undefined) { connectionView = value; },
    // Fault/scheduling seams at the external persistence transport; neither
    // substitutes the owner algorithm nor manufactures a publication result.
    failPublication(error: Error) { publicationFailure = error; },
    beforeConnectionWrite(value: () => Promise<void>) { beforeConnectionWrite = value; },
    afterConnectionWrite(value: () => Promise<void>) { afterConnectionWrite = value; },
    get authorization() { return authorization!; },
    visitAuthorization(value: string) {
      const url = new URL(value);
      if (url.origin !== issuer || url.pathname !== '/authorize') throw Error('Unexpected synthetic authorization');
      authorization = url;
    },
    cimd() { cimd = true; dcr = false; },
    bothRegistrations() { cimd = true; dcr = true; },
    omitRefreshOnRenewal() { omitRefreshedToken = true; },
    withoutRefreshToken() { noRefreshToken = true; },
    expiry(seconds: number) { expiresIn = seconds; }, rejectRefresh() { rejectRefresh = true; },
    resource(value: string) { resource = value; }, issuer(value: string) { issuer = value; },
    beforeToken(value: () => Promise<void>) { beforeToken = value; },
    beforeDiscovery(value: () => Promise<void>) { beforeDiscovery = value; },
    beforeRefreshRejection(value: () => Promise<void>) { beforeRefreshRejection = value; },
    rotateRefresh() { rotatingRefresh = true; },
    issuedForCode(code: string) { return issuedByCode.get(code); },
  };
}
