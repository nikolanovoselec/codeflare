/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { inspect } from 'node:util';
import type { Env } from '../../types';
import * as access from '../../lib/access';
import * as r2 from '../../lib/r2-client';
import * as regime from '../../lib/r2-regime-state';
import { discoverDispatcherOwnerProfile } from '../../operators/dispatcher-owner-inference';
import { setLogLevel } from '../../lib/logger';
import {
  type DispatcherFixture, diagnosticTraversal, diagnosticsBrowser, digest, fixture, start,
} from './fixtures/dispatcher-production';
import { connectionSecret, normalCallback } from './fixtures/normal-dispatcher';

// Metadata-only Root: replace the external container lifecycle base, not Root's
// ownership/credential coordination. Native DO storage and RPC remain real; no
// container process or user-session Host is available in this lane.
vi.mock('@cloudflare/containers', async importOriginal => {
  const sdk = await importOriginal<typeof import('@cloudflare/containers')>();
  const { DurableObject } = await import('cloudflare:workers');
  return { ...sdk, Container: DurableObject };
});

/**
 * Root #119 RED: public Activity/installed HTTP + R2 boundary contracts, NOT SDK/Flue execution proof.
 * Frozen private protocol (all POST, installation headers from normalCallback, no-store):
 *   pi/config {operation:'read'} -> Parent-derived source and opaque SDK settings/models/resources;
 *             managed mode returns only {source:'managed'}, with no native R2 reads.
 *   pi/credentials {operation:'read', providerId} -> {credential: Credential | null}
 *                  {operation:'list'} -> {credentials: CredentialInfo[]}
 *                  {operation:'begin', providerId} -> {leaseId, credential, expiresAt}
 *                  {operation:'commit', leaseId, credential} -> {credential}
 *                  {operation:'abort', leaseId} -> 204
 *   gateway {operation:'read'} -> nonsecret platform-provisioned SDK configuration and admitted route.
 *   model-admission {operationId, context, options:neutral} -> {permitId, expiresAt}
 *   model-fetch {operationId, permitId, request:{url, method, headers:[pairs], bodyBase64?}} -> original HTTP response
 * Account Gateway credentials remain Root-only; a trusted SDK fetch uses the protected HTTP capability.
 * The Parent chooses SDK configuration/resource keys; callers cannot address storage.
 * Auth is accessible ONLY through CredentialStore.
 * No callback function crosses HTTP. Flue runs the SDK modify callback between begin and commit.
 * Owner credential transactions serialize the auth file, merge fresh other-provider state, and use conditional R2 writes.
 * A same-provider external update yields 409, never blind retry/overwrite. A busy begin yields 409.
 * Begin grants at most 30 seconds of persist-only authority, even after original cancellation/expiry;
 * read/list/begin/config/gateway still require live original authority. Commit never authorizes inference.
 * Config bodies <=4096 bytes; config object and credential envelopes <=1 MiB UTF-8. Redirects deny.
 * This is an installed HTTP capability, not a new public owner API.
 */
const settingsKey = '.pi/agent/settings.json';
const modelsKey = '.pi/agent/models.json';
const authKey = '.pi/agent/auth.json';
const extensionPrefix = '.pi/agent/extensions/';
const extensionKey = `${extensionPrefix}owner-provider.mjs`;
const canary = 'PRIVATE_R2_SERVICES_CANARY_é🦊';
const providerId = 'owner-custom-virtual';
const logical = { provider: providerId, model: 'logical-review-model', api: 'owner-custom-api', reasoningLevel: 'low' };
const oldOAuth = { type: 'oauth', access: `${canary}_old_access`, refresh: `${canary}_old_refresh`, expires: 1, accountId: 'owner-account' };
const rotated = { ...oldOAuth, access: `${canary}_fresh_access`, refresh: `${canary}_fresh_refresh`, expires: 9_999_999_999_999 };
const other = { type: 'api_key', key: `${canary}_other_provider`, env: { PROJECT: 'unchanged' } };
const callback = (f: DispatcherFixture, path: string, body: unknown, headers?: Record<string, string>) =>
  f.installationCapability.fetch(normalCallback(f.activityId, path, body, headers));
const config = (f: DispatcherFixture) => callback(f, 'pi/config', { operation: 'read' });
const gateway = (f: DispatcherFixture) => callback(f, 'gateway', { operation: 'read' });
// Public SDK TranscriptContext wire: the non-serializable SDK brand is not an HTTP field.
const modelContext = { messages: [{ role: 'user', content: 'Owner SDK transport input.', timestamp: 1 }] };
const modelAdmission = (f: DispatcherFixture, operationId = 'sdk-model-operation') =>
  callback(f, 'model-admission', { operationId, context: modelContext, options: { maxTokens: 16 } });
const sdkBody = '{ "model": "physical-sdk-model", "messages": [{"role":"user","content":"原始 😀"}], "stream": true }';
const encodeBody = (body: string) => btoa(String.fromCharCode(...new TextEncoder().encode(body)));
const modelFetch = (f: DispatcherFixture, permitId: string, request: Record<string, unknown>, operationId = 'sdk-model-operation',
  headers?: Record<string, string>) => callback(f, 'model-fetch', { operationId, permitId, request }, headers);
const credentials = (f: DispatcherFixture, body: Record<string, unknown>) => callback(f, 'pi/credentials', body);
const read = (f: DispatcherFixture) => credentials(f, { operation: 'read', providerId });
const begin = (f: DispatcherFixture) => credentials(f, { operation: 'begin', providerId });
const commit = (f: DispatcherFixture, leaseId: string, credential: unknown = rotated) =>
  credentials(f, { operation: 'commit', leaseId, credential });
async function json(response: Response, status = 200): Promise<Record<string, any>> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}
async function denied(response: Response, statuses = [403, 404, 503]) {
  expect(statuses).toContain(response.status);
  expect(await response.text()).not.toContain(canary);
}

/** S3 boundary simulation: enforce If-Match functionally; never assert private calls or mock counts. */
function storageBoundary() {
  const objects = new Map<string, { body: string; etag: string }>();
  const escapedReads: string[] = [];
  const touchedKeys = new Set<string>();
  let ordinal = 0;
  let afterRead: (() => void | Promise<void>) | undefined;
  let beforeWrite: (() => void) | undefined;
  let responseOverride: (() => Response) | undefined;
  let requireSse = false;
  const put = (key: string, value: unknown, bucket = 'owner-bucket') => {
    objects.set(`/${bucket}/${key}`, { body: JSON.stringify(value), etag: `"revision-${++ordinal}"` });
  };
  put(settingsKey, { defaultProvider: providerId, defaultModel: logical.model, defaultThinkingLevel: 'high',
    privateSetting: `${canary}_settings` });
  put(modelsKey, { providers: { [providerId]: { baseUrl: 'https://custom.example.test', api: logical.api,
    apiKey: `${canary}_command_or_key`, models: [{ id: logical.model, name: 'Logical model', reasoning: true }] } } });
  // This lane verifies opaque SDK file delivery; actual resource execution is tested by the App's public SDK lane.
  const extensionSource = `export const ownerResource = ${JSON.stringify(`${canary}_opaque_resource`)};\n`;
  objects.set(`/owner-bucket/${extensionKey}`, { body: extensionSource, etag: `"revision-${++ordinal}"` });
  put(authKey, { [providerId]: oldOAuth, other });
  put(authKey, { victim: { type: 'api_key', key: `${canary}_CROSS_OWNER` } }, 'foreign-bucket');
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;
    const extensionList = ['/owner-bucket', '/owner-bucket/'].includes(path) && request.method === 'GET'
      && url.searchParams.get('list-type') === '2' && url.searchParams.get('prefix') === extensionPrefix
      && [...url.searchParams.keys()].every(key => ['list-type', 'prefix', 'max-keys', 'continuation-token'].includes(key));
    if (url.origin !== 'https://r2.example.test' || (!extensionList && (![settingsKey, modelsKey, authKey, extensionKey]
      .some(key => path === `/owner-bucket/${key}`) || url.search)) || !['GET', 'HEAD', 'PUT'].includes(request.method)) {
      escapedReads.push(request.url);
      return new Response(`${canary}_CROSS_OWNER`, { status: 403 });
    }
    if (extensionList) {
      touchedKeys.add(`/owner-bucket/${extensionPrefix}`);
      const overridden = responseOverride?.();
      if (overridden) return overridden;
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${extensionKey}</Key><Size>${new TextEncoder().encode(extensionSource).byteLength}</Size><LastModified>2026-10-30T00:00:00.000Z</LastModified></Contents></ListBucketResult>`,
        { headers: { 'content-type': 'application/xml' } });
    }
    touchedKeys.add(path);
    if (requireSse && (request.headers.get('x-amz-server-side-encryption-customer-algorithm') !== 'AES256'
      || !request.headers.get('x-amz-server-side-encryption-customer-key')
      || !request.headers.get('x-amz-server-side-encryption-customer-key-md5'))) return new Response(null, { status: 403 });
    if (request.method === 'PUT') {
      const action = beforeWrite; beforeWrite = undefined; action?.();
      const current = objects.get(path);
      if (!current || request.headers.get('if-match') !== current.etag) return new Response(null, { status: 412 });
      const body = await request.text();
      objects.set(path, { body, etag: `"revision-${++ordinal}"` });
      return new Response(null, { status: 200, headers: { etag: objects.get(path)!.etag } });
    }
    const object = objects.get(path);
    const response = responseOverride?.() ?? (object ? new Response(request.method === 'HEAD' ? null : object.body,
      { headers: { etag: object.etag, 'content-type': 'application/json' } }) : new Response(null, { status: 404 }));
    const action = afterRead; afterRead = undefined; await action?.();
    return response;
  };
  return { fetcher, escapedReads, touchedKeys, put, extensionSource,
    value: (key: string) => JSON.parse(objects.get(`/owner-bucket/${key}`)!.body),
    afterRead: (action: () => void | Promise<void>) => { afterRead = action; },
    beforeWrite: (action: () => void) => { beforeWrite = action; },
    override: (action: () => Response) => { responseOverride = action; },
    requireSse: () => { requireSse = true; },
  };
}
type Store = ReturnType<typeof storageBoundary>;
async function lane(run: (f: DispatcherFixture, store: Store) => Promise<void>, native = true, sharedStore?: Store,
  realInterceptors = false, limits: { operationLimit?: number; inferenceAttemptLimit?: number } = {}) {
  return fixture(async f => {
    const store = sharedStore ?? storageBoundary();
    const cleanups: Array<() => void> = [];
    const spy = <T extends { mockRestore(): void }>(value: T) => { cleanups.push(() => value.mockRestore()); return value; };
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
      const selected = native ? logical : { provider: 'codeflare-gateway', model: 'approved',
        api: 'openai-completions', reasoningLevel: 'off' };
      const identity = { source: native ? 'pi-native' : 'managed', ...selected };
      return Response.json({ selection: { ...identity, ...(!native ? { routeId: 'approved' } : {}),
        profileDigest: await digest(JSON.stringify(identity)) } });
    });
    try { await run(f, store); }
    finally { cleanups.reverse().forEach(cleanup => cleanup()); }
  }, { normalHosting: true, repositoryOnly: true, recovery: true, nativeInference: native, realInterceptors, ...limits });
}
async function admitted(f: DispatcherFixture) {
  expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
}

// Requirements: 007 AC4/5/6; 047 AC1/2/3; 048 AC1/2/5/6/7; 058 AC1 + native/default constraints.
describe('REQ-OPERATOR-007/047/048/058: owner R2 configured-service HTTP contracts', () => {
  it('pins the SDK custom logical profile with zero Host catalog and no source-session descriptor', () => lane(async f => {
    await admitted(f);
    const plan = (await f.activity.getRuntimePlan())!;
    expect(await discoverDispatcherOwnerProfile({ plan, generation: 1, env: f.environment,
      current: () => f.activity.operatorGenerationCurrent(1), waitUntil: f.waitUntil })).toEqual({ source: 'pi-native', ...logical,
      profileDigest: await digest(JSON.stringify({ source: 'pi-native', ...logical })) });
    expect((await f.activity.getRuntimePlan())!.configuredSelection).toMatchObject({ source: 'pi-native', ...logical });
    expect(JSON.stringify(f.normalTransport!.requests)).not.toMatch(/ownerhost123|sessionGeneration|private\.jwt/);
  }));

  it('delivers opaque native SDK configuration/resources and exposes auth solely as typed CredentialStore read/list', () => lane(async (f, store) => {
    await admitted(f);
    const snapshot = await json(await config(f));
    expect(snapshot).toMatchObject({ source: 'pi-native', settings: store.value(settingsKey), models: store.value(modelsKey) });
    expect(snapshot.selection).toMatchObject({ source: 'pi-native', ...logical });
    expect(snapshot.resources).toMatchObject({ files: expect.arrayContaining([
      { path: 'extensions/owner-provider.mjs', content: store.extensionSource },
    ]) });
    expect(snapshot).not.toHaveProperty('credentials');
    expect(snapshot).not.toHaveProperty('auth');
    expect(await json(await read(f))).toEqual({ credential: oldOAuth });
    expect(await json(await credentials(f, { operation: 'read', providerId: 'other' }))).toEqual({ credential: other });
    expect(await json(await credentials(f, { operation: 'read', providerId: 'missing' }))).toEqual({ credential: null });
    const listed = await json(await credentials(f, { operation: 'list' }));
    expect(listed).toEqual({ credentials: expect.arrayContaining([
      { providerId, type: 'oauth' }, { providerId: 'other', type: 'api_key' },
    ]) });
    expect(listed.credentials).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(canary);
    await denied(await callback(f, 'pi/config', { operation: 'read', key: authKey }), [400, 403]);
    // Intentional storage wire allowlist, independent of retries or implementation call counts.
    expect(store.touchedKeys).toEqual(new Set([settingsKey, modelsKey, authKey, extensionKey, extensionPrefix]
      .map(key => `/owner-bucket/${key}`)));
    expect(store.escapedReads).toEqual([]);
  }));

  it('Native OFF returns account default Gateway without reading or exporting Pi R2 canaries', () => lane(async (f, store) => {
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
    await denied(await read(f)); await denied(await begin(f));
    await denied(await credentials(f, { operation: 'list' }));
    expect(JSON.stringify(f.normalTransport!.requests)).not.toContain(canary);
    // Native OFF's intentional storage wire allowlist is empty, not merely a redacted response.
    expect(store.touchedKeys).toEqual(new Set());
    expect(store.escapedReads).toEqual([]);
  }, false));

  it.each([
    { bucket: 'foreign-bucket' }, { owner: 'foreign@example.test' }, { endpoint: 'https://attacker.example.test' },
    { path: '../auth.json' }, { key: '../auth.json' }, { key: '.pi/agent/sessions/private.jsonl' },
    { key: '.pi/agent/settings.json?bucket=foreign-bucket' }, { key: authKey },
    { key: '.pi/agent/extensions/private.ts' },
  ])('fixed-key wire allowlist refuses caller addressing %j without cross-owner I/O', attack => lane(async (f, store) => {
    await admitted(f);
    await denied(await callback(f, 'pi/config', { operation: 'read', ...attack }), [400, 403, 404]);
    expect(store.escapedReads).toEqual([]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    // A rejected addressing attempt must not poison subsequent exact owner reads.
    expect(await json(await read(f))).toEqual({ credential: oldOAuth });
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
    ['owner', () => { vi.spyOn(access, 'resolveBucketName').mockResolvedValue('foreign-bucket'); }],
  ];
  it.each(fences)('%s fence denies before R2 and after a late R2 read', (_name, fence) => lane(async (f, store) => {
    await admitted(f);
    store.afterRead(async () => { await fence(f); });
    await denied(await read(f));
    store.override(() => { throw new Error(`${canary}_READ_AFTER_FENCE`); });
    await denied(await config(f)); await denied(await read(f)); await denied(await begin(f));
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
    await denied(await credentials(f, { operation: 'read', providerId, credentials: rotated }), [400, 403]);
  }));

  it.each(['missing-key', 'migration', 'regime-change', 'key-change'] as const)('SSE %s fails closed around owner reads', failure => lane(async (f, store) => {
    await admitted(f);
    vi.spyOn(regime, 'isR2SseDisabledForBucket').mockResolvedValue(false);
    store.requireSse();
    vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 1 });
    if (failure === 'missing-key') delete (f.environment as unknown as Record<string, unknown>).ENCRYPTION_KEY;
    if (failure === 'migration') {
      vi.spyOn(regime, 'isBucketMigrating').mockResolvedValue(true);
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'migrating', regime: 'sse-c', generation: 1 });
    }
    if (failure === 'regime-change') store.afterRead(() => {
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 2 });
    });
    if (failure === 'key-change') store.afterRead(() => {
      (f.environment as unknown as Record<string, unknown>).ENCRYPTION_KEY = btoa('b'.repeat(32));
    });
    await denied(await read(f));
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
  }));

  it('ready SSE-C reads owner credentials without returning encryption key material', () => lane(async (f, store) => {
    await admitted(f);
    vi.spyOn(regime, 'isR2SseDisabledForBucket').mockResolvedValue(false); store.requireSse();
    vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 1 });
    const response = await json(await read(f));
    expect(response).toEqual({ credential: oldOAuth });
    expect(JSON.stringify(response)).not.toContain(f.environment.ENCRYPTION_KEY);
  }));
});

describe('REQ-OPERATOR-007/047/048: protected SDK-prepared HTTP, not Parent model execution', () => {
  it('native custom API forwards SDK-prepared bytes and original HTTP failure without account credential injection', () => lane(async f => {
    await admitted(f);
    const outgoing: Request[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== 'https://custom.example.test/native/stream') return original(input, init);
      outgoing.push(request.clone());
      return new Response('original SDK provider quota failure 😀', { status: 429,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-provider-trace': 'original-trace' } });
    });
    const permit = await json(await modelAdmission(f));
    expect(permit).toMatchObject({ permitId: expect.any(String), expiresAt: expect.any(Number) });
    expect(JSON.stringify(permit)).not.toMatch(/parent-only|PRIVATE_R2_SERVICES_CANARY/);
    const response = await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
      headers: [['content-type', 'application/json'], ['authorization', `Bearer ${oldOAuth.access}`]],
      bodyBase64: encodeBody(sdkBody) });
    expect(response.status).toBe(429); expect(response.headers.get('x-provider-trace')).toBe('original-trace');
    expect(await response.text()).toBe('original SDK provider quota failure 😀');
    expect(outgoing).toHaveLength(1);
    expect(await outgoing[0].text()).toBe(sdkBody);
    expect(outgoing[0].headers.get('authorization')).toBe(`Bearer ${oldOAuth.access}`);
    expect(outgoing[0].headers.has('cf-aig-authorization')).toBe(false);
    expect(JSON.stringify([...outgoing[0].headers])).not.toContain('parent-only');
  }));

  it('managed SDK HTTP reuses the real operator-aware Gateway interceptor while its account token remains Root-only', () => lane(async f => {
    await admitted(f);
    const outgoing: Request[] = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://gateway.ai.cloudflare.com') return original(input, init);
      outgoing.push(request.clone());
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const configuration = await json(await gateway(f));
    expect(JSON.stringify(configuration)).not.toContain('parent-only');
    const permit = await json(await modelAdmission(f));
    const response = await modelFetch(f, permit.permitId, { url: 'https://api.openai.com/v1/chat/completions', method: 'POST',
      headers: [['content-type', 'application/json'], ['authorization', 'Bearer codeflare-enterprise']],
      bodyBase64: encodeBody(JSON.stringify({ model: 'approved', messages: [{ role: 'user', content: 'Original managed SDK input.' }],
        max_tokens: 16, stream: true })) });
    expect(response.status).toBe(200); expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].headers.get('cf-aig-authorization')).toBe('Bearer parent-only');
    expect(await outgoing[0].json()).toMatchObject({ model: 'dynamic/approved',
      messages: [{ role: 'user', content: 'Original managed SDK input.' }] });
    expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain('parent-only');
  }, false, undefined, true));

  it.each([false, true])('one-operation policy refuses fresh paid work after exhaustion (Actor reconstruction: %s)', reconstructed => lane(async f => {
    await admitted(f);
    // External provider ledger: these are actual HTTP requests, not internal
    // coordination calls. A different body avoids conflating capacity with
    // duplicate-wire protection.
    const paid: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(input, init);
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
    // A committed permit is either replayed from its receipt or refused. Neither
    // outcome authorizes a second paid request, even after memory is discarded.
    const replay = await modelFetch(f, permit.permitId, request, 'capacity-first');
    if (replay.ok) {
      expect(replay.status).toBe(200); expect(await replay.text()).toBe('first paid response');
      expect(replay.headers.get('x-provider-trace')).toBe('capacity-first');
    } else await denied(replay, [403, 404, 409]);
    expect(paid).toEqual([{ url: request.url, body: sdkBody }]);
  }, true, undefined, false, { operationLimit: 1, inferenceAttemptLimit: 1 }));

  it.each([false, true])('initial attempt exhausts a one-attempt policy; HTTP failure replay cannot buy a retry (Actor reconstruction: %s)', reconstructed => lane(async f => {
    await admitted(f);
    const paid: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(input, init);
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
      if (replay.status === 429) {
        expect(await replay.text()).toBe('provider retryable quota failure');
        expect(replay.headers.get('x-provider-trace')).toBe('attempt-first');
      } else await denied(replay, [403, 404, 409]);
    };
    await checkReplay(permit.permitId);
    const readmission = await modelAdmission(f, 'attempt-only');
    if (readmission.ok) await checkReplay((await json(readmission)).permitId);
    else await denied(readmission, [403, 404, 409]);
    // Spare operation capacity is intentional: only inferenceAttemptLimit=1
    // forbids another attempt for this operation, including its initial send.
    expect(paid).toEqual([{ url: request.url, body: sdkBody }]);
  }, true, undefined, false, { operationLimit: 2, inferenceAttemptLimit: 1 }));

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
      if (new URL(request.url).origin !== 'https://custom.example.test') return original(input, init);
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

describe('REQ-OPERATOR-007/047/048: serialized bounded SDK credential persistence', () => {
  it('persists fresh OAuth rotation and preserves a newer unrelated provider', () => lane(async (f, store) => {
    await admitted(f);
    const lease = await json(await begin(f));
    expect(lease).toMatchObject({ leaseId: expect.any(String), credential: oldOAuth, expiresAt: expect.any(Number) });
    const externalOther = { ...other, key: `${canary}_external_other` };
    store.put(authKey, { [providerId]: oldOAuth, other: externalOther });
    expect(await json(await commit(f, lease.leaseId))).toEqual({ credential: rotated });
    expect(store.value(authKey)).toEqual({ [providerId]: rotated, other: externalOther });
    expect(await json(await read(f))).toEqual({ credential: rotated });
    await denied(await commit(f, lease.leaseId, oldOAuth), [403, 404, 409]);
    expect(store.value(authKey)).toEqual({ [providerId]: rotated, other: externalOther });
  }));

  it('concurrent begin has one winner and the next lease sees the committed rotation', () => lane(async (f, store) => {
    await admitted(f);
    const responses = await Promise.all([begin(f), begin(f)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const lease = await json(responses.find(response => response.status === 200)!);
    expect(await json(await commit(f, lease.leaseId))).toEqual({ credential: rotated });
    const next = await json(await begin(f));
    expect(next.credential).toEqual(rotated);
    expect((await credentials(f, { operation: 'abort', leaseId: next.leaseId })).status).toBe(204);
    expect(store.value(authKey)).toEqual({ [providerId]: rotated, other });
  }));

  it('different providers share one owner auth-file transaction without changing their credentials', () => lane(async (f, store) => {
    await admitted(f);
    const lease = await json(await begin(f));
    await denied(await credentials(f, { operation: 'begin', providerId: 'other' }), [409]);
    expect(await json(await credentials(f, { operation: 'read', providerId: 'other' }))).toEqual({ credential: other });
    expect(await json(await commit(f, lease.leaseId))).toEqual({ credential: rotated });
    const next = await json(await credentials(f, { operation: 'begin', providerId: 'other' }));
    expect(next.credential).toEqual(other);
    expect((await credentials(f, { operation: 'abort', leaseId: next.leaseId })).status).toBe(204);
    expect(store.value(authKey)).toEqual({ [providerId]: rotated, other });
  }));

  it('one owner credential transaction serializes separate Activities, not merely one Activity instance', () => lane(async (first, store) => {
    await admitted(first); const lease = await json(await begin(first));
    await lane(async second => {
      await admitted(second);
      await denied(await begin(second), [409]);
      // Knowing another run's lease does not transfer its persist-only authority.
      await denied(await commit(second, lease.leaseId), [403, 404, 409]);
      expect(await json(await commit(first, lease.leaseId))).toEqual({ credential: rotated });
      const next = await json(await begin(second));
      expect(next.credential).toEqual(rotated);
      expect((await credentials(second, { operation: 'abort', leaseId: next.leaseId })).status).toBe(204);
      expect(store.value(authKey)).toEqual({ [providerId]: rotated, other });
    }, true, store);
  }));

  it('CAS 412 preserves the latest external same-provider write instead of replaying stale OAuth', () => lane(async (f, store) => {
    await admitted(f);
    const lease = await json(await begin(f));
    const latest = { ...rotated, refresh: `${canary}_EXTERNAL_LOGIN`, access: `${canary}_EXTERNAL_ACCESS` };
    // Race at the S3 write boundary, after any implementation-side read/merge.
    store.beforeWrite(() => store.put(authKey, { [providerId]: latest, other }));
    await denied(await commit(f, lease.leaseId), [409]);
    expect(store.value(authKey)).toEqual({ [providerId]: latest, other });
    expect(await json(await read(f))).toEqual({ credential: latest });
  }));

  it('external same-provider login between begin and commit is never overwritten', () => lane(async (f, store) => {
    await admitted(f); const lease = await json(await begin(f));
    const latest = { type: 'api_key', key: `${canary}_NEW_LOGIN` };
    store.put(authKey, { [providerId]: latest, other });
    await denied(await commit(f, lease.leaseId), [409]);
    expect(store.value(authKey)).toEqual({ [providerId]: latest, other });
  }));

  it('abort releases serialization without writes; unknown or malformed commits cannot write', () => lane(async (f, store) => {
    await admitted(f); const lease = await json(await begin(f));
    expect((await credentials(f, { operation: 'abort', leaseId: lease.leaseId })).status).toBe(204);
    await denied(await commit(f, lease.leaseId), [403, 404, 409]);
    await denied(await commit(f, 'foreign-lease'), [403, 404, 409]);
    const next = await json(await begin(f));
    await denied(await commit(f, next.leaseId, { type: 'oauth', access: 7 }), [400, 403]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    expect((await credentials(f, { operation: 'abort', leaseId: next.leaseId })).status).toBe(204);
  }));

  it.each(['expiry', 'caller-abort', 'activity-cancel'] as const)('already-begun bounded rotation survives %s but grants no new work', interruption => lane(async (f, store) => {
    await admitted(f);
    // Begin just before the original human deadline; persistence finishes just after it,
    // still well inside the independent 30-second lease (not 5 minutes after begin).
    if (interruption === 'expiry') f.advanceClock(299_000);
    const lease = await json(await begin(f));
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(lease.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
    if (interruption === 'expiry') f.advanceClock(300_001);
    if (interruption === 'activity-cancel') await f.activity.cancelDrive();
    if (interruption === 'caller-abort') {
      const controller = new AbortController(); controller.abort();
      const request = normalCallback(f.activityId, 'pi/credentials', { operation: 'commit', leaseId: lease.leaseId, credential: rotated });
      expect((await f.installationCapability.fetch(new Request(request, { signal: controller.signal }))).status).toBe(200);
    } else expect(await json(await commit(f, lease.leaseId))).toEqual({ credential: rotated });
    expect(store.value(authKey)).toEqual({ [providerId]: rotated, other });
    if (interruption !== 'caller-abort') {
      await denied(await read(f)); await denied(await begin(f)); await denied(await config(f));
      await denied(await callback(f, 'inference', { operationId: 'persist-is-not-infer-authority', context: { messages: [] }, options: {} }));
    }
  }));

  it.each(['migration', 'regime-change', 'key-change'] as const)('an OAuth lease cannot write through an owner SSE %s', failure => lane(async (f, store) => {
    await admitted(f);
    vi.spyOn(regime, 'isR2SseDisabledForBucket').mockResolvedValue(false);
    vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 1 });
    store.requireSse();
    const lease = await json(await begin(f));
    if (failure === 'migration') {
      vi.spyOn(regime, 'isBucketMigrating').mockResolvedValue(true);
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'migrating', regime: 'sse-c', generation: 1 });
    } else if (failure === 'regime-change') {
      vi.spyOn(regime, 'getRegimeState').mockResolvedValue({ status: 'ready', regime: 'sse-c', generation: 2 });
    } else {
      (f.environment as unknown as Record<string, unknown>).ENCRYPTION_KEY = btoa('b'.repeat(32));
    }
    await denied(await commit(f, lease.leaseId), [403, 409, 503]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    expect(store.escapedReads).toEqual([]);
  }));

  it('expired persist-only lease cannot commit even while the Activity remains authorized', () => lane(async (f, store) => {
    await admitted(f); const lease = await json(await begin(f));
    f.advanceClock(31_000);
    await denied(await commit(f, lease.leaseId), [403, 404, 409]);
    expect(store.value(authKey)).toEqual({ [providerId]: oldOAuth, other });
    expect(await json(await read(f))).toEqual({ credential: oldOAuth });
  }));

  it('SDK private files/auth never enter journal, jobs or exports; raw failures retain nonsecret detail only', () => lane(async (f, store) => {
    const output: unknown[][] = [];
    const spies = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation((...args: unknown[]) => { output.push(args); }));
    setLogLevel('info');
    try {
      await admitted(f);
      await json(await config(f)); await json(await read(f));
      const lease = await json(await begin(f)); await json(await commit(f, lease.leaseId));
      const originalFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => new URL(new Request(input, init).url).origin
        === 'https://custom.example.test' ? new Response('original private SDK HTTP bytes') : originalFetch(input, init));
      const permit = await json(await modelAdmission(f));
      const transported = await modelFetch(f, permit.permitId, { url: 'https://custom.example.test/native/stream', method: 'POST',
        headers: [['authorization', `Bearer ${rotated.access}`], ['content-type', 'application/json']], bodyBase64: encodeBody(sdkBody) });
      expect(transported.status).toBe(200); expect(await transported.text()).toBe('original private SDK HTTP bytes');
      store.override(() => { throw new Error('SDK_R2_REFRESH_IO_FAILURE', { cause: { credentials: rotated } }); });
      await denied(await read(f));
      const exported = await diagnosticTraversal(diagnosticsBrowser(f));
      expect(JSON.stringify(exported)).not.toContain(canary);
      expect(JSON.stringify(f.normalTransport!.requests)).not.toContain(canary);
      expect(JSON.stringify(await f.activity.getBrowserDetail())).not.toContain(canary);
      await f.mutateEvidence(async storage => {
        // Security non-retention contract: all persisted Activity values, including journals/messages/jobs.
        expect(JSON.stringify([...await storage.list()])).not.toContain(canary);
        const rows = storage.sql.exec('SELECT name FROM sqlite_master WHERE type = ?', 'table').toArray();
        for (const row of rows) {
          const name = String(row.name).replace(/"/g, '""');
          expect(JSON.stringify(storage.sql.exec(`SELECT * FROM "${name}"`).toArray())).not.toContain(canary);
        }
      });
      // Node inspection retains Error message/stack/cause, handles cycles, and
      // must not truncate a credential hidden deep inside a logged failure.
      const logged = inspect(output, { depth: null, maxStringLength: null, maxArrayLength: null,
        customInspect: false, getters: false, colors: false });
      expect(logged).not.toContain(canary);
      expect(logged).toContain('SDK_R2_REFRESH_IO_FAILURE');
      expect(store.value(authKey)).toEqual({ [providerId]: rotated, other });
    } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  }));
});
