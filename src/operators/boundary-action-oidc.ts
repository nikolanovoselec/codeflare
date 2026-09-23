import { readBoundedResponse } from '../lib/bounded-stream';

const ISSUER = 'https://token.actions.githubusercontent.com';
const KEYS_URL = `${ISSUER}/.well-known/jwks`;
const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface BoundaryActionIdentity {
  repositoryId: number; repository: string; workflowRef: string; workflowSha: string;
  runId: number; runAttempt: number; eventName: 'pull_request_target';
}

/** Fetch only GitHub's fixed signing origin; neither token headers nor request data can select a key URL. */
async function fetchBoundaryActionKeys(): Promise<unknown> {
  const response = await fetch(KEYS_URL, { signal: AbortSignal.timeout(5_000),
    headers: { accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw Error('Action signing keys unavailable');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    await readBoundedResponse(response, 64 * 1024, 'GitHub Action signing keys'))) as unknown;
}

function decode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function numeric(value: unknown, expected: number): boolean {
  return typeof value === 'string' && value === String(expected);
}

/** GitHub OIDC proves a protected job, never the initiating Codeflare human. */
export async function verifyBoundaryActionOidc(token: string, expected: {
  audience: string; repositoryId: number; repository: string; workflowPath: string;
  protectedRef: string; workflowSha: string; runId: number; runAttempt: number;
}, fetchKeys: () => Promise<unknown> = fetchBoundaryActionKeys): Promise<BoundaryActionIdentity | null> {
  if (typeof token !== 'string' || token.length > 8_192 || !TOKEN.test(token)
    || !expected.audience.startsWith('https://') || !Number.isSafeInteger(expected.repositoryId)
    || expected.repositoryId <= 0 || !Number.isSafeInteger(expected.runId) || expected.runId <= 0
    || !Number.isSafeInteger(expected.runAttempt) || expected.runAttempt <= 0
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository)
    || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(expected.workflowPath)
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(expected.protectedRef)
    || !SHA.test(expected.workflowSha)) return null;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(encodedHeader))) as unknown;
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(encodedPayload))) as unknown;
    if (!object(header) || header.alg !== 'RS256' || header.typ !== 'JWT'
      || typeof header.kid !== 'string' || header.kid.length < 1 || header.kid.length > 256
      || 'crit' in header || 'jku' in header || 'x5u' in header || !object(payload)) return null;
    const now = Math.floor(Date.now() / 1000);
    const workflowRef = `${expected.repository}/${expected.workflowPath}@${expected.protectedRef}`;
    if (payload.iss !== ISSUER || payload.aud !== expected.audience
      || typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)
      || typeof payload.nbf !== 'number' || !Number.isSafeInteger(payload.nbf)
      || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.iat > now
      || (payload.nbf as number) > now || (payload.exp as number) <= now
      || (payload.exp as number) < (payload.iat as number)
      || payload.repository !== expected.repository || !numeric(payload.repository_id, expected.repositoryId)
      || payload.event_name !== 'pull_request_target'
      || payload.workflow_ref !== workflowRef || payload.workflow_sha !== expected.workflowSha
      || !numeric(payload.run_id, expected.runId) || !numeric(payload.run_attempt, expected.runAttempt)) return null;
    const jwks = await fetchKeys();
    if (!object(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 64) return null;
    const matching = jwks.keys.filter((candidate: unknown) => object(candidate) && candidate.kid === header.kid);
    if (matching.length !== 1) return null;
    const key = matching[0] as Record<string, unknown>;
    if (key.kty !== 'RSA' || key.use !== 'sig' || key.alg !== 'RS256'
      || typeof key.n !== 'string' || typeof key.e !== 'string') return null;
    const imported = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e,
      alg: 'RS256', use: 'sig', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, decode(encodedSignature), signed)) return null;
    return { repositoryId: expected.repositoryId, repository: expected.repository,
      workflowRef, workflowSha: expected.workflowSha, runId: expected.runId,
      runAttempt: expected.runAttempt, eventName: 'pull_request_target' };
  } catch { return null; }
}
