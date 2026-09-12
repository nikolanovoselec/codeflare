import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createNativeTarget, nativeVerificationMatches, parseNativeAiTargets } from '../../lib/native-ai-targets';
import { getBuiltInProfileRef } from '../../lib/reasoning-profiles';
import { connectionFingerprint } from '../../lib/reasoning-verification';
import { validateConfigurationValues } from '../../lib/admin-configuration';
import reasoningRoutes from '../../routes/admin/reasoning';
import { loadEnterpriseRouteConfig } from '../../lib/access';

vi.mock('../../middleware/auth', () => ({ authMiddleware: async (_c: any, next: any) => next(), requireAdmin: async (_c: any, next: any) => next() }));
const connection = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`, gatewayId: 'synthetic', token: 'synthetic-upgrade-token' };
// Exact immutable built-in reference from d50d93d3, extracted from that source.
// Provider binding and receipt coordinates are synthetic test data, not live authority.
const oldRef = { id: 'bedrock-anthropic-native-opus-auto', revision: 1, hash: '4ff39c642f15d29f5829df5454bf449ee3ee9c481bde20406337cb593d07bd7b' };
function oldTarget(id: string) {
  const target = createNativeTarget({ id, label: 'Old Opus', provider: 'aws-bedrock', providerConfigId: 'synthetic-provider', model: 'eu.anthropic.claude-opus-5',
    transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1', profileRef: oldRef, contextWindow: 200000, enabled: true });
  return { ...target, verification: { schemaVersion: 1 as const, method: 'administrator' as const, targetId: id, model: target.model,
    providerConfigId: target.providerConfigId, connectionFingerprint: connectionFingerprint(connection)!, profileRef: oldRef,
    transport: target.transport, region: target.region, adapterVersion: 'bedrock-anthropic-native-v2' as const, checkedAt: '2026-09-11T12:00:00.000Z' } };
}

describe('REQ-ENTERPRISE-074 existing native receipt upgrade', () => {
  it('certifies, saves and authorizes a synthetic future model through the existing workflow without authoring a profile', async () => {
    const kv = createMockKV();
    const env = { KV: kv, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: connection.gatewayUrl, AIG_GATEWAY_ID: connection.gatewayId, AIG_TOKEN: connection.token } as unknown as Env;
    await kv.put(SETUP_KEYS.AIG_GATEWAY_URL, connection.gatewayUrl); await kv.put(SETUP_KEYS.AIG_GATEWAY_ID, connection.gatewayId);
    const app = new Hono(); app.use('*', async (c, next) => { c.env = env; await next(); }); app.route('/reasoning', reasoningRoutes);
    let calls = 0;
    const authentic = [{ type: 'thinking', thinking: '', signature: 'SYNTHETIC-NOT-LIVE' },
      { type: 'tool_use', id: 'synthetic-canary', name: 'codeflare_profile_canary', input: { value: 'ok' } }];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        const result = String(url).includes('/provider_configs') ? [{ id: 'synthetic-provider', provider_slug: 'aws-bedrock', gateway_id: 'synthetic', default_config: true }] : [];
        return Response.json({ success: true, result, result_info: { page: 1, count: result.length, per_page: 100, total_count: result.length } });
      }
      calls++; const body = JSON.parse(String(init!.body));
      expect(String(url)).toContain('/eu.anthropic.claude-synthetic-future-2099-v1%3A0/invoke');
      if (calls === 2) expect(body.messages.at(-2).content).toEqual(authentic);
      return Response.json({ content: calls === 1 ? authentic : [{ type: 'text', text: 'synthetic result' }], stop_reason: calls === 1 ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4, cache_creation_input_tokens: calls === 3 ? 8192 : 0, cache_read_input_tokens: calls === 4 ? 8192 : 0 } });
    });
    try {
      const target = { label: 'New protocol target', provider: 'aws-bedrock', model: 'eu.anthropic.claude-synthetic-future-2099-v1:0',
        transport: 'aig-bedrock-anthropic-invoke', region: 'eu-central-1', profileRef: getBuiltInProfileRef('bedrock-anthropic-native-provider-default'), contextWindow: 200000, enabled: false };
      const post = (body: unknown) => app.request('/reasoning/native/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post({ target, administratorConfirmed: true })).status).toBe(400);
      expect(calls).toBe(0);
      const response = await post({ target, maxCompletionTokens: 256 });
      expect(response.status).toBe(200);
      const check: any = await response.json();
      expect(check).toMatchObject({ assignable: true, report: { capabilitySummary: { grade: 'Acceptable', nativePromptCache: true } } });
      expect(calls).toBe(4);
      expect(JSON.stringify(check)).not.toContain('SYNTHETIC-NOT-LIVE');
      const values = { gatewayUrl: connection.gatewayUrl, gatewayId: connection.gatewayId, replacementToken: '', dynamicRoutes: [],
        defaultRoute: { route: '', reasoning: 'off' }, routeContextWindows: {}, groupRouting: [], fallbackRouting: { enabled: false },
        reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
        nativeTargets: [{ ...target, id: check.targetId, enabled: true }], nativeChecks: { [check.targetId]: check.checkId } };
      const prepared = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values);
      expect(prepared.fieldErrors ?? {}).toEqual({});
      // Persist only the server-normalized document (the Save workflow's output),
      // never a browser-authored receipt, then resolve the actual access boundary.
      kv._set(SETUP_KEYS.NATIVE_AI_TARGETS, prepared.values!.nativeTargets);
      kv._set(SETUP_KEYS.REASONING_CONFIGURATION, prepared.values!.reasoningConfiguration);
      kv._set(SETUP_KEYS.DYNAMIC_ROUTES, []);
      kv._set(SETUP_KEYS.GROUP_ROUTING, { engineering: { routes: [], targets: [{ kind: 'native-target', targetId: check.targetId }],
        defaultTarget: { kind: 'native-target', targetId: check.targetId }, reasoning: 'max' } });
      const publication = await loadEnterpriseRouteConfig(env, ['engineering']);
      expect(publication.routeCatalog).toEqual([`cf-native-${check.targetId}`]);
      expect(publication.promptCacheTargets).toEqual(publication.routeCatalog);
      expect(publication.routeReasoningLevels[publication.defaultRoute]).toEqual([]);
      expect(calls).toBe(4); // Access/publication do not run paid discovery again.
      const substitution = await validateConfigurationValues(env, 'aiRouting', 'enterprise', { ...values,
        nativeTargets: [{ ...values.nativeTargets[0], model: 'eu.anthropic.claude-another-synthetic-2099-v1:0' }] });
      expect(Object.keys(substitution.fieldErrors ?? {})).not.toHaveLength(0);
    } finally { fetcher.mockRestore(); }
  });

  it('upgrades one real old profile reference via explicit confirmation while retaining another disabled stale target', async () => {
    const kv = createMockKV();
    const env = { KV: kv, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: connection.gatewayUrl, AIG_GATEWAY_ID: connection.gatewayId, AIG_TOKEN: connection.token } as unknown as Env;
    await kv.put(SETUP_KEYS.AIG_GATEWAY_URL, connection.gatewayUrl); await kv.put(SETUP_KEYS.AIG_GATEWAY_ID, connection.gatewayId);
    const old = [oldTarget('11111111-1111-4111-8111-111111111111'), oldTarget('22222222-2222-4222-8222-222222222222')];
    kv._set(SETUP_KEYS.NATIVE_AI_TARGETS, { schemaVersion: 1, targets: old });
    expect(parseNativeAiTargets(await kv.get(SETUP_KEYS.NATIVE_AI_TARGETS)).targets).toHaveLength(2);
    expect(nativeVerificationMatches(old[0], connection)).toBe(false);
    const app = new Hono(); app.use('*', async (c, next) => { c.env = env; await next(); }); app.route('/reasoning', reasoningRoutes);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const result = String(url).includes('/provider_configs') ? [{ id: 'synthetic-provider', provider_slug: 'aws-bedrock', gateway_id: 'synthetic', default_config: true }] : [];
      return Response.json({ success: true, result, result_info: { page: 1, count: result.length, per_page: 100, total_count: result.length } });
    });
    const draft = (target: typeof old[number]) => ({ id: target.id, label: target.label, provider: target.provider, model: target.model,
      transport: target.transport, region: target.region, profileRef: target.profileRef, contextWindow: target.contextWindow, enabled: false });
    try {
      const upgraded = { ...draft(old[0]), profileRef: getBuiltInProfileRef('bedrock-anthropic-native-opus-auto') };
      const response = await app.request('/reasoning/native/discover', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: upgraded, administratorConfirmed: true }) });
      expect(response.status).toBe(200);
      const checked: any = await response.json();
      expect(checked).toMatchObject({ assignable: true, classification: 'Administrator-confirmed' });
      const values = { gatewayUrl: connection.gatewayUrl, gatewayId: connection.gatewayId, replacementToken: '', dynamicRoutes: [],
        defaultRoute: { route: '', reasoning: 'off' }, routeContextWindows: {}, groupRouting: [], fallbackRouting: { enabled: false },
        reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
        nativeTargets: [{ ...upgraded, enabled: true }, draft(old[1])], nativeChecks: { [old[0].id]: checked.checkId } };
      const result = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values);
      expect(result.fieldErrors ?? {}).toEqual({});
      const targets = (result.values!.nativeTargets as any).targets;
      expect(targets[1].profileRef).toEqual(oldRef);
      expect(targets[1].enabled).toBe(false);
      expect(targets[0].transport).toBe(old[0].transport);
      expect(nativeVerificationMatches(targets[0], connection)).toBe(true);
      expect(nativeVerificationMatches(targets[1], connection)).toBe(false);
      // A stale entry may be retained disabled, never edited or re-enabled by
      // borrowing another target's fresh receipt.
      for (const change of [{ enabled: true }, { model: 'eu.anthropic.claude-sonnet-5' }, { label: 'edited stale target' }]) {
        const bad = await validateConfigurationValues(env, 'aiRouting', 'enterprise', { ...values, nativeTargets: [values.nativeTargets[0], { ...values.nativeTargets[1], ...change }] });
        expect(Object.keys(bad.fieldErrors ?? {})).not.toHaveLength(0);
      }
    } finally { fetcher.mockRestore(); }
  });
});
