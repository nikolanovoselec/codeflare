import type { Env } from '../types';
import { getContainerId } from './container-helpers';
import { readBoundedResponse } from './bounded-stream';
import { parseAccessGroups, resolvePersonalPiPermission } from './access';
import { SETUP_KEYS } from './kv-keys';
import { isEnterpriseMode } from './subscription';
import { isPersonalPiCloudFamily, isPersonalPiDestination } from './personal-pi-destinations';
import { jsonError, STRIPPED_REQUEST_HOP_BY_HOP } from './controller-egress';

interface PersonalPiReference { bucket: string; sessionId: string; user: string; generation?: number }
export interface PersonalPiProps {
  personalPi?: PersonalPiReference;
  strict?: boolean;
  operatorPolicy?: unknown;
  operatorInference?: unknown;
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

async function personalTransportStrict(env: Env, hint?: boolean): Promise<boolean> {
  const value = await env.KV.get(SETUP_KEYS.STRICT_EGRESS);
  if (value !== null && value !== 'active' && value !== 'inactive') throw new Error('Invalid transport policy');
  return hint === true || value === 'active';
}

/** A per-host interceptor may delegate only native provider paths, never platform routing. */
export async function forwardPersonalPi(request: Request, env: Env, props?: PersonalPiProps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isEnterpriseMode(env)) return null;
  const native = isPersonalPiDestination(url, env);
  if (!native && !isPersonalPiCloudFamily(url)) return null;
  const denied = () => jsonError(403, 'PERSONAL_PI_DENIED', 'Native Pi provider access is not permitted');
  if (url.hostname === 'api.openai.com' && (!props?.personalPi || request.headers.get('authorization') === 'Bearer codeflare-enterprise')) return null;
  if (props?.operatorPolicy || props?.operatorInference) return native ? denied() : null;
  if (native) try {
    // Gateway names/opaque native handles remain authoritative even when personal
    // credentials are supplied. A revoked handle cannot become a direct request.
    if (url.hostname === 'api.openai.com' && request.body) {
      const bytes = await readBoundedResponse(new Response(request.clone().body), 8 * 1024 * 1024, 'Native request');
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown };
      const rawModel = payload?.model;
      const model = typeof rawModel === 'string' && rawModel.startsWith('dynamic/') ? rawModel.slice(8) : rawModel;
      const routes: unknown = JSON.parse(await env.KV.get(SETUP_KEYS.DYNAMIC_ROUTES) ?? '[]');
      if (typeof model === 'string' && (model.startsWith('cf-native-') || model === 'codeflare-enterprise'
        || (Array.isArray(routes) && routes.includes(model)))) return null;
    }
    if (!props?.personalPi || !await authorizePersonalPi(env, props.personalPi)) return denied();
  } catch { return denied(); }
  const headers = new Headers(request.headers);
  for (const name of ['authorization', 'x-api-key', 'cf-aig-authorization']) {
    const credential = headers.get(name)?.replace(/^Bearer\s+/i, '');
    if (native && credential && (credential.startsWith('codeflare-enterprise') || credential === props?.token || credential === env.AIG_TOKEN)) return denied();
  }
  for (const name of [...STRIPPED_REQUEST_HOP_BY_HOP, 'host', 'content-length', 'cf-access-jwt-assertion', 'cf-aig-metadata', 'cf-aig-gateway-id']) headers.delete(name);
  if (url.hostname !== 'gateway.ai.cloudflare.com') headers.delete('cf-aig-authorization');
  // Headers iterators are live; deleting during iteration can skip adjacent names.
  const platformHeaders: string[] = [];
  for (const name of headers.keys()) if (name.startsWith('x-codeflare-')) platformHeaders.push(name);
  for (const name of platformHeaders) headers.delete(name);
  const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (websocket) { headers.set('upgrade', 'websocket'); headers.set('connection', 'Upgrade'); }
  const upstream = new Request(request, { headers, redirect: 'manual' });
  let strict: boolean;
  try { strict = await personalTransportStrict(env, props?.strict); }
  catch { return jsonError(503, 'EGRESS_UNAVAILABLE', 'Transport policy unavailable'); }
  if (strict && !env.EGRESS) return jsonError(503, 'EGRESS_UNAVAILABLE', 'Strict Gateway egress binding unavailable');
  const response = strict ? await env.EGRESS!.fetch(upstream) : await fetch(upstream);
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
