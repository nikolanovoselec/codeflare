import { describe, it, expect } from 'vitest';
import {
  validateVaultRoute,
  maybeSynthesizeCsrfHeader,
  isServiceWorkerRegistration,
  VAULT_NOOP_SERVICE_WORKER_JS,
  injectVaultEncryptionConfig,
  injectVaultBootScript,
  filterVaultFsListing,
  inferOriginValidated,
} from '../../routes/vault';

/**
 * Unit tests for the validateVaultRoute function.
 *
 * The full handleVaultRequest path requires a complete Worker runtime
 * (authenticateRequest, getContainer, KV) which is too coupled for unit
 * testing — mirrors the terminal.test.ts decision.
 */
describe('validateVaultRoute', () => {
  function createRequest(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`https://example.com${path}`, {
      headers: new Headers(headers),
    });
  }

  describe('valid vault routes', () => {
    it('matches /api/vault/:sid/index.html as an HTTP route', () => {
      const result = validateVaultRoute(createRequest('/api/vault/abcdef12/index.html'));
      expect(result.isVaultRoute).toBe(true);
      expect(result.sessionId).toBe('abcdef12');
      expect(result.remainingPath).toBe('/index.html');
      expect(result.isWebSocket).toBe(false);
      expect(result.errorResponse).toBeUndefined();
    });

    it('matches /api/vault/:sid/.client/ws as a WebSocket upgrade', () => {
      const result = validateVaultRoute(createRequest('/api/vault/abcdef12/.client/ws', {
        Upgrade: 'websocket',
      }));
      expect(result.isVaultRoute).toBe(true);
      expect(result.sessionId).toBe('abcdef12');
      expect(result.remainingPath).toBe('/.client/ws');
      expect(result.isWebSocket).toBe(true);
    });

    it('handles case-insensitive Upgrade header', () => {
      const result = validateVaultRoute(createRequest('/api/vault/abcdef12/x', {
        Upgrade: 'WebSocket',
      }));
      expect(result.isWebSocket).toBe(true);
    });

    it('preserves the remaining path verbatim for deep paths', () => {
      const result = validateVaultRoute(createRequest('/api/vault/abcdef12/api/space/notes/foo.md'));
      expect(result.isVaultRoute).toBe(true);
      expect(result.remainingPath).toBe('/api/space/notes/foo.md');
    });
  });

  describe('non-vault and invalid routes', () => {
    it('returns isVaultRoute=false for /api/terminal', () => {
      const result = validateVaultRoute(createRequest('/api/terminal/abcdef12/ws'));
      expect(result.isVaultRoute).toBe(false);
    });

    it('returns isVaultRoute=false for /api/sessions', () => {
      const result = validateVaultRoute(createRequest('/api/sessions'));
      expect(result.isVaultRoute).toBe(false);
    });

    it('rejects bare /api/vault/:sid with no trailing path', () => {
      // No trailing `/`, so we cannot give SilverBullet a clean path.
      // The regex requires `(\/.*)$` after the sid, so this is not
      // recognised as a vault route.
      const result = validateVaultRoute(createRequest('/api/vault/abcdef12'));
      expect(result.isVaultRoute).toBe(false);
    });

    it('rejects session ids that do not match SESSION_ID_PATTERN', () => {
      const result = validateVaultRoute(createRequest('/api/vault/BAD-ID/x'));
      expect(result.isVaultRoute).toBe(true);
      expect(result.errorResponse).toBeDefined();
      expect(result.errorResponse?.status).toBe(400);
    });
  });

  describe('maybeSynthesizeCsrfHeader', () => {
    function makeRequest(method: string, headers: Record<string, string> = {}, body?: string): Request {
      const init: RequestInit = { method, headers: new Headers(headers) };
      if (body !== undefined) {
        init.body = body;
      }
      return new Request('https://codeflare.ch/api/vault/abcdef12/notes/foo.md', init);
    }

    it('returns the original request when originValidated is false', () => {
      const req = makeRequest('PUT');
      const result = maybeSynthesizeCsrfHeader(req, false);
      expect(result).toBe(req);
      expect(result.headers.has('X-Requested-With')).toBe(false);
    });

    it('returns the original request for safe methods even when originValidated', () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const req = makeRequest(method);
        const result = maybeSynthesizeCsrfHeader(req, true);
        expect(result).toBe(req);
        expect(result.headers.has('X-Requested-With')).toBe(false);
      }
    });

    it('returns the original request when X-Requested-With is already present', () => {
      const req = makeRequest('PUT', { 'X-Requested-With': 'fetch' });
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result).toBe(req);
      expect(result.headers.get('X-Requested-With')).toBe('fetch');
    });

    it('synthesises X-Requested-With on validated state-changing requests', () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const req = makeRequest(method);
        const result = maybeSynthesizeCsrfHeader(req, true);
        expect(result).not.toBe(req);
        expect(result.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
        expect(result.method).toBe(method);
      }
    });

    it('preserves the request body on cloned PUT', async () => {
      const req = makeRequest('PUT', { 'Content-Type': 'text/markdown' }, '# hello');
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result).not.toBe(req);
      const body = await result.text();
      expect(body).toBe('# hello');
    });

    it('case-insensitive method comparison', () => {
      const req = makeRequest('put');
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    });

    it('original request body is disturbed after synthesis (regression guard)', async () => {
      // Documents the runtime invariant that motivated the requestForAuth
      // hoist in handleVaultRequest: once the helper clones a PUT to add
      // X-Requested-With, the original request's body stream is consumed
      // and any subsequent `new Request(url, originalRequest)` throws
      // "This ReadableStream is disturbed". The proxy MUST forward the
      // helper's return value, not the input. The production stack trace
      // for the bug was:
      //   TypeError: This ReadableStream is disturbed (has already been
      //   read from), and cannot be used as a body.
      //     at handleVaultRequest (index.js:27933:45)
      const req = makeRequest('PUT', { 'Content-Type': 'text/markdown' }, '# hello');
      maybeSynthesizeCsrfHeader(req, true);
      // The clone owns the body now. Attempting to construct a new Request
      // around the original triggers the same TypeError prod observed.
      expect(() => new Request('https://example.com/x', req)).toThrow(/disturbed/);
    });

    it('contract: forward chain preserves PUT body end-to-end (synth -> auth-headers-only -> container.fetch)', async () => {
      // Higher-level pin than the disturbed-stream test above: this one
      // walks the EXACT data flow that handleVaultRequest uses on a save
      // PUT and asserts the body arrives at the container intact. If a
      // future refactor reintroduces the original-request-instead-of-
      // requestForAuth pattern (the production bug), the body either
      // disturbs the stream (test throws) or arrives empty (test fails
      // with text() mismatch).
      const payload = '# Note title\n\nbody bytes that must reach the container';
      const original = makeRequest(
        'PUT',
        { 'Content-Type': 'text/markdown', Cookie: 'codeflare_session=fake', Origin: 'https://codeflare.ch' },
        payload,
      );
      // Step 1: CSRF synthesis (originValidated=true mirrors the prod path).
      const requestForAuth = maybeSynthesizeCsrfHeader(original, true);
      // Step 2: simulate every header read authenticateRequest performs.
      // If a future change adds a body read here, this test will fail
      // when step 3 below attempts to re-stream the body.
      void requestForAuth.method.toUpperCase();
      void requestForAuth.headers.get('X-Requested-With');
      void requestForAuth.headers.get('Cookie');
      void requestForAuth.headers.get('cf-access-jwt-assertion');
      // Step 3: forward to the container by constructing a new Request
      // around requestForAuth (the production code path at
      // src/routes/vault.ts -> `container.fetch(new Request(vaultUrl, requestForAuth))`).
      const forwarded = new Request('https://internal.container.local/vault/notes/x.md', requestForAuth);
      const arrived = await forwarded.text();
      expect(arrived).toBe(payload);
      expect(requestForAuth.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    });
  });

  describe('isServiceWorkerRegistration', () => {
    function swRequest(
      method: string,
      headers: Record<string, string> = {},
    ): Request {
      return new Request('https://codeflare.ch/api/vault/abcdef12/service_worker.js', {
        method,
        headers: new Headers(headers),
      });
    }

    it('returns true for GET /service_worker.js with service-worker:script header and no Cookie', () => {
      // The `service-worker: script` header is browser-set on SW registration
      // fetches and is a Fetch-spec forbidden header name (page JS cannot
      // set it via `fetch()`), so it is a safe selector for the no-cookie
      // auth bypass. Cookie absence is required as defence-in-depth.
      expect(isServiceWorkerRegistration(
        swRequest('GET', { 'service-worker': 'script' }),
        '/service_worker.js',
      )).toBe(true);
    });

    it('returns false without the service-worker header (regular asset fetch)', () => {
      expect(isServiceWorkerRegistration(
        swRequest('GET'),
        '/service_worker.js',
      )).toBe(false);
    });

    it('returns false when Cookie is present (defence-in-depth: let normal auth handle authenticated SW reg)', () => {
      // If the browser ever stops stripping cookies on SW registration,
      // or some other path delivers an authenticated SW fetch, we want
      // the normal auth chain to run (returning the real upstream SW or
      // 401) rather than serving the static no-op shortcut.
      expect(isServiceWorkerRegistration(
        swRequest('GET', { 'service-worker': 'script', Cookie: 'codeflare_session=eyJ...' }),
        '/service_worker.js',
      )).toBe(false);
    });

    it('returns false for non-GET methods even with the header', () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect(isServiceWorkerRegistration(
          swRequest(method, { 'service-worker': 'script' }),
          '/service_worker.js',
        )).toBe(false);
      }
    });

    it('returns false for paths other than exactly /service_worker.js', () => {
      const req = swRequest('GET', { 'service-worker': 'script' });
      expect(isServiceWorkerRegistration(req, '/notes/x.md')).toBe(false);
      expect(isServiceWorkerRegistration(req, '/.client/service_worker.js')).toBe(false);
      expect(isServiceWorkerRegistration(req, '/service_worker.js.map')).toBe(false);
      expect(isServiceWorkerRegistration(req, undefined)).toBe(false);
    });

    it('VAULT_NOOP_SERVICE_WORKER_JS contains the minimum SW handshake handlers', () => {
      // skipWaiting + clients.claim is the standard minimal lifecycle that
      // makes the SW take control immediately. Without these, the browser
      // registers the SW but it stays "waiting" forever.
      expect(VAULT_NOOP_SERVICE_WORKER_JS).toContain('skipWaiting');
      expect(VAULT_NOOP_SERVICE_WORKER_JS).toContain('clients.claim');
      expect(VAULT_NOOP_SERVICE_WORKER_JS).toContain('install');
      expect(VAULT_NOOP_SERVICE_WORKER_JS).toContain('activate');
    });
  });

  describe('injectVaultEncryptionConfig (REQ-VAULT-008 AC2)', () => {
    it('adds vaultEncryptionKey and enableClientEncryption=true to a JSON BootConfig body', () => {
      const original = JSON.stringify({ spaceFolderPath: '/Vault', readOnly: false });
      const result = injectVaultEncryptionConfig(original, 'AAAA-base64-key-AAAA');
      const parsed = JSON.parse(result);
      expect(parsed.vaultEncryptionKey).toBe('AAAA-base64-key-AAAA');
      expect(parsed.enableClientEncryption).toBe(true);
      expect(parsed.spaceFolderPath).toBe('/Vault');
      expect(parsed.readOnly).toBe(false);
    });

    it('does not mutate the input string and returns valid JSON', () => {
      const original = '{"a":1}';
      const out = injectVaultEncryptionConfig(original, 'k');
      expect(original).toBe('{"a":1}');
      expect(() => JSON.parse(out)).not.toThrow();
    });

    it('overrides any pre-existing vaultEncryptionKey from upstream (Worker is canonical)', () => {
      const original = JSON.stringify({ vaultEncryptionKey: 'stale-or-empty', enableClientEncryption: false });
      const parsed = JSON.parse(injectVaultEncryptionConfig(original, 'fresh-key'));
      expect(parsed.vaultEncryptionKey).toBe('fresh-key');
      expect(parsed.enableClientEncryption).toBe(true);
    });

    it('throws if input body is not valid JSON (fail loud, do not silently break SB boot)', () => {
      expect(() => injectVaultEncryptionConfig('not json', 'k')).toThrow();
    });

    it('throws if key is empty (vaultEncryptionKey must be a non-empty string)', () => {
      expect(() => injectVaultEncryptionConfig('{}', '')).toThrow();
    });
  });

  describe('injectVaultBootScript (REQ-VAULT-008 AC3+4+5)', () => {
    it('injects a <script> with vaultEncryptionKey, syncConcurrency, and lazyPathPrefixes before </head>', () => {
      const html = '<!DOCTYPE html><html><head><title>SB</title></head><body></body></html>';
      const out = injectVaultBootScript(html, {
        vaultEncryptionKey: 'k1',
        syncConcurrency: 15,
        lazyPathPrefixes: ['Raw/Pasted/'],
      });
      expect(out).toContain('window.__codeflareVaultBoot');
      expect(out).toContain('"k1"');
      expect(out).toContain('"syncConcurrency":15');
      expect(out).toContain('"Raw/Pasted/"');
      expect(out.indexOf('window.__codeflareVaultBoot')).toBeLessThan(out.indexOf('</head>'));
    });

    it('escapes </script> in injected payload to prevent HTML break-out (XSS guard)', () => {
      const html = '<html><head></head><body></body></html>';
      const out = injectVaultBootScript(html, {
        vaultEncryptionKey: 'safe-key',
        syncConcurrency: 15,
        lazyPathPrefixes: ['</script><script>alert(1)</script>'],
      });
      expect(out).not.toContain('</script><script>alert(1)');
      expect(out).toContain('<\\/script>');
    });

    it('is idempotent — re-injecting on already-patched HTML produces single block', () => {
      const html = '<html><head></head><body></body></html>';
      const once = injectVaultBootScript(html, {
        vaultEncryptionKey: 'k',
        syncConcurrency: 15,
        lazyPathPrefixes: [],
      });
      const twice = injectVaultBootScript(once, {
        vaultEncryptionKey: 'k',
        syncConcurrency: 15,
        lazyPathPrefixes: [],
      });
      const occurrences = (twice.match(/window\.__codeflareVaultBoot/g) || []).length;
      expect(occurrences).toBe(1);
    });

    it('returns input unchanged when no </head> tag exists (fail-safe, not error)', () => {
      const html = '<html><body>no head</body></html>';
      const out = injectVaultBootScript(html, {
        vaultEncryptionKey: 'k',
        syncConcurrency: 15,
        lazyPathPrefixes: [],
      });
      expect(out).toBe(html);
    });

    it('throws if vaultEncryptionKey is empty', () => {
      const html = '<html><head></head><body></body></html>';
      expect(() => injectVaultBootScript(html, {
        vaultEncryptionKey: '',
        syncConcurrency: 15,
        lazyPathPrefixes: [],
      })).toThrow();
    });
  });

  describe('filterVaultFsListing (REQ-VAULT-008 AC6)', () => {
    it('removes entries with names starting with graphify-out/', () => {
      const body = JSON.stringify([
        { name: 'Notes/foo.md', size: 10 },
        { name: 'graphify-out/graph.json', size: 5000 },
        { name: 'graphify-out/vault-graph.html', size: 200000 },
        { name: 'Raw/Sessions/x.md', size: 100 },
      ]);
      const filtered = JSON.parse(filterVaultFsListing(body));
      expect(filtered).toHaveLength(2);
      expect(filtered.map((e: { name: string }) => e.name)).toEqual([
        'Notes/foo.md',
        'Raw/Sessions/x.md',
      ]);
    });

    it('returns input unchanged if body is not a JSON array', () => {
      const invalid = '{"not":"array"}';
      expect(filterVaultFsListing(invalid)).toBe(invalid);
    });

    it('returns input unchanged on parse error', () => {
      const garbage = 'not json at all';
      expect(filterVaultFsListing(garbage)).toBe(garbage);
    });

    it('handles entries with no graphify-out prefix as no-op', () => {
      const body = JSON.stringify([{ name: 'a.md' }, { name: 'b.md' }]);
      const out = JSON.parse(filterVaultFsListing(body));
      expect(out).toHaveLength(2);
    });

    it('only filters top-level graphify-out/ entries; substring or nested matches are kept', () => {
      const body = JSON.stringify([
        { name: 'graphify-out/x.json' },               // top-level: filtered
        { name: 'Notes/graphify-out-notes.md' },       // substring: kept
        { name: 'Notes/sub/file.md' },                 // unrelated: kept
        { name: 'Raw/graphify-out/derived.json' },     // nested: kept (filter is top-level only)
      ]);
      const out = JSON.parse(filterVaultFsListing(body));
      expect(out.map((e: { name: string }) => e.name)).toEqual([
        'Notes/graphify-out-notes.md',
        'Notes/sub/file.md',
        'Raw/graphify-out/derived.json',
      ]);
    });
  });

  describe('inferOriginValidated (REQ-VAULT-009 AC1+2)', () => {
    function req(method: string, headers: Record<string, string> = {}): Request {
      return new Request('https://codeflare.ch/api/vault/abcdef12/Inbox/file.pdf', {
        method,
        headers: new Headers(headers),
      });
    }

    it('AC2: returns false on PUT with Origin set (caller still allowlist-checks)', () => {
      expect(inferOriginValidated(req('PUT', { Origin: 'https://codeflare.ch' }))).toBe(false);
    });

    it('AC1: returns true on PUT with no Origin (same-origin fallback)', () => {
      expect(inferOriginValidated(req('PUT'))).toBe(true);
    });

    it('AC1: returns true on POST with no Origin', () => {
      expect(inferOriginValidated(req('POST'))).toBe(true);
    });

    it('AC1: returns true on PATCH with no Origin', () => {
      expect(inferOriginValidated(req('PATCH'))).toBe(true);
    });

    it('AC1: returns true on DELETE with no Origin', () => {
      expect(inferOriginValidated(req('DELETE'))).toBe(true);
    });

    it('AC4: returns false on GET with no Origin (safe methods do not enter fallback)', () => {
      expect(inferOriginValidated(req('GET'))).toBe(false);
    });

    it('AC4: returns false on HEAD with no Origin', () => {
      expect(inferOriginValidated(req('HEAD'))).toBe(false);
    });

    it('AC4: returns false on OPTIONS with no Origin', () => {
      expect(inferOriginValidated(req('OPTIONS'))).toBe(false);
    });

    it('AC1: case-insensitive method comparison', () => {
      expect(inferOriginValidated(req('put'))).toBe(true);
      expect(inferOriginValidated(req('Post'))).toBe(true);
    });
  });

  describe('status sub-route', () => {
    it('matches /api/vault/:sid/status (handled by Hono, not the proxy)', () => {
      // We still report isVaultRoute=true — the caller in src/index.ts
      // is responsible for letting `/status` fall through to Hono.
      // This test guards the contract that validateVaultRoute does not
      // hide /status from the caller.
      const result = validateVaultRoute(createRequest('/api/vault/abcdef12/status'));
      expect(result.isVaultRoute).toBe(true);
      expect(result.remainingPath).toBe('/status');
    });
  });
});
