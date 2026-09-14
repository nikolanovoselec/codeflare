import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import reasoningRoutes from '../../routes/admin/reasoning';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { executeConfigurationTask, validateConfigurationValues } from '../../lib/admin-configuration';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { readRouteCheck, verificationMatches } from '../../lib/reasoning-verification';
import { nativeTargetHandle, parseNativeAiTargets, readNativeTargetCheck } from '../../lib/native-ai-targets';
import { parseReasoningConfiguration } from '../../lib/reasoning-configuration';
import { getBuiltInProfile, normalizeCustomProfile } from '../../lib/reasoning-profiles';
import { bedrockToolResponse } from '../helpers/bedrock-eventstream';
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
  it('binds the Bedrock image wire when discovery inventory is homogeneous Anthropic Bedrock', async () => {
    const { post } = setup(); let calls = 0;
    const bedrockTopology = topology.map((element) => element.id === 'model'
      ? { ...element, properties: { provider: 'aws-bedrock', model: 'eu.anthropic.claude-future-v1:0' } } : element);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        if (String(url).endsWith('/routes')) return Response.json({ data: { routes: [{ id: 'id', name: 'future' }] } });
        return Response.json({ result: { version: { version_id: 'v1', active: true, data: bedrockTopology } } });
      }
      JSON.parse(String(init!.body)); calls++;
      const delta = calls === 1
        ? { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }
        : { content: 'Synthetic result.' };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8192, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream', 'cf-aig-provider': 'aws-bedrock', 'cf-aig-model': 'eu.anthropic.claude-future-v1:0', 'cf-aig-cache-status': calls === 4 ? 'HIT' : 'MISS' } });
    });
    const response = await post({ kind: 'dynamic-route', route: 'future' });
    const result: any = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.assignable).toBe(true);
    expect(result.profile.compatibility.images).toBe('bedrock-native-block');
    expect(calls).toBe(4);
  });

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

  it.each([false, true])('REQ-ENTERPRISE-075: re-verifies only selected Native mappings with exact receipt authority (failed replay: %s)', async (failedReplay) => {
    const { kv, post } = setup();
    const template = getBuiltInProfile('bedrock-anthropic-native-opus-auto')!;
    const selected = normalizeCustomProfile({ schemaVersion: 1, revision: 1, enabled: true,
      id: `bedrock-anthropic-native-discovered-${'a'.repeat(24)}`, name: 'Selected synthetic Native controls', family: 'Synthetic',
      supportedLevels: ['minimal', 'low', 'max'], removePaths: template.removePaths,
      levels: { minimal: template.levels.minimal, low: template.levels.low, max: template.levels.max },
      aliases: { minimal: 'low' }, offSemantics: { status: 'unsupported' } });
    const profileRef = { id: selected.id, revision: selected.revision, hash: selected.hash };
    const target = { provider: 'aws-bedrock', model: 'eu.anthropic.claude-synthetic-reverify-2099-v1:0', label: 'Selected Native',
      transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1', contextWindow: 200000, enabled: false, profileRef };
    const calls: Array<{ mode: string; stage: string }> = [];
    const originals = new Map<string, Record<string, any>[]>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        const providers = String(url).includes('/provider_configs') ? [{ id: 'synthetic-provider', provider_slug: 'aws-bedrock', gateway_id: 'synthetic', default_config: true }] : [];
        return Response.json({ success: true, result: providers, result_info: { page: 1, count: providers.length, per_page: 100, total_count: providers.length } });
      }
      const body = JSON.parse(String(init?.body));
      const mode = body.output_config?.effort;
      expect(['low', 'max']).toContain(mode); // Neither alias duplication nor expansion to other forms.
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.max_tokens).toBe(2048);
      const transport = mode === 'max' ? 'invoke' : 'eventstream';
      expect(String(url)).toContain(`${target.model.replace(':', '%3A')}/${transport === 'invoke' ? 'invoke' : 'invoke-with-response-stream'}`);
      const replay = body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result'));
      const tool = Array.isArray(body.tools) && body.tools.length > 0 && !replay;
      const cache = Array.isArray(body.system) && body.system.some((block: any) => block.cache_control);
      calls.push({ mode, stage: replay ? 'replay' : tool ? 'tool' : cache ? 'cache' : 'reasoning' });
      const thinking = { type: 'thinking', thinking: 'Synthetic private re-verification thought', signature: 'synthetic-private-reverification-signature' };
      if (tool) {
        const content = [thinking, { type: 'tool_use', id: `synthetic-${mode}`, name: 'codeflare_profile_canary', input: { value: 'ok' } }];
        originals.set(mode, content);
        return bedrockToolResponse(content, transport);
      }
      if (replay) {
        expect(body.messages.at(-2).content).toEqual(originals.get(mode));
        expect(body.messages.at(-1).content).toEqual([{ type: 'tool_result', tool_use_id: `synthetic-${mode}`, content: 'ok' }]);
        if (failedReplay && mode === 'max') return Response.json({ error: { code: 'ValidationException' } }, { status: 400 });
      }
      return bedrockToolResponse([thinking, { type: 'text', text: 'Synthetic complete result.' }], transport);
    });
    const response = await post({ target, profileDraft: selected, maxCompletionTokens: 2048 }, '/reasoning/native/discover');
    expect(response.status).toBe(200);
    const result: any = await response.json();
    expect(result.assignable).toBe(!failedReplay);
    expect(calls.filter((call) => call.mode === 'low').map((call) => call.stage)).toEqual(['reasoning', 'tool', 'replay', 'cache', 'cache']);
    expect(calls.filter((call) => call.mode === 'max').map((call) => call.stage)).toEqual(failedReplay ? ['reasoning', 'tool', 'replay'] : ['reasoning', 'tool', 'replay', 'cache', 'cache']);
    expect(kv._store.has(SETUP_KEYS.NATIVE_AI_TARGETS)).toBe(false);
    expect(kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    if (failedReplay) {
      expect(result).not.toHaveProperty('checkId');
      expect(result).not.toHaveProperty('verification');
      expect(result.piCompatibility.failedLevels).toContain('max');
    } else {
      const receipt = await readNativeTargetCheck(kv as unknown as KVNamespace, result.checkId);
      expect(receipt.targetId).toBe(result.targetId);
      expect(receipt.verification).toMatchObject({ profileRef, transport: target.transport, model: target.model, region: target.region,
        discovery: { schemaVersion: 2, mappings: [
          { levels: ['minimal', 'low'], transport: 'bedrock-eventstream', tools: true, replay: true },
          { levels: ['max'], transport: 'bedrock-invoke', tools: true, replay: true },
        ] } });
    }
    for (const privateValue of ['Synthetic private re-verification thought', 'synthetic-private-reverification-signature', connection.token]) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it('does not infer Azure support or accept a browser endpoint/credential override', async () => {
    const { post } = setup(); const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await post({ kind: 'native-provider', target: { provider: 'azure-openai', model: 'model', label: 'Azure', contextWindow: 200000, enabled: false, transport: 'aig-legacy-compat' } })).status).toBe(422);
    expect((await post({ kind: 'dynamic-route', route: 'future', endpoint: 'https://untrusted.invalid' })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// Management fixtures remain real HTTP responses; no discovery/Save/runtime helper is mocked.
function administratorManagement() {
  const modelRequests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    if (method !== 'GET') {
      modelRequests.push(url);
      return Response.json({ error: 'Administrator confirmation must not run a model probe' }, { status: 503 });
    }
    if (url.includes('/provider_configs?')) return Response.json({ success: true,
      result: [{ id: 'private-provider-id', provider_slug: 'aws-bedrock', gateway_id: 'synthetic', default_config: true }],
      result_info: { page: 1, count: 1, per_page: 100, total_count: 1 } });
    if (url.includes('/custom-providers?')) return Response.json({ success: true, result: [],
      result_info: { page: 1, count: 0, per_page: 100, total_count: 0 } });
    if (url.endsWith('/routes')) return Response.json({ data: { routes: [{ id: 'id', name: 'future' }] } });
    return Response.json({ result: { version: { version_id: 'v1', active: true, data: topology } } });
  });
  return modelRequests;
}

const saveContext = { mode: 'enterprise' as const, requestUrl: 'https://codeflare.example.com', resultingRevision: 1 };

describe('Advanced administrator authority for selected generated contracts', () => {
  it.each(capabilityCandidates(false))('REQ-ENTERPRISE-043: confirms selected Dynamic $id through endpoint, Save and runtime without inventing observations', async (profile) => {
    const { kv, env, post } = setup();
    const modelRequests = administratorManagement();
    const profileRef = { id: profile.id, revision: profile.revision, hash: profile.hash };
    const response = await post({ route: 'future', profileRef, profileDraft: profile, administratorConfirmed: true }, '/reasoning/discover');
    const result: any = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ assignable: true, classification: 'Administrator-confirmed', verification: { method: 'administrator', profileRef } });
    const receipt = await readRouteCheck(kv as unknown as KVNamespace, result.checkId);
    expect(receipt.verification).toEqual(result.verification);
    expect(receipt.verification).not.toHaveProperty('capabilities');
    expect(result).not.toHaveProperty('piCompatibility');
    expect(result).not.toHaveProperty('report');
    expect(kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    const reasoning = profile.supportedLevels[0] ?? 'off';
    const values = { ...config, dynamicRoutes: ['future'], routeContextWindows: { future: 200000 }, routeChecks: { future: result.checkId },
      groupRouting: [{ accessGroup: 'engineering', routes: ['future'], defaultRoute: 'future', reasoning }],
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [profile], routeAssignments: { future: { activeProfile: profileRef } } } };
    const saved = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values);
    expect(saved.fieldErrors ?? {}).toEqual({});
    await executeConfigurationTask(env, 'configure_model_routing', saved.values!, saveContext);
    const stored = parseReasoningConfiguration(await kv.get(SETUP_KEYS.REASONING_CONFIGURATION));
    expect(stored.routeAssignments.future.verification).toEqual(receipt.verification);
    const runtime = await loadEnterpriseRouteConfig(env, ['engineering']);
    expect(runtime.routeCatalog).toEqual(['future']);
    expect(runtime.defaultRoute).toBe('future');
    expect(runtime.promptCacheTargets).toBeUndefined();
    expect(modelRequests).toEqual([]); // Confirmation, Save and runtime are not automated probes.
  });

  const nativeSelections = [
    ...capabilityCandidates(true).map((profile) => ({ profile, transport: 'aig-bedrock-anthropic-auto' })),
    { profile: getBuiltInProfile('bedrock-anthropic-native-provider-default')!, transport: 'aig-bedrock-anthropic-auto' },
    { profile: capabilityCandidates(false)[0], transport: 'aig-legacy-compat' },
  ];
  it.each(nativeSelections)('REQ-ENTERPRISE-075: confirms selected Native $profile.id through endpoint, Save and runtime without borrowing tools or cache evidence', async ({ profile, transport }) => {
    const { kv, env, post } = setup();
    const modelRequests = administratorManagement();
    const profileRef = { id: profile.id, revision: profile.revision, hash: profile.hash };
    const customProfileRevisions = getBuiltInProfile(profile.id) ? [] : [profile];
    const target = { provider: 'aws-bedrock', model: 'eu.anthropic.claude-synthetic-admin-2099-v1:0', label: 'Administrator-selected native',
      transport, ...(transport !== 'aig-legacy-compat' && { region: 'eu-central-1' }), contextWindow: 200000, enabled: false, profileRef };
    const response = await post({ target, ...(customProfileRevisions.length && { profileDraft: profile }), administratorConfirmed: true }, '/reasoning/native/discover');
    const result: any = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ assignable: true, classification: 'Administrator-confirmed', verification: { method: 'administrator' } });
    const receipt = await readNativeTargetCheck(kv as unknown as KVNamespace, result.checkId);
    expect(receipt.verification).toMatchObject({ targetId: result.targetId, profileRef, model: target.model, transport, method: 'administrator' });
    expect(receipt.verification).not.toHaveProperty('discovery');
    expect(receipt.verification).not.toHaveProperty('capabilities');
    expect(result).not.toHaveProperty('report');
    expect(result.verification).not.toHaveProperty('discovery');
    expect(kv._store.has(SETUP_KEYS.NATIVE_AI_TARGETS)).toBe(false);
    const handle = nativeTargetHandle(result.targetId);
    const values = { ...config, nativeTargets: [{ ...target, id: result.targetId, enabled: true }], nativeChecks: { [result.targetId]: result.checkId },
      groupRouting: [{ accessGroup: 'engineering', routes: [handle], defaultRoute: handle, reasoning: profile.supportedLevels[0] ?? 'off' }],
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions, routeAssignments: {} } };
    const unreceipted = await validateConfigurationValues(env, 'aiRouting', 'enterprise', { ...values, nativeChecks: {} });
    expect(unreceipted.fieldErrors).toEqual({ reasoningConfiguration: [expect.stringContaining('must be verified')] });
    const browserProof = await validateConfigurationValues(env, 'aiRouting', 'enterprise', { ...values, nativeChecks: {},
      nativeTargets: [{ ...values.nativeTargets[0], verification: receipt.verification }] });
    expect(browserProof.values).toBeUndefined();
    expect(Object.keys(browserProof.fieldErrors ?? {})).not.toHaveLength(0);
    const substituted = await validateConfigurationValues(env, 'aiRouting', 'enterprise', { ...values,
      nativeTargets: [{ ...values.nativeTargets[0], model: 'eu.anthropic.claude-another-admin-2099-v1:0' }] });
    expect(substituted.fieldErrors).toEqual({ reasoningConfiguration: ['Native target check receipt is stale'] });
    const saved = await validateConfigurationValues(env, 'aiRouting', 'enterprise', values);
    expect(saved.fieldErrors ?? {}).toEqual({});
    await executeConfigurationTask(env, 'configure_model_routing', saved.values!, saveContext);
    const stored = parseNativeAiTargets(await kv.get(SETUP_KEYS.NATIVE_AI_TARGETS));
    expect(stored.targets[0].verification).toEqual(receipt.verification);
    const runtime = await loadEnterpriseRouteConfig(env, ['engineering']);
    expect(runtime.routeCatalog).toEqual([handle]);
    expect(runtime.defaultRoute).toBe(handle);
    expect(runtime.promptCacheTargets).toBeUndefined();
    for (const changed of [
      { model: 'eu.anthropic.claude-another-admin-2099-v1:0' },
      { profileRef: { ...profileRef, hash: '0'.repeat(64) } },
      ...(transport !== 'aig-legacy-compat' ? [{ region: 'us-east-1' }, { transport: 'aig-bedrock-anthropic-invoke' }] : []),
    ]) {
      kv._set(SETUP_KEYS.NATIVE_AI_TARGETS, { ...stored, targets: [{ ...stored.targets[0], ...changed }] });
      expect((await loadEnterpriseRouteConfig(env, ['engineering'])).routeCatalog, JSON.stringify(changed)).toEqual([]);
    }
    expect(modelRequests).toEqual([]);
  });
});
