/**
 * Offline interoperability check against the actual locked Pi client.
 *
 * Run with Node's TypeScript support and an installed pi-ai 0.85.1 directory:
 *   node scripts/verify-bedrock-pi-prompt-cache.mjs /path/to/@earendil-works/pi-ai
 *
 * No network, API token, real tools, or provider signatures are used. The
 * injected fetch is the ONLY HTTP implementation Pi receives. Synthetic native
 * responses exercise our real adapter and Pi's real serializer/usage parser;
 * they must never be represented as live cache-hit or model-capability proof.
 * Live evidence and the separate Gateway policy limitation are recorded in
 * documentation/lanes/bedrock-prompt-caching.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBedrockAnthropicRequest, adaptBedrockAnthropicResponse } from '../src/lib/bedrock-anthropic-native-adapter.ts';
import { getBuiltInProfile, translateRuntimeReasoningRequest } from '../src/lib/reasoning-profiles.ts';
import { compatibilityRequest, compatibilityResponse } from '../src/lib/ai-capability-discovery/compatibility-wire.ts';

const piRoot = resolve(process.argv[2] ?? 'preseed/agents/pi/node_modules/@earendil-works/pi-ai');
const { version } = JSON.parse(await readFile(resolve(piRoot, 'package.json'), 'utf8'));
assert.equal(version, '0.85.1', 'Update the contract evidence deliberately when Pi changes');
const { stream } = await import(pathToFileURL(resolve(piRoot, 'dist/api/openai-completions.js')).href);
const syntheticSigned = [
  { type: 'thinking', thinking: 'synthetic, not provider thinking', signature: 'SYNTHETIC-NOT-A-PROVIDER-SIGNATURE' },
  { type: 'tool_use', id: 'call_synthetic', name: 'lookup', input: { value: 'ok' } },
];
const model = {
  id: 'cf-native-11111111-1111-4111-8111-111111111111', name: 'synthetic native fixture',
  api: 'openai-completions', provider: 'codeflare-gateway', baseUrl: 'https://offline-fixture.invalid/v1',
  reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true,
    cacheControlFormat: 'anthropic', supportsLongCacheRetention: false },
};

await test('REQ-ENTERPRISE-083: locked Pi preserves checkpoint opt-in, opt-out and exact replay', { timeout: 10_000 }, async () => {
// These are protocol/capability cases, not release-name fixtures. The generic
// contract has no model list; the third case is a Gateway-HIT-only target whose
// minimum passed but which must NOT publish native prefix checkpoints to Pi.
for (const contract of [
  { profile: 'bedrock-anthropic-native-sonnet', prefix: true },
  { profile: 'bedrock-anthropic-native-provider-default', prefix: true },
  { profile: 'bedrock-anthropic-native-provider-default', prefix: false },
]) for (const cacheRetention of ['none', 'short']) {
  const profile = getBuiltInProfile(contract.profile);
  const targetModel = { ...model, compat: { ...model.compat, supportsReasoningEffort: profile.reasoningMode !== 'provider-default',
    ...(contract.prefix ? {} : { cacheControlFormat: undefined }) } };
  const stored = new Map();
  const replay = { load: async id => stored.get(id) ?? null,
    save: async (id, blocks) => stored.set(id, structuredClone(blocks)) };
  const context = {
    systemPrompt: 'Synthetic reusable system prefix.',
    tools: [{ name: 'lookup', description: 'Synthetic inert tool.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
    messages: [{ role: 'user', content: 'Use the synthetic tool.', timestamp: 0 }],
  };
  let calls = 0;
  const fetch = async (url, init) => {
    assert.equal(String(url), `${model.baseUrl}/chat/completions`);
    const incoming = JSON.parse(init.body);
    const mapped = translateRuntimeReasoningRequest(incoming, profile, 'high');
    const body = await buildBedrockAnthropicRequest(mapped, replay, contract.prefix);
    if (profile.reasoningMode === 'provider-default') {
      assert.equal(body.thinking, undefined);
      assert.equal(body.output_config, undefined);
    }
    const marked = cacheRetention === 'short' && contract.prefix;
    assert.equal(Boolean(body.tools[0].cache_control), marked);
    assert.equal(Boolean(Array.isArray(body.system) && body.system[0].cache_control), marked);
    if (calls === 0) {
      assert.equal(Boolean(body.messages[0].content[0].cache_control), marked);
    } else {
      // Signed state is restored from adapter-owned storage, NOT from Pi text.
      assert.equal(JSON.stringify(body.messages[1].content), JSON.stringify(syntheticSigned));
      assert.equal(body.messages[2].content[0].tool_use_id, 'call_synthetic');
      assert.equal(Boolean(body.messages[2].content[0].cache_control), marked);
      assert.equal(body.messages[2].content[0].content[0]?.cache_control, undefined);
    }
    assert.ok(calls < 2, 'No retries or extra tool requests');
    const initial = calls++ === 0;
    return adaptBedrockAnthropicResponse(Response.json({
      id: 'synthetic-message', model: 'synthetic-model',
      content: initial ? syntheticSigned : [{ type: 'text', text: 'Synthetic final answer.' }],
      stop_reason: initial ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 17, output_tokens: 5, cache_read_input_tokens: 1024, cache_creation_input_tokens: 512 },
    }), 'invoke', replay, true);
  };
  const invoke = async () => {
    const events = stream(targetModel, context, { apiKey: 'synthetic-placeholder', cacheRetention, fetch, maxRetries: 0, maxTokens: 512 });
    for await (const _ of events) { /* Consume Pi's actual incremental parser. */ }
    const result = await events.result();
    assert.deepEqual({ input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite },
      { input: 17, output: 5, cacheRead: 1024, cacheWrite: 512 });
    assert.equal(JSON.stringify(result).includes('SYNTHETIC-NOT-A-PROVIDER-SIGNATURE'), false);
    return result;
  };
  const first = await invoke();
  assert.equal(first.stopReason, 'toolUse');
  const tool = first.content.find(block => block.type === 'toolCall');
  assert.equal(tool?.name, 'lookup');
  assert.deepEqual(tool.arguments, { value: 'ok' });
  context.messages.push(first, { role: 'toolResult', toolCallId: tool.id, toolName: tool.name,
    content: [{ type: 'text', text: '{"value":"ok"}' }], isError: false, timestamp: 1 });
  assert.equal((await invoke()).stopReason, 'stop');
  assert.equal(calls, 2);
}
// A discovered buffered contract still owes Pi a valid OpenAI tool lifecycle.
// This is intentionally one completed chunk, NOT incremental-generation proof.
// Verify the real locked serializer/parser rather than a locally invented Pi.
{
  const wire = { response: 'buffered', toolNames: 'repeated-complete', transport: 'compat' };
  const target = { ...model, id: 'synthetic-dynamic', compat: { supportsDeveloperRole: false } };
  const context = { systemPrompt: 'Public synthetic context.', tools: [{ name: 'lookup', description: 'Inert synthetic tool.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
    messages: [{ role: 'user', content: 'Use lookup with value ok.', timestamp: 0 }] };
  let calls = 0;
  const fetch = async (_url, init) => {
    const incoming = JSON.parse(init.body);
    const body = compatibilityRequest(incoming, wire);
    assert.equal(body.stream, false); assert.equal(body.stream_options, undefined);
    assert.equal(JSON.stringify(body).includes('cache_control'), false);
    if (calls === 1) {
      const toolResult = body.messages.find(message => message.role === 'tool');
      assert.equal(toolResult.tool_call_id, 'synthetic-buffered-tool');
      const assistant = body.messages.find(message => message.role === 'assistant');
      assert.equal(assistant.tool_calls[0].id, 'synthetic-buffered-tool');
      assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { value: 'ok' });
    }
    assert.ok(calls < 2);
    const initial = calls++ === 0;
    return compatibilityResponse(Response.json({ choices: [{ message: initial
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-buffered-tool', type: 'function', function: { name: 'lookup', arguments: '{"value":"ok"}' } }] }
      : { role: 'assistant', content: 'Synthetic completed answer.' }, finish_reason: initial ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4 } }), wire, true);
  };
  const call = async () => { const events = stream(target, context, { apiKey: 'synthetic-placeholder', fetch, maxRetries: 0, maxTokens: 512 });
    for await (const _ of events) { /* Actual Pi parser. */ } return events.result(); };
  const first = await call(); assert.equal(first.stopReason, 'toolUse');
  const tool = first.content.find(block => block.type === 'toolCall'); assert.equal(tool.name, 'lookup'); assert.deepEqual(tool.arguments, { value: 'ok' });
  context.messages.push(first, { role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text: '{"value":"ok"}' }], isError: false, timestamp: 1 });
  assert.equal((await call()).stopReason, 'stop'); assert.equal(calls, 2);
}
console.log('PASS: locked Pi native and discovered buffered contracts, checkpoint opt-out/opt-in/revocation, exact synthetic replay, confidential state, and usage accounting; zero network calls.');
});
