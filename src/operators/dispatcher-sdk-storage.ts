import type { Env } from '../types';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { getRegimeState } from '../lib/r2-regime-state';
import { computeKeyMd5, getSseHeaders } from '../lib/r2-sse';
import { SETUP_KEYS } from '../lib/kv-keys';

export interface SdkStorageScope {
  bucket: string;
  email: string;
  activityId: string;
  generation: number;
  deadline: number;
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
  const request = async (url: string) => {
    await guard();
    const pending = client.fetch(new Request(url, { headers, redirect: 'manual', signal }));
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
    return { bytes };
  };
  return { guard, read };
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

/** Owner metadata exposes only the selected saved token; no authentication mutation. */
export async function handleDispatcherSdkCredentials(storage: DurableObjectStorage, env: Env,
  scope: SdkStorageScope, body: unknown): Promise<unknown | null> {
  return privateOperation(async () => {
    scopeValid(scope);
    if (!object(body) || body.operation !== 'read' || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'providerId') || typeof body.providerId !== 'string'
      || !body.providerId || body.providerId.length > 512 || /[\x00-\x20\x7f]/.test(body.providerId)) deny();
    const authorize = async () => {
      active(scope);
      if (await storage.get<string>('bucketOwnerEmail') !== scope.email) deny();
      active(scope);
    };
    const io = await transport(env, scope, authorize, scope.deadline);
    const selected = savedDefaults((await io.read(SETTINGS)).bytes);
    if (selected.defaultProvider !== body.providerId) deny();
    const bytes = (await io.read(AUTH)).bytes;
    const auth = bytes ? json(bytes) : {};
    const credential = Object.hasOwn(auth, selected.defaultProvider) ? auth[selected.defaultProvider] : undefined;
    if (!object(credential)) deny();
    const apiKey = credential.type === 'api_key' ? credential.key : credential.type === 'oauth' ? credential.access : undefined;
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.startsWith('!') || /[\r\n\x00]/.test(apiKey)) deny();
    await io.guard();
    return { apiKey };
  });
}
