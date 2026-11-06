import { readBoundedResponse } from '../lib/bounded-stream';
import { validateNativePiEgress, type NativePiBinding } from './native-pi-profile';
import type { NativeOperatorInference } from './inference-selection';
import { nativePiAuthFailure, type SafePiAuthFailure } from './pi-auth-failure';

/** Tagged raw transport cache. No decoded SDK events or authentication enter this record. */
export interface DispatcherNativeResponse {
  kind: 'pi-native'; status: number; headers: Record<string, string>; bytes: Uint8Array;
  authFailure?: SafePiAuthFailure;
}
export interface DispatcherNativeOperation {
  handle: string; deliveryToken?: string; profileDigest: string; attempt: number;
  phase: 'admitted' | 'in-flight' | 'committed' | 'unknown';
  wireDigest?: string; outcome?: 'completed' | 'failed'; notBefore: number;
}
export function nativeResponse(value: DispatcherNativeResponse): Response {
  return new Response([204, 205, 304].includes(value.status) ? null : value.bytes.slice(),
    { status: value.status, headers: value.headers });
}
export async function nativeDigest(value: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Inspect a bounded copy only; the original SDK request is forwarded byte-for-byte. */
export async function inspectNativeRequest(request: Request, selection: NativeOperatorInference,
  bound: NativePiBinding, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; digest: string } | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.username || url.password || url.hash || request.headers.has('upgrade')
    || ['cookie', 'cf-access-jwt-assertion', 'cf-aig-metadata', 'x-codeflare-operator-operation-id'].some(name => request.headers.has(name))) return null;
  // Registered API options survive; a provider key in its native query slot is
  // checked privately and excluded from durable request identity.
  const identityUrl = new URL(url);
  for (const [key, value] of url.searchParams) {
    if (['api-version', 'alt'].includes(key)) continue;
    if (!['key', 'api_key', 'api-key', 'access_token'].includes(key) || !bound.auth.apiKey || value !== bound.auth.apiKey) return null;
    identityUrl.searchParams.delete(key);
  }
  const credentialHeaders = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];
  if (bound.auth.apiKey) for (const name of credentialHeaders) {
    const actual = request.headers.get(name);
    if (actual !== null && !(bound.auth.headers && Object.hasOwn(bound.auth.headers, name))
      && actual !== bound.auth.apiKey && actual !== `Bearer ${bound.auth.apiKey}`) return null;
  }
  for (const [name, value] of Object.entries(bound.auth.headers ?? {})) {
    if (value === null ? request.headers.has(name) : request.headers.get(name) !== value) return null;
  }
  const bytes = await readBoundedResponse(new Response(request.clone().body), limit, 'Native request', signal);
  let inspection: Uint8Array = bytes;
  const encoding = request.headers.get('content-encoding');
  if (encoding) {
    if (encoding !== 'zstd') return null;
    // Use the same public Node zstd implementation as Pi, with bounded streaming
    // inspection and destruction on cancellation; never rewrite the outgoing bytes.
    const { createZstdDecompress } = await import('node:zlib');
    const { Readable } = await import('node:stream');
    if (typeof createZstdDecompress !== 'function') return null;
    const decoder = createZstdDecompress();
    const abort = () => { decoder.destroy(new Error('Native request inspection cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      // Node's web-stream type lacks Workerd's extra BYOB declarations;
      // Response consumes only the shared standard ReadableStream contract.
      const output = Readable.toWeb(decoder) as unknown as ReadableStream<Uint8Array>;
      decoder.end(bytes);
      inspection = await readBoundedResponse(new Response(output), limit, 'Native request inspection', signal);
    } finally { signal.removeEventListener('abort', abort); decoder.destroy(); }
  }
  const headers = new Headers(request.headers);
  headers.delete('content-encoding'); headers.delete('content-length');
  if (!await validateNativePiEgress(new Request(request.url, { method: 'POST', headers, body: inspection, signal }), selection, limit, signal)) return null;
  const identity = new TextEncoder().encode(JSON.stringify([selection, request.method, identityUrl.origin, identityUrl.pathname, identityUrl.search]));
  const joined = new Uint8Array(identity.length + bytes.length); joined.set(identity); joined.set(bytes, identity.length);
  return { bytes, digest: await nativeDigest(joined) };
}
/** Only fixed safe metadata from unsuccessful upstream responses is durable/SDK-visible. */
export async function commitNativeResponse(response: Response, selection: NativeOperatorInference,
  limit: number, signal: AbortSignal, bound: NativePiBinding): Promise<DispatcherNativeResponse> {
  const bytes = await readBoundedResponse(response, limit, 'Native response', signal);
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'x-request-id', 'request-id', 'retry-after']) {
    const value = response.headers.get(name);
    if (value !== null && value.length <= 1024 && !/[\r\n\0]/.test(value)) headers[name] = value;
  }
  const secrets = [bound.auth.apiKey, ...Object.entries(bound.auth.headers ?? {})
    .filter(([name]) => /authorization|api-key|token/i.test(name)).map(([, value]) => value),
    ...Object.entries(bound.env ?? {}).filter(([name]) => /KEY|TOKEN|SECRET/.test(name)).map(([, value]) => value)];
  for (const [name, value] of Object.entries(headers)) {
    if (secrets.some(secret => secret && value.includes(secret))) delete headers[name];
  }
  if (response.ok) return { kind: 'pi-native', status: response.status, headers, bytes };
  // A status or arbitrary SDK/provider message is not authentication evidence.
  // Only closed native error codes/types on an authentication HTTP response qualify.
  let authFailure: SafePiAuthFailure | undefined;
  if (response.status === 401 || response.status === 403) try {
    authFailure = nativePiAuthFailure(response.status,
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)), selection.provider, selection.api);
  } catch { /* Unrecognized failure remains an ordinary sanitized request error. */ }
  headers['content-type'] = 'application/json';
  return { kind: 'pi-native', status: response.status >= 300 && response.status < 400 ? 502 : response.status,
    headers, bytes: new TextEncoder().encode(JSON.stringify({ error: { message: 'Native Pi request failed', type: 'request_error' },
      ...(authFailure ? { authFailure } : {}) })), ...(authFailure ? { authFailure } : {}) };
}
