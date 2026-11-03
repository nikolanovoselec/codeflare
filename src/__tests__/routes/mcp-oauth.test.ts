import { describe, it, expect } from 'vitest';
import { createMcpOAuthRoutes, type McpOAuthDependencies } from '../../routes/mcp-oauth';
import type { Env } from '../../types';
import type { D1Session } from '../../lib/session-repository';

const state = 'a'.repeat(64), code = 'SYNTHETIC-CALLBACK-SECRET';
function fixture() {
  let authenticated = true, owner = 'owner', generation = 7, stopped = false;
  let pending = true;
  const delivered: string[] = [], retained: string[] = [];
  const binding = { state, owner: 'owner', session: 'abcdefgh', generation: 7, instance: 'https://instance.example',
    redirect: 'https://instance.example/auth/mcp/callback', process: '11111111-1111-4111-a111-111111111111',
    flow: '22222222-2222-4222-a222-222222222222', server: 'codeflare-portal-fixture', issuer: 'https://portal.example', expires: Date.now() + 240000 };
  const session = () => ({ ownerKey: owner, sessionId: 'abcdefgh', lifecycleGeneration: generation,
    lifecycleState: stopped ? 'stopped' : 'running' }) as D1Session;
  const deps: McpOAuthDependencies = {
    authenticate: async request => {
      retained.push(request.url);
      if (!authenticated || request.headers.has('cf-access-authenticated-user-email')) throw Error('unauthenticated');
      return { bucketName: owner, user: { email: 'owner@example.com', authenticated: true } };
    },
    sessions: () => ({ listSessions: async () => [session()], getSession: async () => session() }),
    forward: async (_env, requestedOwner, _session, request) => {
      const data = await request.json() as Record<string, unknown>;
      if (requestedOwner !== 'owner' || !pending) return new Response(null, { status: 404 });
      if (new URL(request.url).pathname.endsWith('/lookup')) {
        // The lookup is state-only; a code never reaches unrelated processes.
        if (data.code || data.state !== state) throw Error('invalid lookup');
        return Response.json(binding);
      }
      if (Object.entries(binding).some(([key, value]) => data[key] !== value)) return new Response(null, { status: 409 });
      pending = false;
      if (data.cancelled !== true) delivered.push(String(data.code));
      return Response.json({ delivered: true });
    },
  };
  const app = createMcpOAuthRoutes(deps);
  const request = (query = `state=${state}&code=${code}`, headers?: HeadersInit) => app.request(`https://instance.example/callback?${query}`, { headers }, {} as Env);
  return { request, delivered, retained, binding, setOwner(v: string) { owner = v; }, setGeneration(v: number) { generation = v; },
    deny() { authenticated = false; }, stop() { stopped = true; }, disconnect() { pending = false; } };
}

describe('hosted OAuth callback', () => {
  it('REQ-AGENT-226 AC3: callback authority and one-use delivery protect the original waiter', async () => {
    const f = fixture();
    expect((await f.request()).status).toBe(303);
    expect(f.delivered).toEqual([code]);
    expect((await f.request()).status).toBe(409);
    expect(f.delivered).toEqual([code]);
    const changes: ((x: ReturnType<typeof fixture>) => void)[] = [x => x.deny(), x => x.setOwner('other'), x => x.setGeneration(8), x => x.stop(), x => x.disconnect(), x => { x.binding.instance = 'https://other.example'; }, x => { x.binding.expires = Date.now() - 1; }, x => { x.binding.redirect = 'https://other.example/callback'; }];
    for (const change of changes) {
      const rejected = fixture(); change(rejected);
      expect((await rejected.request()).status).not.toBe(303);
      expect(rejected.delivered).toEqual([]);
    }
    for (const query of [`state=${'b'.repeat(64)}&code=${code}`, `state=${state}&code=${code}&iss=https://other.example`, `state=${state}&code=${code}&code=duplicate`, `state=${state}&code=${code}&error=denied`]) {
      const rejected = fixture(); expect((await rejected.request(query)).status).not.toBe(303); expect(rejected.delivered).toEqual([]);
    }
  });

  it('REQ-AGENT-226 AC4: callback responses and retained diagnostics exclude secret material', async () => {
    for (const denied of [false, true]) {
      const f = fixture(); if (denied) f.deny();
      const response = await f.request(undefined, { 'cf-access-authenticated-user-email': 'spoof@example.com' });
      const artifact = JSON.stringify({ body: await response.text(), headers: [...response.headers], retained: f.retained });
      expect(artifact).not.toContain(code);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Location')).toBe(denied ? null : '/auth/mcp/complete');
    }
    for (const header of ['X-Service-Auth', 'Authorization', 'CF-Access-Client-Id']) {
      const f = fixture(); const response = await f.request(undefined, { [header]: 'synthetic-service-secret' });
      expect(response.status).toBe(401); expect(f.delivered).toEqual([]);
      expect(f.retained).toEqual([]);
    }
    const error = fixture();
    const response = await error.request(`state=${state}&error=access_denied&error_description=${code}`);
    expect(response.status).toBe(303); expect(await response.text()).not.toContain(code); expect(error.delivered).toEqual([]);
  });
});
