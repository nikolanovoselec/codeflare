/** CI-only browser-route adapter: production authenticated-session middleware, verified
 * human Access and owner routes. Only the exact identity/JWKS upstreams are synthetic.
 * No child reference, SDK query, diagnostic synthesis or execution action exists here.
 */
import { Hono } from 'hono';
import activityRoutes from '../../../routes/operator-activities';
import { authMiddleware, type AuthVariables } from '../../../middleware/auth';
import { AppError } from '../../../lib/error-types';
import { resetAuthConfigCache } from '../../../lib/access';
import { SETUP_KEYS } from '../../../lib/kv-keys';
import type { Env } from '../../../types';

const issuer = 'https://dispatcher-fixture.cloudflareaccess.com';
const email = 'owner@example.test';
let access: Promise<{ jwt: string; jwk: JsonWebKey }> | undefined;
const browser = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
// Same authentication as browser APIs, then the route's separate verified human
// and durable owner checks. Never populate a fabricated user/verifiedAccess context.
browser.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); return next(); });
browser.use('*', authMiddleware);
browser.onError((error, c) => error instanceof AppError
  ? c.json({ code: error.code }, error.statusCode as 400) : c.json({ code: 'INTERNAL_ERROR' }, 500));
browser.route('/api/operator-activities', activityRoutes);
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const json = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
function browserAccess() {
  return access ??= (async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const now = Math.floor(Date.now() / 1000);
    const signed = `${json({ alg: 'RS256', kid: 'fixture-browser' })}.${json({ type: 'app', sub: 'fixture-owner',
      email, iss: issuer, aud: ['fixture'], iat: now - 1, exp: now + 180 })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signed));
    return { jwt: `${signed}.${base64url(new Uint8Array(signature))}`, jwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
  })();
}
/** Exact fixture upstream only. Returns undefined for every unrelated request. */
export async function fixtureBrowserAccessUpstream(request: Request): Promise<Response | undefined> {
  if (!access) return undefined;
  if (request.url === `${issuer}/cdn-cgi/access/certs`) {
    const value = await access;
    return Response.json({ keys: [{ ...value.jwk, kid: 'fixture-browser', alg: 'RS256', use: 'sig' }] });
  }
  if (request.url === `${issuer}/cdn-cgi/access/get-identity`
    && request.headers.get('cookie') === `CF_Authorization=${(await access).jwt}` && request.redirect === 'manual') {
    return Response.json({ user_uuid: 'fixture-owner', email });
  }
  return undefined;
}
export async function fixtureOwnerDiagnostics(request: Request, env: Env, activityId: string): Promise<Response> {
  const url = new URL(request.url);
  const view = url.searchParams.get('diagnostics');
  // Only the closed diagnostic GET surfaces; never forward fixture commands.
  if (request.method !== 'GET' || !['summary', 'history', 'export'].includes(view ?? '')) return new Response(null, { status: 400 });
  const suffix = view === 'summary' ? '' : `/${view}`;
  const credential = await browserAccess();
  await env.KV.put(SETUP_KEYS.AUTH_DOMAIN, new URL(issuer).hostname);
  await env.KV.put(SETUP_KEYS.ACCESS_AUD_LIST, JSON.stringify(['fixture']));
  resetAuthConfigCache();
  const target = new URL(`https://fixture.internal/api/operator-activities/${encodeURIComponent(activityId)}/diagnostics/v2${suffix}`);
  for (const cursor of url.searchParams.getAll('cursor')) target.searchParams.append('cursor', cursor);
  const route = new Request(target, {
    headers: { 'cf-access-authenticated-user-email': email, 'cf-access-jwt-assertion': credential.jwt,
      cookie: `CF_Authorization=${credential.jwt}` },
  });
  return browser.fetch(route, env);
}
