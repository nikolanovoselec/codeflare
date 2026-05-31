/**
 * Vault HTML/JS rewriting + the service-worker shim string.
 *
 * Extracted from src/routes/vault.ts (CF-002) so the routing/auth module
 * stays focused on the request chain. This module owns every byte the
 * Worker injects into, or serves to, the browser on behalf of the
 * in-container SilverBullet editor:
 *
 *   - VAULT_KEY_SHIM_SERVICE_WORKER_JS: the key-shim SW source.
 *   - isServiceWorkerRegistration: the SW-registration request selector.
 *   - injectVaultEncryptionConfig / injectVaultBootScript /
 *     injectVaultIdbRecorder: BootConfig + shell-HTML injectors.
 *   - injectVaultBootstrapHopHtml + VAULT_BOOTSTRAP_COOKIE helpers.
 *   - rewriteVaultBaseHref / rewriteVaultHtmlResponse: base-href adapter.
 *   - filterVaultFsListing: /.fs listing filter.
 *
 * Behaviour is identical to the previous in-vault.ts definitions; these
 * are pure functions with no Worker-runtime dependencies (only the
 * SESSION_ID_PATTERN constant), which is what makes the extraction safe.
 */
import { SESSION_ID_PATTERN } from '../lib/constants';
import { toErrorMessage } from '../lib/error-types';

/**
 * Synthesise `X-Requested-With: XMLHttpRequest` on a request clone when
 * (and ONLY when) the caller has already validated the request's Origin
 * against the codeflare CORS allowlist. The synthesis lets SilverBullet's
 * client.js writes (which never set the header) bypass the CSRF guard in
 * `authenticateRequest` without weakening protection: per the Fetch spec,
 * browsers always set Origin on cross-origin state-changing requests, so
 * once Origin is allowlist-validated, the X-Requested-With check is
 * redundant defence.
 *
 * Safety invariant (enforced by THIS function, not by call-site ordering):
 *   - If `originValidated` is false → return the original request unchanged.
 *   - If the request already carries `X-Requested-With` → unchanged.
 *   - If the method is not state-changing (GET/HEAD/OPTIONS) → unchanged.
 *   - Otherwise clone the FULL request (preserves body, signal, etc.) and
 *     set the synthesised header.
 *
 * The full-clone form `new Request(request, { headers })` is critical:
 * `authenticateRequest` only reads method + headers today, but the next
 * change there could legitimately need the body (e.g. to verify a CSRF
 * token in the payload); a partial reconstruction would silently fail.
 *
 * Browser baseline this depends on: Origin set on every cross-origin
 * state-changing request. True in all major browsers since 2020
 * (Chrome 76+, Firefox 70+, Safari 13.1+). Older browsers fall through
 * the `originValidated=false` branch and hit the original CSRF guard.
 *
 * Exported solely so the unit test in src/__tests__/routes/vault.test.ts
 * can pin the behavioural cases (validated+write synthesises; validated
 * +read passes through; not-validated passes through; header-already-
 * present passes through; cloned body preserved; case-insensitive method).
 */
export function maybeSynthesizeCsrfHeader(request: Request, originValidated: boolean): Request {
  if (!originValidated) return request;
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return request;
  if (request.headers.has('X-Requested-With')) return request;
  const headers = new Headers(request.headers);
  headers.set('X-Requested-With', 'XMLHttpRequest');
  return new Request(request, { headers });
}

/**
 * Service Worker shim served by the Worker for `service_worker.js`
 * registration requests. SilverBullet's real SW (offline-cache bundle)
 * cannot be served via the vault proxy because Chrome omits cookies on
 * the SW script fetch - the browser's `navigator.serviceWorker.register()`
 * call sends only `Accept`, `DNT`, and `Service-Worker: script` (no
 * `Cookie`), so any cookie-gated route returns 401 and registration
 * fails permanently.
 *
 * The shim is functionally a no-op for SB's sync engine (file sync still
 * goes through the auth-gated Worker proxy directly), with one carved-out
 * responsibility: hold the per-session AES-CTR encryption key in memory
 * so SilverBullet's `client/boot.ts` get-encryption-key message returns
 * a non-undefined value. The codeflare bootstrap-hop page posts the key
 * via `{type: "set-encryption-key"}` before SB boots; SB's boot then
 * polls `{type: "get-encryption-key"}` and uses the reply to enable the
 * `EncryptedKvPrimitives` wrapper on the sb_data IDB.
 *
 * The key never leaves the SW process - it is in-memory only, scoped to
 * `/api/vault/<sid>/`, and gone the moment the browser tears the SW down.
 * That matches SilverBullet's upstream contract for `encryptionKeyMemoryStore`
 * (client/service_worker.ts:60 in SB 2.8). Implements REQ-VAULT-008 AC5.
 */
export const VAULT_KEY_SHIM_SERVICE_WORKER_JS =
  '// Codeflare vault key-shim service worker - see src/routes/vault.ts.\n' +
  'let encryptionKey = undefined;\n' +
  'function isSameOriginClient(source) {\n' +
  '  if (!source || typeof source.url !== "string") return false;\n' +
  '  try { return new URL(source.url).origin === self.location.origin; }\n' +
  '  catch (_) { return false; }\n' +
  '}\n' +
  'async function recoverKey() {\n' +
  '  if (encryptionKey !== undefined) return;\n' +
  '  try {\n' +
  '    var r = await fetch(self.registration.scope + ".vault-key", { credentials: "same-origin" });\n' +
  '    if (r.ok) { var b = await r.json(); if (b && b.key) encryptionKey = b.key; }\n' +
  '  } catch (_) {}\n' +
  '}\n' +
  'self.addEventListener("install", () => self.skipWaiting());\n' +
  'self.addEventListener("activate", (event) => event.waitUntil(\n' +
  '  recoverKey().then(() => self.clients.claim())\n' +
  '));\n' +
  'self.addEventListener("message", (event) => {\n' +
  '  const msg = event && event.data;\n' +
  '  if (!msg || typeof msg !== "object") return;\n' +
  '  if (!isSameOriginClient(event.source)) return;\n' +
  '  if (msg.type === "set-encryption-key") {\n' +
  '    encryptionKey = msg.key;\n' +
  '    return;\n' +
  '  }\n' +
  '  if (msg.type === "get-encryption-key") {\n' +
  '    if (encryptionKey === undefined) {\n' +
  '      recoverKey().then(() => event.source.postMessage({ type: "encryption-key", key: encryptionKey !== undefined ? encryptionKey : null }));\n' +
  '      return;\n' +
  '    }\n' +
  '    event.source.postMessage({ type: "encryption-key", key: encryptionKey });\n' +
  '    return;\n' +
  '  }\n' +
  '});\n';

/**
 * Identify a browser-initiated Service Worker registration GET. The
 * `service-worker: script` request header is set by the user agent and is
 * a Fetch-spec forbidden header name today, so page JavaScript cannot
 * forge it via `fetch()`. The path-suffix check pins the SilverBullet-
 * served SW URL; any other path falls through to the normal auth chain.
 *
 * Cookie header is intentionally NOT checked. Chrome 76+ strips cookies
 * on SW registration fetches per spec, but Samsung Internet and other
 * Chromium forks may not. When cookies are present and this function
 * returns false, the request falls through to the proxy chain which
 * serves SilverBullet's real 97KB SW instead of the key-shim. That SW
 * runs cache.addAll() during install, which fetches the vault root
 * without the bootstrap cookie and gets a 302 redirect, causing the
 * install to fail and navigator.serviceWorker.ready to hang forever.
 * The service-worker header alone is sufficient security (forbidden
 * header, not forgeable by page JS) and the response is a static JS
 * string with no user data.
 */
export function isServiceWorkerRegistration(request: Request, remainingPath: string | undefined): boolean {
  if (request.method !== 'GET') return false;
  if (remainingPath !== '/service_worker.js') return false;
  if (request.headers.get('service-worker') !== 'script') return false;
  return true;
}

/**
 * Inject the per-session vault encryption key into a SilverBullet
 * BootConfig JSON body. The Worker is the canonical source of the key
 * (it lives in the container DO's ctx.storage and is RPC-fetched at
 * request time); any value the container might emit for this field is
 * stale or empty and is overridden here.
 *
 * Fail-loud contract: throws if `bootConfigJson` is not parseable JSON
 * or if `vaultEncryptionKey` is empty. A silently-broken /.config
 * response would still render the SB shell but client-side encryption
 * would fall back to plaintext IDB - a silent data-at-rest regression.
 *
 * Implements REQ-VAULT-008 AC3.
 */
export function injectVaultEncryptionConfig(bootConfigJson: string, vaultEncryptionKey: string): string {
  if (!vaultEncryptionKey) {
    throw new Error('injectVaultEncryptionConfig: vaultEncryptionKey must be non-empty');
  }
  const parsed = JSON.parse(bootConfigJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('injectVaultEncryptionConfig: BootConfig must be a JSON object');
  }
  const merged = {
    ...parsed,
    vaultEncryptionKey,
    enableClientEncryption: true,
  };
  return JSON.stringify(merged);
}

/**
 * Inject a tiny codeflare bootstrap script into the SilverBullet shell
 * HTML, immediately before `</head>`. The script exposes a single global
 * `window.__codeflareVaultBoot = { sessionId }` that the recorder
 * (injected separately by `injectVaultIdbRecorder`) reads to scope its
 * localStorage entries per session. The encryption key is NOT injected
 * into the page window - it travels through the bootstrap-hop page →
 * service-worker channel instead, which keeps it off the DOM where any
 * SB plug could read it.
 *
 * Idempotent via `VAULT_BOOT_MARKER`. Returns the input unchanged when
 * `</head>` is missing (SB error pages and 404 HTML have no head and
 * must not be mutilated).
 *
 * Implements REQ-VAULT-015 AC3 plumbing (the sid handoff that the
 * IDB recorder consumes).
 */
export interface VaultBootConfig {
  sessionId: string;
}

const VAULT_BOOT_MARKER = 'window.__codeflareVaultBoot';

// Defence-in-depth cap on the serialised payload size. The payload today
// is one short session id; the cap exists so a future field addition
// does not silently grow the inline script past sensible limits.
const VAULT_BOOT_CONFIG_MAX_BYTES = 1024;

export function injectVaultBootScript(html: string, config: VaultBootConfig): string {
  if (!config.sessionId) {
    throw new Error('injectVaultBootScript: sessionId must be non-empty');
  }
  if (!SESSION_ID_PATTERN.test(config.sessionId)) {
    throw new Error('injectVaultBootScript: sessionId must match SESSION_ID_PATTERN');
  }
  if (html.includes(VAULT_BOOT_MARKER)) {
    return html;
  }
  if (!html.includes('</head>')) {
    return html;
  }
  // Defence-in-depth escapes for JSON-in-script-tag boundary:
  //   </ -> <\/   (defang literal </script> break-out)
  //   <!-- -> <\!--  (HTML5 script-data-double-escape-start)
  //   line separators U+2028 and U+2029 are escaped (legal in JSON, illegal as
  //     bare JS string literals in older runtimes)
  const serialised = JSON.stringify(config)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/[\u2028\u2029]/g, (m) => '\\u' + m.charCodeAt(0).toString(16));
  if (serialised.length > VAULT_BOOT_CONFIG_MAX_BYTES) {
    throw new Error(
      `injectVaultBootScript: serialised config exceeds ${VAULT_BOOT_CONFIG_MAX_BYTES}-byte safety cap`
    );
  }
  const tag = `<script>${VAULT_BOOT_MARKER} = ${serialised};</script>`;
  return html.replace('</head>', `${tag}</head>`);
}

/**
 * Inject a SilverBullet IDB-name recorder into the shell HTML. The
 * recorder lands before `</head>` AFTER the boot-config script (so
 * `window.__codeflareVaultBoot.sessionId` is defined when it runs).
 *
 * It wraps `indexedDB.open` to capture every database name SilverBullet
 * opens that starts with `sb_` and persists the names into
 * `localStorage["vault-session-<sid>-idbs"]` as a JSON array. The
 * dashboard's `cleanupSessionVaultCache` / `sweepOrphanVaultCaches`
 * functions read that array and call `indexedDB.deleteDatabase(name)`
 * on session DELETE / dashboard mount - the real fix for the
 * previously-leaking SB IDBs (REQ-VAULT-015 AC3 + AC4).
 *
 * Idempotent via `VAULT_IDB_RECORDER_MARKER`. Returns the input
 * unchanged when `</head>` is missing or the script is already present.
 *
 * Why record at boot instead of compute the name in the dashboard:
 * SilverBullet's `deriveDbName` depends on `spaceFolderPath`,
 * `document.baseURI`, AND the encryption key. The dashboard could
 * reproduce the formula, but the recorder is resilient to any future
 * upstream change in that formula - we work from observed reality, not
 * a derivation that may drift.
 */
export const VAULT_IDB_RECORDER_MARKER = '/*codeflare-vault-idb-recorder*/';

export function injectVaultIdbRecorder(html: string): string {
  if (html.includes(VAULT_IDB_RECORDER_MARKER)) {
    return html;
  }
  if (!html.includes('</head>')) {
    return html;
  }
  const script =
    '<script>' + VAULT_IDB_RECORDER_MARKER + '(function () {' +
    'try {' +
    'var boot = window.__codeflareVaultBoot;' +
    'if (!boot || typeof boot.sessionId !== "string") return;' +
    'var sid = boot.sessionId;' +
    'if (!/^[a-z0-9]{8,24}$/.test(sid)) return;' +
    'var key = "vault-session-" + sid + "-idbs";' +
    'var origOpen = indexedDB.open.bind(indexedDB);' +
    'indexedDB.open = function (name, version) {' +
    'if (typeof name === "string" && name.indexOf("sb_") === 0) {' +
    'try {' +
    'var arr = JSON.parse(localStorage.getItem(key) || "[]");' +
    'if (!Array.isArray(arr)) arr = [];' +
    'if (arr.indexOf(name) === -1) {' +
    'arr.push(name);' +
    'localStorage.setItem(key, JSON.stringify(arr));' +
    '}' +
    '} catch (_) {}' +
    '}' +
    'return origOpen(name, version);' +
    '};' +
    '} catch (_) {}' +
    '})();</script>';
  return html.replace('</head>', `${script}</head>`);
}

/**
 * Render the codeflare bootstrap-hop HTML page. Served from
 * `GET /api/vault/<sid>/.codeflare-bootstrap` and from the shell-path
 * fallback when no `codeflare_vault_bootstrap` cookie is present.
 *
 * The page registers the codeflare key-shim service worker, posts the
 * per-session AES-CTR encryption key to it via `{type: "set-encryption-key"}`,
 * sets `localStorage["enableEncryption"] = "true"` (the SB-side gate at
 * `client/boot.ts:97`), sets the `codeflare_vault_bootstrap` cookie so
 * subsequent shell-path requests bypass the hop, then `location.replace`s
 * to `/api/vault/<sid>/`. SB's boot then races `cachedFetch(".config")`
 * (~50-200 ms network) before reading `navigator.serviceWorker.controller`
 * - by that point the SW is registered, active, claimed (via the
 * `clients.claim()` call in the shim's activate handler), and holds the
 * key. The encryption gate at `client/boot.ts:96-143` then succeeds and
 * SB wraps the sb_data IDB with `EncryptedKvPrimitives`.
 *
 * Security:
 *   - Throws on empty `vaultEncryptionKey` so a misconfigured DO key
 *     never silently degrades to plaintext IDB.
 *   - Throws on session-id format mismatch.
 *   - The key is embedded as a JSON-literal string, escaping all break-out
 *     vectors (</script>, <!--, U+2028/U+2029).
 *   - The page itself is auth-gated (served by handleVaultRequest only
 *     after authenticateRequest). The shim SW URL is auth-bypassed for
 *     the registration GET only; the SW's get-encryption-key message
 *     handler returns the key only to same-origin `event.source` clients.
 *
 * Implements REQ-VAULT-008 AC5.
 */
export const VAULT_BOOTSTRAP_COOKIE = 'codeflare_vault_bootstrap';
export const VAULT_SW_ACTIVATION_TIMEOUT_MS = 10_000;

export function injectVaultBootstrapHopHtml(sessionId: string, vaultEncryptionKey: string): string {
  if (!vaultEncryptionKey) {
    throw new Error('injectVaultBootstrapHopHtml: vaultEncryptionKey must be non-empty');
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('injectVaultBootstrapHopHtml: sessionId must match SESSION_ID_PATTERN');
  }
  // Defence-in-depth escapes for the JS-string-literal boundary inside
  // <script>...</script>. The same escapes used by injectVaultBootScript.
  const escape = (s: string): string =>
    JSON.stringify(s)
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '<\\!--')
      .replace(/[\u2028\u2029]/g, (m) => '\\u' + m.charCodeAt(0).toString(16));
  const escapedKey = escape(vaultEncryptionKey);
  const escapedSid = escape(sessionId);
  const escapedCookie = escape(VAULT_BOOTSTRAP_COOKIE);
  // The cookie and redirect run ONLY inside the SW-success branch.
  // If SW registration or the postMessage handoff fails (private mode,
  // SW disabled, exotic browser), we must NOT set the cookie or redirect
  // - falling through to SB without a key in the SW would silently boot
  // unencrypted IDB, the exact regression this REQ exists to prevent.
  // Instead, show an inline failure UI so the user sees the problem
  // and can retry instead of getting opaquely-plaintext storage.
  return '<!doctype html>\n' +
    '<html><head><meta charset="utf-8"><title>Codeflare vault loading</title>' +
    '<style>html,body{height:100%;margin:0;background:#1e1e1e;color:#ccc;' +
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;' +
    'align-items:center;justify-content:center;text-align:center;padding:1em}</style>' +
    '</head><body><div id="status">Loading vault\u2026</div><script>' +
    '(async function () {' +
    'var sid = ' + escapedSid + ';' +
    'var key = ' + escapedKey + ';' +
    'var cookieName = ' + escapedCookie + ';' +
    'var scope = "/api/vault/" + sid + "/";' +
    'var el = document.getElementById("status");' +
    'function fail(msg) {' +
    'if (el) el.textContent = "Vault could not start encryption: " + msg + ". Reload to retry.";' +
    'console.warn("Codeflare vault bootstrap:", msg);' +
    '}' +
    'function step(msg) { if (el) el.textContent = msg; console.log("vault-hop:", msg); }' +
    'if (!navigator.serviceWorker) { fail("browser does not support service workers"); return; }' +
    'try {' +
    'step("Registering service worker...");' +
    'var reg = await navigator.serviceWorker.register(scope + "service_worker.js", { scope: scope });' +
    'step("Registered. SW state: " + (reg.active ? "active" : reg.installing ? "installing" : reg.waiting ? "waiting" : "none"));' +
    'var sw = reg.active || reg.installing || reg.waiting;' +
    'if (!sw) { fail("no service worker instance after registration"); return; }' +
    'if (sw.state !== "activated") {' +
    'step("Waiting for activation (state: " + sw.state + ")...");' +
    'await new Promise(function (resolve, reject) {' +
    'var timer = setTimeout(function () { sw.removeEventListener("statechange", check); reject(new Error("activation timed out after " + (' + VAULT_SW_ACTIVATION_TIMEOUT_MS + ' / 1000) + " s (state: " + sw.state + ")")); }, ' + VAULT_SW_ACTIVATION_TIMEOUT_MS + ');' +
    'function check() {' +
    'if (sw.state === "activated") { clearTimeout(timer); sw.removeEventListener("statechange", check); resolve(); return; }' +
    'if (sw.state === "redundant") { clearTimeout(timer); sw.removeEventListener("statechange", check); reject(new Error("service worker became redundant")); return; }' +
    '}' +
    'sw.addEventListener("statechange", check);' +
    'check();' +
    '});' +
    '}' +
    'step("Posting encryption key...");' +
    'sw.postMessage({ type: "set-encryption-key", key: key });' +
    'step("Redirecting...");' +
    '} catch (e) {' +
    'fail(e && e.message ? e.message : String(e));' +
    'return;' +
    '}' +
    'try { localStorage.setItem("enableEncryption", "true"); } catch (_) {}' +
    'document.cookie = cookieName + "=1; Path=" + scope + "; SameSite=Lax; Secure";' +
    'location.replace(scope);' +
    '})();' +
    '</script></body></html>';
}

/**
 * Check if the request carries the `codeflare_vault_bootstrap` cookie,
 * which the bootstrap-hop page sets after registering the SW and posting
 * the encryption key. Used by `handleVaultRequest` shell-path dispatch
 * to decide whether to serve the bootstrap-hop or proceed to the real
 * SB shell.
 *
 * Cookies are matched by name only - the value is always "1" set by the
 * hop page. A missing cookie or any other value returns false.
 */
export function hasVaultBootstrapCookie(request: Request): boolean {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return false;
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const idx = cookie.indexOf('=');
    if (idx === -1) continue;
    const name = cookie.slice(0, idx).trim();
    const value = cookie.slice(idx + 1).trim();
    if (name === VAULT_BOOTSTRAP_COOKIE && value === '1') return true;
  }
  return false;
}

/**
 * Filter a SilverBullet `/.fs` JSON listing response, removing entries
 * whose `name` starts with `graphify-out/`. The vault contains agent-
 * derived graph artifacts (sometimes multi-MB graph.html) that must
 * not appear in the SB UI's space listing - they would clutter the
 * tree, slow initial sync, and confuse the user.
 *
 * Server-side filter (here) is the canonical enforcement point because
 * the SB binary embeds its own listing logic and we cannot reach in
 * to add an exclude pattern. Treeview UI exclusion (AC7) is a parallel
 * surface guard for the editor's tree pane.
 *
 * Fail-safe: returns the input string unchanged on any parse error or
 * if the body is not a JSON array - never breaks a 200 response just
 * because the upstream shape drifted.
 *
 * Implements REQ-VAULT-015 AC1.
 */
export function filterVaultFsListing(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) return body;
    const filtered = parsed.filter((entry) => {
      if (entry == null || typeof entry !== 'object') return true;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string') return true;
      return !name.startsWith('graphify-out/');
    });
    // Pass through the original body byte-for-byte when nothing was
    // filtered so any upstream ETag / cache-validation key the SB
    // binary may rely on stays intact (no-op safety).
    if (filtered.length === parsed.length) return body;
    return JSON.stringify(filtered);
  } catch {
    return body;
  }
}

/**
 * Same-origin fallback for the CSRF synthesis gate. Returns true when
 * the request is a state-changing method (POST/PUT/PATCH/DELETE) AND
 * the Origin header is absent. SilverBullet's attachment upload path
 * (PUT `/api/vault/<sid>/Inbox/<file>`) lands at the Worker without an
 * Origin header in some browser configurations; treating it as
 * same-origin closes the 401 gap. Returns false on safe methods and on
 * any state-changing method that supplied an Origin (the caller still
 * runs the allowlist check on the Origin).
 *
 * Implements REQ-VAULT-009 AC1+AC4.
 */
export function inferOriginValidated(request: Request): boolean {
  if (request.headers.get('Origin')) return false;
  // Defence-in-depth note (code-reviewer 1st report H4): per Fetch spec,
  // modern browsers always set Origin on state-changing requests, so an
  // attacker browser cannot forge "no Origin" to bypass CSRF. If a
  // future hardening pass wants belt-and-braces, also require
  // `Sec-Fetch-Site: same-origin` here (Chromium/Firefox/Safari all set
  // it). We do NOT require it today because some embedded WebViews
  // omit Sec-Fetch-Site, and SilverBullet's PUT path needs to remain
  // reachable from those.
  const method = request.method.toUpperCase();
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export interface RewriteResult {
  readonly rewritten: string;
  readonly wasNoOp: boolean;
}

export function rewriteVaultBaseHref(html: string, sessionId: string): RewriteResult {
  const prefix = `/api/vault/${sessionId}`;
  const rewritten = html.replace(
    /<base\s+href="\/"\s*\/?>/gi,
    `<base href="${prefix}/" />`,
  );
  return { rewritten, wasNoOp: rewritten === html };
}

export async function rewriteVaultHtmlResponse(
  response: Response,
  sessionId: string,
  remainingPath: string,
  pathname: string,
  contentType: string,
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<Response> {
  const body = await response.text();
  const { rewritten: baseRewritten, wasNoOp } = rewriteVaultBaseHref(body, sessionId);
  let rewritten = baseRewritten;

  const isShellPath = remainingPath === '/' || remainingPath === '/index.html';
  if (response.status === 200 && isShellPath) {
    try {
      rewritten = injectVaultBootScript(rewritten, { sessionId });
      rewritten = injectVaultIdbRecorder(rewritten);
    } catch (err) {
      logger.warn('vault boot-script injection skipped', { error: toErrorMessage(err) });
    }
  }
  if (wasNoOp && response.status === 200 && isShellPath) {
    logger.warn('vault base-href rewrite no-op', { pathname, contentType });
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
