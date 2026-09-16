import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { ValidationError } from '../lib/error-types';
import { parseOperatorManifest, parseOperatorBundle, validateOperatorEndpoint, type OperatorManifest, type OperatorBundle } from './distribution';

/** Parent-owned, already-verified human context; never expose to operator code. */
export interface OperatorDistributionCredentials {
  readonly human: VerifiedHumanAccessClaims;
  readonly accessJwt: string;
  readonly connectionSecret: string;
}

/**
 * REQ-OPERATOR-010: Download only the parent-approved artifact using explicit
 * human/connection authentication. Re-resolve its canonical path on the registered
 * origin before sending credentials; reject inconsistent stored URL metadata.
 * Bound bytes before buffering, verify the approved digest before parsing, never
 * execute modules, and never replace approval with newly advertised metadata.
 */
export async function fetchOperatorBundle(
  endpoint: string,
  approved: OperatorManifest,
  credentials: OperatorDistributionCredentials,
): Promise<OperatorBundle> {
  const { url, ...artifact } = approved.artifact;
  const manifest = parseOperatorManifest(JSON.stringify({ ...approved, artifact }), endpoint);
  if (manifest.artifact.url !== url) throw new ValidationError('Operator artifact URL does not match approval');
  return await fetchValidatedJson(new URL(url), credentials, 8 * 1024 * 1024,
    bytes => parseOperatorBundle(bytes, manifest.artifact.sha256));
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const REQUEST_DEADLINE_MS = 15_000;

/**
 * REQ-OPERATOR-010: Fetch discovery using explicit endpoint authentication, not
 * automatic JWT stamping. The parent must cryptographically verify the supplied
 * human JWT and resolve enterprise/user eligibility before calling. This function
 * never renews authority or substitutes a service credential. Redirects, non-JSON
 * responses, expired authority and over-limit bodies fail closed with safe errors.
 * No retries, persistence or executable content. No live endpoint Access claim is
 * implied by the transport fixture. Example: fetchOperatorManifest(url, context).
 */
export async function fetchOperatorManifest(
  endpoint: string,
  credentials: OperatorDistributionCredentials,
): Promise<OperatorManifest> {
  const url = validateOperatorEndpoint(endpoint);
  return await fetchValidatedJson(url, credentials, MAX_MANIFEST_BYTES, bytes => parseOperatorManifest(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes), url.href,
  ));
}

/** Shared bounded authenticated transport; caller-specific validation stays within its deadline. */
async function fetchValidatedJson<T>(
  url: URL,
  credentials: OperatorDistributionCredentials,
  maxBytes: number,
  validate: (bytes: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const expiresAt = credentials.human.expiresAt * 1000;
  const remaining = expiresAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0
    || !credentials.accessJwt.trim() || !credentials.connectionSecret.trim()) {
    throw new ValidationError('Valid human authority and connection secret are required');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, REQUEST_DEADLINE_MS));
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    response = await fetch(new Request(url.href, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: {
        accept: 'application/json',
        'cf-access-jwt-assertion': credentials.accessJwt,
        authorization: `Bearer ${credentials.connectionSecret}`,
      },
    }));
    if (response.status !== 200 || response.redirected
      || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
      || !response.body) throw new Error('Invalid discovery response');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength)
      || Number(declaredLength) > maxBytes)) throw new Error('Invalid response length');

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('Discovery response too large');
      chunks.push(chunk.value);
    }
    if (controller.signal.aborted || Date.now() >= expiresAt) throw new Error('Discovery authority expired');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = await validate(bytes);
    if (controller.signal.aborted || Date.now() >= expiresAt) throw new Error('Distribution authority expired');
    completed = true;
    return result;
  } catch {
    // Never expose endpoint diagnostics, source bytes or credential-bearing errors.
    throw new ValidationError('Operator distribution failed or authority expired');
  } finally {
    clearTimeout(timer);
    if (!completed) {
      controller.abort();
      // Cancellation must not extend the transport deadline on a stalled peer.
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
    }
    reader?.releaseLock();
  }
}
