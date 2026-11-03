import { Hono } from 'hono';
import { getContainer } from '@cloudflare/containers';
import type { Env } from '../types';
import { authenticateRequest } from '../lib/access';
import { D1SessionRepository, type D1Session } from '../lib/session-repository';
import { forwardExisting, getContainerId } from '../lib/container-helpers';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
const failure = (status = 400) => new Response('MCP authorization could not be completed. Return to Pi and retry /mcp:auth.', { status, headers });

interface Binding { owner: string; session: string; generation: number; instance: string; state: string;
  process: string; flow: string; server: string; issuer: string; redirect: string; expires: number }
export interface McpOAuthDependencies {
  authenticate: typeof authenticateRequest;
  sessions(env: Env): Pick<D1SessionRepository, 'listSessions' | 'getSession'>;
  forward(env: Env, owner: string, session: string, request: Request): Promise<Response>;
}
const defaults: McpOAuthDependencies = {
  authenticate: authenticateRequest,
  sessions: env => new D1SessionRepository(env.USAGE_DB),
  forward: (env, owner, session, request) => forwardExisting(getContainer(env.CONTAINER, getContainerId(owner, session)), request),
};
function validBinding(value: unknown, owner: string, session: D1Session, instance: string, state: string): value is Binding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Binding;
  return b.owner === owner && b.session === session.sessionId && b.generation === session.lifecycleGeneration
    && b.instance === instance && b.redirect === `${instance}/auth/mcp/callback` && b.state === state
    && typeof b.process === 'string' && /^[a-f0-9-]{36}$/.test(b.process)
    && typeof b.flow === 'string' && /^[a-f0-9-]{36}$/.test(b.flow)
    && typeof b.server === 'string' && /^codeflare-portal-[a-z][a-z0-9_-]{0,63}$/.test(b.server)
    && typeof b.issuer === 'string' && /^https:\/\//.test(b.issuer)
    && Number.isSafeInteger(b.expires) && b.expires > Date.now() && b.expires <= Date.now() + 300000;
}
const post = (path: string, value: object) => new Request(`http://container/mcp-oauth/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

export function createMcpOAuthRoutes(deps: McpOAuthDependencies = defaults) {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/callback', async c => {
    try {
      // /auth/* does not inherit /api/* authentication. Authenticate a clean URL
      // so auth diagnostics cannot retain the OAuth query. Suppress only the
      // setup-email fallback; no service/account token can stand in for a user.
      if (['X-Service-Auth', 'CF-Access-Client-Id', 'CF-Access-Client-Secret', 'Authorization'].some(h => c.req.header(h))) return failure(401);
      const clean = new URL(c.req.url); clean.search = ''; clean.hash = '';
      const authHeaders = new Headers(c.req.raw.headers);
      authHeaders.delete('cf-access-authenticated-user-email');
      const { bucketName } = await deps.authenticate(new Request(clean, { headers: authHeaders }), c.env);
      const url = new URL(c.req.url), q = url.searchParams;
      if (url.protocol !== 'https:' || [...q.keys()].some(k => !['state', 'code', 'iss', 'error', 'error_description'].includes(k))
        || [...new Set(q.keys())].some(k => q.getAll(k).length !== 1)) return failure();
      const state = q.get('state'), code = q.get('code'), cancelled = q.has('error');
      if (!state || !/^[a-f0-9]{64}$/.test(state) || cancelled === Boolean(code)
        || (code && (code.length > 8192 || /[\x00-\x20\x7f]/.test(code)))) return failure();
      const sessions = deps.sessions(c.env);
      // The original SDK's random state stays untouched. Locate only among the
      // authenticated owner's existing live sessions, using state-only probes.
      // No code queue/index and no auto-start or process guessing is involved.
      const matches: Binding[] = [];
      for (const session of await sessions.listSessions(bucketName)) {
        if (session.lifecycleState !== 'running') continue;
        const response = await deps.forward(c.env, bucketName, session.sessionId, post('lookup', { state }));
        if (!response.ok) continue;
        const binding: unknown = await response.json();
        if (validBinding(binding, bucketName, session, url.origin, state)) matches.push(binding);
      }
      if (matches.length !== 1) return failure(409);
      const binding = matches[0]!;
      if (q.has('iss') && q.get('iss') !== binding.issuer) return failure();
      const current = await sessions.getSession(bucketName, binding.session);
      if (!current || current.lifecycleState !== 'running' || current.lifecycleGeneration !== binding.generation) return failure(409);
      const returned = await deps.forward(c.env, bucketName, binding.session, post('return', {
        ...binding, ...(cancelled ? { cancelled: true } : { code }),
      }));
      if (!returned.ok) return failure(409);
      // A clean completion redirect, never a login-return chain or a reflection
      // of provider response values. Platform invocation privacy is separate.
      return new Response(null, { status: 303, headers: { ...headers, Location: '/auth/mcp/complete' } });
    } catch { return failure(401); }
  });
  app.get('/complete', () => new Response('Return to Pi to continue.', { headers }));
  return app;
}
export default createMcpOAuthRoutes();
