import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import publicRoutes from '../../routes/public';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';

afterEach(() => vi.restoreAllMocks());

describe('Enterprise public metadata confidentiality', () => {
  it('REQ-ENTERPRISE-004 AC2: public configuration responses omit saved and deployment gateway credentials and coordinates', async () => {
    const kv = createMockKV();
    const canaries = {
      gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/private-account-canary/private-gateway-canary',
      gatewayId: 'saved-gateway-name-canary', token: 'saved-credential-canary',
      envUrl: 'https://gateway.ai.cloudflare.com/v1/env-account-canary/env-gateway-canary',
      envToken: 'deployment-credential-canary',
    };
    kv._store.set(SETUP_KEYS.AIG_GATEWAY_URL, canaries.gatewayUrl);
    kv._store.set(SETUP_KEYS.AIG_GATEWAY_ID, canaries.gatewayId);
    kv._store.set(SETUP_KEYS.AIG_TOKEN, canaries.token);
    kv._store.set(SETUP_KEYS.TURNSTILE_SITE_KEY, 'public-site-key');
    const before = new Map(kv._store);
    const env = { KV: kv, ENTERPRISE_MODE: 'active', ONBOARDING_LANDING_PAGE: 'active',
      AIG_GATEWAY_URL: canaries.envUrl, AIG_TOKEN: canaries.envToken } as unknown as Env;
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      requests.push(String(input)); return new Response(null, { status: 503 });
    });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/public', publicRoutes);
    for (const [path, expected] of [
      ['/public/contact-config', { turnstileSiteKey: 'public-site-key' }],
      ['/public/onboarding-config', { active: true, turnstileSiteKey: 'public-site-key' }],
    ] as const) {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(200);
      const wire = JSON.stringify({ headers: [...response.headers], body: await response.clone().text() });
      expect(await response.json()).toEqual(expected);
      for (const canary of Object.values(canaries)) expect(wire).not.toContain(canary);
    }
    expect(kv._store).toEqual(before);
    expect(requests).toEqual([]);
  });
});
