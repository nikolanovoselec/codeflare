import { describe, it, expect } from 'vitest';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { createMockKV, type MockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';

/**
 * REQ-ENTERPRISE-012: the Setup-configured dynamic-route catalog + default route are
 * read back by loadEnterpriseRouteConfig (the resolver the container-env fan and the
 * interceptor's default-route rule both mirror). These exercise the real resolver:
 * gut the default-resolution or the malformed-JSON guards and a test below goes red.
 */
function makeEnv(kv: MockKV, enterprise = true): Env {
  return {
    KV: kv as unknown as KVNamespace,
    ENTERPRISE_MODE: enterprise ? 'active' : undefined,
  } as unknown as Env;
}

describe('loadEnterpriseRouteConfig (REQ-ENTERPRISE-012)', () => {
  it('AC5: returns empty config when ENTERPRISE_MODE is not active', async () => {
    const cfg = await loadEnterpriseRouteConfig(makeEnv(createMockKV(), false));
    expect(cfg).toEqual({ routeCatalog: [], defaultRoute: '', defaultReasoning: '' });
  });

  it('AC2: parses the route catalog (JSON string[]) from KV', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage', 'development']));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv));
    expect(cfg.routeCatalog).toEqual(['general_usage', 'development']);
  });

  it('AC2: uses the configured default route + its reasoning when the default is in the catalog', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage', 'development']));
    kv._store.set('setup:default_route', JSON.stringify({ route: 'development', reasoning: 'medium' }));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv));
    expect(cfg.defaultRoute).toBe('development');
    expect(cfg.defaultReasoning).toBe('medium');
  });

  it('AC2: falls back to the first catalog route AND drops the reasoning when the configured default is absent from the catalog', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage', 'development']));
    kv._store.set('setup:default_route', JSON.stringify({ route: 'retired_route', reasoning: 'high' }));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv));
    expect(cfg.defaultRoute).toBe('general_usage');
    // the discarded route's reasoning must NOT leak onto the fallback route
    expect(cfg.defaultReasoning).toBe('');
  });

  it('AC2: resolves the default to the first catalog route with reasoning off when no default is configured', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage', 'development']));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv));
    expect(cfg.defaultRoute).toBe('general_usage');
    expect(cfg.defaultReasoning).toBe('');
  });

  it('AC3: degrades to empty config on malformed stored JSON instead of throwing', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', '{not json');
    kv._store.set('setup:default_route', '{also not json');
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv));
    expect(cfg.routeCatalog).toEqual([]);
    expect(cfg.defaultRoute).toBe('');
    expect(cfg.defaultReasoning).toBe('');
  });

  it('AC2: ignores non-string catalog entries (defensive parse)', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['ok', 42, null, 'fine']));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv));
    expect(cfg.routeCatalog).toEqual(['ok', 'fine']);
  });
});

/**
 * REQ-ENTERPRISE-013: per-group routing. When GROUP_ROUTING is configured and the user
 * matches a group, the first matched group (configured-list order) overrides the global
 * catalog/default. No groups / no match ⇒ the global catalog, byte-identical to before.
 */
describe('loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)', () => {
  function withGlobalAndGroups(kv: MockKV): MockKV {
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage', 'development', 'code_review']));
    kv._store.set('setup:default_route', JSON.stringify({ route: 'general_usage', reasoning: 'off' }));
    kv._store.set('setup:group_routing', JSON.stringify({
      developers: { routes: ['code_review', 'development'], defaultRoute: 'code_review', reasoning: 'high' },
      ops: { routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'low' },
    }));
    return kv;
  }

  it('uses the matched group config over the global catalog/default', async () => {
    const cfg = await loadEnterpriseRouteConfig(makeEnv(withGlobalAndGroups(createMockKV())), ['developers']);
    expect(cfg.routeCatalog).toEqual(['code_review', 'development']);
    expect(cfg.defaultRoute).toBe('code_review');
    expect(cfg.defaultReasoning).toBe('high');
  });

  it('first matched group wins by configured list order', async () => {
    // groups arrive in configured order; ops precedes developers here.
    const cfg = await loadEnterpriseRouteConfig(makeEnv(withGlobalAndGroups(createMockKV())), ['ops', 'developers']);
    expect(cfg.routeCatalog).toEqual(['general_usage']);
    expect(cfg.defaultRoute).toBe('general_usage');
    expect(cfg.defaultReasoning).toBe('low');
  });

  it('falls back to the global catalog when no passed group has a config', async () => {
    const cfg = await loadEnterpriseRouteConfig(makeEnv(withGlobalAndGroups(createMockKV())), ['unconfigured']);
    expect(cfg.routeCatalog).toEqual(['general_usage', 'development', 'code_review']);
    expect(cfg.defaultRoute).toBe('general_usage');
  });

  it('falls back to the global catalog when no groups are passed (back-compat)', async () => {
    const cfg = await loadEnterpriseRouteConfig(makeEnv(withGlobalAndGroups(createMockKV())));
    expect(cfg.routeCatalog).toEqual(['general_usage', 'development', 'code_review']);
  });

  it('skips a group whose route set is empty and continues to the next match', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage', 'development']));
    kv._store.set('setup:group_routing', JSON.stringify({
      empty_group: { routes: [], defaultRoute: '', reasoning: 'off' },
      real_group: { routes: ['development'], defaultRoute: 'development', reasoning: 'medium' },
    }));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv), ['empty_group', 'real_group']);
    expect(cfg.routeCatalog).toEqual(['development']);
    expect(cfg.defaultRoute).toBe('development');
  });

  it("drops a group default that isn't in the group's own routes (drift → first route, reasoning off)", async () => {
    const kv = createMockKV();
    kv._store.set('setup:group_routing', JSON.stringify({
      g: { routes: ['a', 'b'], defaultRoute: 'gone', reasoning: 'high' },
    }));
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv), ['g']);
    expect(cfg.defaultRoute).toBe('a');
    expect(cfg.defaultReasoning).toBe('');
  });

  it('degrades to the global catalog on malformed GROUP_ROUTING JSON', async () => {
    const kv = createMockKV();
    kv._store.set('setup:dynamic_routes', JSON.stringify(['general_usage']));
    kv._store.set('setup:group_routing', '{not json');
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv), ['developers']);
    expect(cfg.routeCatalog).toEqual(['general_usage']);
  });

  it('non-enterprise ignores groups and returns empty config', async () => {
    const cfg = await loadEnterpriseRouteConfig(makeEnv(withGlobalAndGroups(createMockKV()), false), ['developers']);
    expect(cfg).toEqual({ routeCatalog: [], defaultRoute: '', defaultReasoning: '' });
  });
});
