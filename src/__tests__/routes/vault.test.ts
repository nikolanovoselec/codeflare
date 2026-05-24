import { describe, it, expect, vi } from 'vitest';
import {
  validateVaultRoute,
  maybeSynthesizeCsrfHeader,
  isServiceWorkerRegistration,
  VAULT_KEY_SHIM_SERVICE_WORKER_JS,
  VAULT_BOOTSTRAP_COOKIE,
  VAULT_IDB_RECORDER_MARKER,
  injectVaultEncryptionConfig,
  injectVaultBootScript,
  injectVaultIdbRecorder,
  injectVaultBootstrapHopHtml,
  hasVaultBootstrapCookie,
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
      // src/routes/vault.ts -> `container.fetch(new Request(vaultUrl, requestForAuth))`).
      const forwarded = new Request('https://internal.container.local/vault/notes/x.md', requestForAuth);
      const arrived = await forwarded.text();
      expect(arrived).toBe(payload);
      expect(requestForAuth.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    });
  });

  // REQ-VAULT-013 AC5-AC7 (browser-initiated SW registration short-circuit: method+path+Service-Worker header+no-Cookie selector, defence-in-depth)
  describe('isServiceWorkerRegistration / REQ-VAULT-013 (SilverBullet subpath adapter)', () => {
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

    it('VAULT_KEY_SHIM_SERVICE_WORKER_JS contains the minimum SW handshake handlers', () => {
      // skipWaiting + clients.claim is the standard minimal lifecycle that
      // makes the SW take control immediately. Without these, the browser
      // registers the SW but it stays "waiting" forever.
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('skipWaiting');
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('clients.claim');
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('install');
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('activate');
    });

    it('VAULT_KEY_SHIM_SERVICE_WORKER_JS handles set-encryption-key and get-encryption-key (REQ-VAULT-008 AC5)', () => {
      // The shim is what makes SilverBullet client-side encryption work:
      // boot.ts posts get-encryption-key and uses the reply as the IDB
      // AES-CTR key. Without these handlers, SB silently falls back to
      // plaintext IDB.
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('set-encryption-key');
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('get-encryption-key');
      // The reply message type matches SB's ServiceWorkerSourceMessage
      // contract (client/types/ui.ts: type "encryption-key").
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('encryption-key');
      // The key is stored in module-level memory (not persisted) so it
      // disappears when the SW is torn down — matches upstream SB's
      // encryptionKeyMemoryStore contract.
      expect(VAULT_KEY_SHIM_SERVICE_WORKER_JS).toContain('encryptionKey');
    });

    it('VAULT_KEY_SHIM_SERVICE_WORKER_JS executes the SW lifecycle and stores/returns a posted key', async () => {
      // Behavioural smoke: evaluate the SW source in a sandbox where we
      // shim `self`, fire install / activate / message events, and verify
      // (a) the install handler triggers skipWaiting, (b) activate calls
      // clients.claim, (c) a `set-encryption-key` message stores the key
      // in module-local state, (d) a subsequent `get-encryption-key`
      // message round-trips the same key back to event.source. If any of
      // these break, SB boots without encryption.
      const listeners: Record<string, (e: unknown) => void> = {};
      const skipWaiting = vi.fn();
      const clientsClaim = vi.fn(() => Promise.resolve());
      const self = {
        addEventListener: (type: string, fn: (e: unknown) => void) => {
          listeners[type] = fn;
        },
        skipWaiting,
        clients: { claim: clientsClaim },
        location: { origin: 'https://codeflare.test' },
      };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const runShim = new Function('self', VAULT_KEY_SHIM_SERVICE_WORKER_JS);
      runShim(self);

      // install -> skipWaiting
      listeners.install?.({});
      expect(skipWaiting).toHaveBeenCalled();

      // activate -> clients.claim (wrapped in waitUntil)
      const waitUntilArgs: unknown[] = [];
      listeners.activate?.({ waitUntil: (p: unknown) => waitUntilArgs.push(p) });
      expect(clientsClaim).toHaveBeenCalled();
      expect(waitUntilArgs).toHaveLength(1);

      // Same-origin client builder
      const sameOrigin = (replies: unknown[]) => ({
        url: 'https://codeflare.test/api/vault/abc/',
        postMessage: (msg: unknown) => replies.push(msg),
      });

      // set-encryption-key stores (sent from same-origin client)
      listeners.message?.({
        data: { type: 'set-encryption-key', key: 'KEY-AAAA' },
        source: sameOrigin([]),
      });

      // get-encryption-key replies via event.source.postMessage
      const replies: Array<{ type: string; key: string | undefined }> = [];
      listeners.message?.({
        data: { type: 'get-encryption-key' },
        source: sameOrigin(replies),
      });
      expect(replies).toEqual([{ type: 'encryption-key', key: 'KEY-AAAA' }]);

      // get-encryption-key before any set returns undefined (fresh SW)
      const replies2: Array<{ type: string; key: string | undefined }> = [];
      const fresh = {
        addEventListener: (type: string, fn: (e: unknown) => void) => {
          listeners[type] = fn;
        },
        skipWaiting,
        clients: { claim: clientsClaim },
        location: { origin: 'https://codeflare.test' },
      };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const runShim2 = new Function('self', VAULT_KEY_SHIM_SERVICE_WORKER_JS);
      runShim2(fresh);
      listeners.message?.({
        data: { type: 'get-encryption-key' },
        source: sameOrigin(replies2),
      });
      expect(replies2).toEqual([{ type: 'encryption-key', key: undefined }]);

      // Unknown message types are ignored (no throw, no reply)
      const replies3: unknown[] = [];
      listeners.message?.({
        data: { type: 'something-else' },
        source: sameOrigin(replies3),
      });
      expect(replies3).toEqual([]);
    });

    it('VAULT_KEY_SHIM_SERVICE_WORKER_JS rejects cross-origin clients (defence in depth)', () => {
      // The SW scope already restricts which clients can talk to it, but
      // we also gate on event.source.url being same-origin so that any
      // future scope-widening or sibling-page accident does NOT leak
      // the AES key out of the vault origin.
      const listeners: Record<string, (e: unknown) => void> = {};
      const self = {
        addEventListener: (type: string, fn: (e: unknown) => void) => {
          listeners[type] = fn;
        },
        skipWaiting: vi.fn(),
        clients: { claim: vi.fn(() => Promise.resolve()) },
        location: { origin: 'https://codeflare.test' },
      };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('self', VAULT_KEY_SHIM_SERVICE_WORKER_JS)(self);

      // Prime with a key (from a legitimate same-origin client).
      listeners.message?.({
        data: { type: 'set-encryption-key', key: 'SECRET' },
        source: {
          url: 'https://codeflare.test/api/vault/abc/',
          postMessage: () => {},
        },
      });

      // Attacker (cross-origin) tries to read the key.
      const evilReplies: unknown[] = [];
      listeners.message?.({
        data: { type: 'get-encryption-key' },
        source: {
          url: 'https://evil.example/x',
          postMessage: (msg: unknown) => evilReplies.push(msg),
        },
      });
      expect(evilReplies).toEqual([]);

      // Attacker tries to overwrite the key with a known value.
      listeners.message?.({
        data: { type: 'set-encryption-key', key: 'ATTACKER' },
        source: {
          url: 'https://evil.example/x',
          postMessage: () => {},
        },
      });
      // Same-origin readback confirms the key is still SECRET.
      const goodReplies: Array<{ type: string; key: string | undefined }> = [];
      listeners.message?.({
        data: { type: 'get-encryption-key' },
        source: {
          url: 'https://codeflare.test/api/vault/abc/',
          postMessage: (msg: { type: string; key: string | undefined }) => goodReplies.push(msg),
        },
      });
      expect(goodReplies).toEqual([{ type: 'encryption-key', key: 'SECRET' }]);

      // Sources lacking a parseable url are also rejected.
      const noUrlReplies: unknown[] = [];
      listeners.message?.({
        data: { type: 'get-encryption-key' },
        source: { postMessage: (msg: unknown) => noUrlReplies.push(msg) },
      });
      expect(noUrlReplies).toEqual([]);
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

  describe('injectVaultBootScript (REQ-VAULT-008 AC5 sid plumbing)', () => {
    it('injects a <script> exposing window.__codeflareVaultBoot.sessionId before </head>', () => {
      const html = '<!DOCTYPE html><html><head><title>SB</title></head><body></body></html>';
      const out = injectVaultBootScript(html, { sessionId: 'abcdef12' });
      expect(out).toContain('window.__codeflareVaultBoot');
      expect(out).toContain('"sessionId":"abcdef12"');
      expect(out.indexOf('window.__codeflareVaultBoot')).toBeLessThan(out.indexOf('</head>'));
    });

    it('does NOT inject the encryption key (key travels via SW, not via DOM)', () => {
      // Regression guard: the previous design baked the key into the boot
      // config, exposing it to every plug running in the page. The new
      // design routes the key through the bootstrap-hop → service-worker
      // postMessage channel instead, keeping it off the DOM.
      const html = '<html><head></head><body></body></html>';
      const out = injectVaultBootScript(html, { sessionId: 'abcdef12' });
      expect(out).not.toContain('vaultEncryptionKey');
      expect(out).not.toContain('enableClientEncryption');
    });

    it('escapes </script> in payload to prevent HTML break-out (XSS guard)', () => {
      // The sessionId itself is regex-validated, so the realistic XSS
      // vector is gone — but the serialiser's escape behaviour is
      // load-bearing for future field additions and worth pinning.
      const html = '<html><head></head><body></body></html>';
      const out = injectVaultBootScript(html, { sessionId: 'abcdef12' });
      // No </script> inside the JSON literal even though the wrapper
      // tag itself ends with </script>.
      const scriptOpenIdx = out.indexOf('<script>');
      const scriptCloseIdx = out.indexOf('</script>', scriptOpenIdx);
      const between = out.slice(scriptOpenIdx + '<script>'.length, scriptCloseIdx);
      expect(between).not.toContain('</script');
    });

    it('is idempotent — re-injecting on already-patched HTML produces single block', () => {
      const html = '<html><head></head><body></body></html>';
      const once = injectVaultBootScript(html, { sessionId: 'abcdef12' });
      const twice = injectVaultBootScript(once, { sessionId: 'abcdef12' });
      const occurrences = (twice.match(/window\.__codeflareVaultBoot/g) || []).length;
      expect(occurrences).toBe(1);
    });

    it('returns input unchanged when no </head> tag exists (fail-safe, not error)', () => {
      const html = '<html><body>no head</body></html>';
      const out = injectVaultBootScript(html, { sessionId: 'abcdef12' });
      expect(out).toBe(html);
    });

    it('throws if sessionId is empty', () => {
      const html = '<html><head></head><body></body></html>';
      expect(() => injectVaultBootScript(html, { sessionId: '' })).toThrow();
    });

    it('throws if sessionId does not match SESSION_ID_PATTERN', () => {
      const html = '<html><head></head><body></body></html>';
      expect(() => injectVaultBootScript(html, { sessionId: 'BAD-ID' })).toThrow();
      // Too short
      expect(() => injectVaultBootScript(html, { sessionId: 'abc' })).toThrow();
      // Uppercase
      expect(() => injectVaultBootScript(html, { sessionId: 'ABCDEFGH' })).toThrow();
    });
  });

  describe('injectVaultIdbRecorder (REQ-VAULT-015 AC3 boot recording)', () => {
    it('injects a recorder <script> before </head>', () => {
      const html = '<html><head></head><body></body></html>';
      const out = injectVaultIdbRecorder(html);
      expect(out).toContain('indexedDB.open');
      expect(out).toContain('vault-session-');
      expect(out).toContain('-idbs');
      expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</head>'));
    });

    it('records names that start with sb_ via the recorded localStorage key shape', () => {
      const out = injectVaultIdbRecorder('<html><head></head><body></body></html>');
      // The recorder gates on the sb_ prefix — never records other IDBs.
      expect(out).toContain('"sb_"');
      // The key shape matches the dashboard cleanup function contract:
      // localStorage["vault-session-<sid>-idbs"].
      expect(out).toContain('vault-session-');
    });

    it('reads sessionId from window.__codeflareVaultBoot (boot script must inject first)', () => {
      const out = injectVaultIdbRecorder('<html><head></head><body></body></html>');
      // The recorder depends on the boot script having already set
      // window.__codeflareVaultBoot.sessionId. If a future refactor
      // re-orders injection, this test should pin the dependency.
      expect(out).toContain('__codeflareVaultBoot');
      expect(out).toContain('sessionId');
    });

    it('is idempotent — re-injecting on already-patched HTML produces single block', () => {
      const html = '<html><head></head><body></body></html>';
      const once = injectVaultIdbRecorder(html);
      const twice = injectVaultIdbRecorder(once);
      // Count substring occurrences without regex — avoids the
      // incomplete-sanitization trap (CodeQL js/incomplete-sanitization)
      // of escaping only some regex meta-chars in the marker.
      const occurrences = twice.split(VAULT_IDB_RECORDER_MARKER).length - 1;
      expect(occurrences).toBe(1);
    });

    it('returns input unchanged when no </head> tag exists (fail-safe)', () => {
      const html = '<html><body>no head</body></html>';
      expect(injectVaultIdbRecorder(html)).toBe(html);
    });
  });

  describe('injectVaultBootstrapHopHtml (REQ-VAULT-008 AC5)', () => {
    it('produces an HTML page that registers the SW, posts the key, sets the cookie, then redirects', () => {
      const out = injectVaultBootstrapHopHtml('abcdef12', 'AAAA-base64-key-AAAA');
      // Page shape
      expect(out).toContain('<!doctype html>');
      expect(out).toContain('<script>');
      // Flips the SB-side encryption gate
      expect(out).toContain('localStorage.setItem("enableEncryption"');
      // Registers our SW shim under the per-session scope
      expect(out).toContain('serviceWorker.register');
      expect(out).toContain('service_worker.js');
      expect(out).toContain('/api/vault/');
      // Posts the key the SW shim expects
      expect(out).toContain('set-encryption-key');
      expect(out).toContain('AAAA-base64-key-AAAA');
      // Sets the bootstrap cookie so shell-path requests no longer redirect
      expect(out).toContain(VAULT_BOOTSTRAP_COOKIE);
      expect(out).toContain('document.cookie');
      // Redirects to the real shell URL
      expect(out).toContain('location.replace');
    });

    it('sets the bootstrap cookie with both SameSite=Lax and Secure', () => {
      // The project policy is: every state cookie carries Secure (HSTS
      // enforced everywhere). This is a one-line behavioural pin so a
      // future hand-edit cannot silently drop the flag.
      const out = injectVaultBootstrapHopHtml('abcdef12', 'k');
      // Both flags must appear in the same cookie string. Use a regex
      // tolerant of whitespace inside the JS source.
      expect(out).toMatch(/SameSite=Lax/);
      expect(out).toMatch(/Secure/);
      // Sanity check: not declaring Secure inside a comment / string
      // that says "don't add Secure". The literal `; Secure` substring
      // appears in the cookie assignment.
      expect(out).toContain('; Secure');
    });

    it('guards cookie+redirect inside the SW-success branch -- failure must NOT proceed (REQ-VAULT-008 AC5 fail-loud)', () => {
      // The function's own docstring promises "never silently degrades
      // to plaintext IDB". The earlier implementation set the cookie
      // and called location.replace unconditionally; the followup
      // bug code-reviewer flagged was that localStorage.setItem fired
      // BEFORE the SW await, so a tab close between setItem and
      // postMessage left enableEncryption=true with no SW key. The
      // current contract: setItem, cookie, AND redirect all live after
      // the post-handoff success branch; the catch branch returns with
      // none of the three side-effects ever observed.
      const out = injectVaultBootstrapHopHtml('abcdef12', 'k');
      // Failure UI exists.
      expect(out).toContain('Vault could not start encryption');
      // Walk balanced braces to extract the FULL catch body.
      const catchOpenStr = '} catch (e) {';
      const catchOpenIdx = out.indexOf(catchOpenStr);
      expect(catchOpenIdx).toBeGreaterThanOrEqual(0);
      const bodyStart = catchOpenIdx + catchOpenStr.length;
      let depth = 1;
      let i = bodyStart;
      for (; i < out.length && depth > 0; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}') depth--;
      }
      const catchBodyEndIdx = i - 1;
      expect(depth).toBe(0);
      const catchBody = out.slice(bodyStart, catchBodyEndIdx);
      // Catch branch returns early. None of the three side-effects fire.
      expect(catchBody).toContain('return;');
      expect(catchBody).not.toContain('document.cookie');
      expect(catchBody).not.toContain('location.replace');
      // No-rollback assertion: there is nothing to roll back because the
      // flag is never set on this branch. A future refactor that
      // reintroduces the set-first pattern would have to also reintroduce
      // a removeItem here; pinning the absence catches that drift.
      expect(catchBody).not.toContain('localStorage.setItem("enableEncryption"');
      expect(catchBody).not.toContain('localStorage.removeItem("enableEncryption"');
      // Ordering: setItem("enableEncryption") MUST appear after the
      // sw.postMessage call and before document.cookie. This is the
      // load-bearing invariant the bootstrap-hop race fix enforces.
      const postIdx = out.indexOf('sw.postMessage');
      const setItemIdx = out.indexOf('localStorage.setItem("enableEncryption"');
      const cookieIdx = out.indexOf('document.cookie');
      const replaceIdx = out.indexOf('location.replace');
      expect(postIdx).toBeGreaterThanOrEqual(0);
      expect(setItemIdx).toBeGreaterThan(postIdx);
      expect(cookieIdx).toBeGreaterThan(setItemIdx);
      expect(replaceIdx).toBeGreaterThan(cookieIdx);
      // All three side-effects live after the catch block closes.
      expect(setItemIdx).toBeGreaterThan(catchBodyEndIdx);
      expect(cookieIdx).toBeGreaterThan(catchBodyEndIdx);
      expect(replaceIdx).toBeGreaterThan(catchBodyEndIdx);
    });

    it('aborts (no cookie, no redirect, no enableEncryption=true) when reg.active/installing/waiting are all null', () => {
      // Edge case: serviceWorker.ready resolves but the registration has
      // no SW reference yet. The hop must NOT proceed -- and because the
      // localStorage flag is only set on the post-handoff success path,
      // there is nothing to roll back here either.
      const out = injectVaultBootstrapHopHtml('abcdef12', 'k');
      const ifIdx = out.indexOf('if (!sw)');
      expect(ifIdx).toBeGreaterThanOrEqual(0);
      const bodyStart = out.indexOf('{', ifIdx) + 1;
      let depth = 1;
      let i = bodyStart;
      for (; i < out.length && depth > 0; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}') depth--;
      }
      const ifBody = out.slice(bodyStart, i - 1);
      expect(ifBody).toContain('fail("service worker not active")');
      expect(ifBody).toContain('return;');
      // No setItem / removeItem on the no-SW branch -- the flag is never
      // touched outside the post-handoff success branch.
      expect(ifBody).not.toContain('localStorage.setItem("enableEncryption"');
      expect(ifBody).not.toContain('localStorage.removeItem("enableEncryption"');
    });

    it('embeds the session id verbatim once', () => {
      const out = injectVaultBootstrapHopHtml('abcdef12', 'k');
      expect(out).toContain('"abcdef12"');
    });

    it('escapes </script> in the key payload to prevent HTML break-out', () => {
      const out = injectVaultBootstrapHopHtml('abcdef12', '</script><script>alert(1)</script>');
      // The literal attack string must not appear inside the page; the
      // escape replaces </ with <\/.
      expect(out).not.toContain('</script><script>alert(1)');
      expect(out).toContain('<\\/script>');
    });

    it('throws if vaultEncryptionKey is empty (fail loud, never silently plaintext)', () => {
      expect(() => injectVaultBootstrapHopHtml('abcdef12', '')).toThrow();
    });

    it('throws if sessionId does not match SESSION_ID_PATTERN', () => {
      expect(() => injectVaultBootstrapHopHtml('BAD-ID', 'k')).toThrow();
      expect(() => injectVaultBootstrapHopHtml('abc', 'k')).toThrow();
      expect(() => injectVaultBootstrapHopHtml('', 'k')).toThrow();
    });
  });

  // REQ-VAULT-008 AC6 (codeflare_vault_bootstrap cookie selector: subsequent shell-path requests bypass the hop via the cookie)
  describe('hasVaultBootstrapCookie', () => {
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
