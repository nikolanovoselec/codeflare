import { describe, it, expect, vi } from 'vitest';
import {
  validateVaultRoute,
  maybeSynthesizeCsrfHeader,
  maybeIssueCsrfCookie,
  isServiceWorkerRegistration,
  isServiceWorkerContextFetch,
  VAULT_NATIVE_SERVICE_WORKER_JS,
  VAULT_NATIVE_SW_VERBATIM,
  VAULT_NATIVE_SW_SHA256,
  graftVaultKeyRecovery,
  VAULT_BOOTSTRAP_COOKIE,
  injectVaultEncryptionConfig,
  hasVaultBootstrapCookie,
  filterVaultFsListing,
  inferOriginValidated,
  isBootstrapHopRequest,
  rewriteVaultBaseHref,
  rewriteVaultHtmlResponse,
} from '../../routes/vault';

/**
 * Unit tests for the validateVaultRoute function.
 *
 * The full handleVaultRequest path requires a complete Worker runtime
 * (authenticateRequest, getContainer, KV) which is too coupled for unit
 * testing — mirrors the terminal.test.ts decision.
 */
// REQ-VAULT-005 AC3 (validateVaultRoute is the boundary identifier paired with handleVaultRequest for the shared auth chain; per Verification field: "validateVaultRoute boundary cases")
describe('validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)', () => {
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

  // REQ-VAULT-009 AC1, AC2 (missing-Origin fallback + allowlist preserved), AC3 (body preservation), AC4 (GET/HEAD unchanged)
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
      // src/routes/vault/index.ts -> `container.fetch(new Request(vaultUrl, requestForAuth))`).
      const forwarded = new Request('https://internal.container.local/vault/notes/x.md', requestForAuth);
      const arrived = await forwarded.text();
      expect(arrived).toBe(payload);
      expect(requestForAuth.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    });

    // CF-019: independent double-submit token echo on origin-validated writes.
    it('echoes the CSRF cookie into the X-Vault-Csrf header on validated writes', () => {
      const req = makeRequest('PUT', { Cookie: 'codeflare_vault_csrf=tok-xyz' });
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result).not.toBe(req);
      expect(result.headers.get('X-Vault-Csrf')).toBe('tok-xyz');
      // X-Requested-With still synthesised alongside (defense-in-depth).
      expect(result.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    });

    it('does not echo the CSRF header when no cookie is present', () => {
      const req = makeRequest('PUT');
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result.headers.has('X-Vault-Csrf')).toBe(false);
    });

    it('does not overwrite an X-Vault-Csrf header the client already set', () => {
      const req = makeRequest('PUT', {
        Cookie: 'codeflare_vault_csrf=cookie-tok',
        'X-Vault-Csrf': 'client-tok',
      });
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result.headers.get('X-Vault-Csrf')).toBe('client-tok');
    });

    it('does not echo the CSRF cookie when originValidated is false', () => {
      const req = makeRequest('PUT', { Cookie: 'codeflare_vault_csrf=tok' });
      const result = maybeSynthesizeCsrfHeader(req, false);
      expect(result).toBe(req);
      expect(result.headers.has('X-Vault-Csrf')).toBe(false);
    });

    it('does not echo the CSRF cookie on safe methods', () => {
      const req = makeRequest('GET', { Cookie: 'codeflare_vault_csrf=tok' });
      const result = maybeSynthesizeCsrfHeader(req, true);
      expect(result).toBe(req);
      expect(result.headers.has('X-Vault-Csrf')).toBe(false);
    });
  });

  // CF-019: GET vault responses seed the double-submit CSRF cookie.
  describe('maybeIssueCsrfCookie / CF-019 (GET vault responses seed the double-submit token cookie)', () => {
    function getReq(headers: Record<string, string> = {}): Request {
      return new Request('https://codeflare.ch/api/vault/abcdef12/', {
        method: 'GET',
        headers: new Headers(headers),
      });
    }

    it('sets a Set-Cookie with the CSRF token when none is present', () => {
      const headers = new Headers();
      maybeIssueCsrfCookie(getReq(), headers, 'abcdef12');
      const setCookie = headers.get('Set-Cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('codeflare_vault_csrf=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('Path=/api/vault/abcdef12/');
    });

    it('issues a non-empty token value', () => {
      const headers = new Headers();
      maybeIssueCsrfCookie(getReq(), headers, 'abcdef12');
      const setCookie = headers.get('Set-Cookie') ?? '';
      const value = setCookie.split(';')[0].split('=')[1];
      expect(value.length).toBeGreaterThan(0);
    });

    it('does not re-issue when the request already carries the cookie', () => {
      const headers = new Headers();
      maybeIssueCsrfCookie(getReq({ Cookie: 'codeflare_vault_csrf=existing' }), headers, 'abcdef12');
      expect(headers.get('Set-Cookie')).toBeNull();
    });

    it('does not issue for an invalid session id', () => {
      const headers = new Headers();
      maybeIssueCsrfCookie(getReq(), headers, 'BAD-ID');
      expect(headers.get('Set-Cookie')).toBeNull();
    });
  });

  // REQ-VAULT-017 AC1-AC3 (browser-initiated SW registration short-circuit: method+path+Service-Worker header selector)
  describe('isServiceWorkerRegistration / REQ-VAULT-017 (native SW short-circuit selector)', () => {
    function swRequest(
      method: string,
      headers: Record<string, string> = {},
    ): Request {
      return new Request('https://codeflare.ch/api/vault/abcdef12/service_worker.js', {
        method,
        headers: new Headers(headers),
      });
    }

    it('returns true for GET /service_worker.js with service-worker:script header', () => {
      // The `service-worker: script` header is browser-set on SW registration
      // fetches and is a Fetch-spec forbidden header name (page JS cannot
      // set it via `fetch()`), so it is a safe selector for the auth bypass.
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

    it('returns true even when Cookie is present (Samsung Internet and other Chromium forks may send cookies on SW reg)', () => {
      // Cookie header is NOT checked. Samsung Internet and other Chromium
      // forks may not strip cookies on SW registration fetches. If we
      // reject the request, it falls through to the proxy which serves
      // SB's real 97KB SW whose cache.addAll() install fails and hangs
      // navigator.serviceWorker.ready forever.
      expect(isServiceWorkerRegistration(
        swRequest('GET', { 'service-worker': 'script', Cookie: 'codeflare_session=eyJ...' }),
        '/service_worker.js',
      )).toBe(true);
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
  });

  describe('VAULT_NATIVE_SERVICE_WORKER_JS / REQ-VAULT-017 AC1 (native SW served, AD69)', () => {
    async function sha256Hex(input: string): Promise<string> {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    it('REQ-VAULT-024 AC5 / T1: serves the native SilverBullet worker with the key-recovery graft', () => {
      // The native worker carries SB's sync engine + offline precache, which
      // is what restores the persistent sb_files_* store (#445); asserting the
      // served bytes contain `precache`/`addAll` fails the moment serving is
      // swapped for anything without the sync engine.
      expect(VAULT_NATIVE_SERVICE_WORKER_JS.length).toBeGreaterThan(50_000);
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('precache');
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('addAll');
      // Cold-boot encryption rides the native worker's own key handlers.
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('set-encryption-key');
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('get-encryption-key');
      // REQ-VAULT-024 AC5: the served worker carries the codeflare recovery
      // graft (the verbatim upstream worker does NOT) - without it the key is
      // lost between the bootstrap-hop and shell boot and SB bounces to .auth.
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('.vault-key');
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('Recovered encryption key from codeflare');
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).not.toBe(VAULT_NATIVE_SW_VERBATIM);
      // The recovery must be wired at BOTH key-empty checkpoints: the helper is
      // defined, the config auth-gate calls it before posting auth-error (the
      // path that actually fires the .auth bounce), and get-encryption-key calls
      // it before replying. The verbatim worker has none of these.
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain(';var v;async function __cfRecover()');
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain(
        'if(t.enableClientEncryption&&!v){await __cfRecover()}if(t.enableClientEncryption&&!v){console.error("Supposed',
      );
      expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('case"get-encryption-key":{if(v===void 0)await __cfRecover()');
      expect(VAULT_NATIVE_SW_VERBATIM).not.toContain('__cfRecover');
    });

    it('T9: the drift guard hashes the VERBATIM upstream worker', async () => {
      // The guard pins the upstream SB 2.10.0 bytes (pre-graft); a SilverBullet
      // version bump that changes the worker must be a deliberate re-vendor
      // (update the constant AND the hash), never a silent drift. The verbatim
      // bytes are what is hashed - the graft is applied deterministically on top.
      expect(await sha256Hex(VAULT_NATIVE_SW_VERBATIM)).toBe(VAULT_NATIVE_SW_SHA256);
    });

    it('T10: graftVaultKeyRecovery throws if the upstream get-encryption-key anchor moves', () => {
      // The graft is anchored on an exact minified substring. If SB changes it,
      // the transform must fail loud (forcing a re-vendor + re-verify) rather
      // than silently serve an un-grafted worker that re-breaks REQ-VAULT-024 AC4/AC5.
      expect(() => graftVaultKeyRecovery('definitely not the silverbullet worker')).toThrow();
      // It is idempotent-safe on the real verbatim worker (produces the served bytes).
      expect(graftVaultKeyRecovery(VAULT_NATIVE_SW_VERBATIM)).toBe(VAULT_NATIVE_SERVICE_WORKER_JS);
    });
  });

  describe('isServiceWorkerContextFetch / REQ-VAULT-017 AC6/AC7 (SW precache vs navigation)', () => {
    function req(headers: Record<string, string> = {}): Request {
      return new Request('https://codeflare.ch/api/vault/abcdef12/', {
        headers: new Headers(headers),
      });
    }

    it('T3: false for top-level navigations, true for SW-context fetches, false when absent', () => {
      // navigate => a real document load; the bootstrap-hop 302 must still fire.
      expect(isServiceWorkerContextFetch(req({ 'Sec-Fetch-Mode': 'navigate' }))).toBe(false);
      // no-cors / same-origin => the native SW's cache.addAll precache fetch;
      // the 302 must be suppressed or the SW install hangs.
      expect(isServiceWorkerContextFetch(req({ 'Sec-Fetch-Mode': 'no-cors' }))).toBe(true);
      expect(isServiceWorkerContextFetch(req({ 'Sec-Fetch-Mode': 'same-origin' }))).toBe(true);
      // Absent header (older browsers, exotic WebViews, non-browser clients):
      // fail-safe FALSE so a real navigation is never served the raw shell
      // without the hop. This polarity is the bug this test guards.
      expect(isServiceWorkerContextFetch(req())).toBe(false);
    });
  });

  describe('injectVaultEncryptionConfig (REQ-VAULT-008 AC3)', () => {
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

  describe('REQ-VAULT-024 AC7: only GET enters bootstrap completion', () => {
    it('accepts only a non-WebSocket GET for the exact bootstrap path', () => {
      expect(isBootstrapHopRequest('/.codeflare-bootstrap', false, 'GET')).toBe(true);
      expect(isBootstrapHopRequest('/.codeflare-bootstrap', false, 'POST')).toBe(false);
      expect(isBootstrapHopRequest('/.codeflare-bootstrap', true, 'GET')).toBe(false);
      expect(isBootstrapHopRequest('/other', false, 'GET')).toBe(false);
    });
  });

  // REQ-VAULT-024 AC3 (codeflare_vault_bootstrap cookie selector: subsequent shell-path requests bypass the hop via the cookie)
  describe('hasVaultBootstrapCookie (REQ-VAULT-024 AC3)', () => {
    function reqWithCookie(value: string | undefined): Request {
      const headers = new Headers();
      if (value !== undefined) headers.set('Cookie', value);
      return new Request('https://codeflare.ch/api/vault/abcdef12/', { headers });
    }

    it('returns true when the cookie is present with value 1', () => {
      expect(hasVaultBootstrapCookie(reqWithCookie(`${VAULT_BOOTSTRAP_COOKIE}=1`))).toBe(true);
    });

    it('returns true when the cookie is one of several', () => {
      expect(
        hasVaultBootstrapCookie(reqWithCookie(`session=abc; ${VAULT_BOOTSTRAP_COOKIE}=1; foo=bar`)),
      ).toBe(true);
    });

    it('returns false when the cookie is missing', () => {
      expect(hasVaultBootstrapCookie(reqWithCookie(undefined))).toBe(false);
      expect(hasVaultBootstrapCookie(reqWithCookie('session=abc'))).toBe(false);
    });

    it('returns false when the cookie value is not exactly "1"', () => {
      expect(hasVaultBootstrapCookie(reqWithCookie(`${VAULT_BOOTSTRAP_COOKIE}=0`))).toBe(false);
      expect(hasVaultBootstrapCookie(reqWithCookie(`${VAULT_BOOTSTRAP_COOKIE}=`))).toBe(false);
      expect(hasVaultBootstrapCookie(reqWithCookie(`${VAULT_BOOTSTRAP_COOKIE}=true`))).toBe(false);
    });

    it('handles cookies with whitespace around delimiters', () => {
      expect(hasVaultBootstrapCookie(reqWithCookie(`  ${VAULT_BOOTSTRAP_COOKIE}=1  `))).toBe(true);
    });
  });

  describe('filterVaultFsListing (REQ-VAULT-015 AC1)', () => {
    it('removes entries that are derived graph artifacts', () => {
      const body = JSON.stringify([
        { name: 'Notes/foo.md', size: 10 },
        { name: 'graphify-out/graph.json', size: 5000 },
        { name: 'graphify-out/vault-graph.html', size: 200000 },
        { name: 'Raw/Graphs/vault-graph.html', size: 200000 },
        { name: 'Raw/Graphs/Vault Graph.md', size: 1000 },
        { name: 'Raw/Sessions/x.md', size: 100 },
      ]);
      const filtered = JSON.parse(filterVaultFsListing(body));
      // Raw/Sessions/ (machine-owned session-capture memory) is now filtered so
      // it never enters the SB client sync/index; the Raw/Graphs .md index page
      // and human notes stay visible.
      expect(filtered).toHaveLength(2);
      expect(filtered.map((e: { name: string }) => e.name)).toEqual([
        'Notes/foo.md',
        'Raw/Graphs/Vault Graph.md',
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

    it('keeps graph substrings and non-HTML Raw/Graphs pages visible', () => {
      const body = JSON.stringify([
        { name: 'graphify-out/x.json' },               // top-level: filtered
        { name: 'Raw/Graphs/vault-callflow.HTML' },    // generated HTML: filtered
        { name: 'Notes/graphify-out-notes.md' },       // substring: kept
        { name: 'Notes/sub/file.md' },                 // unrelated: kept
        { name: 'Raw/graphify-out/derived.json' },     // nested: kept
        { name: 'Raw/Graphs/Vault Graph.md' },         // markdown index page: kept
      ]);
      const out = JSON.parse(filterVaultFsListing(body));
      expect(out.map((e: { name: string }) => e.name)).toEqual([
        'Notes/graphify-out-notes.md',
        'Notes/sub/file.md',
        'Raw/graphify-out/derived.json',
        'Raw/Graphs/Vault Graph.md',
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

  describe('rewriteVaultBaseHref / rewriteVaultHtmlResponse (REQ-VAULT-013 AC1-AC4)', () => {
    const SID = 'abc123';

    it('AC1: rewrites bare base-href to session-prefixed path on HTML', () => {
      const html = '<html><head><base href="/" /></head><body>hi</body></html>';
      const { rewritten, wasNoOp } = rewriteVaultBaseHref(html, SID);
      expect(rewritten).toContain(`<base href="/api/vault/${SID}/" />`);
      expect(rewritten).not.toContain('<base href="/" />');
      expect(wasNoOp).toBe(false);
    });

    it('AC1: rewrites case-insensitive and self-closing variants', () => {
      const variants = [
        '<BASE HREF="/" />',
        '<base  href="/"  >',
        '<Base href="/" >',
      ];
      for (const tag of variants) {
        const { rewritten, wasNoOp } = rewriteVaultBaseHref(`<html>${tag}</html>`, SID);
        expect(wasNoOp).toBe(false);
        expect(rewritten).toContain(`/api/vault/${SID}/`);
      }
    });

    it('AC2: non-HTML content passes through rewriteVaultBaseHref unchanged', () => {
      const jsBody = 'console.log("hello"); var x = "</base>";';
      const { rewritten, wasNoOp } = rewriteVaultBaseHref(jsBody, SID);
      expect(rewritten).toBe(jsBody);
      expect(wasNoOp).toBe(true);
    });

    it('AC3: drops content-length and content-encoding headers after rewrite', async () => {
      const html = '<html><head><base href="/" /></head></html>';
      const upstream = new Response(html, {
        headers: {
          'content-type': 'text/html',
          'content-length': '999',
          'content-encoding': 'gzip',
          'x-custom': 'kept',
        },
      });
      const logger = { warn: vi.fn() };
      const result = await rewriteVaultHtmlResponse(upstream, SID, '/deep/page', '/vault/deep/page', 'text/html', logger);
      expect(result.headers.get('content-length')).toBeNull();
      expect(result.headers.get('content-encoding')).toBeNull();
      expect(result.headers.get('x-custom')).toBe('kept');
      const body = await result.text();
      expect(body).toContain(`/api/vault/${SID}/`);
    });

    it('AC4: logs warning when base-href not found on shell path (no-op rewrite)', async () => {
      const html = '<html><head><base href="/already-set/" /></head></html>';
      const upstream = new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
      const logger = { warn: vi.fn() };
      await rewriteVaultHtmlResponse(upstream, SID, '/', '/vault/', 'text/html', logger);
      expect(logger.warn).toHaveBeenCalledWith('vault base-href rewrite no-op', expect.objectContaining({
        pathname: '/vault/',
        contentType: 'text/html',
      }));
    });

    it('AC4: does NOT warn on no-op for non-shell paths (error pages)', async () => {
      const html = '<html><body>404 not found</body></html>';
      const upstream = new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
      const logger = { warn: vi.fn() };
      await rewriteVaultHtmlResponse(upstream, SID, '/some/plugin/page', '/vault/some/plugin/page', 'text/html', logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('REQ-VAULT-021: rewrites every shell to the permanent bucket-token scope without session metadata', async () => {
      const TOKEN = '0123456789abcdef0123456789abcdef';
      const html = '<html><head><base href="/" /></head><body>hi</body></html>';
      const upstream = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      const logger = { warn: vi.fn() };
      const result = await rewriteVaultHtmlResponse(
        upstream, TOKEN, '/', '/vault/', 'text/html', logger,
      );
      const body = await result.text();
      expect(body).toContain(`<base href="/api/vault/${TOKEN}/" />`);
      expect(body).not.toContain('__codeflareVaultBoot');
      expect(body).not.toContain('vault-session-');
    });
  });

  // REQ-VAULT-005 Constraint (/api/vault/:sid/status runs through Hono middleware chain; only catch-all proxy is intercepted before Hono)
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
