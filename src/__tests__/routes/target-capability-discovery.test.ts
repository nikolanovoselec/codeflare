import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import reasoningRoutes from '../../routes/admin/reasoning';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { validateConfigurationValues } from '../../lib/admin-configuration';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { readRouteCheck, verificationMatches } from '../../lib/reasoning-verification';
import { readNativeTargetCheck } from '../../lib/native-ai-targets';
import { getBuiltInProfile } from '../../lib/reasoning-profiles';
import { capabilityCandidates } from '../../lib/ai-capability-discovery';

vi.mock('../../middleware/auth', () => ({ authMiddleware: async (_c: any, next: any) => next(), requireAdmin: async (_c: any, next: any) => next() }));
afterEach(() => vi.restoreAllMocks());
const connection = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`, gatewayId: 'synthetic', token: 'synthetic-token' };
function setup() {
  const kv = createMockKV();
  kv._store.set(SETUP_KEYS.AIG_GATEWAY_URL, connection.gatewayUrl); kv._store.set(SETUP_KEYS.AIG_GATEWAY_ID, connection.gatewayId);
  const env = { KV: kv, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: connection.gatewayUrl, AIG_GATEWAY_ID: connection.gatewayId, AIG_TOKEN: connection.token } as unknown as Env;
  const app = new Hono(); app.use('*', async (c, next) => { c.env = env; await next(); }); app.route('/reasoning', reasoningRoutes);
  return { kv, env, post: (body: unknown, path = '/reasoning/capabilities/discover') => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
const config = { gatewayUrl: connection.gatewayUrl, gatewayId: connection.gatewayId, replacementToken: '', dynamicRoutes: [],
  defaultRoute: { route: '', reasoning: 'off' }, routeContextWindows: {}, groupRouting: [], fallbackRouting: { enabled: false },
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, nativeTargets: [], nativeChecks: {} };
const topology = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } },
  { id: 'model', type: 'model', properties: { provider: 'unlisted-provider', model: 'synthetic-future-2099' }, outputs: { success: { elementId: 'end' } } },
  { id: 'end', type: 'end', outputs: {} }];

describe('REQ-ENTERPRISE-074 server-owned automatic discovery authority', () => {
  it('discovers an unlisted Dynamic backend, issues a receipt and survives Save → authorization without profile authoring', async () => {
    const { kv, env, post } = setup(); let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        if (String(url).endsWith('/routes')) return Response.json({ data: { routes: [{ id: 'id', name: 'future' }] } });
        return Response.json({ result: { version: { version_id: 'v1', active: true, data: topology } } });
      }
      expect(String(url)).toContain('/compat/chat/completions');
      const body = JSON.parse(String(init!.body)); calls++;
      expect(body.model).toBe('dynamic/future'); expect(body).not.toHaveProperty('cache_control');
      const delta = calls === 1 ? { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] } : { content: 'Synthetic result.' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8192, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream', 'cf-aig-provider': 'unlisted-provider', 'cf-aig-model': 'synthetic-future-2099', 'cf-aig-cache-status': calls === 4 ? 'HIT' : 'MISS' } });
    });
    const response = await post({ kind: 'dynamic-route', route: 'future' }); expect(response.status, JSON.stringify({ body: await response.clone().json(), calls })).toBe(200);
    const result: any = await response.json(); expect(result.assignable).toBe(true); expect(calls).toBe(4);
    expect(result).not.toHaveProperty('matchedProfiles');
    expect(verificationMatches(result.routeVerification, result.profile, connection)).toBe(true);
    expect(verificationMatches({ ...result.routeVerification, capabilities: undefined }, result.profile, connection)).toBe(false);
    expect(verificationMatches({ ...result.routeVerification, method: 'administrator' }, result.profile, connection)).toBe(false);
    const receipt = await readRouteCheck(kv as unknown as KVNamespace, result.checkId); expect(receipt.verification.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ cache: 'gateway-response' }] });
    const values = { ...config, dynamicRoutes: ['future'], routeContextWindows: { future: 200000 }, routeChecks: { future: result.checkId },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [result.profile], routeAssignments: { future: { activeProfile: result.routeVerification.profileRef, verification: result.routeVerification } } } };
    const saved = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values); expect(saved.fieldErrors ?? {}).toEqual({});
    kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['future']); kv._set(SETUP_KEYS.REASONING_CONFIGURATION, saved.values!.reasoningConfiguration);
    kv._set(SETUP_KEYS.GROUP_ROUTING, { engineering: { routes: ['future'], defaultRoute: 'future', reasoning: 'max' } });
    const access = await loadEnterpriseRouteConfig(env, ['engineering']); expect(access.routeCatalog).toEqual(['future']);
    expect(access.promptCacheTargets).toBeUndefined(); // A Gateway HIT never grants native checkpoint serialization.
    expect(calls).toBe(4);
  });

  it('REQ-ENTERPRISE-035/043: lets an administrator activate verified tools without cache reuse and save an Off preference through real receipt authority', async () => {
    const { kv, env, post } = setup();
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        if (String(url).endsWith('/routes')) return Response.json({ data: { routes: [{ id: 'id', name: 'future' }] } });
        return Response.json({ result: { version: { version_id: 'v1', active: true, data: topology } } });
      }
      const body = JSON.parse(String(init?.body)); calls++;
      expect(String(url)).toContain('/compat/chat/completions');
      expect(body.model).toBe('dynamic/future');
      expect(body.stream).toBe(true); // Missing cache evidence must not force a buffered alternative.
      expect(JSON.stringify(body)).not.toContain('cache_control');
      const first = calls === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }
        : { content: 'Synthetic result.' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8192, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream', 'cf-aig-provider': 'unlisted-provider', 'cf-aig-model': 'synthetic-future-2099', 'cf-aig-cache-status': 'MISS' } });
    });
    const response = await post({ kind: 'dynamic-route', route: 'future' });
    expect(response.status).toBe(200);
    const result: any = await response.json();
    expect(result.assignable).toBe(true);
    expect(calls).toBe(4);
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ tools: true, replay: true, cache: 'inconclusive' }] });
    expect(result.capabilities).not.toHaveProperty('grade');
    const receipt = await readRouteCheck(kv as unknown as KVNamespace, result.checkId);
    expect(receipt.route).toBe('future');
    expect(receipt.verification).toEqual(result.routeVerification);
    expect(verificationMatches(receipt.verification, result.profile, connection)).toBe(true);
    expect(verificationMatches({ ...receipt.verification, capabilities: undefined }, result.profile, connection)).toBe(false);
    expect(verificationMatches({ ...receipt.verification, method: 'administrator' }, result.profile, connection)).toBe(false);
    expect(kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false); // Discovery did not save or enable.
    const values = { ...config, dynamicRoutes: ['future'], routeContextWindows: { future: 200000 }, routeChecks: { future: result.checkId },
      groupRouting: [{ accessGroup: 'engineering', routes: ['future'], defaultRoute: 'future', reasoning: 'off' }],
      fallbackRouting: { enabled: true, routes: ['future'], defaultRoute: 'future', reasoning: 'off' },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [result.profile], routeAssignments: { future: { activeProfile: result.routeVerification.profileRef, verification: result.routeVerification } } } };
    const saved = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values);
    expect(saved.fieldErrors ?? {}).toEqual({});
    kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['future']);
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, saved.values!.reasoningConfiguration);
    kv._set(SETUP_KEYS.GROUP_ROUTING, { engineering: { routes: ['future'], defaultRoute: 'future', reasoning: 'off' } });
    const access = await loadEnterpriseRouteConfig(env, ['engineering']);
    expect(access.routeCatalog).toEqual(['future']);
    expect(access.promptCacheTargets).toBeUndefined();
    expect(calls).toBe(4); // Save and authorization never run another paid probe.
  });

  describe.each(['/reasoning/capabilities/discover', '/reasoning/discover'])('%s backend identity authority', (path) => {
    it.each([false, true])('requires response identities on a multi-backend route (identified: %s)', async (identified) => {
      const { kv, post } = setup(); let calls = 0;
      const generated = capabilityCandidates(false)[0];
      const profileRef = { id: generated.id, revision: generated.revision, hash: generated.hash };
      const multiBackend = [topology[0],
        { ...topology[1], outputs: { success: { elementId: 'end' }, failure: { elementId: 'backup' } } },
        { id: 'backup', type: 'model', properties: { provider: 'other-provider', model: 'synthetic-backup-2099' }, outputs: { success: { elementId: 'end' } } },
        topology[2]];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          if (String(url).endsWith('/routes')) return Response.json({ data: { routes: [{ id: 'id', name: 'future' }] } });
          return Response.json({ result: { version: { version_id: 'v1', active: true, data: multiBackend } } });
        }
        expect(String(url)).toContain('/compat/chat/completions');
        const body = JSON.parse(String(init!.body)); calls++;
        expect(body.model).toBe('dynamic/future');
        const delta = calls === 1 ? { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] } : { content: 'Synthetic result.' };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8192, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream', 'cf-aig-cache-status': calls === 4 ? 'HIT' : 'MISS',
            ...(identified && { 'cf-aig-provider': 'unlisted-provider', 'cf-aig-model': 'synthetic-future-2099' }) } });
      });
      const response = await post(path === '/reasoning/discover'
        ? { route: 'future', profileRef, profileDraft: generated }
        : { kind: 'dynamic-route', route: 'future' }, path);
      const result: any = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(calls).toBe(4);
      if (identified) {
        // All observations identify one exercised backend; the fallback need not be probed.
        expect(result.assignable).toBe(true);
        const receipt = await readRouteCheck(kv as unknown as KVNamespace, result.checkId);
        expect(receipt.route).toBe('future');
        expect(receipt.verification).toMatchObject({ profileRef, scope: 'observed-path', capabilities: { schemaVersion: 2, mappings: [{ cache: 'gateway-response' }] } });
        expect(verificationMatches(receipt.verification, generated, connection)).toBe(true);
      } else {
        expect.soft(result.assignable).toBe(false);
        expect.soft(result).not.toHaveProperty('checkId');
        expect.soft(result).not.toHaveProperty('verification');
        expect.soft(result).not.toHaveProperty('routeVerification');
        expect([...kv._store.keys()].filter((key) => key.startsWith('admin:reasoning:check:'))).toEqual([]);
      }
    });
  });

  it('certifies a synthetic future native model through the saved Invoke transport and authentic replay', async () => {
    const { post, env } = setup(); let calls = 0; let defaultCalls = 0;
    const blocks = [{ type: 'tool_use', id: 'synthetic-call', name: 'codeflare_profile_canary', input: { value: 'ok' } }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ success: true, result: [{ id: 'private-provider-id', provider_slug: 'aws-bedrock', gateway_id: 'synthetic', default_config: true }],
        result_info: { page: 1, count: 1, per_page: 100, total_count: 1 } });
      calls++; const body = JSON.parse(String(init!.body)); expect(String(url)).toMatch(/\/invoke$/);
      expect(body).not.toHaveProperty('stream');
      // Default is the real fallback only after this synthetic provider rejects
      // all six explicit forms; no inherited selectable controls are assumed.
      if (body.thinking !== undefined) return Response.json({ error: { code: 'ValidationException' } }, { status: 400 });
      defaultCalls++;
      if (defaultCalls === 2) expect(body.messages.at(-2).content).toEqual(blocks);
      return Response.json({ content: defaultCalls === 1 ? blocks : [{ type: 'text', text: 'Synthetic result' }], stop_reason: defaultCalls === 1 ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 4, output_tokens: 4, cache_read_input_tokens: defaultCalls === 4 ? 8192 : 0 } });
    });
    const target = { provider: 'aws-bedrock', model: 'eu.anthropic.claude-synthetic-future-2099-v1:0', label: 'Future native',
      transport: 'aig-bedrock-anthropic-invoke', region: 'eu-central-1', contextWindow: 200000, enabled: false };
    const response = await post({ kind: 'native-provider', target }); expect(response.status, JSON.stringify({ body: await response.clone().json(), calls })).toBe(200);
    const result: any = await response.json(); expect(result.assignable).toBe(true); expect(calls).toBe(10);
    expect(defaultCalls).toBe(4);
    expect(result.profile).toEqual(getBuiltInProfile('bedrock-anthropic-native-provider-default'));
    expect(result.capabilities).toMatchObject({ schemaVersion: 2, mappings: [{ cache: 'provider-prefix', transport: 'bedrock-invoke', reasoning: 'provider-default' }] });
    expect(JSON.stringify(result)).not.toContain('private-provider-id');
    const values = { ...config, nativeTargets: [{ ...target, id: result.targetId, enabled: true,
      profileRef: { id: result.profile.id, revision: result.profile.revision, hash: result.profile.hash } }], nativeChecks: { [result.targetId]: result.checkId } };
    expect((await validateConfigurationValues(env, 'aiRouting', 'enterprise', values)).fieldErrors ?? {}).toEqual({});
    const substituted = { ...values, nativeTargets: [{ ...values.nativeTargets[0], model: 'eu.anthropic.claude-another-future-2099' }] };
    expect(Object.keys((await validateConfigurationValues(env, 'aiRouting', 'enterprise', substituted)).fieldErrors ?? {})).not.toHaveLength(0);
  });

  it('REQ-ENTERPRISE-072/075: binds discovered Native selectable mappings to the receipt and saved target rather than replacing them with Provider default', async () => {
    const { kv, post, env } = setup();
    const modes = new Set<string>();
    let submissions = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ success: true, result: [{ id: 'private-provider-id', provider_slug: 'aws-bedrock', gateway_id: 'synthetic', default_config: true }],
        result_info: { page: 1, count: 1, per_page: 100, total_count: 1 } });
      submissions++;
      expect(String(url)).toMatch(/\/invoke$/); // Explicit Invoke remains authoritative for every tested mode.
      const body = JSON.parse(String(init?.body));
      const mode = body.thinking?.type === 'disabled' ? 'off' : body.output_config?.effort ?? 'default';
      modes.add(mode);
      expect(body.max_tokens).toBe(2048);
      expect(body).not.toHaveProperty('stream');
      const replay = body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result'));
      const firstTool = Array.isArray(body.tools) && !replay;
      const privateBlock = { type: 'thinking', thinking: 'Synthetic private thought', signature: 'synthetic-private-signature' };
      const toolBlock = { type: 'tool_use', id: `synthetic-${mode}`, name: 'codeflare_profile_canary', input: { value: 'ok' } };
      if (replay) expect(body.messages.at(-2).content).toEqual([...(body.thinking?.type === 'adaptive' ? [privateBlock] : []), toolBlock]);
      return Response.json({ content: [...(body.thinking?.type === 'adaptive' ? [privateBlock] : []), ...(firstTool ? [toolBlock] : [{ type: 'text', text: 'Synthetic result.' }])],
        stop_reason: firstTool ? 'tool_use' : 'end_turn', usage: { input_tokens: 4, output_tokens: 12,
          output_tokens_details: { thinking_tokens: body.thinking?.type === 'adaptive' ? 4 : 0 }, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    });
    const target = { provider: 'aws-bedrock', model: 'eu.anthropic.claude-synthetic-selectable-2099-v1:0', label: 'Selectable native',
      transport: 'aig-bedrock-anthropic-invoke', region: 'eu-central-1', contextWindow: 200000, enabled: false };
    const response = await post({ kind: 'native-provider', target });
    expect(response.status).toBe(200);
    const result: any = await response.json();
    expect(result.assignable).toBe(true);
    expect([...modes]).toEqual(expect.arrayContaining(['off', 'low', 'medium', 'high', 'xhigh', 'max']));
    expect(result.profile.supportedLevels).toEqual(expect.arrayContaining(['off', 'low', 'medium', 'high', 'xhigh', 'max']));
    expect(result.profile.reasoningMode).not.toBe('provider-default');
    const selectedRef = { id: result.profile.id, revision: result.profile.revision, hash: result.profile.hash };
    const receipt = await readNativeTargetCheck(kv as unknown as KVNamespace, result.checkId);
    expect(receipt.verification.profileRef).toEqual(selectedRef);
    expect(receipt.verification.transport).toBe(target.transport);
    expect(kv._store.has(SETUP_KEYS.NATIVE_AI_TARGETS)).toBe(false);
    const values = { ...config, reasoningConfiguration: { ...config.reasoningConfiguration, customProfileRevisions: [result.profile] },
      nativeTargets: [{ ...target, id: result.targetId, enabled: true, profileRef: selectedRef }], nativeChecks: { [result.targetId]: result.checkId } };
    const saved = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values);
    expect(saved.fieldErrors ?? {}).toEqual({});
    const savedNative = saved.values!.nativeTargets as { targets: Array<{ profileRef: unknown }> };
    expect(savedNative.targets[0].profileRef).toEqual(selectedRef);
    const substituted = { ...values, nativeTargets: [{ ...values.nativeTargets[0], model: 'eu.anthropic.claude-another-target-2099' }] };
    expect(Object.keys((await validateConfigurationValues(env, 'aiRouting', 'enterprise', substituted)).fieldErrors ?? {})).not.toHaveLength(0);
    expect(submissions).toBeLessThanOrEqual(40);
    for (const secret of ['private-provider-id', 'Synthetic private thought', 'synthetic-private-signature', connection.token]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not infer Azure support or accept a browser endpoint/credential override', async () => {
    const { post } = setup(); const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await post({ kind: 'native-provider', target: { provider: 'azure-openai', model: 'model', label: 'Azure', contextWindow: 200000, enabled: false, transport: 'aig-legacy-compat' } })).status).toBe(422);
    expect((await post({ kind: 'dynamic-route', route: 'future', endpoint: 'https://untrusted.invalid' })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
