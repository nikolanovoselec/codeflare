import type { Env } from '../types';
import { getContainerId } from './container-helpers';
import { readBoundedResponse } from './bounded-stream';
import { parseAccessGroups, resolvePersonalPiPermission } from './access';
import { SETUP_KEYS } from './kv-keys';
import { isEnterpriseMode } from './subscription';
import { isPersonalPiCloudFamily, isPersonalPiDestination } from './personal-pi-destinations';
import { jsonError, STRIPPED_REQUEST_HOP_BY_HOP } from './controller-egress';
import { classifyCloudflareCredentials } from './cloudflare-credentials';
import { ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER } from './constants';
import { validateNativePiEgress } from '../operators/native-pi-profile';
import { nativePiAuthFailure, type OperatorPiAuthDescriptor, type SafePiAuthFailure } from '../operators/pi-auth-failure';
import { parseNativeOperatorInference } from '../operators/inference-selection';

interface PersonalPiReference { bucket: string; sessionId: string; user: string; generation?: number }
export interface PersonalPiProps {
  personalPi?: PersonalPiReference;
  strict?: boolean;
  operatorPolicy?: unknown;
  operatorInference?: unknown;
  /** Trusted parent profile only; never populated from request headers/body. */
  operatorNative?: { provider: string; model: string; api?: string; reasoningLevel: string; binding: OperatorPiAuthDescriptor };
  /** Activity-owned Dispatcher scope; no container session or request-supplied authority. */
  operatorDispatcherNative?: { activityId: string; generation: number; profileDigest: string };
  token?: string;
}

async function authorizePersonalPi(env: Env, ref: PersonalPiReference): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(ref.generation) || !ref.generation || ref.generation < 0) return false;
    const session = env.CONTAINER.getByName(getContainerId(ref.bucket, ref.sessionId)) as unknown as {
      getPersonalPiSession(ref: { bucket: string; sessionId: string; email: string }): Promise<{ generation: number; groups: string[] }>;
    };
    const reference = { bucket: ref.bucket, sessionId: ref.sessionId, email: ref.user };
    const authority = await session.getPersonalPiSession(reference);
    if (authority.generation !== ref.generation) return false;
    const fingerprint = (value: typeof authority) => JSON.stringify([value.generation, value.groups]);
    const evaluatedAuthority = fingerprint(authority);
    const configured = parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
    const groups = configured.filter(name => authority.groups.includes(name));
    if (!await resolvePersonalPiPermission(env.KV, groups)) return false;
    // Recheck ownership, generation and shutdown after policy I/O, without a browser lease.
    const currentAuthority = await session.getPersonalPiSession(reference);
    return fingerprint(currentAuthority) === evaluatedAuthority;
  } catch { return false; }
}

async function authorizeDispatcherNative(env: Env, scope: NonNullable<PersonalPiProps['operatorDispatcherNative']>): Promise<boolean> {
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope.activityId) || !Number.isSafeInteger(scope.generation)
      || scope.generation <= 0 || !/^[a-f0-9]{64}$/.test(scope.profileDigest) || !env.OPERATOR_ACTIVITY) return false;
    const selected = await env.OPERATOR_ACTIVITY.getByName(scope.activityId)
      .dispatcherNativeEgressCurrent(scope.generation, scope.profileDigest);
    return selected !== null && parseNativeOperatorInference(selected).profileDigest === scope.profileDigest;
  } catch { return false; }
}

async function personalTransportStrict(env: Env, hint?: boolean): Promise<boolean> {
  const value = await env.KV.get(SETUP_KEYS.STRICT_EGRESS);
  if (value !== null && value !== 'active' && value !== 'inactive') throw new Error('Invalid transport policy');
  return hint === true || value === 'active';
}

/** A per-host interceptor may delegate only native provider paths, never platform routing. */
export async function forwardPersonalPi(request: Request, env: Env, props?: PersonalPiProps): Promise<Response | null> {
  const url = new URL(request.url);
  const denied = () => jsonError(403, 'PERSONAL_PI_DENIED', 'Native Pi provider access is not permitted');
  const dispatcherNative = props?.operatorDispatcherNative;
  if (!isEnterpriseMode(env)) return dispatcherNative ? denied() : null;
  const native = isPersonalPiDestination(url, env);
  if (dispatcherNative && (!native || props?.strict !== true || props.personalPi || props.operatorNative
    || props.operatorPolicy || props.operatorInference || request.method !== 'POST' || request.headers.has('upgrade')
    || request.signal.aborted || !await authorizeDispatcherNative(env, dispatcherNative))) return denied();
  if (!native && !isPersonalPiCloudFamily(url)) return null;
  const operatorNative = props?.operatorNative;
  const signal = operatorNative ? AbortSignal.any([request.signal,
    AbortSignal.timeout(Math.max(1, operatorNative.binding.deadline - Date.now()))]) : request.signal;
  if (operatorNative && (props?.personalPi?.generation !== operatorNative.binding.generation
    || operatorNative.binding.deadline <= Date.now() || !native)) return denied();
  if (url.hostname === 'api.openai.com' && (!props?.personalPi || request.headers.get('authorization') === 'Bearer codeflare-enterprise')) {
    if (!dispatcherNative || request.headers.get('authorization') === 'Bearer codeflare-enterprise') {
      return operatorNative || dispatcherNative ? denied() : null;
    }
  }
  if (props?.operatorPolicy || props?.operatorInference) {
    if (!operatorNative) return native ? denied() : null;
    if (!await validateNativePiEgress(request, operatorNative, 8 * 1024 * 1024, signal)) return denied();
  }
  if (native && !dispatcherNative) try {
    // Gateway names/opaque native handles remain authoritative even when personal
    // credentials are supplied. A revoked handle cannot become a direct request.
    if (url.hostname === 'api.openai.com' && request.body) {
      const bytes = await readBoundedResponse(new Response(request.clone().body), 8 * 1024 * 1024, 'Native request', signal);
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown };
      const rawModel = payload?.model;
      const model = typeof rawModel === 'string' && rawModel.startsWith('dynamic/') ? rawModel.slice(8) : rawModel;
      const routes: unknown = JSON.parse(await env.KV.get(SETUP_KEYS.DYNAMIC_ROUTES) ?? '[]');
      if (typeof model === 'string' && (model.startsWith('cf-native-') || model === 'codeflare-enterprise'
        || (Array.isArray(routes) && routes.includes(model)))) return operatorNative ? denied() : null;
    }
    if (!props?.personalPi || !await authorizePersonalPi(env, props.personalPi)) return denied();
  } catch { return denied(); }
  const headers = new Headers(request.headers);
  const cloudflare = url.hostname === 'api.cloudflare.com' || url.hostname === 'gateway.ai.cloudflare.com';
  if (cloudflare) {
    const credentials = classifyCloudflareCredentials(headers, url.hostname === 'gateway.ai.cloudflare.com',
      ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER);
    if (credentials === 'invalid') return jsonError(400, 'CF_CREDENTIALS_INVALID', 'Cloudflare credentials are invalid');
    if (credentials === 'key-email') headers.delete('authorization');
  }
  for (const name of ['authorization', 'x-api-key', 'cf-aig-authorization']) {
    const credential = headers.get(name)?.replace(/^Bearer\s+/i, '');
    const placeholder = cloudflare ? credential === ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER : credential?.startsWith('codeflare-enterprise');
    if (native && credential && (placeholder || credential === props?.token || credential === env.AIG_TOKEN)) return denied();
  }
  for (const name of [...STRIPPED_REQUEST_HOP_BY_HOP, 'host', 'content-length', 'cf-access-jwt-assertion', 'cf-aig-metadata', 'cf-aig-gateway-id']) headers.delete(name);
  if (url.hostname !== 'gateway.ai.cloudflare.com') headers.delete('cf-aig-authorization');
  // Headers iterators are live; deleting during iteration can skip adjacent names.
  const platformHeaders: string[] = [];
  for (const name of headers.keys()) if (name.startsWith('x-codeflare-')) platformHeaders.push(name);
  for (const name of platformHeaders) headers.delete(name);
  const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (websocket) { headers.set('upgrade', 'websocket'); headers.set('connection', 'Upgrade'); }
  const upstream = new Request(request, { headers, redirect: 'manual', signal });
  let strict: boolean;
  try { strict = await personalTransportStrict(env, props?.strict); }
  catch { return jsonError(503, 'EGRESS_UNAVAILABLE', 'Transport policy unavailable'); }
  if (strict && !env.EGRESS) return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict Gateway egress binding unavailable');
  if (operatorNative && (!props?.personalPi || !await authorizePersonalPi(env, props.personalPi)
    || operatorNative.binding.deadline <= Date.now() || signal.aborted)) return denied();
  if (dispatcherNative && (!strict || signal.aborted || !await authorizeDispatcherNative(env, dispatcherNative))) return denied();
  const response = strict ? await env.EGRESS!.fetch(upstream) : await fetch(upstream);
  if (dispatcherNative) {
    if (signal.aborted || !await authorizeDispatcherNative(env, dispatcherNative)) {
      void response.body?.cancel().catch(() => undefined);
      return denied();
    }
    // The Activity already inspected the original bounded request and exclusively
    // owns error sanitization, raw commitment and replay before SDK delivery.
    return response;
  }
  if (operatorNative) {
    if (!props?.personalPi || !await authorizePersonalPi(env, props.personalPi)
      || operatorNative.binding.deadline <= Date.now() || signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      return denied();
    }
    if (!response.ok) {
      // Upstream error text is never allowed into SDK-persisted assistant content.
      // A bare 403/429/5xx is deliberately not authentication evidence.
      let authFailure: SafePiAuthFailure | undefined;
      if (response.status === 401 || response.status === 403) try {
        // Retain only closed evidence under the existing Host error-inspection
        // allowance, never provider text or a new model/output limit.
        const bytes = await readBoundedResponse(response, 16 * 1024, 'Native Pi error', signal);
        authFailure = nativePiAuthFailure(response.status,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), operatorNative.provider, operatorNative.api);
      } catch { /* Malformed/oversized errors remain ordinary sanitized failures. */ }
      void response.body?.cancel().catch(() => undefined);
      if (!props?.personalPi || !await authorizePersonalPi(env, props.personalPi)
        || operatorNative.binding.deadline <= Date.now() || signal.aborted) return denied();
      return Response.json({ error: { message: 'Native Pi request failed', type: 'request_error' },
        ...(authFailure ? { authFailure } : {}) },
        { status: response.status >= 300 && response.status < 400 ? 502 : response.status });
    }
  }
  const location = response.headers.get('location');
  if (native && response.status >= 300 && response.status < 400 && location) {
    try { if (new URL(location, url).origin !== url.origin) return jsonError(502, 'PERSONAL_PI_REDIRECT_DENIED', 'Native provider redirect is not permitted'); }
    catch { return jsonError(502, 'PERSONAL_PI_REDIRECT_DENIED', 'Native provider redirect is not permitted'); }
  }
  const remote = (response as unknown as { webSocket?: WebSocket }).webSocket;
  if (!websocket || !remote) return response;
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  remote.accept(); server.accept();
  // Codex reuses its WebSocket across turns. Reauthorize each client frame, not
  // just the handshake; serialize bounded pending frames to retain wire order.
  const ref = props?.personalPi;
  let relay = Promise.resolve();
  let pending = 0;
  server.addEventListener('message', event => {
    if (++pending > 16) { server.close(1008, 'native request denied'); remote.close(1008, 'native request denied'); return; }
    relay = relay.then(async () => {
      if (native && (!ref || (!strict && await personalTransportStrict(env)) || !await authorizePersonalPi(env, ref))) { server.close(1008, 'native request denied'); remote.close(1008, 'native request denied'); return; }
      try { remote.send(event.data); } catch { /* peer closed */ }
    }).catch(() => { try { server.close(1008, 'native request denied'); remote.close(1008, 'native request denied'); } catch { /* peer closed */ } })
      .finally(() => { pending--; });
  });
  remote.addEventListener('message', event => { try { server.send(event.data); } catch { /* peer closed */ } });
  server.addEventListener('close', event => { try { remote.close(event.code, event.reason); } catch { /* peer closed */ } });
  remote.addEventListener('close', event => { try { server.close(event.code, event.reason); } catch { /* peer closed */ } });
  server.addEventListener('error', () => { try { remote.close(1011, 'client error'); } catch { /* peer closed */ } });
  remote.addEventListener('error', () => { try { server.close(1011, 'upstream error'); } catch { /* peer closed */ } });
  return new Response(null, { status: 101, webSocket: client });
}
