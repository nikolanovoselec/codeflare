import type { Env } from '../types';
import { createR2Client, getR2Url, parseListObjectsXml } from '../lib/r2-client';
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
const PREFIX = '.pi/agent/extensions/';
const AUTH = '.pi/agent/auth.json';
const LEASE_KEY = 'dispatcherSdkCredentialLease';
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
// Retained only inside private owner metadata; never returned in capability DTOs.
type EncryptionFence = { state: string; keyIdentity: string | null };
/** Snapshot the actual bucket regime and key; no setup discovery or repair. */
async function transport(env: Env, scope: SdkStorageScope, authorize: () => Promise<void>, until: number,
  externalSignal?: AbortSignal, expectedFence?: EncryptionFence) {
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
  const fence: EncryptionFence = { state: snapshot, keyIdentity: key ? await digest(key) : null };
  if (expectedFence && (expectedFence.state !== fence.state || expectedFence.keyIdentity !== fence.keyIdentity)) deny(409);
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
  const request = async (url: string, init: RequestInit = {}, list = false) => {
    await guard();
    const requestHeaders = new Headers(list ? undefined : headers);
    new Headers(init.headers).forEach((value, name) => requestHeaders.set(name, value));
    const pending = client.fetch(new Request(url, { ...init, headers: requestHeaders, redirect: 'manual', signal }));
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
  return { endpoint, signal, guard, request, read, fence };
}

export async function readDispatcherSdkFiles(input: SdkStorageScope & {
  env: Env; signal?: AbortSignal; current: () => Promise<boolean>;
}): Promise<{ settings: JsonObject; models: JsonObject; resources: { files: Array<{ path: string; content: string }> } }> {
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
    const settings = await io.read('.pi/agent/settings.json');
    const models = await io.read('.pi/agent/models.json');
    const files: Array<{ path: string; content: string }> = [];
    if ((settings.bytes?.byteLength ?? 0) + (models.bytes?.byteLength ?? 0) > LIMIT) deny(413);
    const seen = new Set<string>();
    const tokens = new Set<string>();
    let token: string | undefined;
    let total = (settings.bytes?.byteLength ?? 0) + (models.bytes?.byteLength ?? 0);
    do {
      const url = new URL(getR2Url(io.endpoint, input.bucket));
      url.searchParams.set('list-type', '2'); url.searchParams.set('prefix', PREFIX);
      if (token) url.searchParams.set('continuation-token', token);
      const response = await io.request(url.href, {}, true);
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); deny(); }
      const xml = text(await bounded(response, io.signal));
      await io.guard();
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>\s*$/.test(xml)
        || !/<IsTruncated>(?:true|false)<\/IsTruncated>/.test(xml) || /<CommonPrefixes>/.test(xml)) deny();
      const page = parseListObjectsXml(xml);
      if ((xml.match(/<Contents>/g) ?? []).length !== page.objects.length) deny();
      for (const item of page.objects) {
        const relative = item.key.slice(PREFIX.length);
        if (!item.key.startsWith(PREFIX) || !relative || /[\\%?#\x00-\x20\x7f]/.test(relative)
          || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(item.key)
          || !Number.isSafeInteger(item.size) || item.size < 0) deny();
        if (item.size > LIMIT || total + item.size > LIMIT) deny(413);
        seen.add(item.key);
        const saved = await io.read(item.key);
        if (!saved.bytes) deny();
        total += saved.bytes.byteLength;
        if (total > LIMIT) deny(413);
        files.push({ path: `extensions/${relative}`, content: text(saved.bytes) });
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
      if (page.isTruncated && (!token || tokens.has(token))) deny();
      if (token) tokens.add(token);
      if (tokens.size > 1024) deny(413);
    } while (token);
    await io.guard();
    return { settings: settings.bytes ? json(settings.bytes) : {}, models: models.bytes ? json(models.bytes) : {}, resources: { files } };
  });
}

type Lease = { leaseId: string; scope: SdkStorageScope; providerId: string; expiresAt: number;
  digest?: string; fence?: EncryptionFence; committing?: boolean };
function sameScope(a: SdkStorageScope, b: SdkStorageScope): boolean {
  return a.bucket === b.bucket && a.email === b.email && a.activityId === b.activityId
    && a.generation === b.generation && a.deadline === b.deadline;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function credential(value: unknown): value is JsonObject & { type: string } {
  if (!object(value)) return false;
  // Public pi-ai Credential union; provider IDs and opaque metadata are not interpreted.
  if (value.type === 'api_key') {
    if (value.key !== undefined && typeof value.key !== 'string') return false;
    if (value.env !== undefined && (!object(value.env) || !Object.values(value.env).every(item => typeof item === 'string'))) return false;
  } else if (value.type === 'oauth') {
    if (typeof value.refresh !== 'string' || typeof value.access !== 'string'
      || typeof value.expires !== 'number' || !Number.isFinite(value.expires)) return false;
  } else return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= LIMIT; } catch { return false; }
}
function authFile(bytes: Uint8Array | null): JsonObject {
  const value = bytes ? json(bytes) : {};
  if (!Object.values(value).every(credential)) deny();
  return value;
}
/** Called only by the owner metadata DO after its identity and existing claim checks. */
export async function handleDispatcherSdkCredentials(storage: DurableObjectStorage, env: Env,
  scope: SdkStorageScope, body: unknown): Promise<unknown | null> {
  return privateOperation(async () => {
    scopeValid(scope);
    if (!object(body) || typeof body.operation !== 'string') deny();
    const operation = body.operation;
    const fields: Record<string, string[]> = { read: ['operation', 'providerId'], list: ['operation'],
      begin: ['operation', 'providerId'], commit: ['operation', 'leaseId', 'credential'], abort: ['operation', 'leaseId'] };
    const allowed = fields[operation];
    if (!allowed || Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key))) deny();
    if (['read', 'begin'].includes(operation) && (typeof body.providerId !== 'string' || !body.providerId
      || body.providerId.length > 256 || /[\x00-\x20\x7f]/.test(body.providerId))) deny();
    if (['commit', 'abort'].includes(operation) && (typeof body.leaseId !== 'string' || !body.leaseId)) deny();
    if (operation === 'commit' && !credential(body.credential)) deny();
    const owner = async () => {
      if (await storage.get<string>('bucketOwnerEmail') !== scope.email) deny();
    };
    await owner();
    const remove = async (id: string) => storage.transaction(async txn => {
      if ((await txn.get<Lease>(LEASE_KEY))?.leaseId === id) await txn.delete(LEASE_KEY);
    });
    if (operation === 'commit' || operation === 'abort') {
      const lease = await storage.transaction(async txn => {
        const saved = await txn.get<Lease>(LEASE_KEY);
        if (saved && saved.expiresAt <= Date.now()) { await txn.delete(LEASE_KEY); return null; }
        if (!saved || saved.leaseId !== body.leaseId || !sameScope(saved.scope, scope) || saved.committing) return null;
        if (operation === 'abort') await txn.delete(LEASE_KEY);
        else await txn.put(LEASE_KEY, { ...saved, committing: true });
        return saved;
      });
      if (!lease) deny(409);
      if (operation === 'abort') return null;
      try {
        const authorize = async () => {
          await owner();
          const saved = await storage.get<Lease>(LEASE_KEY);
          if (!saved || saved.leaseId !== lease.leaseId || Date.now() >= lease.expiresAt) deny(409);
        };
        if (!lease.fence) deny(409);
        const io = await transport(env, scope, authorize, lease.expiresAt, undefined, lease.fence);
        const saved = await io.read(AUTH);
        const auth = authFile(saved.bytes);
        if (await digest(Object.hasOwn(auth, lease.providerId) ? auth[lease.providerId] : null) !== lease.digest) deny(409);
        Object.defineProperty(auth, lease.providerId, { value: body.credential, enumerable: true, configurable: true, writable: true });
        const encoded = JSON.stringify(auth);
        if (new TextEncoder().encode(encoded).byteLength > LIMIT) deny(413);
        if (saved.bytes && !saved.etag) deny(409);
        const response = await io.request(getR2Url(io.endpoint, scope.bucket, AUTH), { method: 'PUT', body: encoded,
          headers: { 'content-type': 'application/json', ...(saved.bytes ? { 'If-Match': saved.etag! } : { 'If-None-Match': '*' }) } });
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 412) deny(409);
        if (response.status !== 200 && response.status !== 204) deny();
        await io.guard();
        return { credential: body.credential };
      } finally { await remove(lease.leaseId); }
    }
    active(scope);
    const authorize = async () => { await owner(); active(scope); };
    let lease: Lease | undefined;
    if (operation === 'begin') {
      const proposed: Lease = { leaseId: crypto.randomUUID(), scope: { ...scope }, providerId: body.providerId as string,
        expiresAt: Date.now() + 30_000 };
      const acquired = await storage.transaction(async txn => {
        const saved = await txn.get<Lease>(LEASE_KEY);
        if (saved && saved.expiresAt > Date.now()) return false;
        await txn.put(LEASE_KEY, proposed); return true;
      });
      if (!acquired) deny(409);
      lease = proposed;
    }
    try {
      const io = await transport(env, scope, authorize, scope.deadline);
      const saved = await io.read(AUTH);
      const auth = authFile(saved.bytes);
      await io.guard();
      if (operation === 'list') return { credentials: Object.entries(auth).map(([providerId, value]) =>
        ({ providerId, type: (value as { type: string }).type })) };
      const selected = Object.hasOwn(auth, body.providerId as string) ? auth[body.providerId as string] : null;
      if (!lease) return { credential: selected };
      const selectedDigest = await digest(selected);
      const acquired = lease;
      await storage.transaction(async txn => {
        const savedLease = await txn.get<Lease>(LEASE_KEY);
        if (!savedLease || savedLease.leaseId !== acquired.leaseId || savedLease.expiresAt <= Date.now()) deny(409);
        await txn.put(LEASE_KEY, { ...savedLease, digest: selectedDigest, fence: io.fence });
      });
      await io.guard();
      return { leaseId: lease.leaseId, credential: selected, expiresAt: lease.expiresAt };
    } catch (error) { if (lease) await remove(lease.leaseId); throw error; }
  });
}
