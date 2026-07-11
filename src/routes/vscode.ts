/**
 * Browser IDE routes -- proxy from the Worker to the in-container OpenVSCode
 * Server that hosts the full VS Code editor over the session's ~/workspace.
 *
 * Mirrors the Vault proxy plumbing (src/routes/vault.ts) but is much simpler:
 * OpenVSCode is launched with --server-base-path=/api/vscode/<sessionId>, so it
 * builds its own asset + service-worker URLs and needs no HTML base-href graft,
 * no bootstrap hop, and no encryption/CSRF machinery of its own. The path is
 * forwarded to the container UNCHANGED (the base-path-native server expects its
 * own path); the in-container host (host/src/server.ts) forwards /api/vscode/*
 * to 127.0.0.1:13337 without stripping.
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
import { putSessionWithMetadata } from '../lib/kv-keys';
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
import { checkVaultOrigin, authenticateVaultRequest, assertActiveTier } from './vault-auth';
import { assertSessionOwnership } from './vault-access';
import type { VscodeRouteResult } from './vscode-validation';

// Re-export the boundary parser so src/index.ts imports the route pair from
// one module, mirroring the vault.ts re-export of validateVaultRoute.
export { validateVscodeRoute } from './vscode-validation';
export type { VscodeRouteResult } from './vscode-validation';

const logger = createLogger('vscode');

/**
 * Forward a browser-IDE HTTP or WebSocket request to the in-container
 * OpenVSCode Server.
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
      return new Response(JSON.stringify({ error: 'Container not ready', code: 'CONTAINER_NOT_READY' }),
        { status: 503, headers: jsonHeaders });
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
          webSocket: undefined,
        });
      }
    }

    // Keep the session alive on IDE activity, out of band (same as
    // terminal/vault): editing in the IDE should reset idle the same way.
    ctx.waitUntil((async () => {
      const fresh = await env.KV.get<Session>(sessionKey, 'json');
      if (fresh) {
        const touched = { ...fresh, lastAccessedAt: new Date().toISOString() };
        await putSessionWithMetadata(env.KV, sessionKey, touched);
      }
    })().catch((err) => logger.warn('Failed to update lastAccessedAt', { error: toErrorMessage(err) })));

    // Forward to the container with the path UNCHANGED. OpenVSCode runs with
    // --server-base-path=/api/vscode/<sessionId>, so it expects to receive its
    // own path; the in-container host forwards /api/vscode/* to :13337 without
    // stripping (unlike the vault, which rewrites to /vault). Forward the
    // auth-validated body-owning request; WS upgrades flow through this same
    // line (their Upgrade / Sec-WebSocket-* headers are preserved verbatim).
    logger.info('Forwarding vscode request to container', {
      email: user.email,
      containerId,
      pathname: new URL(request.url).pathname,
      method: request.method,
      isWebSocket: !!isWebSocket,
    });
    const response = await container.fetch(new Request(request.url, requestForAuth));
    return response;
  } catch (err) {
    logger.error('vscode proxy failed', toError(err));
    return new Response(
      JSON.stringify({ error: 'Browser IDE unreachable', code: 'VSCODE_PROXY_FAILED' }),
      { status: 500, headers: jsonHeaders },
    );
  }
}
