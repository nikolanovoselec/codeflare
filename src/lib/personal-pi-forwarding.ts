import type { Env } from '../types';
import type { VerifiedHumanAccessClaims } from './jwt';
import { getContainerId } from './container-helpers';
import { readBoundedResponse } from './bounded-stream';
import { parseAccessGroups, resolvePersonalPiPermission } from './access';
import { SETUP_KEYS } from './kv-keys';
import { isEnterpriseMode } from './subscription';
import { isPersonalPiCloudFamily, isPersonalPiDestination } from './personal-pi-destinations';
import { jsonError, STRIPPED_REQUEST_HOP_BY_HOP } from './controller-egress';

export interface PersonalPiReference { bucket: string; sessionId: string; user: string }
export interface PersonalPiProps {
  personalPi?: PersonalPiReference;
  strict?: boolean;
  operatorPolicy?: unknown;
  operatorInference?: unknown;
  token?: string;
}

async function authorizePersonalPi(env: Env, ref: PersonalPiReference): Promise<boolean> {
  try {
    const session = env.CONTAINER.getByName(getContainerId(ref.bucket, ref.sessionId)) as unknown as {
      openReviewHuman(ref: { bucket: string; sessionId: string; email: string }): Promise<{ human: VerifiedHumanAccessClaims; accessJwt: string }>;
    };
    const authority = await session.openReviewHuman({ bucket: ref.bucket, sessionId: ref.sessionId, email: ref.user });
    const human = authority.human;
    if (human.email.toLowerCase() !== ref.user.toLowerCase() || human.expiresAt * 1000 <= Date.now()
      || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(human.issuer)) return false;
    const response = await fetch(`${human.issuer}/cdn-cgi/access/get-identity`, {
      method: 'GET', headers: { Cookie: `CF_Authorization=${authority.accessJwt}` },
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const identity = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, 65536, 'Access identity'))) as {
      user_uuid?: unknown; id?: unknown; email?: unknown; groups?: unknown;
    };
    if (!identity || (identity.user_uuid ?? identity.id) !== human.subject
      || (identity.id !== undefined && identity.id !== human.subject)
      || typeof identity.email !== 'string' || identity.email.toLowerCase() !== ref.user.toLowerCase()
      || (identity.groups !== undefined && !Array.isArray(identity.groups))) return false;
    const memberships = identity.groups ?? [];
    if (!Array.isArray(memberships) || memberships.length > 1024) return false;
    const names = new Set<string>();
    for (const group of memberships) {
      if (typeof group === 'string' && group.length > 0 && group.length <= 256) { names.add(group); continue; }
      if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
      const record = group as Record<string, unknown>;
      let valid = false;
      for (const key of ['id', 'name', 'email']) {
        if (record[key] === undefined) continue;
        if (typeof record[key] !== 'string' || !record[key] || record[key].length > 256) return false;
        names.add(record[key]); valid = true;
      }
      if (!valid) return false;
    }
    const policies: unknown = JSON.parse(await env.KV.get(SETUP_KEYS.GROUP_ROUTING) ?? '{}');
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return false;
    const configured = parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP));
    const groups = configured.filter(name => names.has(name));
    if (!await resolvePersonalPiPermission(env.KV, groups)) return false;
    // Reopen immediately before forwarding: shutdown, owner/session revocation or
    // a lifecycle-generation change while identity/policy I/O was pending denies.
    await session.openReviewHuman({ bucket: ref.bucket, sessionId: ref.sessionId, email: ref.user });
    return true;
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
  if (!props?.personalPi || !isEnterpriseMode(env)) return null;
  const native = isPersonalPiDestination(url);
  if (!native && !isPersonalPiCloudFamily(url)) return null;
  const denied = () => jsonError(403, 'PERSONAL_PI_DENIED', 'Native Pi provider access is not permitted');
  if (url.hostname === 'api.openai.com' && request.headers.get('authorization') === 'Bearer codeflare-enterprise') return null;
  if (props.operatorPolicy || props.operatorInference) return native ? denied() : null;
  if (native) try {
    // Gateway names/opaque native handles remain authoritative even when personal
    // credentials are supplied. A revoked handle cannot become a direct request.
    if (url.hostname === 'api.openai.com' && request.body && request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const bytes = await readBoundedResponse(new Response(request.clone().body), 8 * 1024 * 1024, 'Native request');
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown };
      const model = payload?.model;
      const routes: unknown = JSON.parse(await env.KV.get(SETUP_KEYS.DYNAMIC_ROUTES) ?? '[]');
      if (typeof model === 'string' && (model.startsWith('cf-native-') || model === 'codeflare-enterprise'
        || (Array.isArray(routes) && routes.includes(model)))) return null;
    }
    if (!await authorizePersonalPi(env, props.personalPi)) return denied();
  } catch { return denied(); }
  const headers = new Headers(request.headers);
  for (const name of ['authorization', 'x-api-key', 'cf-aig-authorization']) {
    const credential = headers.get(name)?.replace(/^Bearer\s+/i, '');
    if (native && credential && (credential.startsWith('codeflare-enterprise') || credential === props.token || credential === env.AIG_TOKEN)) return denied();
  }
  for (const name of [...STRIPPED_REQUEST_HOP_BY_HOP, 'host', 'content-length', 'cf-access-jwt-assertion', 'cf-aig-metadata', 'cf-aig-gateway-id']) headers.delete(name);
  if (url.hostname !== 'gateway.ai.cloudflare.com') headers.delete('cf-aig-authorization');
  for (const name of [...headers.keys()]) if (name.startsWith('x-codeflare-')) headers.delete(name);
  const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (websocket) { headers.set('upgrade', 'websocket'); headers.set('connection', 'Upgrade'); }
  const upstream = new Request(request, { headers, redirect: 'manual' });
  let strict: boolean;
  try { strict = await personalTransportStrict(env, props.strict); }
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
  const ref = props.personalPi;
  let relay = Promise.resolve();
  let pending = 0;
  server.addEventListener('message', event => {
    if (++pending > 16) { server.close(1008, 'native request denied'); remote.close(1008, 'native request denied'); return; }
    relay = relay.then(async () => {
      if (native && ((!strict && await personalTransportStrict(env)) || !await authorizePersonalPi(env, ref))) { server.close(1008, 'native request denied'); remote.close(1008, 'native request denied'); return; }
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
