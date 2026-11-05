import { expect, it } from 'vitest';
import { wireContainerInterception, refreshStrictEgressInterception, type InterceptionHost } from '../../container/container-interception';
import { EgressController } from '../../egress-controller';
import { McpPortalInterceptor } from '../../mcp-portal-interceptor';
import { mcpPortalFixture, portal, access } from '../helpers/mcp-portal-fixture';
import { SETUP_KEYS } from '../../lib/kv-keys';

async function boundary(enterprise: boolean, operator = false, strict = false) {
  const f = await mcpPortalFixture();
  const env = { ...f.env, ENTERPRISE_MODE: enterprise ? 'active' : undefined };
  const handlers = new Map<string, Fetcher>();
  const exports = new Proxy({}, { get: (_target, name) => ({ props }: { props: Record<string, unknown> }) => name === 'McpPortalInterceptor'
    ? new McpPortalInterceptor({ props } as unknown as ExecutionContext, env)
    : name === 'EgressController' ? new EgressController({ props } as unknown as ExecutionContext, env)
      : { fetch: async () => new Response('existing non-MCP transport') } });
  const host = { env, logger: { info() {}, warn() {}, error() {} }, _bucketName: 'owner', _sessionId: null,
    _userEmail: null, _userGroups: [], _cloudflareApiToken: null, _strictEgress: strict,
    ...(operator ? { _operatorPolicy: { transport: 'synthetic' } } : {}),
    ctx: { exports, container: { interceptOutboundHttps: (name: string, handler: Fetcher) => { handlers.set(name, handler); } } },
  } as unknown as InterceptionHost;
  return { ...f, host, handlers };
}

it.each([false, true])('REQ-AGENT-229 AC1: registered portal boundary is available in all deployment modes and refuses missing owner grants (enterprise=%s)', async enterprise => {
  const f = await boundary(enterprise);
  await wireContainerInterception(f.host);
  const response = await f.handlers.get('portal.example')!.fetch(new Request(portal.url, { headers: { Authorization: 'Bearer arbitrary-agent-value' } }));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: 'MCP_RECONNECT_REQUIRED' });
  if (enterprise) expect(await (await f.handlers.get('api.github.com')!.fetch('https://api.github.com')).text()).toBe('existing non-MCP transport');
});

it('REQ-AGENT-229 AC3: portal host collisions and unavailable interception fail startup rather than bypassing credential isolation', async () => {
  const f = await boundary(true);
  await f.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([{ name: 'collision', url: 'https://api.github.com/mcp' }]));
  await expect(wireContainerInterception(f.host)).rejects.toThrow(/collides/);
  const unavailable = await boundary(false);
  (unavailable.host.ctx as unknown as { container: unknown }).container = undefined;
  await expect(wireContainerInterception(unavailable.host)).rejects.toThrow(/interception/);
});

it('REQ-AGENT-229 AC2: parent-bound Operators cannot inherit ordinary owner portal grants', async () => {
  const f = await boundary(false, true);
  await wireContainerInterception(f.host);
  const response = await f.handlers.get('portal.example')!.fetch(new Request(portal.url));
  expect(response.status).toBe(403);
});

it.each([false, true])('REQ-AGENT-229 AC1: strict catch-all keeps parent portal ownership across R2 refresh (refresh=%s)', async refresh => {
  const f = await boundary(true, false, true);
  await f.begin(); await f.finish();
  const destinations: string[] = [];
  f.host.env.EGRESS = { fetch: async (request: Request) => {
    destinations.push(request.url);
    expect(request.headers.get('authorization')).toBe(`Bearer ${access}`);
    return new Response('owner portal result', { status: 202 });
  } } as unknown as Fetcher;
  await wireContainerInterception(f.host);
  if (refresh) await refreshStrictEgressInterception(f.host, { bucket: 'not-the-portal-owner', resourcePolicy: 'mutable' });
  // Exercise the public catch-all directly, without assuming platform pattern precedence.
  const response = await f.handlers.get('*')!.fetch(new Request(portal.url, { headers: { authorization: 'Bearer codeflare-mcp-portal' } }));
  expect(response.status).toBe(202); expect(await response.text()).toBe('owner portal result');
  expect(destinations).toEqual([portal.url]);
  await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
  expect((await f.handlers.get('*')!.fetch(new Request(portal.url))).status).toBe(403);
  expect(destinations).toEqual([portal.url]);
});

it('REQ-AGENT-229 AC2: strict refresh selects current configuration without adopting an old grant', async () => {
  const f = await boundary(true, false, true);
  await f.begin(); await f.finish();
  const destinations: string[] = [];
  f.host.env.EGRESS = { fetch: async (request: Request) => {
    destinations.push(request.url); return new Response('unexpected send');
  } } as unknown as Fetcher;
  await wireContainerInterception(f.host);
  const updated = { ...portal, url: 'https://replacement.example/mcp' };
  await f.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([updated]));
  await refreshStrictEgressInterception(f.host, { bucket: 'not-the-portal-owner', resourcePolicy: 'mutable' });
  const response = await f.handlers.get('*')!.fetch(new Request(updated.url));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: 'MCP_RECONNECT_REQUIRED' });
  expect(destinations).toEqual([]);
});

it.each([false, true])('REQ-AGENT-229 AC2: parent Operator profile cannot inherit a catch-all owner grant (refresh=%s)', async refresh => {
  const f = await boundary(true, false, true);
  await f.begin(); await f.finish();
  // Profile presence alone excludes personal grants, even without an Operator policy.
  f.host._operatorContainerProfile = { activityId: 'activity', outputPrefix: 'outputs/', piProfile: { source: 'managed' } } as unknown as NonNullable<InterceptionHost['_operatorContainerProfile']>;
  const destinations: string[] = [];
  f.host.env.EGRESS = { fetch: async (request: Request) => {
    destinations.push(request.url); return new Response('unexpected send');
  } } as unknown as Fetcher;
  await wireContainerInterception(f.host);
  if (refresh) await refreshStrictEgressInterception(f.host, { bucket: 'owner', resourcePolicy: 'mutable' });
  expect((await f.handlers.get('*')!.fetch(new Request(portal.url))).status).toBe(403);
  expect(destinations).toEqual([]);
});
