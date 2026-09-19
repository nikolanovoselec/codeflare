/**
 * Test navigation: Authenticated artifact transport, approved digest integrity and bounded response handling; no live publisher acceptance claim.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { parseOperatorManifest } from '../../operators/distribution';
import { fetchOperatorBundle, type OperatorDistributionCredentials } from '../../operators/distribution-client';

const ENDPOINT = 'https://operator.example.test/discovery';
const bundle = { schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05',
  compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js', modules: { 'index.js': { js: 'export default {};' } } };
const bytes = new TextEncoder().encode(JSON.stringify(bundle));
function credentials(): OperatorDistributionCredentials {
  const now = Math.floor(Date.now() / 1000);
  return { human: { subject: 'fixture', email: 'fixture@example.test', issuer: 'https://access.example.test',
    audiences: ['fixture'], issuedAt: now - 60, expiresAt: now + 3600 },
    accessJwt: 'fixture-human-jwt', connectionSecret: 'fixture-secret' };
}
async function approvedManifest() {
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return parseOperatorManifest(JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'fixture', name: 'Fixture',
    description: '', coreVersion: '1', intentVersion: '1', inputSchema: {}, requiredCapabilities: [],
    artifact: { path: '/bundle.json', sha256 } }), ENDPOINT);
}
const response = () => new Response(bytes, { headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('REQ-OPERATOR-035: authenticated approved artifact download', () => {
  it('returns only the pinned bundle from an endpoint requiring both credentials and manual redirects', async () => {
    const approved = await approvedManifest();
    const auth = credentials();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== approved.artifact.url || request.method !== 'GET' || request.redirect !== 'manual'
        || request.headers.get('cf-access-jwt-assertion') !== auth.accessJwt
        || request.headers.get('authorization') !== `Bearer ${auth.connectionSecret}`) return new Response('denied', { status: 403 });
      return response();
    });
    expect(await fetchOperatorBundle(ENDPOINT, approved, auth)).toEqual(bundle);
  });

  it('rejects changed bytes rather than approving the downloaded replacement', async () => {
    const approved = await approvedManifest();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...bundle, mainModule: 'replacement.js' }),
      { headers: { 'content-type': 'application/json' } }));
    await expect(fetchOperatorBundle(ENDPOINT, approved, credentials())).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(['https://other.example.test/bundle.json', 'https://operator.example.test/other.json'])
  ('rejects an artifact URL inconsistent with approval before I/O: %s', async url => {
    const approved = await approvedManifest();
    let received = 0;
    vi.stubGlobal('fetch', async () => { received++; return response(); });
    await expect(fetchOperatorBundle(ENDPOINT, { ...approved, artifact: { ...approved.artifact, url } }, credentials()))
      .rejects.toBeInstanceOf(ValidationError);
    expect(received).toBe(0);
  });

  it.each([302, 403])('rejects HTTP %s without accepting a valid-looking body', async status => {
    const approved = await approvedManifest();
    vi.stubGlobal('fetch', async () => new Response(bytes, { status,
      headers: { 'content-type': 'application/json', location: 'https://login.example.test/' } }));
    await expect(fetchOperatorBundle(ENDPOINT, approved, credentials())).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects streaming artifacts over 8 MiB and cancels the body', async () => {
    const approved = await approvedManifest();
    let cancelled = false;
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }));
    await expect(fetchOperatorBundle(ENDPOINT, approved, credentials())).rejects.toBeInstanceOf(ValidationError);
    expect(cancelled).toBe(true);
  });

  it('checks actual expiry before sending credentials', async () => {
    const approved = await approvedManifest();
    const auth = credentials();
    let received = 0;
    vi.stubGlobal('fetch', async () => { received++; return response(); });
    await expect(fetchOperatorBundle(ENDPOINT, approved, { ...auth, human: { ...auth.human, expiresAt: 1 } }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(received).toBe(0);
  });

  it('rejects a response delivered after human authority expires', async () => {
    const approved = await approvedManifest();
    vi.useFakeTimers();
    const auth = credentials();
    vi.stubGlobal('fetch', async () => { vi.setSystemTime((auth.human.expiresAt + 1) * 1000); return response(); });
    await expect(fetchOperatorBundle(ENDPOINT, approved, auth)).rejects.toBeInstanceOf(ValidationError);
  });
});
