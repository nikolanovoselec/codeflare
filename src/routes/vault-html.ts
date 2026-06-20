/**
 * Vault HTML/JS rewriting + the service-worker request selectors.
 *
 * Extracted from src/routes/vault.ts (CF-002) so the routing/auth module
 * stays focused on the request chain. This module owns every byte the
 * Worker injects into, or serves to, the browser on behalf of the
 * in-container SilverBullet editor:
 *
 *   - isServiceWorkerRegistration / isServiceWorkerContextFetch: the
 *     SW-registration and SW-context request selectors. The worker bytes
 *     served for registration live in src/routes/vault-native-sw.ts (AD69).
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
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../lib/access';

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
 * CF-019: when an independent double-submit CSRF cookie is present, this
 * function ALSO echoes its value into the X-Vault-Csrf header on the clone.
 * The Worker reading the cookie and synthesising the matching header has the
 * SAME trust basis as the X-Requested-With synthesis above (originValidated),
 * so SilverBullet's client.js / SPA writes - which cannot set custom headers
 * themselves - satisfy the double-submit check in authenticateRequest. A
 * genuine cross-site attacker never reaches this branch: they cannot produce
 * an allowlisted Origin (or the same-origin no-Origin carve-out) for a
 * cross-site request, so originValidated is false and the request passes
 * through unchanged to hit the cookie/header layer directly.
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
  // CF-019: echo the CSRF cookie into the X-Vault-Csrf header for origin-
  // validated writes when the client did not supply it. This is what makes the
  // token defense-in-depth rather than an independent factor (see access.ts):
  // the Origin allowlist is the primary CSRF defense.
  const csrfCookie = readCsrfCookie(request);
  const needsCsrfEcho = !!csrfCookie && !request.headers.has(CSRF_HEADER_NAME);
  const needsXrwEcho = !request.headers.has('X-Requested-With');
  if (!needsCsrfEcho && !needsXrwEcho) return request;
  const headers = new Headers(request.headers);
  if (needsXrwEcho) headers.set('X-Requested-With', 'XMLHttpRequest');
  if (needsCsrfEcho) headers.set(CSRF_HEADER_NAME, csrfCookie as string);
  return new Request(request, { headers });
}

/**
 * CF-019: append a Set-Cookie for the double-submit CSRF token to `headers`
 * when the request does not already carry one. Called on safe (GET) vault
 * responses so the browser holds a token before issuing any state-changing
 * write. Mutates the passed Headers in place (caller owns a fresh Headers).
 *
 *   - HttpOnly: the value never needs to be read by page JS; the Worker echoes
 *     it into the request header itself (maybeSynthesizeCsrfHeader). HttpOnly
 *     keeps it out of reach of XSS-based exfiltration.
 *   - SameSite=Lax + Secure: standard CSRF cookie hardening.
 *   - Path=/api/vault/<sid>/: scoped to the session's vault namespace.
 *
 * No-op when the cookie is already present (stable token across the session).
 */
export function maybeIssueCsrfCookie(request: Request, headers: Headers, sessionId: string): void {
  if (readCsrfCookie(request)) return;
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  const token = crypto.randomUUID();
  headers.append(
    'Set-Cookie',
    `${CSRF_COOKIE_NAME}=${token}; Path=/api/vault/${sessionId}/; HttpOnly; SameSite=Lax; Secure`,
  );
}

/** Read the CF-019 double-submit CSRF cookie value, or null. */
function readCsrfCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === CSRF_COOKIE_NAME) return part.slice(idx + 1).trim() || null;
  }
  return null;
}

/**
 * Identify a browser-initiated Service Worker registration GET. The
 * `service-worker: script` request header is set by the user agent and is
 * a Fetch-spec forbidden header name today, so page JavaScript cannot
 * forge it via `fetch()`. The path-suffix check pins the SilverBullet-
 * served SW URL; any other path falls through to the normal auth chain.
 *
 * Cookie header is intentionally NOT checked. Chrome 76+ strips cookies
 * on SW registration fetches per spec, but Samsung Internet and other
 * Chromium forks may not. Serving the native worker (vault-native-sw.ts,
 * AD69) for this exact request regardless of cookie presence keeps
 * registration browser-agnostic; the response is open-source SilverBullet
 * frontend bytes plus the codeflare key-recovery graft, with no user data.
 * The `service-worker` header alone is sufficient security (forbidden
 * header, not forgeable by page JS).
 */
export function isServiceWorkerRegistration(request: Request, remainingPath: string | undefined): boolean {
  if (request.method !== 'GET') return false;
  if (remainingPath !== '/service_worker.js') return false;
  if (request.headers.get('service-worker') !== 'script') return false;
  return true;
}

/**
 * Identify a fetch issued from the Service Worker context rather than a
 * top-level browser navigation. SilverBullet's native service worker (now
 * served by the vault proxy, see VAULT_NATIVE_SERVICE_WORKER_JS) precaches
 * the shell `/` plus its `/.client/*` assets via `cache.addAll(...)` during
 * `install`. Those precache fetches carry `Sec-Fetch-Mode: no-cors` (or
 * `same-origin`), NOT `navigate` - the browser only sets `navigate` on
 * top-level document loads. The shell-path 302 to the bootstrap-hop is meant
 * for navigations; if it also fires on the SW precache fetch, `cache.addAll`
 * sees a redirect, rejects atomically, and `navigator.serviceWorker.ready`
 * hangs forever. Returning true here lets the dispatcher suppress that 302
 * for SW-context fetches so the precache resolves against the real shell.
 *
 * `Sec-Fetch-Mode` is a browser-set forbidden header (page JS cannot forge
 * it), the same trust basis already relied on at vault.ts for the WS Origin
 * gate. Fail-safe polarity: when the header is ABSENT (older browsers, exotic
 * WebViews, non-browser clients) this returns false, so the 302 still fires
 * and a real navigation is never accidentally served the raw shell without
 * the bootstrap hop. Only an explicit non-`navigate` mode suppresses it.
 *
 * Breadth is deliberate: every non-`navigate` mode (`no-cors`, `same-origin`,
 * `cors`, `websocket`) suppresses the 302, not just the `no-cors`/`same-origin`
 * the precache emits. This is safe because the suppression is applied AFTER the
 * full auth + session-ownership chain in handleVaultRequest, so it only changes
 * whether an already-authorized request is redirected to the hop vs. proxied -
 * it never exposes a path to an unauthenticated caller. The one functional
 * consequence is that a non-navigation same-origin GET to `/` (e.g. a prefetch)
 * would skip the hop; acceptable, since only top-level navigations need it.
 */
export function isServiceWorkerContextFetch(request: Request): boolean {
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (!mode) return false;
  return mode !== 'navigate';
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
 * It wraps page-context `indexedDB.open` and listens for matching
 * `codeflare-vault-idb-open` messages from the native service worker to
 * capture every database name SilverBullet opens that starts with `sb_`.
 * It persists the names into `localStorage["vault-session-<sid>-idbs"]`
 * as a JSON array. The
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
const VAULT_PREWARM_QUERY = 'codeflarePrewarm';
const VAULT_PREWARM_ID_QUERY = 'prewarmId';
export const VAULT_PREWARM_BRIDGE_MARKER = 'data-codeflare-vault-prewarm-bridge';
export const VAULT_PREWARM_FOCUS_GUARD_MARKER = 'data-codeflare-vault-prewarm-focus-guard';
export const VAULT_PREWARM_REQUIRED_FILES = ['CONFIG.md', 'Index.md', 'STYLES.md'] as const;

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
    'function record(name) {' +
    'if (typeof name !== "string" || name.indexOf("sb_") !== 0) return;' +
    'try {' +
    'var arr = JSON.parse(localStorage.getItem(key) || "[]");' +
    'if (!Array.isArray(arr)) arr = [];' +
    'if (arr.indexOf(name) === -1) {' +
    'arr.push(name);' +
    'localStorage.setItem(key, JSON.stringify(arr));' +
    '}' +
    '} catch (_) {}' +
    '}' +
    'var origOpen = indexedDB.open.bind(indexedDB);' +
    'indexedDB.open = function (name, version) {' +
    'record(name);' +
    'return origOpen(name, version);' +
    '};' +
    'if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === "function") {' +
    'navigator.serviceWorker.addEventListener("message", function (event) {' +
    'var data = event.data;' +
    'if (data && data.type === "codeflare-vault-idb-open") record(data.name);' +
    '});' +
    '}' +
    '} catch (_) {}' +
    '})();</script>';
  return html.replace('</head>', `${script}</head>`);
}

function readVaultPrewarmId(request: Request): string | null {
  const url = new URL(request.url);
  if (url.searchParams.get(VAULT_PREWARM_QUERY) !== '1') return null;
  const prewarmId = url.searchParams.get(VAULT_PREWARM_ID_QUERY);
  if (!prewarmId || prewarmId.length > 128) return null;
  if (!/^[A-Za-z0-9._~-]+$/.test(prewarmId)) return null;
  return prewarmId;
}

export function getVaultPrewarmRedirectSearch(request: Request): string {
  const prewarmId = readVaultPrewarmId(request);
  if (!prewarmId) return '';
  const params = new URLSearchParams({
    [VAULT_PREWARM_QUERY]: '1',
    [VAULT_PREWARM_ID_QUERY]: prewarmId,
  });
  return `?${params.toString()}`;
}

export function installVaultPrewarmNoFocus(windowRef: any, documentRef: any, prewarmId: string | null): boolean {
  try {
    function valid(value: any) {
      return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
    }
    let resolvedPrewarmId = prewarmId;
    if (!valid(resolvedPrewarmId)) {
      const SearchParams = windowRef.URLSearchParams || URLSearchParams;
      const params = new SearchParams(windowRef.location ? windowRef.location.search : '');
      if (params.get('codeflarePrewarm') === '1') resolvedPrewarmId = params.get('prewarmId');
    }
    if (!valid(resolvedPrewarmId)) return false;
    windowRef.__codeflareVaultPrewarmNoFocus = true;
    const noop = function () {};
    function replace(proto: any, name: string) {
      try {
        if (proto && typeof proto[name] === 'function') {
          Object.defineProperty(proto, name, { configurable: true, writable: true, value: noop });
        }
      } catch (_) {}
    }
    replace(windowRef.HTMLElement && windowRef.HTMLElement.prototype, 'focus');
    replace(windowRef.SVGElement && windowRef.SVGElement.prototype, 'focus');
    replace(windowRef.HTMLInputElement && windowRef.HTMLInputElement.prototype, 'select');
    replace(windowRef.HTMLTextAreaElement && windowRef.HTMLTextAreaElement.prototype, 'select');
    try { windowRef.focus = noop; } catch (_) {}
    if (documentRef && typeof documentRef.addEventListener === 'function') {
      documentRef.addEventListener('focusin', function (event: any) {
        try {
          const target = event.target;
          if (target && typeof target.blur === 'function') target.blur();
        } catch (_) {}
      }, true);
    }
    return true;
  } catch (_) {
    return false;
  }
}

export function injectVaultPrewarmFocusGuard(html: string, prewarmId?: string): string {
  if (html.includes(VAULT_PREWARM_FOCUS_GUARD_MARKER)) return html;
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (!headMatch || headMatch.index === undefined) return html;
  if (prewarmId !== undefined && (!prewarmId || prewarmId.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(prewarmId))) {
    throw new Error('injectVaultPrewarmFocusGuard: prewarmId must be a safe non-empty token');
  }
  const escapedId = prewarmId === undefined
    ? 'null'
    : JSON.stringify(prewarmId)
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '<\\!--')
      .replace(/[\u2028\u2029]/g, (m) => '\\u' + m.charCodeAt(0).toString(16));
  const focusGuardSource = installVaultPrewarmNoFocus.toString()
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/[\u2028\u2029]/g, (m) => '\\u' + m.charCodeAt(0).toString(16));
  const script = '<script ' + VAULT_PREWARM_FOCUS_GUARD_MARKER + '="1">(function () {(' +
    focusGuardSource + ')(window, document, ' + escapedId + ');})();</script>';
  const insertAt = headMatch.index + headMatch[0].length;
  return html.slice(0, insertAt) + script + html.slice(insertAt);
}

export function injectVaultPrewarmBridge(html: string, prewarmId?: string): string {
  if (html.includes(VAULT_PREWARM_BRIDGE_MARKER)) return html;
  if (!html.includes('</head>')) return html;
  if (prewarmId !== undefined && (!prewarmId || prewarmId.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(prewarmId))) {
    throw new Error('injectVaultPrewarmBridge: prewarmId must be a safe non-empty token');
  }
  const escapedId = prewarmId === undefined
    ? 'null'
    : JSON.stringify(prewarmId)
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '<\\!--')
      .replace(/[\u2028\u2029]/g, (m) => '\\u' + m.charCodeAt(0).toString(16));
  const requiredFilesJson = JSON.stringify(VAULT_PREWARM_REQUIRED_FILES);
  const script = '<script ' + VAULT_PREWARM_BRIDGE_MARKER + '="1">(function () {' +
    'var prewarmId = ' + escapedId + ';' +
    'var source = "codeflare-vault-prewarm";' +
    'var sid = null;' +
    'var requiredFiles = ' + requiredFilesJson + ';' +
    'var spaceSyncCompleted = false;' +
    'try {' +
    'if (!prewarmId) {' +
    'var params = new URLSearchParams(window.location.search);' +
    'if (params.get("codeflarePrewarm") === "1") prewarmId = params.get("prewarmId");' +
    '}' +
    'if (!prewarmId || prewarmId.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(prewarmId)) return;' +
    'var boot = window.__codeflareVaultBoot;' +
    'sid = boot && typeof boot.sessionId === "string" ? boot.sessionId : null;' +
    'if (!sid || !/^[a-z0-9]{8,24}$/.test(sid)) return;' +
    'window.sbRuntime = window.sbRuntime || {}; window.sbRuntime.headless = true;' +
    '} catch (_) { return; }' +
    'function post(status, message, proof) {' +
    'if (!window.parent || window.parent === window) return;' +
    'var payload = { source: source, prewarmId: prewarmId, status: status };' +
    'if (message) payload.message = message;' +
    'if (proof) payload.proof = proof;' +
    'window.parent.postMessage(payload, window.location.origin);' +
    '}' +
    'function proof(recordedDbs, hasDbApi, reason, swState) {' +
    'return { ready: !reason, reason: reason, recordedDbs: recordedDbs, hasIndexedDbDatabasesApi: hasDbApi, serviceWorkerState: swState };' +
    '}' +
    'function hasSpaceSyncCompleted() {' +
    'if (spaceSyncCompleted) return true;' +
    'try { return !!(window.client && window.client.fullSyncCompleted === true); } catch (_) { return false; }' +
    '}' +
    'if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === "function") {' +
    'navigator.serviceWorker.addEventListener("message", function (event) {' +
    'var data = event.data;' +
    'if (data && data.type === "space-sync-complete") spaceSyncCompleted = true;' +
    '});' +
    '}' +
    'async function checkIndexReadiness() {' +
    'try {' +
    'var client = window.client;' +
    'if (!client || client.systemReady !== true || client.pageListLoaded !== true) return false;' +
    'if (!client.clientSystem || client.clientSystem.scriptsLoaded !== true) return false;' +
    'if (!client.objectIndex || typeof client.objectIndex.hasFullIndexCompleted !== "function") return false;' +
    'if (client.mq && typeof client.mq.getQueueStats === "function") {' +
    'var stats = await client.mq.getQueueStats("indexQueue");' +
    'if (!stats || stats.queued !== 0 || stats.processing !== 0 || stats.dlq !== 0) return false;' +
    '} else if (client.mq && typeof client.mq.isQueueEmpty === "function" && !(await client.mq.isQueueEmpty("indexQueue"))) return false;' +
    'return await client.objectIndex.hasFullIndexCompleted();' +
    '} catch (_) { return false; }' +
    '}' +
    'async function checkContentReadiness() {' +
    'if (!hasSpaceSyncCompleted() || !(await checkIndexReadiness())) return null;' +
    'try {' +
    'var res = await fetch(".fs/", { cache: "no-store" });' +
    'if (!res || !res.ok) return null;' +
    'var list = await res.json();' +
    'if (!Array.isArray(list)) return null;' +
    'var names = {};' +
    'list.forEach(function (entry) { if (entry && typeof entry.name === "string") names[entry.name] = true; });' +
    'for (var i = 0; i < requiredFiles.length; i++) { if (!names[requiredFiles[i]]) return null; }' +
    'return { contentReady: true, spaceSyncCompleted: true, indexReady: true, requiredFiles: requiredFiles.slice(), listedFileCount: list.length };' +
    '} catch (_) { return null; }' +
    '}' +
    'function readRecorded(storage, sid) {' +
    'try {' +
    'var raw = storage.getItem("vault-session-" + sid + "-idbs");' +
    'if (!raw) return [];' +
    'var parsed = JSON.parse(raw);' +
    'if (!Array.isArray(parsed)) return [];' +
    'return parsed.filter(function (entry) { return typeof entry === "string"; });' +
    '} catch (_) { return []; }' +
    '}' +
    'function hasPrefix(recordedDbs, prefix) {' +
    'return recordedDbs.some(function (name) { return name.indexOf(prefix) === 0; });' +
    '}' +
    'async function findRegistration(sid) {' +
    'if (!navigator.serviceWorker) return null;' +
    'var scopePath = "/api/vault/" + encodeURIComponent(sid) + "/";' +
    'try { var direct = await navigator.serviceWorker.getRegistration(scopePath); if (direct) return direct; } catch (_) {}' +
    'try {' +
    'var regs = await navigator.serviceWorker.getRegistrations();' +
    'for (var i = 0; i < regs.length; i++) { if (regs[i].scope.indexOf(scopePath) !== -1) return regs[i]; }' +
    '} catch (_) {}' +
    'return null;' +
    '}' +
    'async function checkLocalReadiness(sid) {' +
    'var storage = null;' +
    'try { storage = window.localStorage || null; } catch (_) {}' +
    'var idb = null;' +
    'try { idb = window.indexedDB || null; } catch (_) {}' +
    'var hasDbApi = !!(idb && typeof idb.databases === "function");' +
    'var recordedDbs = storage ? readRecorded(storage, sid) : [];' +
    'if (!storage) return proof(recordedDbs, hasDbApi, "no-local-storage");' +
    'if (!idb) return proof(recordedDbs, hasDbApi, "no-indexeddb");' +
    'if (recordedDbs.length === 0) return proof(recordedDbs, hasDbApi, "no-recorder");' +
    'if (!hasPrefix(recordedDbs, "sb_data_")) return proof(recordedDbs, hasDbApi, "missing-sb-data");' +
    'if (!hasPrefix(recordedDbs, "sb_files_")) return proof(recordedDbs, hasDbApi, "missing-sb-files");' +
    'var reg = await findRegistration(sid);' +
    'var active = reg && reg.active ? reg.active : null;' +
    'if (!active) return proof(recordedDbs, hasDbApi, "missing-service-worker");' +
    'if (hasDbApi) {' +
    'try {' +
    'var dbs = await idb.databases();' +
    'var names = {};' +
    'dbs.forEach(function (db) { if (db && typeof db.name === "string") names[db.name] = true; });' +
    'var hasExistingDataDb = recordedDbs.some(function (name) { return name.indexOf("sb_data_") === 0 && names[name]; });' +
    'var hasExistingFilesDb = recordedDbs.some(function (name) { return name.indexOf("sb_files_") === 0 && names[name]; });' +
    'if (!hasExistingDataDb || !hasExistingFilesDb) return proof(recordedDbs, hasDbApi, "missing-idb-database", active.state);' +
    '} catch (_) { return proof(recordedDbs, hasDbApi, "missing-idb-database", active.state); }' +
    '}' +
    'return proof(recordedDbs, hasDbApi, null, active.state);' +
    '}' +
    'var inFlight = false;' +
    'var timer = window.setInterval(async function () {' +
    'if (inFlight) return;' +
    'inFlight = true;' +
    'try {' +
    'if (window.sbRuntime && window.sbRuntime.ready === true) {' +
    'var localProof = await checkLocalReadiness(sid);' +
    'var contentProof = localProof.ready === true ? await checkContentReadiness() : null;' +
    'if (localProof.ready === true && contentProof) {' +
    'localProof.contentReady = contentProof.contentReady;' +
    'localProof.spaceSyncCompleted = contentProof.spaceSyncCompleted;' +
    'localProof.indexReady = contentProof.indexReady;' +
    'localProof.requiredFiles = contentProof.requiredFiles;' +
    'localProof.listedFileCount = contentProof.listedFileCount;' +
    'window.clearInterval(timer);' +
    'post("ready", null, localProof);' +
    '}' +
    '}' +
    '} catch (e) {' +
    'window.clearInterval(timer);' +
    'post("error", e && e.message ? e.message : String(e));' +
    '} finally { inFlight = false; }' +
    '}, 250);' +
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

export function injectVaultBootstrapHopHtml(sessionId: string, vaultEncryptionKey: string, redirectSearch = ''): string {
  if (!vaultEncryptionKey) {
    throw new Error('injectVaultBootstrapHopHtml: vaultEncryptionKey must be non-empty');
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('injectVaultBootstrapHopHtml: sessionId must match SESSION_ID_PATTERN');
  }
  if (redirectSearch && !/^\?codeflarePrewarm=1&prewarmId=[A-Za-z0-9._%~-]+$/.test(redirectSearch)) {
    throw new Error('injectVaultBootstrapHopHtml: redirectSearch must be a sanitized prewarm query');
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
  const escapedRedirectSearch = escape(redirectSearch);
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
    'try { reg = await reg.update(); } catch (_) {}' +
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
    'location.replace(scope + ' + escapedRedirectSearch + ');' +
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
 * whose `name` starts with `graphify-out/` plus generated
 * `Raw/Graphs/*.html` visualisations. The vault contains agent-derived
 * graph artifacts (sometimes multi-MB graph.html) that must not appear
 * in the SB UI's space listing - they would clutter the tree, slow
 * initial sync, trigger useless document indexing, and confuse the user.
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
function isFilteredVaultListingName(name: string): boolean {
  if (name.startsWith('graphify-out/')) return true;
  return /^Raw\/Graphs\/[^/]+\.html$/i.test(name);
}

export function filterVaultFsListing(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) return body;
    const filtered = parsed.filter((entry) => {
      if (entry == null || typeof entry !== 'object') return true;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string') return true;
      return !isFilteredVaultListingName(name);
    });
    // Pass through the original body byte-for-byte when nothing was
    // filtered so any upstream ETag / cache-validation key the SB
    // binary may rely on stays intact (no-op safety).
    if (filtered.length === parsed.length) return body;
    return JSON.stringify(filtered);
  } catch {
    // CF-026: fail-safe - never break a 200 listing because the upstream
    // shape drifted; return the body untouched (see JSDoc fail-safe note).
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
  request?: Request,
): Promise<Response> {
  const body = await response.text();
  const { rewritten: baseRewritten, wasNoOp } = rewriteVaultBaseHref(body, sessionId);
  let rewritten = baseRewritten;

  const isShellPath = remainingPath === '/' || remainingPath === '/index.html';
  if (response.status === 200 && isShellPath) {
    try {
      rewritten = injectVaultBootScript(rewritten, { sessionId });
      rewritten = injectVaultIdbRecorder(rewritten);
      const prewarmId = request ? readVaultPrewarmId(request) ?? undefined : undefined;
      rewritten = injectVaultPrewarmFocusGuard(rewritten, prewarmId);
      rewritten = injectVaultPrewarmBridge(rewritten, prewarmId);
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
  // CF-019: issue the double-submit CSRF cookie on this safe (GET) HTML
  // response so the SPA holds a token before it issues any write. `request`
  // is optional only for the existing unit tests that call this helper
  // without it; the production call site (handleVaultRequest) always passes it.
  if (request && request.method === 'GET') {
    maybeIssueCsrfCookie(request, headers, sessionId);
  }
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
