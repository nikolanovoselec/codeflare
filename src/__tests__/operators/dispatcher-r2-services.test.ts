/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { inspect } from 'node:util';
import type { Env } from '../../types';
// Register the fixture's existing Access boundary before any production importer.
import {
  type DispatcherFixture, diagnosticSummary, diagnosticTraversal, diagnosticsBrowser, digest, fixture, start,
} from './fixtures/dispatcher-production';
import * as fixtureAccess from '../../lib/access';
import * as fixtureAig from '../../lib/aig-config';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { discoverDispatcherOwnerProfile } from '../../operators/dispatcher-owner-inference';
import { setLogLevel } from '../../lib/logger';
import { connectionSecret, normalCallback } from './fixtures/normal-dispatcher';
import { nativePiAuthFailure } from '../../operators/pi-auth-failure';

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
 * pi/config {operation:'read'} -> {source:'pi-native',settings:{defaultProvider,defaultModel},selection?}
 *                             or {source:'managed'} with no native R2 reads.
 * pi/credentials {operation:'read',providerId} -> {apiKey: saved API key or OAuth access token}
 * Only the selected provider may be read; list/begin/commit/abort and writes are denied.
 * No Pi settings passthrough, models.json, extensions, environment, refresh or account metadata.
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
const providerId = 'groq';
const logical = { provider: providerId, model: 'openai/gpt-oss-20b', api: 'openai-completions', reasoningLevel: 'low' };
const oldOAuth = { type: 'oauth', access: `${canary}_old_access`, refresh: `${canary}_old_refresh`, expires: 1, accountId: 'owner-account' };
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

/** Protected R2 wire allowlist: only fixed settings/auth GETs; every other request is denied. */
function storageBoundary() {
  const objects = new Map<string, { body: string; etag: string }>();
  const escapedReads: string[] = [];
  const touchedKeys = new Set<string>();
  let ordinal = 0;
  let afterRead: (() => void | Promise<void>) | undefined;
  let responseOverride: (() => Response) | undefined;
  let requireSse = false;
  const put = (key: string, value: unknown, bucket = 'owner-bucket') => {
    objects.set(`/${bucket}/${key}`, { body: JSON.stringify(value), etag: `"revision-${++ordinal}"` });
  };
  put(settingsKey, { defaultProvider: providerId, defaultModel: logical.model, defaultThinkingLevel: 'high',
    privateSetting: `${canary}_settings`, env: { SECRET: `${canary}_env` },
    extensions: [`${canary}_extension`], resources: { files: [`${canary}_resource`] } });
  put(authKey, { [providerId]: oldOAuth, other });
  put(authKey, { victim: { type: 'api_key', key: `${canary}_CROSS_OWNER` } }, 'foreign-bucket');
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;
    if (url.origin !== 'https://r2.example.test' || ![settingsKey, authKey]
      .some(key => path === `/owner-bucket/${key}`) || url.search || request.method !== 'GET') {
      escapedReads.push(`${request.method} ${request.url}`);
      return new Response(`${canary}_CROSS_OWNER`, { status: 403 });
    }
    touchedKeys.add(path);
    if (requireSse && (request.headers.get('x-amz-server-side-encryption-customer-algorithm') !== 'AES256'
      || !request.headers.get('x-amz-server-side-encryption-customer-key')
      || !request.headers.get('x-amz-server-side-encryption-customer-key-md5'))) return new Response(null, { status: 403 });
    const object = objects.get(path);
    const response = responseOverride?.() ?? (object ? new Response(object.body,
      { headers: { etag: object.etag, 'content-type': 'application/json' } }) : new Response(null, { status: 404 }));
    const action = afterRead; afterRead = undefined; await action?.();
    return response;
  };
  return { fetcher, escapedReads, touchedKeys, put,
    value: (key: string) => JSON.parse(objects.get(`/owner-bucket/${key}`)!.body),
    afterRead: (action: () => void | Promise<void>) => { afterRead = action; },
    override: (action: () => Response) => { responseOverride = action; },
    requireSse: () => { requireSse = true; },
  };
}
type Store = ReturnType<typeof storageBoundary>;
async function lane(run: (f: DispatcherFixture, store: Store, metadataEnvironment: Env) => Promise<void>, native = true,
  realInterceptors = false, limits: { operationLimit?: number; inferenceAttemptLimit?: number; managedProviderDefault?: boolean;
    nativeProviderDefault?: boolean; nativeNullProfile?: boolean; loggingEnabled?: boolean } = {}) {
  return fixture(async f => {
    const store = storageBoundary();
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
      const selected = native ? { ...logical,
        ...(limits.nativeProviderDefault || limits.nativeNullProfile ? { reasoningLevel: null } : {}) }
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
}

// Requirements: 007 AC4/5/6; 047 AC1/2/3/5; 048 AC2/5/6 + native/default constraints; 058 AC1.
describe('REQ-OPERATOR-007/047/048/058: owner R2 configured-service HTTP contracts', () => {
  it('pins the saved built-in logical profile with zero Host catalog and no source-session descriptor', () => lane(async f => {
    await admitted(f);
    const plan = (await f.activity.getRuntimePlan())!;
    expect(await discoverDispatcherOwnerProfile({ plan, generation: 1, env: f.environment,
      current: () => f.activity.operatorGenerationCurrent(1), waitUntil: f.waitUntil })).toEqual({ source: 'pi-native', ...logical,
      profileDigest: await digest(JSON.stringify({ source: 'pi-native', ...logical })) });
    expect((await f.activity.getRuntimePlan())!.configuredSelection).toMatchObject({ source: 'pi-native', ...logical });
    expect(JSON.stringify(f.normalTransport!.requests)).not.toMatch(/ownerhost123|sessionGeneration|private\.jwt/);
  }));

  it('admits normal native provider-default when approved without inventing an explicit reasoning level', () => lane(async f => {
    await admitted(f);
    const selected = (await f.activity.getRuntimePlan())!.configuredSelection;
    expect(selected).toMatchObject({ source: 'pi-native', provider: providerId, model: logical.model, reasoningLevel: null });
    expect((await f.activity.getBrowserDetail())?.inferenceSelection).toMatchObject({
      source: 'pi-native', provider: providerId, model: logical.model, reasoningLevel: null });
    expect((await modelAdmission(f)).status).toBe(200);
  }, true, false, { nativeProviderDefault: true }));

  it('provider-default discovery cannot erase an existing installation Low override', () => lane(async f => {
    expect((await f.activity.getRuntimePlan())?.receipt).toMatchObject({
      selection: { installation: { piReasoningOverride: 'low' } } });
    const result = await start(f);
    // ok acknowledges the durable drive fence, not admission of the rejected profile.
    expect(result).toMatchObject({ ok: true, state: { status: 'unknown' } });
    expect((await f.activity.getRuntimePlan())?.configuredSelection).toBeUndefined();
    expect(f.normalTransport!.requests.filter(request => request.path === '/control/dispatch')).toEqual([]);
  }, true, false, { nativeNullProfile: true }));

  it.each([false, true])('caller High cannot replace admitted native reasoning (provider-default: %s)', providerDefault => lane(async f => {
    await admitted(f);
    await denied(await callback(f, 'model-admission', { operationId: 'caller-reasoning', context: modelContext,
      options: { maxTokens: 16, reasoning: 'high' } }), [403]);
    expect((await modelAdmission(f)).status).toBe(200);
  }, true, false, { nativeProviderDefault: providerDefault }));

  it('returns only saved provider/model and selected OAuth access token through fixed read-only DTOs', () => lane(async (f, store) => {
    await admitted(f);
    const selection = (await f.activity.getRuntimePlan())!.configuredSelection;
    expect(selection).toMatchObject({ source: 'pi-native', ...logical });
    // Exact DTO is the intentional wire contract: no settings/resources/auth metadata passthrough.
    expect(await json(await config(f))).toEqual({ source: 'pi-native',
      settings: { defaultProvider: providerId, defaultModel: logical.model }, selection });
    expect(await json(await read(f))).toEqual({ apiKey: oldOAuth.access });
    await denied(await callback(f, 'pi/config', { operation: 'read', key: authKey }), [400, 403]);
    expect(store.touchedKeys).toEqual(new Set([settingsKey, authKey].map(key => `/owner-bucket/${key}`)));
    expect(store.escapedReads).toEqual([]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
  }));

  it('returns only the selected saved API key, without evaluating or exporting provider metadata', () => lane(async (f, store) => {
    const saved = { type: 'api_key', key: `${canary}_selected_api_key`, env: { PRIVATE: `${canary}_private_env` } };
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

  it.each([false, true])('Native OFF returns account default Gateway without Pi R2 access (stale native preference: %s)', staleNative => lane(async (f, store) => {
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

  it('Native OFF denies an account default excluded by policy rather than substituting an allowed route', () => lane(async (f, store) => {
    await admitted(f);
    const routes = await fixtureAccess.loadEnterpriseRouteConfig(f.environment, []);
    vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ ...routes,
      routeCatalog: ['approved', 'not-allowed'], defaultRoute: 'not-allowed', allowPersonalPiProviders: false });
    store.override(() => { throw new Error(`${canary}_NATIVE_OFF_R2_READ`); });
    await denied(await gateway(f));
    await denied(await config(f));
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
    expect(paid).toEqual([sdkBody]);
  }));

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
