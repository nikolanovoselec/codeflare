import { getContainer } from '@cloudflare/containers';
import { z } from 'zod';
import { isPiWebEligible, PI_WEB_GENERATION_HEADER, PI_WEB_ROOT, piWebSessionId } from '../container/pi-web';
import { authenticateRequest } from '../lib/access';
import { allowedAgents } from '../lib/agent-allowlist';
import { WS_RATE_LIMIT_MAX_CONNECTIONS, WS_RATE_LIMIT_TTL_SECONDS, WS_RATE_LIMIT_WINDOW_MS } from '../lib/constants';
import { forwardExisting, getContainerId, getPersonalPiSession } from '../lib/container-helpers';
import { isAllowedOrigin } from '../lib/cors-cache';
import { AppError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { isSessionOidcMode } from '../lib/onboarding';
import { checkRateLimit } from '../lib/rate-limit-core';
import { D1SessionRepository } from '../lib/session-repository';
import { getEffectiveTier, isActiveTier, isEnterpriseMode } from '../lib/subscription';
import { maybeSynthesizeCsrfHeader } from '../lib/vault-view';
import { PiSurfaceSchema, type Env } from '../types';

const logger = createLogger('pi-web');
const CONTROL_BODY_LIMIT = 4096;
const SwitchAttempt = z.object({ generation: z.number().int().positive(), requestId: z.uuid() }).strict();
const SwitchStatus = SwitchAttempt.partial({ requestId: true });
const StartSwitch = SwitchAttempt.extend({ target: PiSurfaceSchema });
const FORWARDED_HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Content-Type', 'Content-Length',
  'Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since',
  'Last-Event-ID', 'Origin',
] as const;
const WEBSOCKET_HEADERS = ['Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions'] as const;

function forwardHeaders(request: Request, url: URL, generation: number, upgrade: boolean): Headers {
  // Positive transport list: browser identity, proxy/CSRF headers and cookies never reach the host.
  const headers = new Headers();
  for (const name of upgrade ? [...FORWARDED_HEADERS, ...WEBSOCKET_HEADERS] : FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (upgrade) {
    headers.set('Upgrade', 'websocket');
    headers.set('Connection', 'Upgrade');
  }
  headers.set('Host', url.host);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
  headers.set(PI_WEB_GENERATION_HEADER, String(generation));
  return headers;
}

/** Read only our tiny control messages; the stock app body streams unchanged. */
async function readControlBody(request: Request): Promise<{ bytes: Uint8Array<ArrayBuffer>; value: unknown }> {
  if (!request.body) throw new AppError('INVALID_PI_SWITCH', 400, 'Missing Pi switch body');
  const reader = request.body.getReader();
  const buffer = new Uint8Array(CONTROL_BODY_LIMIT);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > buffer.length) {
        void reader.cancel().catch(() => {});
        throw new AppError('PI_SWITCH_TOO_LARGE', 413, 'Pi switch body too large');
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
    const bytes = buffer.subarray(0, length);
    return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_PI_SWITCH', 400, 'Invalid Pi switch body');
  } finally {
    reader.releaseLock();
  }
}

function scopedResponse(response: Response, url: URL, prefix: string): Response {
  const location = response.headers.get('Location');
  if (response.status >= 300 && response.status < 400 && location !== null) {
    let target: URL | undefined;
    try { target = new URL(location, url); } catch { /* Invalid upstream location. */ }
    if (!target || target.origin !== url.origin || target.username || target.password || !target.pathname.startsWith(prefix)) {
      return Response.json({ error: 'Invalid Pi web redirect' }, { status: 502 });
    }
  }
  const headers = new Headers(response.headers);
  for (const name of ['Set-Cookie', 'Set-Cookie2', 'Clear-Site-Data', 'Service-Worker-Allowed',
    'Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']) headers.delete(name);
  if (response.webSocket) return new Response(null, { status: 101, headers, webSocket: response.webSocket });
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Authenticated same-origin proxy; neither an app read nor an upgrade starts a container. */
export async function handlePiWebRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = piWebSessionId(url.pathname);
  if (!sessionId) return Response.json({ error: 'Pi web route not found' }, { status: 404 });
  const prefix = `${PI_WEB_ROOT}/${sessionId}/`;
  const path = url.pathname.slice(prefix.length);
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const passive = request.method === 'GET' || request.method === 'HEAD';
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if ((site && site !== 'same-origin' && site !== 'none')
    || (origin === null ? !passive || upgrade : origin !== url.origin || !await isAllowedOrigin(origin, env))) {
    return Response.json({ error: 'Pi web requires the same origin' }, { status: 403 });
  }
  if ((!passive && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))
    || (request.headers.has('Upgrade') && (!upgrade || request.method !== 'GET'))) {
    return Response.json({ error: 'Unsupported Pi web method' }, { status: 405 });
  }

  try {
    // The stock app does not set Codeflare's request marker. Synthesize it
    // only after exact Origin validation, preserving any submitted CSRF token.
    const authenticatedRequest = maybeSynthesizeCsrfHeader(request, origin !== null);
    const { user, bucketName } = await authenticateRequest(authenticatedRequest, env);
    if (isSessionOidcMode(env) && !isEnterpriseMode(env)
      && !isActiveTier(getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, env))) {
      return Response.json({ error: 'Access denied' }, { status: 403 });
    }
    const session = await new D1SessionRepository(env.USAGE_DB).getSession(bucketName, sessionId);
    if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
    if (session.boundaryActivityId || !isPiWebEligible(session) || !(await allowedAgents(env)).includes('pi')) {
      return Response.json({ error: 'Pi web requires an ordinary Pi Terminal workspace' }, { status: 403 });
    }
    const generation = session.lifecycleGeneration;
    if (session.lifecycleState !== 'running' || session.terminationIntentId || !Number.isSafeInteger(generation) || generation < 1) {
      return Response.json({ error: 'Pi web session is not running' }, { status: 409 });
    }

    let controlBody: Uint8Array<ArrayBuffer> | undefined;
    if (path === '_switch' || path === '_cancel') {
      if (upgrade || (request.method !== 'POST' && !(request.method === 'GET' && path === '_switch'))) {
        return Response.json({ error: 'Unsupported Pi switch method' }, { status: 405 });
      }
      let attempt;
      if (request.method === 'GET') {
        const [generations, ids] = [url.searchParams.getAll('generation'), url.searchParams.getAll('requestId')];
        const value = generations[0];
        attempt = SwitchStatus.safeParse({
          generation: generations.length === 1 && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined,
          requestId: ids.length > 1 ? null : ids[0],
        });
      } else {
        const { bytes, value } = await readControlBody(authenticatedRequest);
        controlBody = bytes;
        attempt = (path === '_switch' ? StartSwitch : SwitchAttempt).safeParse(value);
      }
      if (!attempt.success) return Response.json({ error: 'Invalid Pi switch request' }, { status: 400 });
      if (attempt.data.generation !== generation) return Response.json({ error: 'Pi web generation changed' }, { status: 409 });
    }

    const container = getContainer(env.CONTAINER, getContainerId(bucketName, sessionId));
    const ordinary = await getPersonalPiSession(container, { bucket: bucketName, sessionId, email: user.email }, true);
    if (ordinary.generation !== generation) return Response.json({ error: 'Pi web generation changed' }, { status: 409 });

    if (upgrade && env.STRESS_TEST_MODE !== 'active') {
      const rate = await checkRateLimit({ kv: env.KV, key: `ws-connect:${user.email}`, limit: WS_RATE_LIMIT_MAX_CONNECTIONS,
        windowMs: WS_RATE_LIMIT_WINDOW_MS, ttlSeconds: WS_RATE_LIMIT_TTL_SECONDS });
      if (!rate.allowed) return new Response(null, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } });
    }

    const headers = forwardHeaders(authenticatedRequest, url, generation, upgrade);
    // Control reads consumed the original stream; rebuild with exactly those bytes.
    if (controlBody) headers.delete('Content-Length');
    const forwarded = controlBody
      ? new Request(url, { method: request.method, headers, body: controlBody, redirect: 'manual', signal: request.signal })
      : new Request(authenticatedRequest, { headers, redirect: 'manual' });
    // 101 responses require native Stub.fetch rather than DO RPC serialization.
    const response = upgrade ? await container.fetch(forwarded) : await forwardExisting(container, forwarded);
    return scopedResponse(response, url, prefix);
  } catch (error) {
    if (error instanceof AppError) return Response.json(error.toJSON(), { status: error.statusCode });
    logger.warn('Pi web proxy unavailable');
    return Response.json({ error: 'Pi web unavailable' }, { status: 503 });
  }
}
