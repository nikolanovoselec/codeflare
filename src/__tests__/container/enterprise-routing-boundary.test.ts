import { afterEach, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { verifiedRoutingConfiguration, routingGatewayUrl } from '../helpers/verified-routing';
import { getBuiltInProfileRef } from '../../lib/reasoning-profiles';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { buildEnvVars, type ContainerEnvState } from '../../container/container-env';
import { wireContainerInterception, type InterceptionHost } from '../../container/container-interception';
import { LlmInterceptor } from '../../llm-interceptor';

afterEach(() => vi.restoreAllMocks());

it('REQ-ENTERPRISE-004 AC4 / REQ-ENTERPRISE-013 AC3: missing email uses the bound bucket and publication matches filtered runtime defaults', async () => {
  const kv = createMockKV();
  const env = { KV: kv, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: routingGatewayUrl,
    AIG_TOKEN: 'routing-boundary-token' } as unknown as Env;
  const profileRef = getBuiltInProfileRef('openai-gpt-chat-tools-off');
  const configuration = verifiedRoutingConfiguration({ schemaVersion: 1, customProfileRevisions: [],
    routeAssignments: { admitted: { activeProfile: profileRef }, excluded: { activeProfile: profileRef } },
    fallbackRouting: { enabled: false } }, { gatewayUrl: routingGatewayUrl, token: env.AIG_TOKEN });
  configuration.routeAssignments.unconfirmed = { activeProfile: profileRef };
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
  kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['admitted', 'excluded', 'unconfirmed']);
  kv._set(SETUP_KEYS.GROUP_ROUTING, { engineering: { routes: ['admitted', 'unconfirmed'], defaultRoute: 'admitted', reasoning: 'off' } });
  const before = new Map(kv._store);
  const published = await loadEnterpriseRouteConfig(env, ['engineering']);
  const state = { _bucketName: 'bound-bucket', _sessionId: 'boundtest01', _userEmail: null, _userGroups: ['engineering'],
    _routeCatalog: published.routeCatalog, _defaultRoute: published.defaultRoute, _defaultReasoning: published.defaultReasoning,
    _routeContextWindows: published.routeContextWindows, _routeReasoningLevels: published.routeReasoningLevels,
    _modelDisplayNames: published.modelDisplayNames } as unknown as ContainerEnvState;
  const vars = buildEnvVars(state, env);
  expect(JSON.parse(vars.ENTERPRISE_ROUTE_CATALOG)).toEqual(['admitted']);
  expect(vars.ENTERPRISE_DEFAULT_ROUTE).toBe('admitted');
  expect(JSON.parse(vars.ENTERPRISE_ROUTE_REASONING_LEVELS)).toEqual({ admitted: ['off'] });
  const handlers = new Map<string, Fetcher>();
  const upstream: Array<{ url: string; headers: Headers; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    upstream.push({ url: request.url, headers: request.headers, body: await request.json() });
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  const host = { ...state, env, _strictEgress: false, logger: { info() {}, warn() {}, error() {} },
    ctx: { exports: { LlmInterceptor: ({ props }: { props: unknown }) => new LlmInterceptor({ props } as unknown as ExecutionContext, env) },
      container: { interceptOutboundHttps: (name: string, handler: Fetcher) => handlers.set(name, handler) } },
  } as unknown as InterceptionHost;
  await wireContainerInterception(host);
  const handler = handlers.get('api.openai.com')!;
  expect(handler).toBeDefined();
  for (const model of ['admitted', 'unconfirmed', 'excluded', 'unknown']) {
    const response = await handler.fetch(new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
    }));
    expect(response.status).toBe(200);
    expect(upstream.at(-1)?.body).toMatchObject({ model: 'dynamic/admitted', messages: [{ role: 'user', content: 'hello' }] });
    const headers = upstream.at(-1)!.headers;
    expect(headers.get('cf-aig-gateway-id')).toBe('gateway');
    const metadata = JSON.parse(headers.get('cf-aig-metadata')!);
    expect(metadata).toEqual({ user: 'bound-bucket', group_engineering_4qx73k: 1 });
  }
  expect(kv._store).toEqual(before);
});
