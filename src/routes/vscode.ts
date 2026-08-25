/**
 * Browser IDE routes -- proxy from the Worker to in-container code-server.
 *
 * The browser retains `/api/vscode/<sessionId>/` as its session-scoped location.
 * After this route authenticates and validates the request, it replaces any
 * client forwarding metadata with canonical host/protocol identity and sends
 * the external path unchanged to the container host. That trusted host strips
 * only the exact current-session prefix before forwarding to loopback
 * code-server. No second auth system, HTML graft, or public listener is added.
 *
 * Session-keyed only (REQ-IDE-002): the sessionId in the URL is the sole
 * container selector -- the deliberate opposite of the Vault's bucket-stable
 * serving (REQ-VAULT-021). This is what isolates each session's editor.
 *
 * Auth chain reuses the Vault's extracted, session-safe guards:
 *   origin allowlist -> authenticate (+CSRF synth) -> active tier ->
 *   session ownership -> container health -> WS rate limit -> container.fetch.
 * The container.fetch wrapper injects the container-auth Bearer, so the
 * in-container host boundary accepts the forwarded request.
 *
 * Implements REQ-IDE-001, REQ-IDE-002, REQ-IDE-003.
 */
import { getContainer } from '@cloudflare/containers';
import type { Env, Session } from '../types';
import { putSessionEditorState } from '../lib/kv-keys';
import {
  REQUEST_ID_LENGTH,
  REQUEST_ID_PATTERN,
  WS_RATE_LIMIT_WINDOW_MS,
  WS_RATE_LIMIT_MAX_CONNECTIONS,
  WS_RATE_LIMIT_TTL_SECONDS,
} from '../lib/constants';
import { checkRateLimit } from '../lib/rate-limit-core';
import { getContainerId, safeCheckContainerHealth } from '../lib/container-helpers';
import { createLogger } from '../lib/logger';
import { toError, toErrorMessage } from '../lib/error-types';
import { checkVaultOrigin, authenticateVaultRequest, assertActiveTier } from './vault/auth';
import { assertSessionOwnership } from './vault/access';
import type { VscodeRouteResult } from './vscode-validation';

// Re-export the boundary parser so src/index.ts imports the route pair from
// one module, mirroring the vault.ts re-export of validateVaultRoute.
export { validateVscodeRoute } from './vscode-validation';
export type { VscodeRouteResult } from './vscode-validation';

const logger = createLogger('vscode');

/**
 * The container-warming page and its bound.
 *
 * The IDE opens in a bare `_blank` tab, so whatever this returns is rendered as
 * a document: a JSON error body reaches the user as raw machine text. The
 * in-container warming page (host/src/vscode-proxy.ts) never gets the chance to
 * handle this, because the health probe below fails before the request can be
 * forwarded at all.
 *
 * The Worker holds no per-session state, so the episode's start time rides in the
 * query string. A meta refresh cannot measure itself -- each reload is a fresh
 * document -- and an attempt count cannot stand in for a clock here, because
 * every attempt also pays a container health probe of unpredictable duration.
 * Carrying the start instead makes the elapsed time real, the bound an actual
 * duration, and this page comparable with its in-container twin, which derives
 * its number the same way.
 *
 * A start in the query string is client-controlled, but forging an older one only
 * makes that tab give up sooner: it is the client's own retry it is shortening.
 * It is also part of the tab's document URL, which is why the success path
 * redirects it away (see `redirectAwayFromWarmParam`): a tab left sitting on an
 * exhausted start would render the give-up page instantly on every later reload,
 * including while a fresh container warms up perfectly normally -- a permanent
 * failure state that the page's own "reload to try again" cannot escape.
 */
const WARM_PARAM = 'cf_since';
const WORKSPACE_SELECTOR_KEYS = Object.freeze(['folder', 'workspace', 'ew']);
const WARM_GIVE_UP_MS = 120_000;
const WARM_REFRESH_SECONDS = 3;

function warmingPage(url: URL, startedAt: number, requestId: string): Response {
  // The most failure-prone path on this route is the one that most needs a
  // correlation id, so it carries the same X-Request-ID as every other response.
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'X-Request-ID': requestId };
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= WARM_GIVE_UP_MS) {
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>Session not ready</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>The session container did not become ready. Reload to try again, or restart the session.</p></body></html>',
      { status: 504, headers },
    );
  }
  const next = new URL(url);
  next.searchParams.set(WARM_PARAM, String(startedAt));
  const target = escapeAttribute(`${next.pathname}${next.search}`);
  const seconds = Math.floor(elapsedMs / 1000);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="${WARM_REFRESH_SECONDS};url=${target}"><meta name="color-scheme" content="dark light"><title>Starting session</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><p>Starting the session container&hellip; ${seconds}s</p></body></html>`,
    { status: 503, headers },
  );
}

/**
 * The URL serializer already percent-encodes `"`, `<` and `>` in a path or query,
 * so this is belt-and-braces rather than the only thing standing between the
 * timestamp and the attribute -- but the escape should not depend on that
 * invariant holding in a future URL implementation.
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Once the container answers, take the episode start back out of the tab's URL.
 * Without this the NEXT cold start inherits an already-spent clock, and a tab
 * that reached the bound never shows the warming page again.
 */
function redirectAwayFromWarmParam(url: URL, requestId: string): Response {
  const clean = new URL(url);
  clean.searchParams.delete(WARM_PARAM);
  return new Response(null, {
    status: 302,
    headers: { Location: clean.toString(), 'X-Request-ID': requestId },
  });
}

/** This episode's start: the one in the URL, or now for a tab that has not waited yet. */
function warmStartedAt(url: URL): number {
  const now = Date.now();
  const raw = Number(url.searchParams.get(WARM_PARAM));
  // A future timestamp is the one forged value worth rejecting: it would hold the
  // tab on the warming page indefinitely rather than merely cutting its own retry.
  return Number.isSafeInteger(raw) && raw > 0 && raw <= now ? raw : now;
}

/** The Worker-only warming marker must never reach the container host. */
function stripWarmParam(url: URL): string {
  if (!url.searchParams.has(WARM_PARAM)) return url.toString();
  const clean = new URL(url);
  clean.searchParams.delete(WARM_PARAM);
  return clean.toString();
}

/**
 * Forward a browser-IDE HTTP or WebSocket request to the in-container host,
 * which performs the exact session-prefix strip before code-server.
 */
export async function handleVscodeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  routeResult: VscodeRouteResult,
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

  if (!remainingPath || !sessionId) {
    return new Response(
      JSON.stringify({ error: 'Invalid routing result', code: 'INVALID_ROUTING' }),
      { status: 500, headers: jsonHeaders },
    );
  }
  const requestUrl = new URL(request.url);
  if (WORKSPACE_SELECTOR_KEYS.some((key) => requestUrl.searchParams.has(key))) {
    return new Response(
      JSON.stringify({ error: 'Browser IDE workspace selectors are not allowed', code: 'VSCODE_WORKSPACE_SELECTOR_FORBIDDEN' }),
      { status: 400, headers: jsonHeaders },
    );
  }

  // Browser WS upgrade requires Origin; non-browser clients without
  // Sec-Fetch-Mode are exempted (matches terminal.ts / vault.ts).
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

  // Hoisted so the container.fetch below forwards the same body-owning Request
  // that authenticateRequest received (avoids "ReadableStream is disturbed" on
  // PUT/POST once the CSRF synthesiser clones the body). For GETs the helper
  // returns `request` unchanged, so this is a no-op there.
  let requestForAuth = request;

  const originResult = await checkVaultOrigin(request, env, jsonHeaders);
  if ('errorResponse' in originResult) return originResult.errorResponse;

  try {
    const authResult = await authenticateVaultRequest(
      request, originResult.originValidated, env, jsonHeaders,
    );
    if ('errorResponse' in authResult) return authResult.errorResponse;
    const { user, bucketName } = authResult;
    requestForAuth = authResult.requestForAuth;

    const tierRejection = assertActiveTier(user, env, jsonHeaders);
    if (tierRejection) return tierRejection;

    const containerId = getContainerId(bucketName, sessionId);

    const ownershipResult = await assertSessionOwnership(env, bucketName, sessionId, jsonHeaders);
    if ('errorResponse' in ownershipResult) return ownershipResult.errorResponse;
    const { sessionKey } = ownershipResult;

    const container = getContainer(env.CONTAINER, containerId);
    const warmProbe = await safeCheckContainerHealth(container, containerId);
    if (!warmProbe.healthy) {
      // A WebSocket upgrade cannot render a page, so it keeps the machine-readable
      // 503 its client expects. Everything else gets the HTML: this route cannot
      // tell a document navigation from a subresource fetch, and a 503 is a 503
      // to a subresource either way, so serving the page to both is harmless.
      if (isWebSocket) {
        return new Response(JSON.stringify({ error: 'Container not ready', code: 'CONTAINER_NOT_READY' }),
          { status: 503, headers: jsonHeaders });
      }
      return warmingPage(requestUrl, warmStartedAt(requestUrl), requestId);
    }

    // Healthy again: get the episode start out of the tab's address bar before
    // the editor loads, so the next cold start begins from a clean slate.
    if (!isWebSocket && request.method === 'GET' && requestUrl.searchParams.has(WARM_PARAM)) {
      return redirectAwayFromWarmParam(requestUrl, requestId);
    }

    if (env.STRESS_TEST_MODE !== 'active' && isWebSocket) {
      // The VS Code server protocol is a long-lived browser WS; share the
      // per-user WS rate-limit bucket with terminal and vault so a tab-spam
      // attack cannot find a separate budget here.
      const wsRateResult = await checkRateLimit({
        kv: env.KV,
        key: `ws-connect:${user.email}`,
        limit: WS_RATE_LIMIT_MAX_CONNECTIONS,
        windowMs: WS_RATE_LIMIT_WINDOW_MS,
        ttlSeconds: WS_RATE_LIMIT_TTL_SECONDS,
      });
      if (!wsRateResult.allowed) {
        logger.warn('Vscode WS rate limit exceeded', { email: user.email, count: wsRateResult.count });
        return new Response(null, {
          status: 429,
          headers: { ...jsonHeaders, 'Retry-After': String(wsRateResult.retryAfterSec) },
        });
      }
    }

    // Preserve the public path/query and body for the container host, but never
    // trust client-supplied forwarding identity. The request URL has already
    // passed the route and Origin/auth chain, so its URL is canonical for the
    // external host/protocol while its allowlisted caller Origin is preserved. WS handshake
    // headers remain intact; only forwarding metadata is replaced.
    logger.info('Forwarding vscode request to container', {
      email: user.email,
      containerId,
      pathname: new URL(request.url).pathname,
      method: request.method,
      isWebSocket: !!isWebSocket,
    });
    const forwardedRequest = new Request(stripWarmParam(requestUrl), requestForAuth);
    for (const name of Array.from(forwardedRequest.headers.keys())) {
      const lower = name.toLowerCase();
      if (lower === 'forwarded' || lower.startsWith('x-forwarded-')) {
        forwardedRequest.headers.delete(name);
      }
    }
    forwardedRequest.headers.set('X-Forwarded-Host', requestUrl.host);
    forwardedRequest.headers.set('X-Forwarded-Proto', requestUrl.protocol.slice(0, -1));
    // Preserve the caller Origin after the allowlist check above. code-server
    // independently compares it with the canonical external Host; synthesizing
    // a same-origin value here would neutralize that defense-in-depth check.
    if (!request.headers.has('Origin')) forwardedRequest.headers.delete('Origin');
    const response = await container.fetch(forwardedRequest);

    // Successful editor traffic is direct evidence that the editor is ready.
    // Readiness has its own KV record so this event cannot replace a concurrent
    // rename, metrics update, or lifecycle transition on the durable session.
    // Editor input recency remains owned by the host activity probe and metrics
    // overlay; proxy traffic does not reorder durable session creation history.
    if (response.status < 400) {
      ctx.waitUntil(putSessionEditorState(env.KV, bucketName, sessionId, {
        editorReady: true,
      }).catch((err) => logger.warn('Failed to reassert editor readiness', { error: toErrorMessage(err) })));
    }
    return response;
  } catch (err) {
    logger.error('vscode proxy failed', toError(err));
    return new Response(
      JSON.stringify({ error: 'Browser IDE unreachable', code: 'VSCODE_PROXY_FAILED' }),
      { status: 500, headers: jsonHeaders },
    );
  }
}
