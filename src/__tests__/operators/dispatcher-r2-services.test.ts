/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { inspect } from 'node:util';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { DEFAULT_ROUTE_CONTEXT_WINDOW } from '../../lib/constants';
import type { Env } from '../../types';
// Register the fixture's existing Access boundary before any production importer.
import {
  type DispatcherFixture, diagnosticSummary, diagnosticTraversal, diagnosticsBrowser, digest, fixture, start,
} from './fixtures/dispatcher-production';
import * as fixtureAccess from '../../lib/access';
import * as fixtureAig from '../../lib/aig-config';
import { SETUP_KEYS } from '../../lib/kv-keys';
import type { PiReasoningLevel } from '../../lib/reasoning-profiles';
import { type ConfiguredDispatcherInference, discoverDispatcherOwnerProfile, dispatcherSdkOwnerContext } from '../../operators/dispatcher-owner-inference';
import { setLogLevel } from '../../lib/logger';
import { connectionSecret, normalCallback } from './fixtures/normal-dispatcher';
import { nativePiAuthFailure } from '../../operators/pi-auth-failure';
import { EgressController } from '../../egress-controller';

// Metadata-only Root: replace the external container lifecycle base, not Root's
// ownership/credential coordination. Native DO storage and RPC remain real; no
// container process or user-session Host is available in this lane.
vi.mock('@cloudflare/containers', async importOriginal => {
  const sdk = await importOriginal<typeof import('@cloudflare/containers')>();
  const { DurableObject } = await import('cloudflare:workers');
  return { ...sdk, Container: DurableObject };
});

// CI observed the original resolver executing while fixture replacements lived
// on a different namespace. Configure the original exports as well, acquiring
// them in the Runner context rather than performing loader I/O in DO callbacks.
const [access, r2, regime, aig] = await Promise.all([
  vi.importActual<typeof import('../../lib/access')>('../../lib/access'),
  vi.importActual<typeof import('../../lib/r2-client')>('../../lib/r2-client'),
  vi.importActual<typeof import('../../lib/r2-regime-state')>('../../lib/r2-regime-state'),
  vi.importActual<typeof import('../../lib/aig-config')>('../../lib/aig-config'),
]);

/**
 * Root #119 test-only contract: installed HTTP + fixed owner R2 reads, not Flue execution proof.
 * pi/config {operation:'read'} -> {source:'pi-native',settings:{defaultProvider,defaultModel},reasoningOverride?,selection?}
 *                             or {source:'managed'} with no native R2 reads.
 * pi/credentials {operation:'read',providerId} -> {apiKey: saved API key or OAuth access token}
 * Only the selected provider may be resolved; caller listing/login/writes are denied.
 * SDK refresh stays Root-private with serialized ETag CAS; no refresh metadata enters the DTO.
 * gateway/model-admission/model-fetch retain their protected HTTP contracts and Root-only account auth.
 * Root derives owner and fixed storage keys; Flue owns inference without a user-session Host.
 * Original authority, bounded reads (1 MiB), redirect denial and no-store remain mandatory.
 */
// Security assertions must inspect actual bytes, not their numeric JSON rendering.
function decodeRetainedBytes(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (Array.isArray(value)) return value.map(decodeRetainedBytes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeRetainedBytes(entry)]));
  return value;
}
const settingsKey = '.pi/agent/settings.json';
const authKey = '.pi/agent/auth.json';
const canary = 'PRIVATE_R2_SERVICES_CANARY_é🦊';
const managedSse = 'data: {"choices":[{"index":0,"delta":{"content":"managed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const providerId = 'openai';
const logical = { provider: providerId, model: 'gpt-4o-mini', api: 'openai-responses', reasoningLevel: 'low' };
const oldOAuth = { type: 'oauth', access: `${canary}_old_access`, refresh: `${canary}_old_refresh`, expires: Date.now() + 3_600_000, clientId: 'owner-issued-client', scopes: ['chatgpt.tokens.use.direct'] };
const other = { type: 'api_key', key: `${canary}_other_provider`, env: { PROJECT: 'unchanged' } };
const callback = (f: DispatcherFixture, path: string, body: unknown, headers?: Record<string, string>) =>
  f.installationCapability.fetch(normalCallback(f.activityId, path, body, headers));
const config = (f: DispatcherFixture) => callback(f, 'pi/config', { operation: 'read' });
const gateway = (f: DispatcherFixture) => callback(f, 'gateway', { operation: 'read' });
// Public SDK TranscriptContext wire: the non-serializable SDK brand is not an HTTP field.
const modelContext = { messages: [{ role: 'user', content: 'Owner SDK transport input.', timestamp: 1 }] };
const modelAdmission = (f: DispatcherFixture, operationId = 'sdk-model-operation') =>
  callback(f, 'model-admission', { operationId, context: modelContext, options: { maxTokens: 16 } });
const sdkBody = '{ "model": "gpt-4o-mini", "messages": [{"role":"user","content":"原始 😀"}], "stream": true }';
const encodeBody = (body: string) => btoa(String.fromCharCode(...new TextEncoder().encode(body)));
const modelFetch = (f: DispatcherFixture, permitId: string, request: Record<string, unknown>, operationId = 'sdk-model-operation',
  headers?: Record<string, string>) => callback(f, 'model-fetch', { operationId, permitId, request }, headers);
const credentials = (f: DispatcherFixture, body: Record<string, unknown>) => callback(f, 'pi/credentials', body);
const read = (f: DispatcherFixture) => credentials(f, { operation: 'read', providerId });
async function json(response: Response, status = 200): Promise<Record<string, any>> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}
async function denied(response: Response, statuses = [403, 404, 503]) {
  expect(statuses).toContain(response.status);
  expect(response.headers.get('x-codeflare-sdk-model-response')).toBeNull();
  expect(await response.text()).not.toContain(canary);
}

/** Protected R2 wire: fixed GETs and conditional auth PUT only. */
function storageBoundary() {
  const objects = new Map<string, { body: string; etag: string }>();
  const escapedReads: string[] = [];
  const touchedKeys = new Set<string>();
  let ordinal = 0;
  let afterRead: ((path: string) => void | Promise<void>) | undefined;
  let responseOverride: ((path: string) => Response | undefined) | undefined;
  let requireSse = false;
  let beforeWrite: (() => void | Promise<void>) | undefined;
  const put = (key: string, value: unknown, bucket = 'owner-bucket') => {
    objects.set(`/${bucket}/${key}`, { body: JSON.stringify(value), etag: `"revision-${++ordinal}"` });
  };
  put(settingsKey, { defaultProvider: providerId, defaultModel: logical.model, defaultThinkingLevel: 'low',
    privateSetting: `${canary}_settings`, env: { SECRET: `${canary}_env` },
    extensions: [`${canary}_extension`], resources: { files: [`${canary}_resource`] } });
  put(authKey, { [providerId]: oldOAuth, other });
  put(authKey, { victim: { type: 'api_key', key: `${canary}_CROSS_OWNER` } }, 'foreign-bucket');
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;
    if (url.origin !== 'https://r2.example.test' || ![settingsKey, authKey]
      .some(key => path === `/owner-bucket/${key}`) || url.search || !['GET', 'PUT'].includes(request.method)
      || request.method === 'PUT' && path !== `/owner-bucket/${authKey}`) {
      escapedReads.push(`${request.method} ${request.url}`);
      return new Response(`${canary}_CROSS_OWNER`, { status: 403 });
    }
    touchedKeys.add(path);
    if (requireSse && (request.headers.get('x-amz-server-side-encryption-customer-algorithm') !== 'AES256'
      || !request.headers.get('x-amz-server-side-encryption-customer-key')
      || !request.headers.get('x-amz-server-side-encryption-customer-key-md5'))) return new Response(null, { status: 403 });
    if (request.method === 'PUT') {
      const action = beforeWrite; beforeWrite = undefined; await action?.();
      const object = objects.get(path);
      if (!object || request.headers.get('if-match') !== object.etag) return new Response(null, { status: 412 });
      put(authKey, JSON.parse(await request.text()));
      return new Response(null, { headers: { etag: objects.get(path)!.etag } });
    }
    const object = objects.get(path);
    const response = responseOverride?.(path) ?? (object ? new Response(object.body,
      { headers: { etag: object.etag, 'content-type': 'application/json' } }) : new Response(null, { status: 404 }));
    const action = afterRead; afterRead = undefined; await action?.(path);
    return response;
  };
  return { fetcher, escapedReads, touchedKeys, put,
    value: (key: string) => JSON.parse(objects.get(`/owner-bucket/${key}`)!.body),
    etag: (key: string) => objects.get(`/owner-bucket/${key}`)!.etag,
    beforeWrite: (action: () => void | Promise<void>) => { beforeWrite = action; },
    afterRead: (action: (path: string) => void | Promise<void>) => { afterRead = action; },
    override: (action: (path: string) => Response | undefined) => { responseOverride = action; },
    requireSse: () => { requireSse = true; },
  };
}
// Exercise the public SDK's real auth resolver, replacing only external OAuth HTTP.
const tokenUrl = 'https://auth.openai.com/api/accounts/oauth/token';
function oauthBoundary(reply: (request: Request, ordinal: number) => Promise<Response> = async () => {
  throw new Error('Fresh OAuth must not exchange tokens');
}) {
  const requests: Request[] = [];
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== tokenUrl) return original(request);
    requests.push(request.clone());
    const response = reply(request, requests.length);
    // Observe the fixture-owned promise before forwarding across the DO I/O
    // boundary. Await the original rejection so the real SDK still handles it.
    void response.catch(() => undefined);
    return await response;
  });
  return requests;
}
const renewedAccess = `${canary}_renewed_access`;
const renewedRefresh = `${canary}_renewed_refresh`;
const tokenReply = () => Response.json({ access_token: renewedAccess, refresh_token: renewedRefresh,
  expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' });
type Store = ReturnType<typeof storageBoundary>;
const laneStores = new WeakMap<DispatcherFixture, Store>();
async function lane(run: (f: DispatcherFixture, store: Store, metadataEnvironment: Env) => Promise<void>, native = true,
  realInterceptors = false, limits: { operationLimit?: number; inferenceAttemptLimit?: number; managedProviderDefault?: boolean;
    nativeProviderDefault?: boolean; nativeNullProfile?: boolean; loggingEnabled?: boolean; nativeSelection?: typeof logical } = {}) {
  return fixture(async f => {
    const store = storageBoundary();
    laneStores.set(f, store);
    if (limits.nativeProviderDefault || limits.nativeNullProfile) {
      const { defaultThinkingLevel: _thinking, ...saved } = store.value(settingsKey);
      store.put(settingsKey, saved);
    }
    const cleanups: Array<() => void> = [];
    const spy = <T extends { mockRestore(): void }>(value: T) => { cleanups.push(() => value.mockRestore()); return value; };
    // Reuse the shared fixture's external identity/configuration behavior on the
    // original exports used by the application. Real invoker checks stay intact.
    spy(vi.spyOn(access, 'resolveOperatorGroupIdentity')).mockImplementation(fixtureAccess.resolveOperatorGroupIdentity);
    spy(vi.spyOn(access, 'operatorAccessSessionCurrent')).mockImplementation(fixtureAccess.operatorAccessSessionCurrent);
    spy(vi.spyOn(access, 'resolveBucketName')).mockImplementation(fixtureAccess.resolveBucketName);
    spy(vi.spyOn(access, 'resolveSessionAccessGroup')).mockImplementation(fixtureAccess.resolveSessionAccessGroup);
    spy(vi.spyOn(access, 'loadEnterpriseRouteConfig')).mockImplementation(fixtureAccess.loadEnterpriseRouteConfig);
    spy(vi.spyOn(access, 'requireOperatorHumanContext')).mockImplementation((...args) => fixtureAccess.requireOperatorHumanContext(...args));
    spy(vi.spyOn(aig, 'getAigConfig')).mockImplementation(fixtureAig.getAigConfig);
    // The existing bucket-owner DO is metadata, not a running user container.
    // Keep that real coordination boundary while denying every user-session Host.
    const metadataNamespace = (env as unknown as Env).CONTAINER;
    const metadataName = 'bucket-owner:owner-bucket';
    const metadataId = metadataNamespace.idFromName(metadataName);
    const parent = (await f.activity.getRuntimePlan())!;
    const metadata = metadataNamespace.get(metadataId) as unknown as {
      claimBucketOwner(email: string, allowInitialClaim: boolean): Promise<'owned' | 'conflict' | 'ambiguous'>;
    };
    // Match the ownership claim normally established by production resolveBucketName.
    if (await metadata.claimBucketOwner(parent.executionContext.owner.email, true) !== 'owned') {
      throw new Error('Owner metadata fixture claim failed');
    }
    const onlyMetadataName = (name: string) => {
      if (name !== metadataName) throw new Error('User-session Host access is unavailable');
      return metadataId;
    };
    f.environment.CONTAINER = {
      idFromName: onlyMetadataName,
      get: (id: DurableObjectId) => {
        if (id.toString() !== metadataId.toString()) throw new Error('User-session Host access is unavailable');
        return metadataNamespace.get(id);
      },
      getByName: (name: string) => metadataNamespace.get(onlyMetadataName(name)),
    } as Env['CONTAINER'];
    await f.mutateEvidence(async storage => {
      const admission = await storage.get<Record<string, unknown>>('admission');
      const { ownerSource: _retiredSource, ...retained } = admission!;
      await storage.put('admission', retained);
    });
    spy(vi.spyOn(r2, 'createR2Client')).mockImplementation(() => ({ fetch: store.fetcher }) as unknown as ReturnType<typeof r2.createR2Client>);
    spy(vi.spyOn(regime, 'getRegimeState')).mockResolvedValue({ status: 'ready', regime: 'plain', generation: 1 });
    spy(vi.spyOn(regime, 'isBucketMigrating')).mockResolvedValue(false);
    spy(vi.spyOn(regime, 'isR2SseDisabledForBucket')).mockResolvedValue(true);
    // External strict-Gateway transport reaches the selected HTTP ledger; the
    // real Root egress interceptor and its fail-closed checks remain in the path.
    f.environment.EGRESS = { fetch: (request: Request) => globalThis.fetch(request) } as Env['EGRESS'];
    const normalFetch = f.normalTransport!.fetcher;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== '/control/profile') return normalFetch(request);
      if (request.headers.get('authorization') !== `Bearer ${connectionSecret}`) return new Response(null, { status: 403 });
      // External normal-App HTTP boundary, not an SDK context or model resolver.
      const nativeConfig = native ? await json(await config(f)) : undefined;
      const selected = native ? { ...(limits.nativeSelection ?? logical),
        reasoningLevel: limits.nativeSelection?.reasoningLevel ?? nativeConfig!.reasoningOverride ?? null }
        : { provider: 'codeflare-gateway', model: 'approved',
        api: 'openai-completions', reasoningLevel: limits.managedProviderDefault ? null : 'off' };
      const identity = { source: native ? 'pi-native' : 'managed', ...selected };
      return Response.json({ selection: { ...identity, ...(!native ? { routeId: 'approved' } : {}),
        profileDigest: await digest(JSON.stringify(identity)) } });
    });
    // Public test API, real Root metadata instance: credential storage executes
    // with this environment, not the Activity fixture's separate configuration.
    let metadataEnvironment!: Env;
    await runInDurableObject(metadataNamespace.get(metadataId), instance => {
      metadataEnvironment = (instance as unknown as { env: Env }).env;
    });
    const environmentKeys = ['ENCRYPTION_KEY', 'R2_ACCOUNT_ID', 'R2_ENDPOINT'] as const;
    const originalEnvironment = environmentKeys.map(key => ({ key,
      present: Object.hasOwn(metadataEnvironment, key), value: metadataEnvironment[key] }));
    for (const key of environmentKeys) metadataEnvironment[key] = f.environment[key];
    try { await run(f, store, metadataEnvironment); }
    finally {
      for (const { key, present, value } of originalEnvironment) {
        if (present) metadataEnvironment[key] = value;
        else delete metadataEnvironment[key];
      }
      cleanups.reverse().forEach(cleanup => cleanup());
    }
  }, { normalHosting: true, repositoryOnly: true, recovery: true, nativeInference: native, realInterceptors,
    ...limits });
}
async function admitted(f: DispatcherFixture) {
  expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
  // HTTP-service assertions below observe post-admission I/O; profile bootstrap now
  // reads real configuration just as the installed App does. Never reset escaped reads.
  laneStores.get(f)?.touchedKeys.clear();
}

// REQ-007 AC1/2 and 047 AC1/2/3: installation selection, constrained by all four grants.
async function managedOwner(f: DispatcherFixture, options: {
  reasoning?: 'low' | null; deniedScope?: number; denial?: 'route' | 'reasoning';
  missingRoute?: boolean; eligibleRoutes?: string[]; supportedReasoning?: PiReasoningLevel[];
} = {}) {
  await admitted(f);
  const plan = (await f.activity.getRuntimePlan())!;
  if (!('selection' in plan.receipt)) throw new Error('Expected management receipt');
  const live = await f.environment.OPERATOR_REGISTRY!.getByName('registry')
    .resolveManagementExecution(plan.receipt.selection.installation.id);
  if (!live.ok) throw new Error('Expected current management grants');
  const pinned = plan.receipt.selection;
  const policies = [pinned.installation.policy, pinned.operator.policy,
    live.value.installation.policy, live.value.operator.policy];
  policies.forEach((policy, index) => {
    policy.inference = { allowedSources: ['managed'], routeIds: ['approved', 'policy-default'],
      defaultRouteId: 'policy-default', reasoningLevels: ['off', 'low', 'medium'],
      defaultReasoningLevel: 'off', inheritUserDefaults: false };
    if (index === options.deniedScope) {
      if (options.denial === 'route') policy.inference.routeIds = ['policy-default'];
      else policy.inference.reasoningLevels = ['off', 'medium'];
    }
  });
  pinned.installation.policy.inference!.defaultRouteId = options.missingRoute ? null : 'approved';
  pinned.installation.policy.inference!.defaultReasoningLevel = options.reasoning === null ? null : 'low';
  pinned.installation.policy.inference!.inheritUserDefaults = options.missingRoute === true;
  const routes = await fixtureAccess.loadEnterpriseRouteConfig(f.environment, []);
  const routeConfig = { ...routes, routeCatalog: options.eligibleRoutes ?? ['approved', 'policy-default'],
    defaultRoute: 'policy-default', defaultReasoning: 'medium',
    ...(options.supportedReasoning ? { routeReasoningLevels: { approved: options.supportedReasoning } } : {}),
    piDefaultSource: 'managed' as const, allowPersonalPiProviders: false };
  const routeBoundary = vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue(routeConfig);
  const grants = structuredClone({ pinned, live: live.value });
  return {
    select: (selection?: ConfiguredDispatcherInference) => dispatcherSdkOwnerContext({ plan, generation: 1, env: f.environment,
      current: () => f.activity.operatorGenerationCurrent(1) }, selection),
    changeAccountDefaults: (route: string, reasoning: string) => routeBoundary.mockResolvedValue({ ...routeConfig,
      defaultRoute: route, defaultReasoning: reasoning }),
    unchanged: () => expect({ pinned, live: live.value }).toEqual(grants),
  };
}

const managedSelection = (routeId = 'approved', reasoningLevel: 'low' | 'off' = 'low'): ConfiguredDispatcherInference => ({
  source: 'managed', provider: 'codeflare-gateway', model: routeId, routeId,
  api: 'openai-completions', reasoningLevel, profileDigest: 'a'.repeat(64),
});

describe('REQ-OPERATOR-007/047: Dispatcher installation Gateway selection', () => {
  it('selects installation approved/Low despite a different account route/Medium and operator Off defaults', () => lane(async f => {
    const owner = await managedOwner(f);
    expect(await owner.select()).toMatchObject({ source: 'managed', managed: { routeId: 'approved', reasoningLevel: 'low' } });
    owner.unchanged();
  }, false));

  it('account default changes do not alter the installation selected pair', () => lane(async f => {
    const owner = await managedOwner(f);
    const selection = managedSelection();
    expect(await owner.select(selection)).toMatchObject({ managed: { routeId: 'approved', reasoningLevel: 'low' } });
    owner.changeAccountDefaults('foreign-account-route', 'high');
    expect(await owner.select(selection)).toMatchObject({ managed: { routeId: 'approved', reasoningLevel: 'low' } });
    owner.unchanged();
  }, false));

  it.each([
    { scope: 'admitted installation', index: 0 }, { scope: 'admitted operator', index: 1 },
    { scope: 'current installation', index: 2 }, { scope: 'current operator', index: 3 },
  ])('refuses installation route denied by $scope without substitution or grant mutation', ({ index }) => lane(async f => {
    const owner = await managedOwner(f, { deniedScope: index, denial: 'route' });
    await expect(owner.select()).rejects.toMatchObject({ code: 'ROUTE_NOT_ELIGIBLE' });
    owner.unchanged();
  }, false));

  it.each([
    { scope: 'admitted installation', index: 0 }, { scope: 'admitted operator', index: 1 },
    { scope: 'current installation', index: 2 }, { scope: 'current operator', index: 3 },
  ])('refuses installation Low denied by $scope without substitution or grant mutation', ({ index }) => lane(async f => {
    const owner = await managedOwner(f, { deniedScope: index, denial: 'reasoning' });
    await expect(owner.select()).rejects.toMatchObject({ code: 'REASONING_NOT_ELIGIBLE' });
    owner.unchanged();
  }, false));

  it('refuses the installation route excluded by the eligible catalog without substituting its eligible default', () => lane(async f => {
    const owner = await managedOwner(f, { eligibleRoutes: ['policy-default'] });
    await expect(owner.select()).rejects.toMatchObject({ code: 'ROUTE_NOT_ELIGIBLE' });
    owner.unchanged();
  }, false));

  it('refuses explicit Low unsupported by the known route profile without substituting Off', () => lane(async f => {
    const owner = await managedOwner(f, { supportedReasoning: ['off', 'medium'] });
    await expect(owner.select()).rejects.toMatchObject({ code: 'REASONING_NOT_ELIGIBLE' });
    owner.unchanged();
  }, false));

  it('retains installation provider-default null rather than forcing policy Off or account Medium', () => lane(async f => {
    const owner = await managedOwner(f, { reasoning: null, supportedReasoning: ['off'] });
    expect(await owner.select()).toMatchObject({ source: 'managed', managed: { routeId: 'approved', reasoningLevel: null } });
    owner.unchanged();
  }, false));

  it('missing installation route refuses with ROUTE_SELECTION_REQUIRED even with user-default inheritance enabled', () => lane(async f => {
    const owner = await managedOwner(f, { missingRoute: true });
    // Intentional management error contract: explain the installation configuration required, not account fallback.
    await expect(owner.select()).rejects.toMatchObject({ code: 'ROUTE_SELECTION_REQUIRED',
      message: 'Configure a managed Gateway route for this installation' });
    owner.unchanged();
  }, false));

  it.each([
    { changed: 'route', selection: managedSelection('policy-default') },
    { changed: 'reasoning', selection: managedSelection('approved', 'off') },
  ])('refuses a changed already selected $changed without substitution or grant mutation', ({ selection }) => lane(async f => {
    const owner = await managedOwner(f);
    expect(await owner.select(managedSelection())).toMatchObject({ managed: { routeId: 'approved', reasoningLevel: 'low' } });
    await expect(owner.select(selection)).rejects.toThrow('Owner managed selection changed');
    owner.unchanged();
  }, false));
});

// Requirements: 007 AC4/5/6; 047 AC1/2/3/5; 048 AC2/5/6 + native/default constraints; 058 AC1.
describe('REQ-OPERATOR-007/047/048/058: owner R2 configured-service HTTP contracts', () => {
  it('pins the saved built-in logical profile with zero Host catalog and no source-session descriptor', () => lane(async (f, store) => {
    await admitted(f);
    const plan = (await f.activity.getRuntimePlan())!;
    // Native ON has no managed route defaults; the legacy installation field is inert.
    expect(plan.receipt).toMatchObject({ selection: { installation: { piReasoningOverride: 'low',
      policy: { inference: { routeIds: [], defaultRouteId: null } } } } });
    expect(await dispatcherSdkOwnerContext({ plan, generation: 1, env: f.environment,
      current: () => f.activity.operatorGenerationCurrent(1) })).toMatchObject({ source: 'pi-native' });
    expect(await discoverDispatcherOwnerProfile({ plan, generation: 1, env: f.environment,
      current: () => f.activity.operatorGenerationCurrent(1), waitUntil: f.waitUntil })).toEqual({ source: 'pi-native', ...logical,
      profileDigest: await digest(JSON.stringify({ source: 'pi-native', ...logical })) });
    expect((await f.activity.getRuntimePlan())!.configuredSelection).toMatchObject({ source: 'pi-native', ...logical });
    expect(JSON.stringify(f.normalTransport!.requests)).not.toMatch(/ownerhost123|sessionGeneration|private\.jwt/);
    expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
    expect(store.touchedKeys).toEqual(new Set([settingsKey, authKey].map(key => `/owner-bucket/${key}`)));
    expect(store.escapedReads).toEqual([]);
  }));

  it('admits normal native provider-default when approved without inventing an explicit reasoning level', () => lane(async f => {
    await admitted(f);
    const selected = (await f.activity.getRuntimePlan())!.configuredSelection;
    expect(selected).toMatchObject({ source: 'pi-native', provider: providerId, model: logical.model, reasoningLevel: null });
    expect((await f.activity.getBrowserDetail())?.inferenceSelection).toMatchObject({
      source: 'pi-native', provider: providerId, model: logical.model, reasoningLevel: null });
    expect((await modelAdmission(f)).status).toBe(200);
  }, true, false, { nativeProviderDefault: true }));

  it('provider-default owner R2 discovery ignores legacy installation Low without relabelling its receipt', () => lane(async f => {
    await admitted(f);
    expect((await f.activity.getRuntimePlan())?.receipt).toMatchObject({
      selection: { installation: { piReasoningOverride: 'low' } } });
    expect((await f.activity.getRuntimePlan())?.configuredSelection).toMatchObject({ reasoningLevel: null });
    expect((await f.activity.getBrowserDetail())?.inferenceSelection).toMatchObject({
      source: 'pi-native', reasoningLevel: null, reasoningSource: 'inherited' });
    expect((await modelAdmission(f)).status).toBe(200);
  }, true, false, { nativeNullProfile: true }));

  it('inherits exact-model R2 Off instead of global High or legacy installation Low without changing saved preferences', () => lane(async (f, store) => {
    store.put(settingsKey, { defaultProvider: providerId, defaultModel: logical.model, defaultThinkingLevel: 'high',
      modelThinkingLevels: { [`${providerId}/${logical.model}`]: 'off' } });
    // Explicitly approve Off at every original/current scope, without changing the legacy field.
    const plan = (await f.activity.getRuntimePlan())!;
    if (!('selection' in plan.receipt)) throw new Error('Expected installation receipt');
    const current = await f.environment.OPERATOR_REGISTRY!.getByName('registry')
      .resolveManagementExecution(plan.receipt.selection.installation.id);
    if (!current.ok) throw new Error('Expected current grants');
    for (const policy of [current.value.operator.policy, current.value.installation.policy]) {
      policy.inference!.reasoningLevels.push('off');
    }
    await f.mutateEvidence(async storage => {
      const state = (await storage.get<any>('admission'))!;
      for (const policy of [state.receipt.selection.operator.policy, state.receipt.selection.installation.policy]) {
        policy.inference.reasoningLevels.push('off');
      }
      await storage.put('admission', state);
    });
    const saved = store.value(settingsKey);
    await admitted(f);
    expect((await f.activity.getRuntimePlan())?.configuredSelection).toMatchObject({ reasoningLevel: 'off' });
    expect((await f.activity.getBrowserDetail())?.inferenceSelection).toMatchObject({ reasoningLevel: 'off', reasoningSource: 'inherited' });
    expect(await json(await config(f))).toMatchObject({ reasoningOverride: 'off' });
    expect(store.value(settingsKey)).toEqual(saved);
  }));

  it.each(['medium', 'high'])('REQ-OPERATOR-007: normal Native admits saved R2 %s independently of Gateway Low', level => lane(async (f, store) => {
    store.put(settingsKey, { defaultProvider: providerId, defaultModel: logical.model, defaultThinkingLevel: level });
    const saved = store.value(settingsKey);
    const original = (await f.activity.getRuntimePlan())!.receipt;
    if (!('selection' in original)) throw new Error('Expected management receipt');
    const policies = structuredClone([original.selection.operator.policy, original.selection.installation.policy]);
    expect(policies.map(policy => policy.inference?.reasoningLevels)).toEqual([['low'], ['low']]);
    await admitted(f);
    expect((await f.activity.getRuntimePlan())?.configuredSelection).toMatchObject({ source: 'pi-native', reasoningLevel: level });
    expect((await f.activity.getBrowserDetail())?.inferenceSelection).toMatchObject({ reasoningLevel: level, reasoningSource: 'inherited' });
    expect((await modelAdmission(f)).status).toBe(200);
    const retained = (await f.activity.getRuntimePlan())!.receipt;
    if (!('selection' in retained)) throw new Error('Expected management receipt');
    expect([retained.selection.operator.policy, retained.selection.installation.policy]).toEqual(policies);
    expect(store.value(settingsKey)).toEqual(saved);
  }));

  it.each((['original-operator', 'original-installation', 'current-operator', 'current-installation'] as const)
    .flatMap(scope => (['source', 'inference'] as const).map(check => ({ scope, check }))))(
    'REQ-OPERATOR-007/047: normal Native retains $scope $check authorization', ({ scope, check }) => lane(async f => {
      await admitted(f);
      const plan = (await f.activity.getRuntimePlan())!;
      if (!('selection' in plan.receipt)) throw new Error('Expected management receipt');
      const current = await f.environment.OPERATOR_REGISTRY!.getByName('registry')
        .resolveManagementExecution(plan.receipt.selection.installation.id);
      if (!current.ok) throw new Error('Expected current grants');
      if (scope.startsWith('current-')) {
        const policy = scope === 'current-operator' ? current.value.operator.policy : current.value.installation.policy;
        if (check === 'source') policy.inference!.allowedSources = ['managed'];
        else policy.capabilities = policy.capabilities.filter(value => value !== 'inference');
      } else await f.mutateEvidence(async storage => {
        const state = (await storage.get<any>('admission'))!;
        const policy = scope === 'original-operator' ? state.receipt.selection.operator.policy : state.receipt.selection.installation.policy;
        if (check === 'source') policy.inference.allowedSources = ['managed'];
        else policy.capabilities = policy.capabilities.filter((value: string) => value !== 'inference');
        await storage.put('admission', state);
      });
      await denied(await modelAdmission(f));
    }));

  it('later owner R2 reasoning changes do not replace the original admitted identity across reconstruction', () => lane(async (f, store) => {
    await admitted(f);
    const selected = (await f.activity.getRuntimePlan())!.configuredSelection;
    const original = (await f.activity.getBrowserDetail())!.inferenceSelection;
    store.put(settingsKey, { defaultProvider: providerId, defaultModel: logical.model, defaultThinkingLevel: 'high' });
    const cold = f.restart();
    expect((await cold.getRuntimePlan())!.configuredSelection).toEqual(selected);
    expect((await cold.getBrowserDetail())!.inferenceSelection).toEqual(original);
    expect((await modelAdmission(f)).status).toBe(200);
  }));

  it.each([false, true])('caller High cannot replace admitted native reasoning (provider-default: %s)', providerDefault => lane(async f => {
    await admitted(f);
    await denied(await callback(f, 'model-admission', { operationId: 'caller-reasoning', context: modelContext,
      options: { maxTokens: 16, reasoning: 'high' } }), [403]);
    expect((await modelAdmission(f)).status).toBe(200);
  }, true, false, { nativeProviderDefault: providerDefault }));

  it('returns only saved provider/model/reasoning and selected OAuth access token through fixed read-only DTOs', () => lane(async (f, store) => {
    await admitted(f);
    const selection = (await f.activity.getRuntimePlan())!.configuredSelection;
    expect(selection).toMatchObject({ source: 'pi-native', ...logical });
    // Exact DTO is the intentional wire contract: no settings/resources/auth metadata passthrough.
    expect(await json(await config(f))).toEqual({ source: 'pi-native',
      settings: { defaultProvider: providerId, defaultModel: logical.model }, reasoningOverride: 'low', selection });
    expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
    await denied(await callback(f, 'pi/config', { operation: 'read', key: authKey }), [400, 403]);
    expect(store.touchedKeys).toEqual(new Set([settingsKey, authKey].map(key => `/owner-bucket/${key}`)));
    expect(store.escapedReads).toEqual([]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
  }));

  it('normal fresh OAuth does not force renewal or mutate the owner credential', () => lane(async (f, store) => {
    await admitted(f);
    const exchanges = oauthBoundary();
    const version = store.etag(authKey);
    expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
    expect(exchanges).toEqual([]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    expect(store.etag(authKey)).toBe(version);
  }));

  // Charge elapsed time at external authority/R2 boundaries, not at private
  // helpers. Shared state is plain data; no timer or pending Promise is captured
  // from the Activity and awaited by the metadata DO. Date-based production
  // deadline checks remain active, without making CI wait thirty real seconds.
  function credentialBoundaryLatency(f: DispatcherFixture, store: Store) {
    const clock = { now: Date.now() };
    const startedAt = clock.now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const authorityReply = async () => {
      // Model aggregate boundary cost, not individual network timing: the
      // latest live request spent 30.9s across 203 registry resolutions.
      clock.now += 160;
      f.afterRegistryResolve(authorityReply);
    };
    f.afterRegistryResolve(authorityReply);
    const r2Fetch = store.fetcher;
    store.fetcher = async (input, init) => {
      clock.now += 25;
      return r2Fetch(input, init);
    };
    return { elapsed: () => clock.now - startedAt };
  }

  it.each(['fresh', 'expired'] as const)(
    '%s OAuth resolves within the existing 30s credential budget under authority and R2 latency', state => lane(async (f, store) => {
      await admitted(f);
      const saved = { [providerId]: { ...oldOAuth,
        expires: state === 'fresh' ? Date.now() + 3_600_000 : 1 }, other };
      store.put(authKey, saved);
      oauthBoundary(async () => tokenReply());
      const clock = credentialBoundaryLatency(f, store);

      expect(await json(await read(f))).toEqual({ apiKey: state === 'fresh' ? oldOAuth.access : renewedAccess });
      expect(clock.elapsed()).toBeLessThan(30_000);
      if (state === 'fresh') expect(store.value(authKey)).toEqual(saved);
      else expect(store.value(authKey)).toEqual({ [providerId]: {
        type: 'oauth', access: renewedAccess, refresh: renewedRefresh, clientId: oldOAuth.clientId,
        scopes: ['openid', 'chatgpt.tokens.use.direct'], expires: expect.any(Number),
      }, other });
    }));

  it('revocation during OAuth refresh under boundary latency releases no auth or persisted rotation', () => lane(async (f, store) => {
    await admitted(f);
    const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
    store.put(authKey, saved);
    let revoked = false;
    oauthBoundary(async () => {
      f.revokeGrant();
      revoked = true;
      return tokenReply();
    });
    const clock = credentialBoundaryLatency(f, store);

    await denied(await read(f), [403, 409, 503]);
    expect(revoked).toBe(true);
    expect(clock.elapsed()).toBeLessThan(30_000);
    expect(store.value(authKey)).toEqual(saved);
  }));

  it('concurrent whole-file CAS under boundary latency preserves the winning credential file and releases no auth', () => lane(async (f, store) => {
    await admitted(f);
    const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
    const winner = { ...saved, other: { type: 'api_key', key: `${canary}_concurrent_other` } };
    store.put(authKey, saved);
    store.beforeWrite(() => { store.put(authKey, winner); });
    oauthBoundary(async () => tokenReply());
    const clock = credentialBoundaryLatency(f, store);

    await denied(await read(f), [403, 409, 503]);
    expect(clock.elapsed()).toBeLessThan(30_000);
    expect(store.value(authKey)).toEqual(winner);
  }));

  it('revocation after R2 headers but before body completion releases no credentials', () => lane(async (f, store) => {
    await admitted(f);
    const saved = store.value(authKey);
    let bodyConsumed = false;
    store.override(path => path === `/owner-bucket/${authKey}` ? new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyConsumed = true;
        f.revokeGrant();
        controller.enqueue(new TextEncoder().encode(JSON.stringify(saved)));
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { etag: store.etag(authKey), 'content-type': 'application/json' } }) : undefined);
    oauthBoundary();

    await denied(await read(f), [403, 409, 503]);
    expect(bodyConsumed).toBe(true);
    expect(store.value(authKey)).toEqual(saved);
  }));

  it('a fresh concurrent login found under the SDK lock is returned without rewriting its R2 version', () => lane(async (f, store) => {
    await admitted(f);
    store.put(authKey, { [providerId]: { ...oldOAuth, expires: 1 }, other });
    const login = { ...oldOAuth, access: `${canary}_fresh_login`, refresh: `${canary}_fresh_login_refresh`,
      expires: Date.now() + 3_600_000 };
    let loginVersion: string | undefined;
    // Publish after the initial response snapshot, before the SDK's locked reread.
    const loginDuringRead = (path: string) => {
      if (path === `/owner-bucket/${authKey}`) {
        store.put(authKey, { [providerId]: login, other });
        loginVersion = store.etag(authKey);
      } else store.afterRead(loginDuringRead);
    };
    store.afterRead(loginDuringRead);
    oauthBoundary();
    expect(await json(await read(f))).toEqual({ apiKey: login.access });
    expect(loginVersion).toBeDefined();
    expect(store.etag(authKey)).toBe(loginVersion);
    expect(store.value(authKey)).toEqual({ [providerId]: login, other });
  }));

  it.each([false, true])('successive credential requests cross SDK freshness and persist the full renewed credential (SSE: %s)', sse => lane(async (f, store, metadataEnvironment) => {
    await admitted(f);
    f.advanceClock(0);
    if (sse) {
      metadataEnvironment.ENCRYPTION_KEY = btoa('a'.repeat(32));
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 1 });
      store.requireSse();
    }
    store.put(authKey, { [providerId]: { ...oldOAuth, expires: Date.now() + 301_000 }, other });
    const exchanges = oauthBoundary(async request => {
      // Intentional public OAuth wire contract; no manual token exchange implementation.
      expect(request.method).toBe('POST');
      expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({ grant_type: 'refresh_token',
        client_id: oldOAuth.clientId, refresh_token: oldOAuth.refresh, resource: 'https://api.openai.com/v1' });
      return tokenReply();
    });
    expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
    f.advanceClock(2000);
    expect(await json(await read(f))).toEqual({ apiKey: renewedAccess });
    expect(await json(await read(f))).toEqual({ apiKey: renewedAccess });
    expect(exchanges).toHaveLength(1);
    expect(store.value(authKey)).toEqual({ [providerId]: { type: 'oauth', access: renewedAccess,
      refresh: renewedRefresh, clientId: oldOAuth.clientId, scopes: ['openid', 'chatgpt.tokens.use.direct'],
      expires: expect.any(Number) }, other });
  }));

  it('Root-owned OAuth maintenance does not relax strict delegated model HTTP', () => lane(async (f, store) => {
    await admitted(f);
    f.environment.ENTERPRISE_MODE = 'active';
    delete f.environment.EGRESS;
    const originalGet = f.environment.KV.get.bind(f.environment.KV);
    vi.spyOn(f.environment.KV, 'get').mockImplementation((async (key: string, ...args: unknown[]) => {
      if (key === SETUP_KEYS.STRICT_EGRESS) return 'active';
      return (originalGet as (...args: unknown[]) => Promise<unknown>)(key, ...args);
    }) as typeof f.environment.KV.get);
    store.put(authKey, { [providerId]: { ...oldOAuth, expires: 1 }, other });
    const exchanges = oauthBoundary(async () => tokenReply());
    expect(await json(await read(f))).toEqual({ apiKey: renewedAccess });
    const permit = await json(await modelAdmission(f, 'strict-model-not-auth'));
    const modelRequests: Request[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      modelRequests.push(request); return new Response('must not send');
    });
    await denied(await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['authorization', `Bearer ${renewedAccess}`]], bodyBase64: encodeBody(sdkBody) }, 'strict-model-not-auth'), [403, 409, 503]);
    expect(exchanges).toHaveLength(1);
    expect(modelRequests).toEqual([]);
  }, true, true));

  it('concurrent renewal reads again under metadata serialization and shares one rotation', () => lane(async (f, store) => {
    await admitted(f);
    store.put(authKey, { [providerId]: { ...oldOAuth, expires: 1 }, other });
    // Share plain coordination state only. Each wait/timer belongs to the DO
    // executing it; an Activity-owned pending promise cannot gate metadata I/O.
    let started = false; let released = false;
    const exchanges = oauthBoundary(async () => {
      started = true;
      while (!released) await new Promise<void>(resolve => setTimeout(resolve, 1));
      return tokenReply();
    });
    const requests: Promise<Response>[] = [];
    try {
      requests.push(read(f)); await vi.waitFor(() => expect(started).toBe(true));
      requests.push(read(f)); released = true;
      for (const result of await Promise.all(requests)) expect(await json(result)).toEqual({ apiKey: renewedAccess });
      expect(exchanges).toHaveLength(1);
      expect(store.value(authKey).other).toEqual(other);
      expect(store.value(authKey)[providerId].refresh).toBe(renewedRefresh);
    } finally {
      released = true;
      await Promise.allSettled(requests);
    }
  }));

  it.each(['login', 'other provider'] as const)('concurrent %s wins CAS without refresh retry or superseded auth', change => lane(async (f, store) => {
    await admitted(f);
    store.put(authKey, { [providerId]: { ...oldOAuth, expires: 1 }, other });
    const login = { ...oldOAuth, access: `${canary}_new_login`, refresh: `${canary}_new_login_refresh` };
    const changed = change === 'login' ? { [providerId]: login, other }
      : { [providerId]: { ...oldOAuth, expires: 1 }, other: { type: 'api_key', key: `${canary}_new_other` } };
    store.beforeWrite(() => { store.put(authKey, changed); });
    const exchanges = oauthBoundary(async () => tokenReply());
    await denied(await read(f), [403, 409, 503]);
    expect(store.value(authKey)).toEqual(changed);
    expect(exchanges).toHaveLength(1);
    if (change === 'login') expect(await json(await read(f))).toEqual({ apiKey: login.access });
  }));

  it('rejected renewal with secret echoes has closed evidence and preserves saved auth', () => lane(async (f, store) => {
    const output: unknown[][] = [];
    const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation((...args: unknown[]) => { output.push(args); }));
    setLogLevel('info');
    try {
      await admitted(f);
      const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
      store.put(authKey, saved);
      const vendorMessage = `PRIVATE_VENDOR_RENEWAL_MESSAGE ${canary} ${oldOAuth.refresh}`;
      const vendorCause = `PRIVATE_VENDOR_NESTED_CAUSE ${oldOAuth.access}`;
      oauthBoundary(async () => Response.json({ error: 'invalid_grant', error_description: vendorMessage,
        cause: { message: vendorCause, cause: { token: other.key } } }, { status: 400 }));
      await denied(await read(f), [403]);
      expect(store.value(authKey)).toEqual(saved);
      await f.drainBackground();
      f.restart();
      const actionable = await diagnosticSummary(f);
      expect(actionable).toMatchObject({ diagnosis: { code: 'provider-failed', sdkService: {
        sdkCode: 'oauth', sdkStage: 'refresh', httpStatus: 400, oauthError: 'invalid_grant',
        exceptionCategory: 'error', requestAborted: false, wrapperStatus: 403 } } });
      const retained = await diagnosticTraversal(diagnosticsBrowser(f));
      const failed = retained.records.find(record => record.kind === 'event' && record.error
        && (record.error as { sdkService?: unknown }).sdkService);
      expect(failed).toMatchObject({ boundary: 'model', outcome: 'failed', error: {
        sdkService: { httpStatus: 400, wrapperStatus: 403, oauthError: 'invalid_grant' } } });
      const exported = await diagnosticTraversal(diagnosticsBrowser(f), '/diagnostics/v2/export');
      expect(exported.records).toContainEqual(expect.objectContaining({ id: failed!.id,
        error: expect.objectContaining({ sdkService: expect.objectContaining({ oauthError: 'invalid_grant' }) }) }));
      for (const evidence of [actionable, retained, exported, await f.activity.getBrowserDetail()]) {
        expect(inspect(evidence, { depth: null, maxStringLength: null })).not.toContain(canary);
      }
      const logged = inspect(output, { depth: null, maxStringLength: null, maxArrayLength: null,
        customInspect: false, getters: false, colors: false });
      // Intentional private error contract: the real metadata RPC failure is
      // reconstructed by the service and logged with only finite SDK classification.
      const failures = output.flatMap(args => args.flatMap(arg => {
        if (typeof arg !== 'string') return [];
        try {
          const record = JSON.parse(arg);
          return record.module === 'operator-execution' && record.message === 'sdk-service-failure'
            ? [record.data.value] : [];
        } catch { return []; }
      }));
      const failure = failures.find(value => value.message === 'SDK authentication unavailable (oauth)');
      expect(failure).toMatchObject({ status: 403, message: 'SDK authentication unavailable (oauth)' });
      // Exact closed cause excludes raw SDK messages and recursively retained causes.
      expect(failure?.cause).toEqual({ sdkCode: 'oauth', sdkStage: 'refresh', exceptionCategory: 'error',
        httpStatus: 400, oauthError: 'invalid_grant', requestAborted: false, abortReason: null });
      expect(logged).toContain('SDK authentication unavailable (oauth)');
      expect(logged).toContain('invalid_grant');
      expect(logged).not.toContain('PRIVATE_VENDOR_RENEWAL_MESSAGE');
      expect(logged).not.toContain('PRIVATE_VENDOR_NESTED_CAUSE');
      expect(logged).not.toContain(vendorMessage);
      expect(logged).not.toContain(vendorCause);
      for (const secret of [canary, oldOAuth.access, oldOAuth.refresh, other.key]) expect(logged).not.toContain(secret);
    } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  }));

  // REQ-007 private OAuth failure wire + REQ-090 existing admitted capture:
  // public SDK refresh and real protected RPC, replacing only external HTTP.
  it.each([
    { label: 'HTTP403 vendor body', kind: 'http', httpStatus: 403, exceptionCategory: 'error' },
    { label: 'HTTP400 unknown OAuth error', kind: 'unknown-code', httpStatus: 400, exceptionCategory: 'error' },
    { label: 'HTTP400 malformed JSON', kind: 'malformed', httpStatus: 400, exceptionCategory: 'error' },
    { label: 'oversized JSON preserves HTTP status without parsing its body', kind: 'oversized', httpStatus: 400, exceptionCategory: 'error' },
    { label: 'oversized HTML preserves HTTP status without retaining its body', kind: 'oversized-html', httpStatus: 403, exceptionCategory: 'error' },
    { label: 'unknown thrown cause', kind: 'unknown', httpStatus: null, exceptionCategory: 'unknown' },
    { label: 'dangerous cause getters', kind: 'getter', httpStatus: null, exceptionCategory: 'unknown' },
    { label: 'uninspectable proxy cause', kind: 'proxy', httpStatus: null, exceptionCategory: 'error' },
    { label: 'SDK independent TimeoutError', kind: 'timeout', httpStatus: null, exceptionCategory: 'timeout' },
    { label: 'SDK independent AbortError', kind: 'abort', httpStatus: null, exceptionCategory: 'abort' },
  ])('closed private OAuth evidence: $label', test => lane(async (f, store) => {
    const output: unknown[][] = [];
    const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation((...args: unknown[]) => { output.push(args); }));
    setLogLevel('info');
    try {
      await admitted(f);
      const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
      store.put(authKey, saved);
      const version = store.etag(authKey);
      oauthBoundary(async () => {
        if (test.kind === 'http') return Response.json({ error: { code: 'vendor_account_blocked',
          message: `${canary}_VENDOR_BODY`, token: oldOAuth.refresh } }, { status: 403,
          headers: { 'x-private-vendor': `${canary}_HEADER` } });
        if (test.kind === 'unknown-code') return Response.json({ error: `${canary}_vendor_code` }, { status: 400 });
        if (test.kind === 'malformed') return new Response(`{${canary}`, { status: 400 });
        if (test.kind === 'oversized') return Response.json({ error: 'invalid_grant',
          error_description: `${'x'.repeat(8192)}${canary}` }, { status: 400 });
        if (test.kind === 'oversized-html') return new Response(`<!doctype html>${'x'.repeat(8192)}${canary}`,
          { status: 403, headers: { 'content-type': 'text/html' } });
        if (test.kind === 'timeout' || test.kind === 'abort') throw new DOMException(`${canary}_RAW_MESSAGE`,
          test.kind === 'timeout' ? 'TimeoutError' : 'AbortError');
        if (test.kind === 'getter') {
          const dangerous = Object.create(null);
          for (const key of ['message', 'cause', 'code', 'toJSON', 'name']) Object.defineProperty(dangerous, key,
            { get() { throw new Error(`${canary}_GETTER`); } });
          dangerous.toString = () => `${canary}_RAW_CAUSE`;
          throw dangerous;
        }
        if (test.kind === 'proxy') throw new Proxy(new Error(`${canary}_RAW_STACK`), {
          getOwnPropertyDescriptor() { throw new Error(`${canary}_PROXY`); },
        });
        throw `${canary}_UNKNOWN_CAUSE`;
      });
      const response = await read(f);
      expect(response.status).toBe(403);
      const responseText = await response.text();
      const failures = output.flatMap(args => args.flatMap(arg => {
        if (typeof arg !== 'string') return [];
        try {
          const record = JSON.parse(arg);
          return record.module === 'operator-execution' && record.message === 'sdk-service-failure'
            ? [record.data.value] : [];
        } catch { return []; }
      }));
      const failure = failures.find(value => value.message === 'SDK authentication unavailable (oauth)');
      // Intentional private closed wire: every field is a bounded scalar, not raw evidence.
      expect(failure).toMatchObject({ status: 403 });
      expect(failure?.cause).toEqual({ sdkCode: 'oauth', sdkStage: 'refresh',
        exceptionCategory: test.exceptionCategory, httpStatus: test.httpStatus, oauthError: null,
        requestAborted: false, abortReason: null });
      expect(store.value(authKey)).toEqual(saved);
      expect(store.etag(authKey)).toBe(version);
      expect(store.escapedReads).toEqual([]);
      for (const evidence of [responseText, output, await f.activity.getBrowserDetail(),
        await diagnosticTraversal(diagnosticsBrowser(f))]) {
        const retained = inspect(decodeRetainedBytes(evidence), { depth: null, maxStringLength: null,
          maxArrayLength: null, customInspect: false, getters: false });
        for (const secret of [canary, oldOAuth.access, oldOAuth.refresh, other.key, 'vendor_account_blocked']) {
          expect(retained).not.toContain(secret);
        }
      }
    } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  }));

  it('OAuth failure with admitted logging OFF remains a private 403 without raw emission', () => lane(async (f, store) => {
    const output: unknown[][] = [];
    const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation((...args: unknown[]) => { output.push(args); }));
    setLogLevel('info');
    try {
      await admitted(f);
      const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
      store.put(authKey, saved);
      oauthBoundary(async () => Response.json({ error: 'invalid_grant', error_description: canary }, { status: 400 }));
      await denied(await read(f), [403]);
      expect(store.value(authKey)).toEqual(saved);
      const logged = inspect(output, { depth: null, maxStringLength: null, customInspect: false, getters: false });
      expect(logged).not.toContain('sdk-service-failure');
      await f.drainBackground();
      expect(await diagnosticSummary(f)).not.toHaveProperty('diagnosis.sdkService');
      const retained = await diagnosticTraversal(diagnosticsBrowser(f));
      expect(inspect(retained, { depth: null })).not.toContain('invalid_grant');
      expect(logged).not.toContain(canary);
    } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  }, true, false, { loggingEnabled: false }));

  it('credential PUT transport errors cannot retain secret-bearing request bodies', () => lane(async (f, store) => {
    const output: unknown[][] = [];
    const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation((...args: unknown[]) => { output.push(args); }));
    setLogLevel('info');
    try {
      await admitted(f);
      const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
      store.put(authKey, saved);
      oauthBoundary(async () => tokenReply());
      store.beforeWrite(() => { throw new Error(`Transport echoed ${renewedRefresh} ${other.key}`); });
      await denied(await read(f));
      expect(store.value(authKey)).toEqual(saved);
      const logged = inspect(output, { depth: null, maxStringLength: null, maxArrayLength: null,
        customInspect: false, getters: false, colors: false });
      expect(logged).toContain('SDK credential persistence unavailable');
      // Storage causal failure keeps priority over the SDK's wrapping auth error.
      expect(logged).not.toContain('SDK authentication unavailable');
      expect(logged).not.toContain('sdkStage');
      expect(logged).not.toContain(canary);
      for (const evidence of [await f.activity.getBrowserDetail(), await diagnosticTraversal(diagnosticsBrowser(f))]) {
        expect(inspect(evidence, { depth: null, maxStringLength: null })).not.toContain(canary);
      }
    } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  }));

  it('caller cancellation cannot authorize persistence when a started SDK exchange finishes late', () => lane(async (f, store) => {
    await admitted(f);
    const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
    store.put(authKey, saved);
    let started = false; let released = false; let finished = false;
    oauthBoundary(async () => {
      started = true;
      while (!released) await new Promise<void>(resolve => setTimeout(resolve, 1));
      finished = true;
      return tokenReply();
    });
    const abort = new AbortController();
    const request = new Request(normalCallback(f.activityId, 'pi/credentials', { operation: 'read', providerId }), { signal: abort.signal });
    const pending = f.installationCapability.fetch(request);
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      abort.abort(); released = true;
      await denied(await pending, [403, 409, 503]);
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(store.value(authKey)).toEqual(saved);
    } finally {
      released = true;
      await Promise.allSettled([pending]);
    }
  }));

  it.each([
    { provider: 'kimi-coding', model: 'kimi-for-coding', api: 'openai-completions', reasoningLevel: 'low' },
    { provider: 'github-copilot', model: 'gpt-4o', api: 'openai-completions', reasoningLevel: 'low' },
  ])('REQ-OPERATOR-007/047: preserves SDK $provider OAuth request metadata without flattening or credential mutation', selection => lane(async (f, store) => {
    store.put(settingsKey, { defaultProvider: selection.provider, defaultModel: selection.model });
    const saved = { [selection.provider]: oldOAuth, other };
    store.put(authKey, saved);
    await admitted(f);
    const exchanges = oauthBoundary();
    const response = await credentials(f, { operation: 'read', providerId: selection.provider });
    expect(response.status).toBe(200);
    const value = await json(response);
    if (selection.provider === 'kimi-coding') {
      expect(new Headers(value.auth.headers).get('authorization')).toBe(`Bearer ${oldOAuth.access}`);
      expect(value.auth).not.toHaveProperty('apiKey');
    } else {
      expect(value.auth.apiKey).toBe(oldOAuth.access);
      expect(value.auth.baseUrl).toMatch(/^https:\/\//);
    }
    expect(JSON.stringify(value)).not.toContain(oldOAuth.refresh);
    expect(JSON.stringify(value)).not.toContain(other.key);
    expect(exchanges).toEqual([]);
    expect(store.value(authKey)).toEqual(saved);
    for (const evidence of [await f.activity.getBrowserDetail(), await diagnosticTraversal(diagnosticsBrowser(f))]) {
      const visible = JSON.stringify(evidence);
      for (const secret of [oldOAuth.access, oldOAuth.refresh, other.key]) expect(visible).not.toContain(secret);
    }
  }, true, false, { nativeSelection: selection }));

  it('REQ-OPERATOR-007/047: preserves SDK-resolved API-key request environment without mutation or ambient fallback', () => lane(async (f, store) => {
    const secret = 'synthetic-provider-request-env';
    const saved = { [providerId]: { type: 'api_key', key: oldOAuth.access, env: { SDK_REQUEST_CONTEXT: secret } }, other };
    store.put(authKey, saved);
    await admitted(f);
    expect(await json(await read(f))).toEqual({ auth: { apiKey: oldOAuth.access }, env: { SDK_REQUEST_CONTEXT: secret } });
    expect(store.value(authKey)).toEqual(saved);
    for (const evidence of [await f.activity.getBrowserDetail(), await diagnosticTraversal(diagnosticsBrowser(f))]) {
      const visible = JSON.stringify(evidence);
      for (const value of [secret, oldOAuth.access, other.key]) expect(visible).not.toContain(value);
    }
  }));

  it.each(['invalid', { REQUEST_SECRET: { invalid: 'nested' } }])(
    'REQ-OPERATOR-047: malformed saved API-key environment %j releases no auth', value => lane(async (f, store) => {
      const saved = { [providerId]: { type: 'api_key', key: oldOAuth.access, env: value }, other };
      store.put(authKey, saved);
      await admitted(f);
      await denied(await read(f));
      expect(store.value(authKey)).toEqual(saved);
    }));

  it.each(['enterpriseUrl', 'tokenEndpoint', 'env'] as const)('untrusted OAuth %s cannot choose private exchange destinations', field => lane(async (f, store) => {
    await admitted(f);
    store.put(authKey, { [providerId]: { ...oldOAuth, expires: 1, [field]: 'https://127.0.0.1/private' }, other });
    const exchanges = oauthBoundary();
    await denied(await read(f));
    expect(exchanges).toEqual([]);
  }));

  it.each([
    { selection: logical, credential: undefined, loggingEnabled: false },
    { selection: { provider: 'anthropic', model: 'claude-sonnet-4-5', api: 'anthropic-messages', reasoningLevel: 'low' }, credential: undefined, loggingEnabled: true },
    { selection: { provider: 'xai', model: 'grok-4', api: 'openai-completions', reasoningLevel: 'low' }, credential: 'not-a-credential-record', loggingEnabled: false },
    { selection: { provider: 'kimi-coding', model: 'kimi-k2.5', api: 'anthropic-messages', reasoningLevel: 'low' }, credential: undefined, loggingEnabled: false },
  ])('REQ-OPERATOR-057 AC5/6: missing $selection.provider credential reaches owner recovery without settling a reserved operation', ({ selection, credential, loggingEnabled }) => lane(async (f, store) => {
    const saved = { ...(credential === undefined ? {} : { [selection.provider]: credential }), other };
    store.put(settingsKey, { defaultProvider: selection.provider, defaultModel: selection.model, defaultThinkingLevel: 'low' });
    store.put(authKey, saved);
    await admitted(f);
    await json(await modelAdmission(f));
    await denied(await credentials(f, { operation: 'read', providerId: selection.provider }));
    const authFailure = { code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider: selection.provider };
    expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ authFailure });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ authFailure, result: null, collectionStatus: 'unavailable' });
    await denied(await modelAdmission(f, 'later-inference'), [403, 404, 409]);
    f.normalTransport!.settle('failed');
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ authFailure, executionStatus: 'unknown' });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ result: null, collectionStatus: 'unavailable' });
    expect(store.value(authKey)).toEqual(saved);
    expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain(canary);
  }, true, false, { loggingEnabled, nativeSelection: selection }));

  it('REQ-OPERATOR-057 AC6: an unavailable auth-file read is not diagnosed as missing native credentials', () => lane(async (f, store) => {
    await admitted(f);
    store.override(path => path.endsWith(authKey) ? new Response(null, { status: 403 }) : undefined);
    await denied(await read(f));
    expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).not.toHaveProperty('authFailure');
    expect(await f.activity.getBrowserDetail()).not.toHaveProperty('authFailure');
  }));

  it('returns the legacy selected API-key reply when SDK request metadata is absent', () => lane(async (f, store) => {
    const saved = { type: 'api_key', key: `${canary}_selected_api_key` };
    store.put(authKey, { [providerId]: saved, other });
    await admitted(f);
    expect(await json(await read(f))).toEqual({ apiKey: saved.key });
    expect(store.value(authKey)).toEqual({ [providerId]: saved, other });
    expect(store.escapedReads).toEqual([]);
  }));

  it.each(['other', 'missing', '../auth.json', 'openai/../../foreign'])(
    'denies nonselected or invalid credential provider %s without exporting another provider', requested => lane(async (f, store) => {
      await admitted(f);
      await denied(await credentials(f, { operation: 'read', providerId: requested }), [400, 403, 404]);
      expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
      expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
      expect(store.escapedReads).toEqual([]);
    }));

  it.each(['list', 'begin', 'commit', 'abort'])(
    'denies abandoned credential %s operations without R2 access or persistence', operation => lane(async (f, store) => {
      await admitted(f);
      store.override(() => { throw new Error(`${canary}_FORBIDDEN_CREDENTIAL_OPERATION`); });
      await denied(await credentials(f, { operation, ...(operation === 'begin' ? { providerId } : {}),
        ...(['commit', 'abort'].includes(operation) ? { leaseId: 'unissued-lease' } : {}),
        ...(operation === 'commit' ? { credential: { type: 'api_key', key: `${canary}_rejected_write` } } : {}) }),
        [400, 403, 404]);
      expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
      expect(store.touchedKeys).toEqual(new Set());
      expect(store.escapedReads).toEqual([]);
    }));

  it.each([false, true])('Native OFF returns installation Gateway without Pi R2 access (stale native preference: %s)', staleNative => lane(async (f, store) => {
    if (staleNative) {
      const routes = await fixtureAccess.loadEnterpriseRouteConfig(f.environment, []);
      vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ ...routes,
        piDefaultSource: 'pi-native', allowPersonalPiProviders: false });
    }
    // Any R2 access returns a hostile canary, so native-disabled mode cannot quietly consume native files.
    store.override(() => { throw new Error(`${canary}_NATIVE_OFF_R2_READ`); });
    await admitted(f);
    const managed = await json(await gateway(f));
    expect(managed).toMatchObject({ source: 'managed', routeId: 'approved',
      settings: { defaultProvider: 'codeflare-gateway', defaultModel: 'approved' },
      models: { providers: { 'codeflare-gateway': { api: 'openai-completions',
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
        models: expect.arrayContaining([expect.objectContaining({ id: 'approved' })]) } } } });
    // Account credentials may only be injected by Root's protected HTTP transport.
    expect(JSON.stringify(managed)).not.toMatch(/parent-only|PRIVATE_R2_SERVICES_CANARY/);
    expect(managed).not.toHaveProperty('token'); expect(managed).not.toHaveProperty('credentials');
    expect(await json(await config(f))).toEqual({ source: 'managed' });
    await denied(await read(f));
    await denied(await credentials(f, { operation: 'list' }));
    expect(JSON.stringify(f.normalTransport!.requests)).not.toContain(canary);
    // Native OFF's intentional storage wire allowlist is empty, not merely a redacted response.
    expect(store.touchedKeys).toEqual(new Set());
    expect(store.escapedReads).toEqual([]);
  }, false));

  it.each([undefined, 131072])('managed SDK metadata uses platform token limits without caller overrides (route window: %s)', contextWindow => lane(async (f, store) => {
    await admitted(f);
    const routes = await fixtureAccess.loadEnterpriseRouteConfig(f.environment, []);
    vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ ...routes,
      routeContextWindows: contextWindow === undefined ? {} : { approved: contextWindow } });
    store.override(() => { throw new Error(`${canary}_MANAGED_NATIVE_READ`); });
    const configuration = await json(await gateway(f));
    const configured = configuration.models.providers['codeflare-gateway'];
    const entry = configured.models[0];
    expect(entry.contextWindow).toBe(contextWindow ?? DEFAULT_ROUTE_CONTEXT_WINDOW);
    const models = createModels();
    // Hydrate the actual protected DTO with the same zero defaults used by the
    // normal App. The public SDK must serialize the platform ceiling, not 1.
    models.setProvider(createProvider({ id: 'codeflare-gateway', models: [{
      input: ['text'], contextWindow: 0, maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...entry,
      provider: 'codeflare-gateway', api: 'openai-completions', baseUrl: configured.baseUrl,
      compat: configured.compat,
    }], auth: { apiKey: { name: 'Protected account gateway', resolve: async () => ({ auth: {} }) } },
    api: openAICompletionsApi() }));
    let wire: Record<string, any> | undefined;
    const result = await models.streamSimple(models.getModel('codeflare-gateway', 'approved')!,
      { messages: [{ role: 'user', content: 'Produce a bounded response.', timestamp: 1 }] }, {
        apiKey: 'codeflare-enterprise', fetch: async (input, init) => {
          wire = await new Request(input, init).json() as Record<string, any>;
          const chunks = [
            { id: 'managed-limit', object: 'chat.completion.chunk', created: 1, model: 'approved',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }] },
            { id: 'managed-limit', object: 'chat.completion.chunk', created: 1, model: 'approved',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
          ];
          return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } });
        },
      }).result();
    expect(wire).toMatchObject({ model: 'approved', stream: true });
    // Intentional managed Pi wire contract: existing platform 16,384-token
    // ceiling, under either public OpenAI-compatible token field spelling.
    expect(wire?.max_completion_tokens ?? wire?.max_tokens).toBe(16384);
    expect(result.stopReason).toBe('stop');
    expect(result.usage.output).toBe(3);
    expect(store.touchedKeys).toEqual(new Set());
    expect(store.escapedReads).toEqual([]);
  }, false));

  it('Native OFF ignores a foreign account default and retains the installation Gateway without Pi R2 access', () => lane(async (f, store) => {
    await admitted(f);
    const routes = await fixtureAccess.loadEnterpriseRouteConfig(f.environment, []);
    vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ ...routes,
      routeCatalog: ['approved', 'not-allowed'], defaultRoute: 'not-allowed', allowPersonalPiProviders: false });
    store.override(() => { throw new Error(`${canary}_NATIVE_OFF_R2_READ`); });
    expect(await json(await gateway(f))).toMatchObject({ source: 'managed', routeId: 'approved' });
    expect(await json(await config(f))).toEqual({ source: 'managed' });
    await denied(await read(f));
    expect(store.touchedKeys).toEqual(new Set());
    expect(store.escapedReads).toEqual([]);
  }, false, false, { managedProviderDefault: true }));

  it('denies configuration writes without touching R2 or changing saved selection/auth', () => lane(async (f, store) => {
    await admitted(f);
    const settings = store.value(settingsKey);
    await denied(await callback(f, 'pi/config', { operation: 'write',
      settings: { defaultProvider: 'foreign', defaultModel: 'foreign' } }), [400, 403, 404]);
    expect(store.value(settingsKey)).toEqual(settings);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    expect(store.touchedKeys).toEqual(new Set());
    expect(store.escapedReads).toEqual([]);
  }));

  it.each([
    { bucket: 'foreign-bucket' }, { owner: 'foreign@example.test' }, { endpoint: 'https://attacker.example.test' },
    { path: '../auth.json' }, { key: '../auth.json' }, { key: '.pi/agent/sessions/private.jsonl' },
    { key: '.pi/agent/settings.json?bucket=foreign-bucket' }, { key: authKey },
    { key: '.pi/agent/extensions/private.ts' }, { key: '.pi/agent/models.json' },
  ])('fixed-key wire allowlist refuses caller addressing %j without cross-owner I/O', attack => lane(async (f, store) => {
    await admitted(f);
    await denied(await callback(f, 'pi/config', { operation: 'read', ...attack }), [400, 403, 404]);
    expect(store.escapedReads).toEqual([]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    // A rejected addressing attempt must not poison subsequent exact owner reads.
    expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
  }));

  it.each([
    ['installation', { 'x-codeflare-operator-installation': 'foreign' }],
    ['activity', { 'x-codeflare-operator-activity': 'foreign' }],
    ['generation', { 'x-codeflare-operator-generation': '2' }],
    ['release', { 'x-codeflare-operator-release': 'foreign' }],
    ['revision', { 'x-codeflare-operator-connection-revision': '2' }],
    ['worker', { 'x-codeflare-operator-worker-version': 'foreign-sdk-worker' }],
    ['credential', { authorization: 'Bearer foreign' }],
  ] as const)('installed %s mismatch grants no R2 credentials', (_name, headers) => lane(async (f, store) => {
    await admitted(f);
    store.override(() => { throw new Error(`${canary}_UNAUTHORIZED_READ`); });
    await denied(await callback(f, 'pi/credentials', { operation: 'read', providerId }, headers));
  }));

  const fences: Array<[string, (f: DispatcherFixture) => void | Promise<unknown>]> = [
    ['Access', f => f.revokeSession()], ['grant', f => f.revokeGrant()], ['disabled', f => f.revoke()],
    ['installation revision', f => f.changeInferenceAuthority('installation')],
    ['release digest', f => f.changeInferenceAuthority('digest')], ['deadline', f => f.expire()],
    ['cancel', f => f.activity.cancelDrive()], ['retired generation', f => f.activity.interruptDrive(1)],
    ['source', async f => {
      const routes = await fixtureAccess.loadEnterpriseRouteConfig(f.environment, []);
      vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ ...routes, piDefaultSource: 'managed' });
    }],
    ['owner', () => { vi.spyOn(access, 'resolveBucketName').mockResolvedValue('foreign-bucket'); }],
  ];
  it.each(fences)('%s fence during started SDK refresh grants no late write or auth', (_name, fence) => lane(async (f, store) => {
    await admitted(f);
    const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
    store.put(authKey, saved);
    oauthBoundary(async () => { await fence(f); return tokenReply(); });
    await denied(await read(f), [403, 409, 503]);
    expect(store.value(authKey)).toEqual(saved);
  }));

  it.each(['model', 'provider', 'owner metadata', 'migration', 'key', 'regime'] as const)(
    '%s changes during SDK refresh fence persistence and return', change => lane(async (f, store, metadataEnvironment) => {
      await admitted(f);
      const originalOwner = (await f.activity.getRuntimePlan())!.executionContext.owner.email;
      const saved = { [providerId]: { ...oldOAuth, expires: 1 }, other };
      store.put(authKey, saved);
      oauthBoundary(async () => {
        if (change === 'model' || change === 'provider') store.put(settingsKey, {
          defaultProvider: change === 'provider' ? 'other' : providerId,
          defaultModel: change === 'model' ? 'different-model' : logical.model });
        if (change === 'owner metadata') await runInDurableObject(
          (env as unknown as Env).CONTAINER.getByName('bucket-owner:owner-bucket'), async (_instance, state) => {
            await state.storage.put('bucketOwnerEmail', 'foreign@example.test');
          });
        if (change === 'migration') vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'migrating', regime: 'sse-c', generation: 1 });
        if (change === 'regime') vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 2 });
        if (change === 'key') metadataEnvironment.ENCRYPTION_KEY = btoa('b'.repeat(32));
        return tokenReply();
      });
      try {
        await denied(await read(f), [403, 409, 503]);
        expect(store.value(authKey)).toEqual(saved);
      } finally {
        // The metadata DO outlives this case. Restore only after exercising the
        // foreign-owner denial, reacquiring its stub in the current I/O context.
        if (change === 'owner metadata') await runInDurableObject(
          (env as unknown as Env).CONTAINER.getByName('bucket-owner:owner-bucket'), async (_instance, state) => {
            await state.storage.put('bucketOwnerEmail', originalOwner);
          });
      }
    }));

  it.each(fences)('%s fence denies before R2 and after a late R2 read', (_name, fence) => lane(async (f, store) => {
    await admitted(f);
    store.afterRead(async () => { await fence(f); });
    await denied(await read(f));
    store.override(() => { throw new Error(`${canary}_READ_AFTER_FENCE`); });
    await denied(await config(f)); await denied(await read(f));
    await denied(await gateway(f));
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    expect(store.escapedReads).toEqual([]);
  }));

  it.each(['redirect', 'oversized', 'malformed'] as const)('bounded R2 %s is unavailable without private content', failure => lane(async (f, store) => {
    await admitted(f);
    store.override(() => failure === 'redirect' ? new Response(null, { status: 302,
      headers: { location: `https://attacker.example.test/${canary}` } }) : new Response(failure === 'oversized'
      ? JSON.stringify({ private: canary.repeat(100_000) }) : `${canary}{`, { headers: { 'content-type': 'application/json' } }));
    await denied(await config(f)); await denied(await read(f));
    expect(store.escapedReads).toEqual([]);
  }));

  it('rejects oversized and unknown config request fields without touching private storage', () => lane(async (f, store) => {
    await admitted(f);
    store.override(() => { throw new Error(`${canary}_BAD_REQUEST_READ`); });
    await denied(await callback(f, 'pi/config', { operation: 'read', key: settingsKey, padding: 'x'.repeat(4097) }), [400, 403, 413]);
    await denied(await credentials(f, { operation: 'read', providerId, credentials: oldOAuth }), [400, 403]);
  }));

  it.each(['missing-key', 'migration', 'regime-change', 'key-change'] as const)('SSE %s fails closed around owner reads', failure => lane(async (f, store, metadataEnvironment) => {
    await admitted(f);
    vi.spyOn(regime, 'isR2SseDisabledForBucket').mockResolvedValue(false);
    store.requireSse();
    vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 1 });
    if (failure === 'missing-key') delete metadataEnvironment.ENCRYPTION_KEY;
    if (failure === 'migration') {
      vi.spyOn(regime, 'isBucketMigrating').mockResolvedValue(true);
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'migrating', regime: 'sse-c', generation: 1 });
    }
    if (failure === 'regime-change') store.afterRead(() => {
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 2 });
    });
    if (failure === 'key-change') store.afterRead(() => {
      metadataEnvironment.ENCRYPTION_KEY = btoa('b'.repeat(32));
    });
    await denied(await read(f), failure === 'missing-key' ? [403, 404, 503] : [403, 404, 409, 503]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
  }));

  it('ready SSE-C reads owner credentials without returning encryption key material', () => lane(async (f, store, metadataEnvironment) => {
    await admitted(f);
    vi.spyOn(regime, 'isR2SseDisabledForBucket').mockResolvedValue(false); store.requireSse();
    vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 1 });
    const response = await json(await read(f));
    expect(response).toEqual({ apiKey: oldOAuth.access });
    expect(JSON.stringify(response)).not.toContain(metadataEnvironment.ENCRYPTION_KEY);
  }));
});

// REQ-OPERATOR-057 AC3: the closed DTO reports rejection, not an account diagnosis.
describe('REQ-OPERATOR-057: trusted native authentication evidence', () => {
  it.each(['invalid_api_key', 'invalid_token', 'token_expired', 'authentication_error'])(
    'top-level and nested trusted %s produce only safe rejected recovery', code => {
      for (const evidence of [{ code }, { type: code }, { error: { code } }, { error: { type: code } }]) {
        const failure = nativePiAuthFailure(401, { ...evidence, message: canary, param: null,
          access_token: oldOAuth.access, refresh_token: oldOAuth.refresh }, providerId, logical.api);
        // Exact three-field wire is the intentional nonsecret DTO contract.
        expect(failure).toEqual({ code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider: providerId });
        expect(JSON.stringify(failure)).not.toContain(canary);
      }
    });

  it.each([
    [401, null], [401, {}], [401, { message: 'token_expired: please login' }],
    [401, { error: { message: 'invalid_api_key' } }],
    [401, { code: 'insufficient_quota' }], [429, { code: 'token_expired' }],
    [503, { error: { type: 'authentication_error' } }],
    [403, { code: 'OPERATOR_CAPABILITY_DENIED', reason: 'policy-denied' }],
  ])('HTTP %s without trusted authentication evidence has no login recovery: %j', (status, evidence) => {
    expect(nativePiAuthFailure(status as number, evidence, providerId, logical.api)).toBeUndefined();
  });
});

describe('REQ-OPERATOR-007/047/048: protected SDK-prepared HTTP, not Parent model execution', () => {
  it.each([401, 429, 503])('native custom API forwards SDK-prepared bytes and original HTTP%i failure without account credential injection', status => lane(async f => {
    await admitted(f);
    const outgoing: Request[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== 'https://custom.example.test/native/stream') return original(request);
      outgoing.push(request.clone());
      return new Response('original SDK provider quota failure 😀', { status,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-provider-trace': 'original-trace',
          'x-codeflare-sdk-model-response': 'vendor-controlled' } });
    });
    const permit = await json(await modelAdmission(f));
    expect(permit).toMatchObject({ permitId: expect.any(String), expiresAt: expect.any(Number) });
    expect(JSON.stringify(permit)).not.toMatch(/parent-only|PRIVATE_R2_SERVICES_CANARY/);
    const response = await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['content-type', 'application/json'], ['authorization', `Bearer ${oldOAuth.access}`]],
      bodyBase64: encodeBody(sdkBody) });
    expect(response.status).toBe(status); expect(response.headers.get('x-provider-trace')).toBe('original-trace');
    expect(response.headers.get('x-codeflare-sdk-model-response')).toBe('1');
    expect(await response.text()).toBe('original SDK provider quota failure 😀');
    expect(outgoing).toHaveLength(1);
    expect(await outgoing[0].text()).toBe(sdkBody);
    expect(outgoing[0].headers.get('authorization')).toBe(`Bearer ${oldOAuth.access}`);
    expect(outgoing[0].headers.has('cf-aig-authorization')).toBe(false);
    expect(JSON.stringify([...outgoing[0].headers])).not.toContain('parent-only');
  }));

  it.each([false, true])('REQ-OPERATOR-057 AC6/AC7 / 048: native top-level rejection remains visible with logging OFF and exact failed settlement (cached recovery: %s)', cached => lane(async f => {
    await admitted(f);
    const paid: string[] = [];
    const body = '{ "code":"token_expired", "message":"Provider rejected this request — 原始 😀", "type":"invalid_request_error", "param":null }';
    const bytes = new TextEncoder().encode(body);
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== 'https://custom.example.test/native/stream') return original(request);
      paid.push(await request.text());
      return new Response(bytes, { status: 401, headers: { 'content-type': 'application/json',
        'x-provider-trace': 'auth-rejection', 'x-codeflare-sdk-model-response': 'vendor-controlled' } });
    });
    const operationId = 'native-auth-rejection';
    const permit = await json(await modelAdmission(f, operationId));
    const request = { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['authorization', `Bearer ${oldOAuth.access}`]], bodyBase64: encodeBody(sdkBody) };
    const assertOriginal = async (response: Response) => {
      expect(response.status).toBe(401);
      expect(response.headers.get('x-codeflare-sdk-model-response')).toBe('1');
      expect(response.headers.get('x-provider-trace')).toBe('auth-rejection');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    };
    await assertOriginal(await modelFetch(f, permit.permitId, request, operationId));
    if (cached) {
      // Arrange a retained complete HTTP receipt without its derived browser projection.
      // Recovery is asserted only through the original public model-fetch and status APIs.
      await f.mutateEvidence(async storage => {
        const state = (await storage.get<Record<string, unknown>>('admission'))!;
        const { authFailure: _projection, ...retained } = state;
        await storage.put('admission', retained);
      });
      f.restart(); await f.drainBackground();
      await assertOriginal(await modelFetch(f, permit.permitId, request, operationId));
    }
    const authFailure = { code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider: providerId };
    expect(await diagnosticSummary(f)).toMatchObject({ capture: 'disabled' });
    expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ authFailure, executionStatus: 'running' });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ authFailure,
      executionStatus: 'running', collectionStatus: 'unavailable', result: null });
    // Refusal of subsequent work is functional, not an optional diagnostic side effect.
    await denied(await modelAdmission(f, 'explicit-later-attempt'), [403, 404, 409]);
    f.normalTransport!.settle('failed');
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ authFailure, executionStatus: 'failed' });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ authFailure, executionStatus: 'failed',
      collectionStatus: 'ready', result: null });
    // Existing terminal-record collection remains available; it does not create an assessment.
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true,
      detail: { authFailure, executionStatus: 'failed', collectionStatus: 'consumed', result: null } });
    expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain(canary);
    expect(paid).toEqual([sdkBody]);
    expect(f.normalTransport!.admissions.size).toBe(1);
  }, true, false, { loggingEnabled: false }));

  it.each(['managed401', 'quota429', 'quota503', 'private-refusal', 'foreign-receipt', 'unresolved-effect'] as const)(
    'REQ-OPERATOR-048/057: %s cannot establish definite failed-auth settlement', fault => lane(async f => {
      await admitted(f);
      const paid: string[] = [];
      const original = globalThis.fetch;
      const status = fault === 'quota429' ? 429 : fault === 'quota503' ? 503 : 401;
      const body = JSON.stringify(fault.startsWith('quota') ? { error: { code: 'insufficient_quota' } }
        : { code: 'token_expired', type: 'invalid_request_error', message: 'Request rejected', param: null });
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (fault === 'managed401' && request.url === 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions') {
          return new Response('Fixture provider is unavailable on REST', { status: 404 });
        }
        if (fault === 'managed401' ? new URL(request.url).origin !== 'https://gateway.ai.cloudflare.com'
          : request.url !== 'https://custom.example.test/native/stream') return original(request);
        paid.push(await request.text()); return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      });
      const permit = await json(await modelAdmission(f));
      const response = await modelFetch(f, permit.permitId, {
        url: fault === 'managed401' ? 'https://api.openai.com/v1/chat/completions' : 'https://custom.example.test/native/stream',
        method: 'POST', headers: fault === 'managed401' ? [['content-type', 'application/json'], ['authorization', 'Bearer codeflare-enterprise']] : [],
        bodyBase64: encodeBody(fault === 'managed401' ? JSON.stringify({ model: 'approved',
          messages: [{ role: 'user', content: 'Managed authentication rejection' }], max_tokens: 16, stream: true }) : sdkBody),
      }, 'sdk-model-operation', fault === 'private-refusal' ? { 'x-codeflare-operator-generation': '2' } : undefined);
      if (fault === 'private-refusal') {
        await denied(response, [403, 404, 409]); expect(paid).toEqual([]);
      } else {
        expect(response.status).toBe(status);
        expect(response.headers.get('x-codeflare-sdk-model-response')).toBe('1');
        expect(await response.text()).toBe(body);
        if (fault === 'managed401') {
          expect(paid).toHaveLength(1);
          expect(JSON.parse(paid[0])).toMatchObject({ model: 'dynamic/approved' });
        } else expect(paid).toEqual([sdkBody]);
      }
      if (fault === 'foreign-receipt') f.normalTransport!.changeReceipt({ uid: 'foreign-sdk-instance' });
      if (fault === 'unresolved-effect') await f.mutateEvidence(async storage => {
        const journal = (await storage.get<{ generation: number; count: number; nextOrdinal: number; unresolved: number }>('dispatcher:journal'))!;
        await storage.put('dispatcher:operation:1:uncertain-comment', { generation: 1, phase: 'unknown',
          requestDigest: 'a'.repeat(64), ordinal: journal.nextOrdinal,
          request: { method: 'POST', url: 'https://api.github.com/repos/authorized/project/issues/17/comments' } });
        await storage.put('dispatcher:journal', { ...journal, count: journal.count + 1,
          nextOrdinal: journal.nextOrdinal + 1, unresolved: journal.unresolved + 1 });
      });
      f.normalTransport!.settle('failed');
      await f.activity.reconcileDispatcherLease();
      const detail = await f.activity.getBrowserDetail();
      expect(detail).toMatchObject({ collectionStatus: 'unavailable', result: null });
      if (fault === 'foreign-receipt' || fault === 'unresolved-effect') {
        expect(detail?.executionStatus).not.toBe('failed');
      } else {
        expect(detail).not.toHaveProperty('authFailure');
        expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).not.toHaveProperty('authFailure');
      }
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(f.normalTransport!.admissions.size).toBe(1);
    }, fault !== 'managed401', fault === 'managed401', { loggingEnabled: false }));

  it('managed SDK HTTP reuses the real operator-aware Gateway interceptor while its account token remains Root-only', () => lane(async f => {
    await admitted(f);
    const outgoing: Request[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      // The real interceptor owns REST-first routing and the 404 compat fallback.
      if (request.method === 'POST' && request.url === 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions') {
        return new Response('Fixture provider is unavailable on REST', { status: 404 });
      }
      if (new URL(request.url).origin !== 'https://gateway.ai.cloudflare.com') return original(request);
      outgoing.push(request.clone());
      return new Response(managedSse, { headers: { 'content-type': 'text/event-stream' } });
    });
    const configuration = await json(await gateway(f));
    expect(JSON.stringify(configuration)).not.toContain('parent-only');
    const permit = await json(await modelAdmission(f));
    const response = await modelFetch(f, permit.permitId, { url: 'https://api.openai.com/v1/chat/completions', method: 'POST',
      headers: [['content-type', 'application/json'], ['authorization', 'Bearer codeflare-enterprise']],
      bodyBase64: encodeBody(JSON.stringify({ model: 'approved', messages: [{ role: 'user', content: 'Original managed SDK input.' }],
        max_tokens: 16, stream: true })) });
    expect(response.status).toBe(200); expect(await response.text()).toBe(managedSse);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].headers.get('cf-aig-authorization')).toBe('Bearer parent-only');
    expect(await outgoing[0].json()).toMatchObject({ model: 'dynamic/approved',
      messages: [{ role: 'user', content: 'Original managed SDK input.' }] });
    expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain('parent-only');
  }, false, true));

  it.each(['body', 'header'] as const)('managed Gateway credential %s echoes remain Root-only through durable response reconciliation', echo => lane(async f => {
    await admitted(f);
    const paid: string[] = [];
    let gatewayCredential = '';
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST' && request.url === 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions') {
        return new Response('Fixture provider is unavailable on REST', { status: 404 });
      }
      if (new URL(request.url).origin !== 'https://gateway.ai.cloudflare.com') return original(request);
      paid.push(await request.text());
      gatewayCredential = request.headers.get('cf-aig-authorization')!.replace(/^Bearer\s+/i, '');
      return new Response(echo === 'body' ? `upstream echoed ${gatewayCredential}` : managedSse, {
        status: echo === 'body' ? 429 : 200,
        headers: { 'content-type': 'text/event-stream',
          'x-provider-trace': echo === 'header' ? `Bearer ${gatewayCredential}` : 'safe-trace' },
      });
    });
    const operationId = `managed-echo-${echo}`;
    const permit = await json(await modelAdmission(f, operationId));
    const request = { url: 'https://api.openai.com/v1/chat/completions', method: 'POST',
      headers: [['content-type', 'application/json'], ['authorization', 'Bearer codeflare-enterprise']],
      bodyBase64: encodeBody(JSON.stringify({ model: 'approved', messages: [{ role: 'user', content: 'Managed SDK input.' }],
        max_completion_tokens: 16, stream: true })) };
    const first = await modelFetch(f, permit.permitId, request, operationId);
    expect(gatewayCredential).toBe('parent-only');
    if (echo === 'body') {
      expect(first.ok).toBe(false);
      expect(await first.text()).not.toContain(gatewayCredential);
    } else {
      expect(first.status).toBe(200);
      expect(first.headers.get('x-provider-trace')).toBeNull();
      expect(await first.text()).toBe(managedSse);
    }
    f.restart(); await f.drainBackground();
    const replay = await modelFetch(f, permit.permitId, request, operationId);
    if (echo === 'body') await denied(replay, [403, 404, 409]);
    else {
      expect(replay.status).toBe(200);
      expect(replay.headers.get('x-provider-trace')).toBeNull();
      expect(await replay.text()).toBe(managedSse);
    }
    expect(paid).toHaveLength(1);
    await f.mutateEvidence(async storage => {
      expect(inspect(decodeRetainedBytes([...await storage.list()]), { depth: null, maxArrayLength: null,
        maxStringLength: null, customInspect: false })).not.toContain(gatewayCredential);
    });
    expect(JSON.stringify(await diagnosticTraversal(diagnosticsBrowser(f)))).not.toContain(gatewayCredential);
    expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain(gatewayCredential);
    expect(JSON.stringify(f.normalTransport!.requests)).not.toContain(gatewayCredential);
  }, false, true));

  it('complete SDK HTTP response is durable before delivery and reconciles exact SSE after reconstruction', () => lane(async f => {
    await admitted(f);
    const payload = new TextEncoder().encode('data: {"text":"原始 😀"}\n\ndata: [DONE]\n\n');
    const paid: string[] = [];
    let opened!: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
    const upstream = new Promise<ReadableStreamDefaultController<Uint8Array>>(resolve => { opened = resolve; });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      paid.push(await request.text());
      return new Response(new ReadableStream<Uint8Array>({ start: controller => opened(controller) }),
        { headers: { 'content-type': 'text/event-stream', 'x-provider-trace': 'durable-sdk' } });
    });
    const permit = await json(await modelAdmission(f, 'durable-sdk'));
    const request = { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) };
    let delivered = false;
    const pending = modelFetch(f, permit.permitId, request, 'durable-sdk').then(response => { delivered = true; return response; });
    const controller = await upstream;
    controller.enqueue(payload.slice(0, 19));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delivered).toBe(false);
    controller.enqueue(payload.slice(19)); controller.close();
    const first = await pending;
    expect(first.status).toBe(200);
    expect(first.headers.get('x-codeflare-sdk-model-response')).toBe('1');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);
    f.restart(); await f.drainBackground();
    const replay = await modelFetch(f, permit.permitId, request, 'durable-sdk');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('content-type')).toBe('text/event-stream');
    expect(replay.headers.get('x-provider-trace')).toBe('durable-sdk');
    expect(replay.headers.get('x-codeflare-sdk-model-response')).toBe('1');
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(payload);
    const changed = await modelFetch(f, permit.permitId,
      { ...request, bodyBase64: encodeBody(`${sdkBody}\n`) }, 'durable-sdk');
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT',
      reason: 'operation-conflict', disposition: 'operation-local' });
    await f.drainBackground();
    expect(await diagnosticSummary(f)).toMatchObject({ diagnosis: { transportStatus: 409,
      transportReason: 'operation-conflict', transportDisposition: 'operation-local' } });
    const exported = await diagnosticTraversal(diagnosticsBrowser(f), '/diagnostics/v2/export');
    expect(exported.records).toContainEqual(expect.objectContaining({ boundary: 'model', outcome: 'failed',
      error: expect.objectContaining({ transportStatus: 409, transportReason: 'operation-conflict' }) }));
    expect(paid).toEqual([sdkBody]);
  }));

  it('SDK admission conflicts preserve a private 409 without diagnostics when logging is OFF', () => lane(async f => {
    await admitted(f);
    await json(await modelAdmission(f, 'unlogged-conflict'));
    const conflict = await callback(f, 'model-admission', { operationId: 'unlogged-conflict',
      context: modelContext, options: { maxTokens: 16, temperature: 0.5 } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT',
      reason: 'operation-conflict', disposition: 'operation-local' });
    await f.drainBackground();
    const summary = await diagnosticSummary(f);
    expect(summary).toMatchObject({ capture: 'disabled' });
    expect(summary).not.toHaveProperty('diagnosis.transportStatus');
    expect(summary).not.toHaveProperty('diagnosis.transportReason');
  }, true, false, { loggingEnabled: false }));

  it('vendor credential echoes cannot enter the durable SDK response journal or exported evidence', () => lane(async f => {
    await admitted(f);
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      return new Response(`provider echoed ${oldOAuth.access}`, { status: 401 });
    });
    const permit = await json(await modelAdmission(f, 'credential-echo'));
    const response = await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['authorization', `Bearer ${oldOAuth.access}`]], bodyBase64: encodeBody(sdkBody) }, 'credential-echo');
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain(oldOAuth.access);
    await f.mutateEvidence(async storage => {
      // Stored binary responses must be decoded, not merely inspected as numbers.
      const retained = inspect(decodeRetainedBytes([...await storage.list()]), { depth: null, maxArrayLength: null,
        maxStringLength: null, customInspect: false });
      expect(retained).not.toContain(oldOAuth.access);
    });
    expect(inspect(await f.activity.getBrowserDetail(), { depth: null, maxStringLength: null })).not.toContain(oldOAuth.access);
  }));

  it('partial SDK HTTP failure delivers no incomplete response and cannot buy a replay after reconstruction', () => lane(async f => {
    await admitted(f);
    const paid: string[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      paid.push(await request.text());
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('incomplete-sdk-response')); }
        else controller.error(new Error('SDK_HTTP_BODY_INTERRUPTED'));
      } }));
    });
    const permit = await json(await modelAdmission(f, 'partial-sdk'));
    const request = { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) };
    const first = await modelFetch(f, permit.permitId, request, 'partial-sdk');
    expect(first.ok).toBe(false);
    expect(await first.text()).not.toContain('incomplete-sdk-response');
    f.restart(); await f.drainBackground();
    await denied(await modelFetch(f, permit.permitId, request, 'partial-sdk'), [403, 404, 409]);
    expect(paid).toEqual([sdkBody]);
  }));

  it.each([false, true].flatMap(loggingEnabled => [false, true].flatMap(nativeProviderDefault => [
    { destination: 'catalog', url: 'https://api.openai.com/v1/responses' },
    { destination: 'custom', url: 'https://custom.example.test/native/stream' },
  ].map(endpoint => ({ loggingEnabled, nativeProviderDefault, ...endpoint })))))(
    'REQ-OPERATOR-007/047: strict Native SDK forwards $destination endpoints (logging: $loggingEnabled, default: $nativeProviderDefault)',
    ({ loggingEnabled, nativeProviderDefault, url }) => lane(async f => {
      await admitted(f);
      f.environment.ENTERPRISE_MODE = 'active';
      const originalGet = f.environment.KV.get.bind(f.environment.KV);
      const policy = vi.spyOn(f.environment.KV, 'get').mockImplementation((async (key: string, ...args: unknown[]) =>
        key === SETUP_KEYS.STRICT_EGRESS ? 'active' : Reflect.apply(originalGet, f.environment.KV, [key, ...args])) as typeof f.environment.KV.get);
      try {
        const outgoing: Request[] = [];
        const original = globalThis.fetch;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.url !== url) return original(request);
          outgoing.push(request.clone());
          return new Response('native SDK original stream', { headers: { 'content-type': 'text/event-stream' } });
        });
        const permit = await json(await modelAdmission(f));
        const response = await modelFetch(f, permit.permitId, { url, method: 'POST',
          headers: [['authorization', `Bearer ${oldOAuth.access}`], ['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('native SDK original stream');
        expect(outgoing.map(request => request.url)).toEqual([url]);
        expect(outgoing[0].headers.get('authorization')).toBe(`Bearer ${oldOAuth.access}`);
        expect(await outgoing[0].text()).toBe(sdkBody);
      } finally { policy.mockRestore(); }
    }, true, true, { loggingEnabled, nativeProviderDefault }));

  it.each(['generation', 'profile', 'revoked-owner'] as const)('REQ-OPERATOR-047: normal Native strict egress refuses %s before provider I/O', fault => lane(async f => {
    await admitted(f);
    f.environment.ENTERPRISE_MODE = 'active';
    const selected = (await f.activity.getRuntimePlan())!.configuredSelection!;
    if (fault === 'revoked-owner') f.revokeSession();
    const props = { strict: true, operatorDispatcherNative: { activityId: f.activityId,
      generation: fault === 'generation' ? 2 : 1,
      profileDigest: fault === 'profile' ? 'f'.repeat(64) : selected.profileDigest } };
    const outgoing: string[] = [];
    const controller = new EgressController({ props } as unknown as ExecutionContext, { ...f.environment,
      EGRESS: { fetch: async (request: Request) => { outgoing.push(request.url); return new Response('must not send'); } } } as Env);
    const response = await controller.fetch(new Request('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { authorization: `Bearer ${oldOAuth.access}`, 'content-type': 'application/json' }, body: sdkBody }));
    expect(response.status).toBe(403);
    expect(outgoing).toEqual([]);
  }, true, true));

  it('unavailable strict-egress policy refuses native SDK HTTP without a direct paid request', () => lane(async f => {
    await admitted(f);
    const permit = await json(await modelAdmission(f, 'strict-unavailable'));
    f.environment.ENTERPRISE_MODE = 'active';
    const originalGet = f.environment.KV.get.bind(f.environment.KV);
    const policy = vi.spyOn(f.environment.KV, 'get').mockImplementation((async (key: string, ...args: unknown[]) => {
      if (key === SETUP_KEYS.STRICT_EGRESS) throw new Error('STRICT_POLICY_UNAVAILABLE');
      return Reflect.apply(originalGet, f.environment.KV, [key, ...args]);
    }) as typeof f.environment.KV.get);
    const paid: string[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      paid.push(request.url); return new Response('forbidden direct send');
    });
    try {
      await denied(await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
        headers: [['authorization', `Bearer ${oldOAuth.access}`]], bodyBase64: encodeBody(sdkBody) }, 'strict-unavailable'));
      expect(paid).toEqual([]);
    } finally { policy.mockRestore(); }
  }));

  it.each([false, true])('one-operation policy refuses fresh paid work after exhaustion (Actor reconstruction: %s)', reconstructed => lane(async f => {
    await admitted(f);
    // External provider ledger: these are actual HTTP requests, not internal
    // coordination calls. A different body avoids conflating capacity with
    // duplicate-wire protection.
    const paid: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      paid.push({ url: request.url, body: await request.text() });
      return new Response('first paid response', { headers: { 'x-provider-trace': 'capacity-first' } });
    });
    const request = { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) };
    const permit = await json(await modelAdmission(f, 'capacity-first'));
    const first = await modelFetch(f, permit.permitId, request, 'capacity-first');
    expect(first.status).toBe(200); expect(await first.text()).toBe('first paid response');
    if (reconstructed) { f.restart(); await f.drainBackground(); }
    const next = await modelAdmission(f, 'capacity-second');
    if (next.ok) {
      const second = await json(next);
      await denied(await modelFetch(f, second.permitId, { ...request,
        bodyBase64: encodeBody(sdkBody.replace('原始 😀', 'Second distinct SDK request.')) }, 'capacity-second'), [403, 404, 409]);
    } else await denied(next, [403, 404, 409]);
    // A complete committed response reconciles exactly without another paid send.
    const replay = await modelFetch(f, permit.permitId, request, 'capacity-first');
    expect(replay.status).toBe(200); expect(await replay.text()).toBe('first paid response');
    expect(replay.headers.get('x-provider-trace')).toBe('capacity-first');
    expect(paid).toEqual([{ url: request.url, body: sdkBody }]);
  }, true, false, { operationLimit: 1, inferenceAttemptLimit: 1 }));

  it.each([false, true])('initial attempt exhausts a one-attempt policy; HTTP failure replay cannot buy a retry (Actor reconstruction: %s)', reconstructed => lane(async f => {
    await admitted(f);
    const paid: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      paid.push({ url: request.url, body: await request.text() });
      return new Response('provider retryable quota failure', { status: 429, headers: { 'x-provider-trace': 'attempt-first' } });
    });
    const request = { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) };
    const permit = await json(await modelAdmission(f, 'attempt-only'));
    const first = await modelFetch(f, permit.permitId, request, 'attempt-only');
    expect(first.status).toBe(429); expect(await first.text()).toBe('provider retryable quota failure');
    if (reconstructed) { f.restart(); await f.drainBackground(); }
    const checkReplay = async (permitId: string) => {
      const replay = await modelFetch(f, permitId, request, 'attempt-only');
      expect(replay.status).toBe(429);
      expect(await replay.text()).toBe('provider retryable quota failure');
      expect(replay.headers.get('x-provider-trace')).toBe('attempt-first');
    };
    await checkReplay(permit.permitId);
    const readmission = await modelAdmission(f, 'attempt-only');
    if (readmission.ok) await checkReplay((await json(readmission)).permitId);
    else await denied(readmission, [403, 404, 409]);
    // Spare operation capacity is intentional: only inferenceAttemptLimit=1
    // forbids another attempt for this operation, including its initial send.
    expect(paid).toEqual([{ url: request.url, body: sdkBody }]);
  }, true, false, { operationLimit: 2, inferenceAttemptLimit: 1 }));

  it.each(['permit', 'operation', 'generation', 'owner', 'expiry', 'cancel'] as const)('%s drift cannot turn SDK HTTP authority into a reusable proxy', failure => lane(async f => {
    await admitted(f);
    const permit = await json(await modelAdmission(f));
    if (failure === 'owner') vi.spyOn(access, 'resolveBucketName').mockResolvedValue('foreign-bucket');
    if (failure === 'expiry') f.expire();
    if (failure === 'cancel') await f.activity.cancelDrive();
    const outgoing: Request[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(request);
      outgoing.push(request); return new Response('unauthorized spend', { status: 200 });
    });
    await denied(await modelFetch(f, failure === 'permit' ? 'foreign-permit' : permit.permitId,
      { url: 'https://custom.example.test/native/stream', method: 'POST', headers: [], bodyBase64: encodeBody(sdkBody) },
      failure === 'operation' ? 'other-operation' : 'sdk-model-operation',
      failure === 'generation' ? { 'x-codeflare-operator-generation': '2' } : undefined), [403, 404, 409]);
    // External spend boundary: no request reaches the provider after authority fails.
    expect(outgoing).toEqual([]);
  }));

  it.each(['http://custom.example.test/native/stream', 'https://127.0.0.1/private', 'https://169.254.169.254/latest/meta-data',
    'https://user:password@custom.example.test/native/stream'])('SDK transport rejects unsafe destination %s before egress', url => lane(async f => {
    await admitted(f); const permit = await json(await modelAdmission(f));
    await denied(await modelFetch(f, permit.permitId, { url, method: 'POST', headers: [], bodyBase64: encodeBody(sdkBody) }), [400, 403]);
  }));
});

describe('REQ-OPERATOR-007/047/048: read-only credential non-retention', () => {
  it('SDK private files/auth never enter journal, jobs or exports; raw failures retain nonsecret detail only', () => lane(async (f, store) => {
    const output: unknown[][] = [];
    const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation((...args: unknown[]) => { output.push(args); }));
    setLogLevel('info');
    try {
      await admitted(f);
      await json(await config(f)); await json(await read(f));
      const originalFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return new URL(request.url).origin === 'https://custom.example.test'
          ? new Response('original private SDK HTTP bytes') : originalFetch(request);
      });
      const permit = await json(await modelAdmission(f));
      const transported = await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
        headers: [['authorization', `Bearer ${oldOAuth.access}`], ['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) });
      expect(transported.status).toBe(200); expect(await transported.text()).toBe('original private SDK HTTP bytes');
      store.override(() => { throw new Error('SDK_R2_READ_IO_FAILURE', { cause: { credentials: oldOAuth } }); });
      await denied(await read(f));
      const exported = await diagnosticTraversal(diagnosticsBrowser(f));
      expect(JSON.stringify(exported)).not.toContain(canary);
      expect(JSON.stringify(f.normalTransport!.requests)).not.toContain(canary);
      expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain(canary);
      await f.mutateEvidence(async storage => {
        // KV non-retention complements the supported Activity/export surfaces checked above.
        expect(JSON.stringify([...await storage.list()])).not.toContain(canary);
      });
      // Node inspection retains Error message/stack/cause, handles cycles, and
      // must not truncate a credential hidden deep inside a logged failure.
      const logged = inspect(output, { depth: null, maxStringLength: null, maxArrayLength: null,
        customInspect: false, getters: false, colors: false });
      expect(logged).not.toContain(canary);
      expect(logged).toContain('SDK_R2_READ_IO_FAILURE');
      expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  }));
});
