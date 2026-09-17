/**
 * Test navigation: Discovery transport with controlled responses: explicit credentials, denial, redirects, limits and human expiry.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { fetchOperatorManifest, type OperatorDistributionCredentials } from '../../operators/distribution-client';

const ENDPOINT = 'https://operator.example.test/discovery';
const manifest = {
  schemaVersion: 1, interfaceVersion: 1, id: 'fixture', name: 'Fixture',
  description: 'Distribution transport acceptance fixture', coreVersion: '1', intentVersion: '1',
  inputSchema: { type: 'object' }, requiredCapabilities: ['session'],
  artifact: { path: '/bundle.json', sha256: 'a'.repeat(64) },
};
function credentials(): OperatorDistributionCredentials {
  const now = Math.floor(Date.now() / 1000);
  return {
    human: { subject: 'human-fixture', email: 'human@example.test', issuer: 'https://access.example.test',
      audiences: ['fixture-audience'], issuedAt: now - 60, expiresAt: now + 3600 },
    accessJwt: 'signed-human-credential-fixture', connectionSecret: 'connection-secret-fixture',
  };
}
const jsonResponse = () => new Response(JSON.stringify(manifest), {
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('REQ-OPERATOR-034: authenticated bounded discovery transport', () => {
  it('obtains metadata from a fixture requiring both human assertion and connection secret without redirect following', async () => {
    const auth = credentials();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== ENDPOINT || request.method !== 'GET' || request.redirect !== 'manual'
        || request.headers.get('cf-access-jwt-assertion') !== auth.accessJwt
        || request.headers.get('authorization') !== `Bearer ${auth.connectionSecret}`) {
        return new Response('unauthorized', { status: 401 });
      }
      return jsonResponse();
    });
    expect(await fetchOperatorManifest(ENDPOINT, auth)).toEqual({
      ...manifest, artifact: { ...manifest.artifact, url: 'https://operator.example.test/bundle.json' },
    });
  });

  it.each(['http://operator.example.test/', 'https://user:password@operator.example.test/',
    'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://operator.example.test/#fragment'])
  ('rejects unsafe endpoint %s before protected I/O', async endpoint => {
    let received = 0;
    vi.stubGlobal('fetch', async () => { received++; return jsonResponse(); });
    await expect(fetchOperatorManifest(endpoint, credentials())).rejects.toBeInstanceOf(ValidationError);
    expect(received).toBe(0);
  });

  it('rejects expired human authority before disclosing either credential', async () => {
    const auth = credentials();
    let received = 0;
    vi.stubGlobal('fetch', async () => { received++; return jsonResponse(); });
    await expect(fetchOperatorManifest(ENDPOINT, { ...auth,
      human: { ...auth.human, expiresAt: Math.floor(Date.now() / 1000) },
    })).rejects.toBeInstanceOf(ValidationError);
    expect(received).toBe(0);
  });

  it.each(['accessJwt', 'connectionSecret'] as const)('rejects missing %s without fallback or I/O', async field => {
    let received = 0;
    vi.stubGlobal('fetch', async () => { received++; return jsonResponse(); });
    await expect(fetchOperatorManifest(ENDPOINT, { ...credentials(), [field]: '' }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(received).toBe(0);
  });

  it.each([301, 302, 303, 307, 308, 401, 403, 500])('rejects HTTP %s instead of accepting its JSON body', async status => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(manifest), {
      status, headers: { 'content-type': 'application/json', location: 'https://login.example.test/' },
    }));
    await expect(fetchOperatorManifest(ENDPOINT, credentials())).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(['text/html', 'text/plain', ''])('rejects a login or incompatible content type %s', async contentType => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(manifest), {
      headers: contentType ? { 'content-type': contentType } : {},
    }));
    await expect(fetchOperatorManifest(ENDPOINT, credentials())).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects streaming bodies above 64 KiB even without Content-Length and cancels the stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65537))); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal('fetch', async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    await expect(fetchOperatorManifest(ENDPOINT, credentials())).rejects.toBeInstanceOf(ValidationError);
    expect(cancelled).toBe(true);
  });

  it('rejects an oversized declared length even when the delivered body is small', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(manifest), {
      headers: { 'content-type': 'application/json', 'content-length': '65537' },
    }));
    await expect(fetchOperatorManifest(ENDPOINT, credentials())).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not accept a response after actual human authority expires', async () => {
    vi.useFakeTimers();
    const auth = credentials();
    vi.stubGlobal('fetch', async () => {
      vi.setSystemTime((auth.human.expiresAt + 1) * 1000);
      return jsonResponse();
    });
    await expect(fetchOperatorManifest(ENDPOINT, auth)).rejects.toBeInstanceOf(ValidationError);
  });

  it('aborts a stalled request within the 15-second transport deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const assertion = expect(fetchOperatorManifest(ENDPOINT, credentials())).rejects.toBeInstanceOf(ValidationError);
    await vi.advanceTimersByTimeAsync(15001);
    await assertion;
  });

  it('does not reflect credentials or network diagnostics in public errors', async () => {
    const auth = credentials();
    vi.stubGlobal('fetch', async () => { throw new Error(`${auth.accessJwt} ${auth.connectionSecret}`); });
    const result = await fetchOperatorManifest(ENDPOINT, auth).catch(error => error);
    expect(result).toBeInstanceOf(ValidationError);
    expect(result.message).not.toContain(auth.accessJwt);
    expect(result.message).not.toContain(auth.connectionSecret);
  });
});
