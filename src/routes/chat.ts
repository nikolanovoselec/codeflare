/**
 * REQ-AGENT-224: the public, owner-scoped boundary for the one live primary Pi.
 * The Host owns primary adoption, question ownership and per-frame filtering;
 * this route exposes neither a Dashboard API proxy nor a second WS protocol.
 */
import { getContainer } from '@cloudflare/containers';
import { z } from 'zod';
import type { Env } from '../types';
import { D1SessionRepository } from '../lib/session-repository';
import { readBoundedStream } from '../lib/bounded-stream';
import { forwardExisting, getContainerId } from '../lib/container-helpers';
import {
  SESSION_ID_PATTERN, REQUEST_ID_LENGTH, REQUEST_ID_PATTERN,
  WS_RATE_LIMIT_WINDOW_MS, WS_RATE_LIMIT_MAX_CONNECTIONS, WS_RATE_LIMIT_TTL_SECONDS,
  CONTAINER_WS_FORWARD_TIMEOUT_MS,
} from '../lib/constants';
import { checkRateLimit } from '../lib/rate-limit-core';
import { warnStressTestBypass } from '../middleware/rate-limit';
import { checkVaultOrigin, authenticateVaultRequest, assertActiveTier } from './vault/auth';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/error-types';

const logger = createLogger('chat');
// Match the existing /api body limit; this pre-Hono boundary must enforce it too.
const MAX_BODY_BYTES = 64 * 1024;
const generationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attachSchema = z.object({ generation: generationSchema }).strict();
// Pinned shared/question-types.ts: QuestionAnswerRequest. Provenance and target
// fields are deliberately not accepted from the browser, even on cancellation.
const answerSchema = z.union([
  z.object({ answer: z.string() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);
const HOP_HEADERS = [
  'Accept', 'Content-Type', 'Origin', 'Upgrade', 'Connection',
  'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions',
];

/** Called before Hono for this exact public family, including unknown roads. */
export async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  const suppliedId = request.headers.get('X-Request-ID');
  const requestId = suppliedId && REQUEST_ID_PATTERN.test(suppliedId)
    ? suppliedId : crypto.randomUUID().slice(0, REQUEST_ID_LENGTH);
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-Request-ID': requestId, 'Cache-Control': 'no-store' };
  const reject = (status: number, error: string, code: string) =>
    new Response(JSON.stringify({ error, code }), { status, headers: jsonHeaders });

  // This intercept does not run Hono's production stress-mode safeguard.
  if (env.SAAS_MODE === 'active' && env.STRESS_TEST_MODE === 'active') {
    return reject(503, 'Misconfiguration: stress test mode cannot be active in SaaS production', 'MISCONFIGURATION');
  }

  const url = new URL(request.url);
  const route = url.pathname.match(/^\/api\/chat\/([^/]+)(\/.*)$/);
  if (!route || !SESSION_ID_PATTERN.test(route[1])) {
    return reject(400, 'Invalid session ID format', 'INVALID_SESSION');
  }
  const sessionId = route[1];
  const path = route[2];
  const isAttach = path === '/attach';
  const isWebSocket = path === '/ws';
  // Pinned QuestionStore IDs are base64url; do not decode path separators or
  // admit a nested/global API. Only detail and manual answer are needed here.
  const question = path.match(/^\/api\/questions\/[a-zA-Z0-9_-]+(\/answer)?$/);
  if (!isAttach && !isWebSocket && !question) {
    return reject(404, 'Not found', 'NOT_FOUND');
  }
  const method = isAttach || question?.[1] ? 'POST' : 'GET';
  if (request.method !== method) {
    const response = reject(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
    response.headers.set('Allow', method);
    return response;
  }
  if (isWebSocket && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return reject(400, 'WebSocket upgrade required', 'INVALID_UPGRADE');
  }
  if (!isWebSocket && request.headers.has('Upgrade')) {
    return reject(400, 'Unexpected upgrade', 'INVALID_UPGRADE');
  }
  if (isWebSocket && request.headers.has('Sec-WebSocket-Key')
    && request.headers.has('Sec-Fetch-Mode') && !request.headers.has('Origin')) {
    return reject(403, 'Origin header required for browser WebSocket connections', 'ORIGIN_NOT_ALLOWED');
  }

  try {
    const origin = await checkVaultOrigin(request, env, jsonHeaders);
    if ('errorResponse' in origin) return origin.errorResponse;
    const auth = await authenticateVaultRequest(request, origin.originValidated, env, jsonHeaders);
    if ('errorResponse' in auth) return auth.errorResponse;
    const tierRejection = assertActiveTier(auth.user, env, jsonHeaders);
    if (tierRejection) return tierRejection;

    // Do not use the vault ownership guard: its stopped outcome is 503, while
    // the Chat contract intentionally reports lifecycle conflicts as 409.
    const session = await new D1SessionRepository(env.USAGE_DB).getSession(auth.bucketName, sessionId);
    if (!session) return reject(404, 'Session not found', 'SESSION_NOT_FOUND');

    let body: string | undefined;
    let generation: number | undefined;
    if (isAttach || question?.[1]) {
      const declaredLength = Number(request.headers.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        return reject(413, 'Request body too large', 'BODY_TOO_LARGE');
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedStream(auth.requestForAuth.body, MAX_BODY_BYTES, 'Chat body', request.signal);
      } catch (error) {
        if (error instanceof Error && error.message === `Chat body exceeds ${MAX_BODY_BYTES} bytes`) {
          return reject(413, 'Request body too large', 'BODY_TOO_LARGE');
        }
        return reject(400, 'Invalid request body', 'INVALID_BODY');
      }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch {
        return reject(400, 'Invalid JSON body', 'INVALID_BODY');
      }
      if (isAttach) {
        const parsed = attachSchema.safeParse(raw);
        if (!parsed.success) return reject(400, 'Expected exactly {generation}', 'INVALID_BODY');
        generation = parsed.data.generation;
        body = JSON.stringify(parsed.data);
      } else {
        const parsed = answerSchema.safeParse(raw);
        if (!parsed.success) return reject(400, 'Expected {answer} or {cancelled:true}', 'INVALID_BODY');
        body = JSON.stringify(parsed.data);
      }
    }
    if (isAttach) {
      if (url.search) return reject(400, 'Attachment takes no query parameters', 'INVALID_QUERY');
    } else {
      const values = url.searchParams.getAll('generation');
      if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0])
        || Array.from(url.searchParams.keys()).some(key => key !== 'generation')
        || !generationSchema.safeParse(Number(values[0])).success) {
        return reject(400, 'Invalid generation query', 'INVALID_GENERATION');
      }
      generation = Number(values[0]);
    }

    // All these gates precede container resolution, including a safe stopped
    // rejection that must not instantiate a DO or touch the protected port.
    if (session.lifecycleState === 'stopped' || session.lifecycleState === 'stopping') {
      return reject(409, 'Container stopped', 'CONTAINER_STOPPED');
    }
    const primaryCommand = session.tabConfig?.find(tab => tab.id === '1')?.command
      ?? (session.tabConfig?.length ? '' : session.agentType);
    if (primaryCommand !== 'pi'
      || !['classic', 'herdr'].includes(session.terminalMode)
      || !['terminal', 'vscode'].includes(session.workspace)) {
      return reject(409, 'Session is not eligible for Pi Chat', 'CHAT_INELIGIBLE');
    }
    if (generation !== session.lifecycleGeneration) {
      return reject(409, 'Stale container generation', 'STALE_GENERATION');
    }

    if (isWebSocket) {
      if (env.STRESS_TEST_MODE === 'active') {
        warnStressTestBypass();
      } else {
        const rate = await checkRateLimit({ kv: env.KV, key: `ws-connect:${auth.user.email}`,
          limit: WS_RATE_LIMIT_MAX_CONNECTIONS, windowMs: WS_RATE_LIMIT_WINDOW_MS,
          ttlSeconds: WS_RATE_LIMIT_TTL_SECONDS });
        if (!rate.allowed) {
          const response = reject(429, 'Connection rate limit exceeded', 'RATE_LIMITED');
          response.headers.set('Retry-After', String(rate.retryAfterSec));
          return response;
        }
      }
    }

    // An explicit header allowlist isolates browser cookies/Access assertions
    // and Authorization from the private Host. It also discards ALL spoofed
    // Forwarded/X-Forwarded-* identity, not just the two canonical fields.
    const headers = new Headers();
    for (const name of HOP_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    headers.set('X-Request-ID', requestId);
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
    // Host adapter authority comes only from the current owner-scoped D1 row.
    headers.set('X-Codeflare-Chat-Generation', String(session.lifecycleGeneration));
    const forwarded = new Request(url, { method: request.method, headers, body });
    const container = getContainer(env.CONTAINER, getContainerId(auth.bucketName, sessionId));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response;
    try {
      response = await Promise.race([
        // Native Stub.fetch carries a 101 without RPC serialization. The exact
        // Chat WS path in container/index.ts dispatches straight to the same
        // no-start, bearer-authenticated port as forwardExisting, never SDK fetch.
        isWebSocket ? container.fetch(forwarded) : forwardExisting(container, forwarded),
        new Promise<Response>(resolve => {
          timer = setTimeout(() => resolve(reject(503, 'Chat Host unavailable', 'CHAT_UNAVAILABLE')),
            CONTAINER_WS_FORWARD_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // The Host adapter returns public data only. Its backend session cookies
    // must never become browser credentials, including on the native upgrade.
    const publicHeaders = new Headers(response.headers);
    publicHeaders.delete('Set-Cookie');
    publicHeaders.set('Cache-Control', 'no-store');
    publicHeaders.set('X-Request-ID', requestId);
    return response.status === 101
      ? new Response(null, { status: 101, headers: publicHeaders, webSocket: response.webSocket })
      : new Response(response.body, { status: response.status, statusText: response.statusText, headers: publicHeaders });
  } catch (error) {
    logger.error('Chat existing-container forwarding failed', toError(error));
    return reject(503, 'Chat Host unavailable', 'CHAT_UNAVAILABLE');
  }
}
