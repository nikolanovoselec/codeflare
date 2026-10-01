import { describe, expect, it } from 'vitest';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { parseFallbackRouting } from '../../lib/reasoning-configuration';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';

describe('REQ-ENTERPRISE-088: native Pi policy selection', () => {
  it('REQ-ENTERPRISE-088 AC1: fallback preserves exact booleans and rejects coercion', () => {
    const policy = { enabled: true, routes: ['route'], defaultRoute: 'route', reasoning: 'off' };
    for (const permission of [true, false]) expect(parseFallbackRouting({ ...policy, allowPersonalPiProviders: permission })).toMatchObject({ allowPersonalPiProviders: permission });
    for (const permission of ['true', 1, null, {}, []]) expect(() => parseFallbackRouting({ ...policy, allowPersonalPiProviders: permission })).toThrow();
    expect(parseFallbackRouting(policy)).toEqual(policy);
    expect(parseFallbackRouting({ enabled: false })).toEqual({ enabled: false });
  });
  it('REQ-ENTERPRISE-088 AC3: first policy wins independently of sanctioned model eligibility', async () => {
    const kv = createMockKV();
    const env = { ENTERPRISE_MODE: 'active', KV: kv } as unknown as Env;
    const empty = { routes: [], defaultRoute: '', reasoning: 'off' };
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {}, fallbackRouting: { enabled: true, routes: ['route'], defaultRoute: 'route', reasoning: 'off', allowPersonalPiProviders: true } });
    kv._set(SETUP_KEYS.GROUP_ROUTING, { first: { ...empty, allowPersonalPiProviders: false }, second: { ...empty, allowPersonalPiProviders: true } });
    expect((await loadEnterpriseRouteConfig(env, ['first', 'second']) as { allowPersonalPiProviders?: boolean }).allowPersonalPiProviders === true).toBe(false);
    expect((await loadEnterpriseRouteConfig(env, ['second', 'first']) as { allowPersonalPiProviders?: boolean }).allowPersonalPiProviders).toBe(true);
    expect((await loadEnterpriseRouteConfig(env, []) as { allowPersonalPiProviders?: boolean }).allowPersonalPiProviders).toBe(true);
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {}, fallbackRouting: { enabled: false } });
    expect((await loadEnterpriseRouteConfig(env, []) as { allowPersonalPiProviders?: boolean }).allowPersonalPiProviders === true).toBe(false);
    kv._set(SETUP_KEYS.GROUP_ROUTING, { second: { ...empty, allowPersonalPiProviders: 'true' } });
    expect((await loadEnterpriseRouteConfig(env, ['second']) as { allowPersonalPiProviders?: boolean }).allowPersonalPiProviders === true).toBe(false);
    kv._store.set(SETUP_KEYS.GROUP_ROUTING, '{bad-json');
    expect((await loadEnterpriseRouteConfig(env, ['second']) as { allowPersonalPiProviders?: boolean }).allowPersonalPiProviders === true).toBe(false);
  });
});
