/**
 * Vault routes — proxy from the Worker to the in-container SilverBullet
 * server that hosts the persistent vault at /home/user/Vault.
 *
 * Two responsibilities, mirroring src/routes/terminal.ts:
 *
 *   1. **Request intercept** (`validateVaultRoute` + `handleVaultRequest`):
 *      Called from `src/index.ts` BEFORE the Hono router so we can pass
 *      WebSocket upgrade requests through (Hono cannot handle them) and
 *      so that a path like `/api/vault/:sid/index.html` reaches the
 *      static file handler in SilverBullet instead of being rejected as
 *      "no Hono route matched".
 *
 *   2. **Hono status route** (`GET /api/vault/:sessionId/status`):
 *      Served through normal middleware (`authMiddleware`); returns a
 *      thin JSON blob describing whether SilverBullet is reachable.
 *
 * Auth chain is identical to terminal:
 *   authenticateRequest → origin allowlist → tier check → rate limit
 *   → session ownership → container health → container.fetch.
 *
 * Implements REQ-MEMORY-103.
 */
import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env, Session } from '../types';
import { getSessionKey, putSessionWithMetadata } from '../lib/kv-keys';
import {
  SESSION_ID_PATTERN,
  REQUEST_ID_LENGTH,
  REQUEST_ID_PATTERN,
  WS_RATE_LIMIT_WINDOW_MS,
  WS_RATE_LIMIT_MAX_CONNECTIONS,
  WS_RATE_LIMIT_TTL_SECONDS,
} from '../lib/constants';
import { checkRateLimit } from '../lib/rate-limit-core';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { getContainerId, safeCheckContainerHealth } from '../lib/container-helpers';
import { authenticateRequest } from '../lib/access';
import { isSaasModeActive } from '../lib/onboarding';
import { isActiveUser } from '../lib/access-tier';
import { getEffectiveTier } from '../lib/subscription';
import { createLogger } from '../lib/logger';
import { isAllowedOrigin } from '../lib/cors-cache';
import { AuthError, ForbiddenError, NotFoundError, toError, toErrorMessage } from '../lib/error-types';

const logger = createLogger('vault');

export interface VaultRouteResult {
  isVaultRoute: boolean;
  sessionId?: string;
  remainingPath?: string;
  isWebSocket?: boolean;
  errorResponse?: Response;
}

/**
 * Parse a `/api/vault/:sessionId/...` URL. Used both for HTTP requests
 * and WebSocket upgrades — SilverBullet uses WS for live-edit sync.
 *
 * Returns isVaultRoute=true for any path under `/api/vault/<id>/`. A
 * bare `/api/vault/<id>` (no trailing slash) is rejected: requests to a
 * directory without a trailing slash must redirect or the SilverBullet
 * client emits broken relative-URL fetches. The Hono status route
 * `/api/vault/:sid/status` does NOT count as a vault proxy path — the
 * caller (src/index.ts) checks for that pattern before calling us.
 */
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
 * the SW script fetch — the browser's `navigator.serviceWorker.register()`
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
 * The key never leaves the SW process — it is in-memory only, scoped to
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
 * into the page window \u2014 it travels through the bootstrap-hop page \u2192
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
  //   U+2028 / U+2029 -> \u2028 / \u2029 (legal in JSON, illegal as
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
 * on session DELETE / dashboard mount \u2014 the real fix for the
 * previously-leaking SB IDBs (REQ-VAULT-015 AC3 + AC4).
 *
 * Idempotent via `VAULT_IDB_RECORDER_MARKER`. Returns the input
 * unchanged when `</head>` is missing or the script is already present.
 *
 * Why record at boot instead of compute the name in the dashboard:
 * SilverBullet's `deriveDbName` depends on `spaceFolderPath`,
 * `document.baseURI`, AND the encryption key. The dashboard could
 * reproduce the formula, but the recorder is resilient to any future
 * upstream change in that formula \u2014 we work from observed reality, not
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
 * (~50\u2013200 ms network) before reading `navigator.serviceWorker.controller`
 * \u2014 by that point the SW is registered, active, claimed (via the
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
  // \u2014 falling through to SB without a key in the SW would silently boot
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
 * Cookies are matched by name only \u2014 the value is always "1" set by the
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
 * not appear in the SB UI's space listing — they would clutter the
 * tree, slow initial sync, and confuse the user.
 *
 * Server-side filter (here) is the canonical enforcement point because
 * the SB binary embeds its own listing logic and we cannot reach in
 * to add an exclude pattern. Treeview UI exclusion (AC7) is a parallel
 * surface guard for the editor's tree pane.
 *
 * Fail-safe: returns the input string unchanged on any parse error or
 * if the body is not a JSON array — never breaks a 200 response just
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

export function validateVaultRoute(request: Request): VaultRouteResult {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/vault\/([^/]+)(\/.*)$/);

  if (!match) {
    return { isVaultRoute: false };
  }

  const sessionId = match[1];
  const remainingPath = match[2];
  const upgradeHeader = request.headers.get('Upgrade');
  const isWebSocket = upgradeHeader?.toLowerCase() === 'websocket';

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return {
      isVaultRoute: true,
      errorResponse: new Response(
        JSON.stringify({ error: 'Invalid session ID format', code: 'INVALID_SESSION' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    };
  }

  return { isVaultRoute: true, sessionId, remainingPath, isWebSocket };
}

/**
 * Forward a vault HTTP or WebSocket request to the in-container
 * SilverBullet server.
 *
 * Auth + rate limit chain is the same as `handleWebSocketUpgrade` in
 * terminal.ts. WebSocket upgrades share the same per-user rate-limit
 * key (`ws-connect:<email>`) — a vault edit session is the same kind
 * of long-lived browser WS as a terminal session and we do not want a
 * tab-spam attack to find a separate budget here.
 */
export async function handleVaultRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  routeResult: VaultRouteResult,
): Promise<Response> {
  const clientRequestId = request.headers.get('X-Request-ID');
  const requestId = (clientRequestId && REQUEST_ID_PATTERN.test(clientRequestId))
    ? clientRequestId
    : crypto.randomUUID().slice(0, REQUEST_ID_LENGTH);

  const { sessionId, remainingPath, isWebSocket } = routeResult;
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
  };

  if (!sessionId || !remainingPath) {
    return new Response(
      JSON.stringify({ error: 'Invalid routing result', code: 'INVALID_ROUTING' }),
      { status: 500, headers: jsonHeaders },
    );
  }

  // Service Worker registration fetches arrive without the session cookie
  // (Chrome 76+ omits credentials on the SW script fetch even for same-
  // origin same-site requests), so the normal auth chain would return 401
  // and registration would fail forever. Serve the key-shim SW directly
  // from the Worker to satisfy the browser's registration handshake without
  // round-tripping to the container; the SW JS is identical for every
  // session and the per-session encryption key arrives later via postMessage
  // from the auth-gated bootstrap-hop page. See
  // VAULT_KEY_SHIM_SERVICE_WORKER_JS for context.
  if (isServiceWorkerRegistration(request, remainingPath)) {
    return new Response(VAULT_KEY_SHIM_SERVICE_WORKER_JS, {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-cache',
        'X-Request-ID': requestId,
      },
    });
  }

  // Browser WS upgrade requires Origin; CLI clients without Sec-Fetch-Mode
  // are exempted (matches terminal.ts behaviour).
  if (isWebSocket) {
    const isBrowserClient = !!request.headers.get('Sec-WebSocket-Key')
      && !!request.headers.get('Sec-Fetch-Mode');
    if (isBrowserClient && !request.headers.get('Origin')) {
      return new Response('Origin header required for browser WebSocket connections', {
        status: 403,
        headers: jsonHeaders,
      });
    }
  }

  // CORS origin check on every request — vault is reachable from any
  // tab the user opens, and we want to keep the same allowlist as the
  // rest of the app rather than minting a new policy here.
  const origin = request.headers.get('Origin');
  let originValidated = false;
  if (origin) {
    const originAllowed = await isAllowedOrigin(origin, env);
    if (!originAllowed) {
      logger.warn('Vault request rejected: origin not allowed', { origin });
      return new Response(
        JSON.stringify({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }),
        { status: 403, headers: jsonHeaders },
      );
    }
    originValidated = true;
  } else if (inferOriginValidated(request)) {
    // REQ-VAULT-009 AC1: state-changing request with no Origin header
    // is same-origin by Fetch-spec semantics; treat as validated so the
    // downstream CSRF synthesiser attaches X-Requested-With and the
    // authenticateRequest CSRF guard does not reject the SB attachment
    // upload (PUT /api/vault/<sid>/Inbox/<file>).
    originValidated = true;
  }

  // Hoisted out of the inner try so line 342's container.fetch can forward
  // the same body-owning Request that authenticateRequest received. The
  // original `request` body is a one-shot ReadableStream; once the CSRF
  // synthesiser builds a clone via `new Request(request, { headers })`,
  // the original is disturbed and any later `new Request(url, request)`
  // throws "This ReadableStream is disturbed". Forwarding `requestForAuth`
  // instead means a PUT body is read exactly once: by the container fetch.
  // For GETs and unvalidated-origin requests, the helper returns `request`
  // unchanged, so this is a no-op there.
  let requestForAuth = request;
  try {
    let user;
    let bucketName;
    try {
      // SilverBullet's client.js writes pages via PUT/DELETE/PATCH without
      // `X-Requested-With`. See `maybeSynthesizeCsrfHeader` for the full
      // security analysis; safety is enforced inside the helper, not by
      // statement ordering here.
      requestForAuth = maybeSynthesizeCsrfHeader(request, originValidated);
      ({ user, bucketName } = await authenticateRequest(requestForAuth, env));
    } catch (err) {
      if (err instanceof AuthError) {
        return new Response(JSON.stringify({ error: err.message, code: 'AUTH_FAILED' }),
          { status: 401, headers: jsonHeaders });
      }
      if (err instanceof ForbiddenError) {
        return new Response(JSON.stringify({ error: err.message, code: 'FORBIDDEN' }),
          { status: 403, headers: jsonHeaders });
      }
      throw err;
    }

    const effectiveTier = getEffectiveTier(
      user.subscriptionTier,
      user.accessTier,
      user.billingStatus,
      user.billingPeriodEnd,
    );
    if (isSaasModeActive(env.SAAS_MODE) && !isActiveUser(effectiveTier)) {
      const code = effectiveTier === 'blocked' ? 'BLOCKED' : 'PENDING';
      return new Response(JSON.stringify({ error: 'Access denied', code }),
        { status: 403, headers: jsonHeaders });
    }

    const containerId = getContainerId(bucketName, sessionId);

    // Session ownership: KV get on the session key for this bucket.
    // If KV does not have it under this bucket, the user does not own
    // the session (different bucket, or session never existed).
    const sessionKey = getSessionKey(bucketName, sessionId);
    const session = await env.KV.get<Session>(sessionKey, 'json');
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }),
        { status: 404, headers: jsonHeaders });
    }
    if (session.status === 'stopped') {
      return new Response(JSON.stringify({ error: 'Container stopped', code: 'CONTAINER_STOPPED' }),
        { status: 503, headers: jsonHeaders });
    }

    const container = getContainer(env.CONTAINER, containerId);
    const warmProbe = await safeCheckContainerHealth(container, containerId);
    if (!warmProbe.healthy) {
      return new Response(JSON.stringify({ error: 'Container not ready', code: 'CONTAINER_NOT_READY' }),
        { status: 503, headers: jsonHeaders });
    }

    if (env.STRESS_TEST_MODE !== 'active') {
      // Vault edits use long-lived WS for sync. Share the WS rate-limit
      // bucket with terminal so the per-user budget is single-keyed
      // (`ws-connect:<email>`) instead of fragmenting across tab types.
      // Apply the rate-limit only to WS upgrades; static HTTP fetches
      // for the SilverBullet shell would otherwise burn the budget on
      // page load (~30 asset requests).
      if (isWebSocket) {
        const wsRateResult = await checkRateLimit({
          kv: env.KV,
          key: `ws-connect:${user.email}`,
          limit: WS_RATE_LIMIT_MAX_CONNECTIONS,
          windowMs: WS_RATE_LIMIT_WINDOW_MS,
          ttlSeconds: WS_RATE_LIMIT_TTL_SECONDS,
        });
        if (!wsRateResult.allowed) {
          logger.warn('Vault WS rate limit exceeded', { email: user.email, count: wsRateResult.count });
          return new Response(null, {
            status: 429,
            headers: { ...jsonHeaders, 'Retry-After': String(wsRateResult.retryAfterSec) },
            webSocket: undefined,
          });
        }
      }
    }

    // Bump session lastAccessedAt out of band — vault edits should keep
    // the session alive the same way terminal activity does.
    ctx.waitUntil((async () => {
      const fresh = await env.KV.get<Session>(sessionKey, 'json');
      if (fresh) {
        const touched = { ...fresh, lastAccessedAt: new Date().toISOString() };
        await putSessionWithMetadata(env.KV, sessionKey, touched);
      }
    })().catch((err) => logger.warn('Failed to update lastAccessedAt', { error: toErrorMessage(err) })));

    // REQ-VAULT-008 AC5: the codeflare bootstrap-hop short-circuit. This
    // route is auth-gated by the chain above but never reaches the
    // container — we render the hop HTML with the encryption key embedded
    // and return it directly. The hop registers the key-shim service
    // worker, posts the key, sets the bootstrap cookie, and redirects to
    // /api/vault/<sid>/ so SB can boot with encryption already wired.
    if (remainingPath === '/.codeflare-bootstrap' && !isWebSocket) {
      try {
        const vaultEncryptionKey = await (container as unknown as {
          ensureVaultKey: () => Promise<string>;
        }).ensureVaultKey();
        const html = injectVaultBootstrapHopHtml(sessionId, vaultEncryptionKey);
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Request-ID': requestId,
          },
        });
      } catch (err) {
        logger.error('vault bootstrap-hop render failed', toError(err));
        return new Response(
          JSON.stringify({ error: 'Vault bootstrap failed', code: 'VAULT_BOOTSTRAP_FAILED' }),
          { status: 500, headers: jsonHeaders },
        );
      }
    }

    if (remainingPath === '/.vault-key' && !isWebSocket && request.method === 'GET') {
      try {
        const vaultEncryptionKey = await (container as unknown as {
          ensureVaultKey: () => Promise<string>;
        }).ensureVaultKey();
        return new Response(JSON.stringify({ key: vaultEncryptionKey }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Request-ID': requestId,
          },
        });
      } catch (err) {
        logger.error('vault key recovery failed', toError(err));
        return new Response(JSON.stringify({ error: 'Key recovery failed' }),
          { status: 500, headers: jsonHeaders });
      }
    }

    // REQ-VAULT-008 AC6: on the SB shell paths (`/` and `/index.html`),
    // redirect to the bootstrap-hop when the per-session bootstrap cookie
    // is absent. The hop sets the cookie before redirecting back here, so
    // subsequent shell-path requests fall straight through to the proxy.
    // Without this redirect SB boots, finds no SW key, and silently runs
    // unencrypted -- the exact regression REQ-VAULT-008 AC5 forbids.
    const isShellPathPre =
      remainingPath === '/' || remainingPath === '/index.html';
    if (isShellPathPre && !isWebSocket && request.method === 'GET' && !hasVaultBootstrapCookie(request)) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/api/vault/${sessionId}/.codeflare-bootstrap`,
          'Cache-Control': 'no-store',
          'X-Request-ID': requestId,
        },
      });
    }

    // Rewrite the URL: strip the `/api/vault/<sid>` prefix so the
    // container's HTTP server sees `/vault/<remaining>`. The in-container
    // handler at host/src/server.ts strips the `/vault` prefix once more
    // before proxying to 127.0.0.1:3030, leaving SilverBullet to handle
    // a clean `/<remaining>` path.
    const vaultUrl = new URL(request.url);
    vaultUrl.pathname = '/vault' + remainingPath;

    logger.info('Forwarding vault request to container', {
      email: user.email,
      containerId,
      pathname: vaultUrl.pathname,
      method: request.method,
      isWebSocket: !!isWebSocket,
    });

    // Forward the auth-validated request (NOT the original `request`): see
    // the `let requestForAuth = request` comment above. Using `request`
    // here triggers "ReadableStream is disturbed" on PUT/POST/PATCH because
    // the CSRF synthesiser has already consumed the body to build its
    // header-rewritten clone. WebSocket upgrades flow through this same
    // line: `maybeSynthesizeCsrfHeader` is a no-op for GET (and WS upgrades
    // are always GET), so `requestForAuth === request` for the WS case and
    // the Upgrade / Sec-WebSocket-* headers are preserved verbatim.
    const response = await container.fetch(new Request(vaultUrl.toString(), requestForAuth));

    // SilverBullet 2.8.0 emits `<base href="/" />` in its index HTML so
    // every relative asset reference (e.g. `.client/client.js`) resolves
    // against the worker root, where the Worker has no route handler and
    // returns 404 - producing the "white screen" symptom under the
    // /api/vault/:sid/ subpath proxy. SilverBullet supports `SB_URL_PREFIX`
    // to render `<base href="<prefix>/" />`, but the prefix is per-session
    // (the worker knows :sid, the container does not), so the container
    // can't bake it in at supervisor start. Rewriting the response here
    // is the per-session adapter: replace the bare `<base href="/" />`
    // with the session-prefixed equivalent so the browser resolves
    // assets back through `/api/vault/<sid>/.client/...`.
    //
    // Scope: any text/html response is eligible. SilverBullet 2.8 serves
    // its SPA shell as a catch-all (every non-API path returns the same
    // shell HTML), so a `location.reload()` from the SB client lands on
    // whatever page path the user was viewing (`/Notes/Today`, not `/`),
    // and the rewrite MUST fire there too. Previously the rewrite was
    // gated to `/` and `/index.html` only, which meant a reload at any
    // deeper path returned the shell with the bare `<base href="/" />`,
    // every relative fetch from client.js then resolved to the Worker
    // root, and the tab went blank with all subsequent writes 404'ing.
    // The text/html guard alone is sufficient: SilverBullet's API
    // endpoints (`.fs/`, `index.json`, `.attachment/`) return
    // text/markdown / application/json / image-mime / etc., never
    // text/html, so we never rewrite an API payload.
    //
    // Header hygiene on rewrite: drop both Content-Length (body length
    // changed) and Content-Encoding (response.text() auto-decompresses
    // gzip/br upstream, so the rewritten body is plain text - leaving
    // the original encoding header would trigger ERR_CONTENT_DECODING
    // _FAILED in the browser).
    //
    // Observability: log a warning when the rewrite runs on a body
    // that did NOT contain `<base href="/" />` (i.e. the replace was a
    // no-op), so a future SilverBullet template change (single-quoted
    // href, added attribute, etc.) surfaces as a logged signal instead
    // of a silent white-screen regression.
    const contentType = response.headers.get('content-type') ?? '';

    // REQ-VAULT-008 AC3: inject the per-session vault encryption key into
    // SilverBullet's BootConfig response. The DO is the canonical key
    // source - SB sees the key through this same authenticated channel
    // and uses it as the IDB encryption key without ever showing the
    // user a passphrase prompt. We treat any 2xx /.config response as
    // injection-eligible regardless of upstream content-type because
    // SB's Go server has shipped both application/json and text/plain
    // for this endpoint across versions; the JSON.parse inside
    // injectVaultEncryptionConfig fails loud if the body is not JSON.
    if (remainingPath === '/.config' && response.ok) {
      try {
        const vaultEncryptionKey = await (container as unknown as {
          ensureVaultKey: () => Promise<string>;
        }).ensureVaultKey();
        const body = await response.text();
        const rewritten = injectVaultEncryptionConfig(body, vaultEncryptionKey);
        const headers = new Headers(response.headers);
        // Drop body-shape headers (we rewrote the body so length/encoding
        // no longer apply) AND cache-validators (etag, last-modified)
        // because they describe the upstream un-rewritten body. A
        // browser SW with a stored copy would otherwise serve the WRONG
        // body on a 304 hit (the un-injected variant, missing the
        // encryption key).
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('etag');
        headers.delete('last-modified');
        headers.set('content-type', 'application/json');
        return new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (err) {
        logger.error('vault /.config injection failed', toError(err));
        return new Response(JSON.stringify({
          error: 'Vault config injection failed',
          code: 'VAULT_CONFIG_INJECT_FAILED',
        }), { status: 500, headers: jsonHeaders });
      }
    }

    // REQ-VAULT-015 AC1: strip graphify-out/** entries from SB's space
    // listing. SB 2.x serves the listing as `index.json` (legacy) and
    // `/.fs/` (newer); both endpoints return a JSON array of file
    // metadata. The filter is a no-op for any other JSON shape.
    if (
      response.ok &&
      (remainingPath === '/index.json' || remainingPath === '/.fs' || remainingPath === '/.fs/')
    ) {
      const body = await response.text();
      const filtered = filterVaultFsListing(body);
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(filtered, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (contentType.includes('text/html')) {
      return rewriteVaultHtmlResponse(response, sessionId, remainingPath, vaultUrl.pathname, contentType, logger);
    }
    return response;
  } catch (err) {
    logger.error('Vault request error', toError(err));
    return new Response(JSON.stringify({
      error: 'Vault request failed',
      code: 'VAULT_REQUEST_FAILED',
    }), { status: 500, headers: jsonHeaders });
  }
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables & { requestId: string } }>();

app.use('*', authMiddleware);

/**
 * GET /api/vault/:sessionId/status
 *
 * Thin status check. Returns whether the container is up and whether
 * SilverBullet is reachable on its in-container port. The Header.tsx
 * "Open vault" button can call this to disable itself when SilverBullet
 * is still warming up rather than opening a tab to a 503.
 */
app.get('/:sessionId/status', async (c) => {
  const bucketName = c.get('bucketName');
  const sessionId = c.req.param('sessionId');

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format', code: 'INVALID_SESSION' }, 400);
  }

  const sessionKey = getSessionKey(bucketName, sessionId);
  const session = await c.env.KV.get<Session>(sessionKey, 'json');
  if (!session) {
    throw new NotFoundError('Session');
  }

  try {
    const containerId = getContainerId(bucketName, sessionId);
    const container = getContainer(c.env.CONTAINER, containerId);
    const healthResult = await safeCheckContainerHealth(container, containerId);

    if (!healthResult.healthy) {
      return c.json({
        session,
        containerRunning: false,
        vaultReady: false,
      });
    }

    let vaultReady = false;
    try {
      const probe = await container.fetch(
        new Request('http://container/vault/', { method: 'GET' }),
      );
      vaultReady = probe.ok;
    } catch {
      // Container is healthy but SilverBullet supervisor may still be
      // starting up — report not-ready rather than 500.
    }

    return c.json({
      session,
      containerRunning: true,
      vaultReady,
      url: `/api/vault/${sessionId}/`,
    });
  } catch (_err) {
    return c.json({
      session,
      containerRunning: false,
      vaultReady: false,
      url: `/api/vault/${sessionId}/`,
    });
  }
});

export default app;
