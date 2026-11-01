import { createModels, ModelsError, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import type { Env } from '../types';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { getRegimeState } from '../lib/r2-regime-state';
import { computeKeyMd5, getSseHeaders } from '../lib/r2-sse';
import { SETUP_KEYS } from '../lib/kv-keys';

// The SDK's opaque OAuth imports are not discovered by Worker bundling.
// Its public static-flow registration preserves SDK-owned resolution and refresh.
registerBunOAuthFlows();

export interface SdkStorageScope {
  bucket: string;
  email: string;
  activityId: string;
  generation: number;
  deadline: number;
  model?: string;
}
export class DispatcherSdkStorageError extends Error {
  constructor(public readonly status: number, message = 'Private SDK storage unavailable', options?: ErrorOptions) { super(message, options); }
}
export type DispatcherSdkCredentialResult = { ok: true; value: unknown | null }
  | { ok: false; status: 403 | 409 | 413; message: string; stack?: string; cause?: unknown };
type JsonObject = Record<string, unknown>;
const LIMIT = 1024 * 1024;
const AUTH = '.pi/agent/auth.json';
const SETTINGS = '.pi/agent/settings.json';
function deny(status = 403): never { throw new DispatcherSdkStorageError(status); }
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function scopeValid(scope: SdkStorageScope): void {
  if (!scope || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(scope.bucket)
    || typeof scope.email !== 'string' || !scope.email || scope.email !== scope.email.trim().toLowerCase()
    || typeof scope.activityId !== 'string' || !scope.activityId || scope.activityId.length > 256
    || scope.model !== undefined && (typeof scope.model !== 'string' || !scope.model || scope.model.length > 512 || /[\x00-\x20\x7f]/.test(scope.model))
    || !Number.isSafeInteger(scope.generation) || scope.generation < 0 || !Number.isSafeInteger(scope.deadline)) deny();
}
function active(scope: SdkStorageScope): void { if (Date.now() >= scope.deadline) deny(); }
async function bounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > LIMIT) {
    void response.body?.cancel().catch(() => undefined); deny(413);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) deny();
      const chunk = await reader.read();
      if (signal.aborted) deny();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > LIMIT) { abort(); deny(413); }
      chunks.push(chunk.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function text(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return deny(); }
}
function json(bytes: Uint8Array): JsonObject {
  try { const value: unknown = JSON.parse(text(bytes)); if (object(value)) return value; } catch { /* private failure */ }
  return deny();
}
async function privateOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof DispatcherSdkStorageError) throw error;
    throw new DispatcherSdkStorageError(403, 'Private SDK storage unavailable', { cause: error });
  }
}
/** Snapshot the actual bucket regime and key; no setup discovery or repair. */
async function transport(env: Env, scope: SdkStorageScope, authorize: () => Promise<void>, until: number,
  externalSignal?: AbortSignal) {
  const signal = AbortSignal.any([...(externalSignal ? [externalSignal] : []),
    AbortSignal.timeout(Math.max(1, Math.min(30_000, until - Date.now())))]);
  const live = async () => {
    if (signal.aborted || Date.now() >= until) deny();
    await authorize();
    if (signal.aborted || Date.now() >= until) deny();
  };
  await live();
  const key = env.ENCRYPTION_KEY;
  const state = await getRegimeState(env, scope.bucket);
  if (state.status !== 'ready' || !['plain', 'sse-c'].includes(state.regime)) deny(409);
  if (state.regime === 'sse-c' && (!key || state.keyMd5 && computeKeyMd5(key) !== state.keyMd5)) deny();
  const snapshot = JSON.stringify(state);
  const headers = getSseHeaders({ ENCRYPTION_KEY: key }, state.regime === 'plain');
  const guard = async () => {
    await live();
    if (env.ENCRYPTION_KEY !== key || JSON.stringify(await getRegimeState(env, scope.bucket)) !== snapshot) deny(409);
    await live();
  };
  const accountId = env.R2_ACCOUNT_ID || await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
  const endpoint = env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password || endpointUrl.search
    || endpointUrl.hash || endpointUrl.pathname !== '/') deny();
  const client = createR2Client(env);
  await guard();
  const request = async (url: string, init?: RequestInit) => {
    await guard();
    const pending = client.fetch(new Request(url, { ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init?.headers)) }, redirect: 'manual', signal }));
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DispatcherSdkStorageError(403));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => {});
    let response: Response;
    try { response = await Promise.race([pending, cancelled]); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
    try { await guard(); if (response.redirected || response.status >= 300 && response.status < 400) deny(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    return response;
  };
  const read = async (path: string) => {
    const response = await request(getR2Url(endpoint, scope.bucket, path));
    if (response.status !== 200 && response.status !== 404) { void response.body?.cancel().catch(() => undefined); deny(); }
    const bytes = response.status === 200 ? await bounded(response, signal) : null;
    if (!bytes) void response.body?.cancel().catch(() => undefined);
    await guard();
    return { bytes, etag: response.headers.get('etag') };
  };
  const write = async (path: string, value: JsonObject, etag: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.byteLength > LIMIT) deny(413);
    let response: Response;
    try {
      response = await request(getR2Url(endpoint, scope.bucket, path), {
        method: 'PUT', headers: { 'if-match': etag, 'content-type': 'application/json' }, body: bytes,
      });
    } catch (error) {
      if (error instanceof DispatcherSdkStorageError) throw error;
      // This request carries the whole credential file. Transport exceptions
      // must not retain its body, unlike existing read-only R2 causal evidence.
      throw new DispatcherSdkStorageError(403, 'SDK credential persistence unavailable');
    }
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 412) deny(409);
    if (!response.ok) deny();
    await guard();
  };
  return { guard, read, write, signal };
}

function savedDefaults(bytes: Uint8Array | null): { defaultProvider: string; defaultModel: string } {
  const settings = bytes ? json(bytes) : {};
  const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);
  if (!valid(settings.defaultProvider) || !valid(settings.defaultModel)) deny();
  return { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel };
}

/** Read the two saved identifiers, never Pi resources or executable configuration. */
export async function readDispatcherSdkFiles(input: SdkStorageScope & {
  env: Env; signal?: AbortSignal; current: () => Promise<boolean>;
}): Promise<{ settings: { defaultProvider: string; defaultModel: string } }> {
  return privateOperation(async () => {
    scopeValid(input);
    const authorize = async () => {
      active(input);
      if (!await input.current()) deny();
      const owner = input.env.CONTAINER.get(input.env.CONTAINER.idFromName(`bucket-owner:${input.bucket}`)) as unknown as {
        claimBucketOwner(email: string, allowInitialClaim: boolean): Promise<string>;
      };
      if (await owner.claimBucketOwner(input.email, false) !== 'owned') deny();
      active(input);
    };
    const io = await transport(input.env, input, authorize, input.deadline, input.signal);
    const settings = savedDefaults((await io.read(SETTINGS)).bytes);
    await io.guard();
    return { settings };
  });
}

/** Only Root can supply this live, request-owned RPC authority. No App fields select it. */
export interface SdkCredentialAuthority { current(): Promise<boolean> }

function oauthCredential(value: unknown): Credential {
  if (!object(value) || value.type !== 'oauth' || typeof value.expires !== 'number'
    || !Number.isFinite(value.expires) || value.expires <= 0) deny();
  for (const field of ['access', 'refresh']) {
    const token = value[field];
    if (typeof token !== 'string' || !token.trim() || token.startsWith('!') || /[\r\n\x00]/.test(token)) deny();
  }
  // Public built-ins own token endpoints. Stored endpoint/env overrides cannot
  // turn private maintenance into caller-addressed credential-bearing I/O.
  if (Object.keys(value).some(key => /url|host|endpoint|^env$|^headers$/i.test(key))) deny();
  if (value.clientId !== undefined && (typeof value.clientId !== 'string' || !value.clientId.trim()
    || /[\r\n\x00]/.test(value.clientId))) deny();
  if (value.scopes !== undefined && (!Array.isArray(value.scopes)
    || value.scopes.some(scope => typeof scope !== 'string' || !scope || /[\r\n\x00]/.test(scope)))) deny();
  return value as unknown as Credential;
}

/** Closed private evidence from Pi AI 1.4; never retain SDK/vendor text. */
function sdkAuthFailure(error: unknown, providerId: string) {
  const own = (value: unknown, key: string): unknown => {
    try {
      if (value === null || typeof value !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch { return undefined; }
  };
  let sdkCode: 'model_source' | 'model_validation' | 'provider' | 'stream' | 'auth' | 'oauth' | null = null;
  try {
    if (error instanceof ModelsError) {
      const code = own(error, 'code');
      if (code === 'model_source' || code === 'model_validation' || code === 'provider'
        || code === 'stream' || code === 'auth' || code === 'oauth') sdkCode = code;
    }
  } catch { /* Uninspectable exceptions remain unclassified. */ }
  let sdkStage: 'refresh' | 'derivation' | null = null;
  const message = own(error, 'message');
  if (sdkCode === 'oauth' && typeof message === 'string') {
    // ModelsError appends cause detail after the SDK-owned template.
    for (const stage of ['refresh', 'derivation'] as const) {
      const prefix = stage === 'refresh' ? `OAuth refresh failed for ${providerId}`
        : `OAuth auth derivation failed for ${providerId}`;
      if (message === prefix || message.startsWith(`${prefix}: `)) sdkStage = stage;
    }
  }
  const cause = own(error, 'cause');
  const exception = sdkStage ? cause : error;
  let exceptionCategory: 'unknown' | 'error' | 'timeout' | 'abort' = 'unknown';
  let nativeName: unknown;
  try {
    // DOMException.name is a native accessor, not an application getter.
    nativeName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(exception);
  } catch { /* Other causes do not pass the native DOMException brand check. */ }
  try {
    const name = nativeName ?? own(exception, 'name');
    if (name === 'TimeoutError') exceptionCategory = 'timeout';
    else if (name === 'AbortError') exceptionCategory = 'abort';
    else if (typeof nativeName === 'string' || exception instanceof Error) exceptionCategory = 'error';
  } catch { /* Proxies cannot replace the functional refusal. */ }
  let httpStatus: number | null = null;
  let oauthError: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client'
    | 'unsupported_grant_type' | 'invalid_scope' | null = null;
  const detail = own(cause, 'message');
  // Only the pinned SDK's HTTP formatter is recognized. Limit parsing, not I/O;
  // no body, arbitrary exception code, or provider-specific error is retained.
  if (sdkStage === 'refresh' && typeof detail === 'string') {
    const match = /^OpenAI OAuth token request failed \(([45][0-9]{2})\): /.exec(detail);
    if (match) {
      httpStatus = Number(match[1]);
      try {
        // A large HTML/JSON error body must not hide its safe HTTP status.
        // Only bounded suffixes are parsed for the optional standard code.
        const code = detail.length <= 8192 ? own(JSON.parse(detail.slice(match[0].length)), 'error') : undefined;
        if (code === 'invalid_request' || code === 'invalid_client' || code === 'invalid_grant'
          || code === 'unauthorized_client' || code === 'unsupported_grant_type' || code === 'invalid_scope') oauthError = code;
      } catch { /* Unknown/non-JSON bodies supply no OAuth classification. */ }
    }
  }
  return { sdkCode, sdkStage, exceptionCategory, httpStatus, oauthError };
}

/** Serialized by the existing bucket-owner metadata DO, never a user Host. */
export async function handleDispatcherSdkCredentials(storage: DurableObjectStorage, env: Env,
  scope: SdkStorageScope, body: unknown, authority: SdkCredentialAuthority,
  retainModification: (pending: Promise<unknown>) => void): Promise<unknown | null> {
  return privateOperation(async () => {
    scopeValid(scope);
    if (!object(body) || body.operation !== 'read' || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'providerId') || typeof body.providerId !== 'string'
      || !body.providerId || body.providerId.length > 512 || /[\x00-\x20\x7f]/.test(body.providerId)) deny();
    const authorize = async () => {
      active(scope);
      if (!authority || !await authority.current()
        || await storage.get<string>('bucketOwnerEmail') !== scope.email) deny();
      active(scope);
    };
    const io = await transport(env, scope, authorize, scope.deadline);
    const selected = savedDefaults((await io.read(SETTINGS)).bytes);
    if (selected.defaultProvider !== body.providerId || scope.model && selected.defaultModel !== scope.model) deny();
    const selectionCurrent = async () => {
      const now = savedDefaults((await io.read(SETTINGS)).bytes);
      if (now.defaultProvider !== selected.defaultProvider || now.defaultModel !== selected.defaultModel) deny();
      await io.guard();
    };
    const snapshot = async () => {
      await selectionCurrent();
      const file = await io.read(AUTH);
      const auth = file.bytes ? json(file.bytes) : {};
      const raw = Object.hasOwn(auth, selected.defaultProvider) ? auth[selected.defaultProvider] : undefined;
      if (!object(raw)) deny();
      return { ...file, auth, raw };
    };
    let saved = await snapshot();
    if (saved.raw.type === 'api_key') {
      const key = saved.raw.key;
      if (typeof key !== 'string' || !key.trim() || key.startsWith('!') || /[\r\n\x00]/.test(key)) deny();
      await selectionCurrent();
      const latest = await snapshot();
      if (latest.etag !== saved.etag || JSON.stringify(latest.raw) !== JSON.stringify(saved.raw)) deny(409);
      await io.guard();
      return { apiKey: key };
    }
    oauthCredential(saved.raw);
    const provider = builtinProviders().find(provider => provider.id === selected.defaultProvider);
    if (!provider?.auth.oauth) deny();
    let storageFailure: unknown;
    const storageOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) { storageFailure = error; throw error; }
    };
    const checkProvider = (id: string) => { if (id !== selected.defaultProvider) deny(); };
    const credentials: CredentialStore = {
      read: id => storageOperation(async () => {
        checkProvider(id); saved = await snapshot(); return oauthCredential(saved.raw);
      }),
      modify: (id, fn) => {
        const pending = (async () => {
          checkProvider(id);
          // Re-read under the metadata lock. No retry after CAS conflict: a
          // concurrent login/other-provider update wins the whole-file revision.
          saved = await storageOperation(snapshot);
          const current = oauthCredential(saved.raw);
          const original = JSON.stringify(current);
          const next = await fn(current);
          return storageOperation(async () => {
            await selectionCurrent();
            if (next !== undefined) {
              oauthCredential(next);
              // SDK freshness is rechecked under the lock; an already renewed
              // credential must not cause an unnecessary persistent mutation.
              if (JSON.stringify(next) === original) return next;
              if (!saved.etag || !/^"[^"\r\n]+"$/.test(saved.etag)) deny();
              await io.write(AUTH, { ...saved.auth, [id]: next }, saved.etag);
              const persisted = await snapshot();
              if (JSON.stringify(persisted.raw) !== JSON.stringify(next)) deny(409);
              saved = persisted;
              return next;
            }
            return current;
          });
        })();
        retainModification(pending);
        return pending;
      },
      list: async () => deny(), delete: async () => deny(),
    };
    const models = createModels({ credentials,
      authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(provider);
    let resolved;
    try { resolved = await models.getAuth(selected.defaultProvider, { signal: io.signal }); }
    catch (error) {
      // Preserve existing private R2 causal evidence, never SDK/vendor bodies,
      // raw causes or token echoes. Started SDK refresh has no late authority.
      if (storageFailure) throw storageFailure;
      const evidence = sdkAuthFailure(error, selected.defaultProvider);
      const category = evidence.sdkCode === 'oauth' ? 'oauth' : 'auth';
      // Own-signal state does not exclude the SDK's independent refresh timeout.
      const requestAborted = io.signal.aborted;
      const abortReason = requestAborted ? 'timeout' : null;
      throw new DispatcherSdkStorageError(403, `SDK authentication unavailable (${category})`, {
        cause: { ...evidence, requestAborted, abortReason },
      });
    }
    await selectionCurrent();
    const latest = await snapshot();
    if (latest.etag !== saved.etag || JSON.stringify(latest.raw) !== JSON.stringify(saved.raw)) deny(409);
    if (!resolved || resolved.env && Object.keys(resolved.env).length
      || Object.keys(resolved.auth).some(key => key !== 'apiKey')) deny();
    const apiKey = resolved.auth.apiKey;
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n\x00]/.test(apiKey)) deny();
    await io.guard();
    return { apiKey };
  });
}
