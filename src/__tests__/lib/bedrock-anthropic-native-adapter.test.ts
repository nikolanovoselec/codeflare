import { describe, expect, it, vi } from 'vitest';
import { bedrockChunkFrame as eventstreamFrame, bedrockEventFrame, bedrockToolResponse, readOpenAiToolTurn } from '../helpers/bedrock-eventstream';
import {
  adaptBedrockAnthropicResponse,
  buildBedrockAnthropicRequest,
  bedrockAnthropicGatewayPath,
  selectBedrockAnthropicTransport,
  type BedrockReplayState,
} from '../../lib/bedrock-anthropic-native-adapter';

const state = (entries: Record<string, unknown[]> = {}): BedrockReplayState => ({
  load: vi.fn(async (toolId: string) => entries[toolId] ?? null),
  save: vi.fn(async () => undefined),
});

describe('Bedrock Anthropic native adapter', () => {
  it('REQ-ENTERPRISE-083: preserves Pi checkpoints at native prefix boundaries without mutating input', async () => {
    const cache = { type: 'ephemeral', ttl: '5m' };
    const payload = { messages: [
      { role: 'system', content: [{ type: 'text', text: 'Synthetic instructions', cache_control: cache }] },
      { role: 'user', content: [{ type: 'text', text: 'Synthetic question', cache_control: cache }] },
    ], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } }, cache_control: cache }] };
    const before = JSON.stringify(payload);
    const native = await buildBedrockAnthropicRequest(payload, state());
    expect(native.system[0].cache_control).toEqual(cache);
    expect(native.tools[0]).toEqual({ name: 'lookup', input_schema: { type: 'object' }, cache_control: cache });
    expect(native.messages[0].content[0].cache_control).toEqual(cache);
    expect(native).not.toHaveProperty('cache_control');
    expect(JSON.stringify(payload)).toBe(before);
    const unmarked = await buildBedrockAnthropicRequest({ messages: [{ role: 'user', content: 'No explicit cache marker' }] }, state());
    expect(JSON.stringify(unmarked)).not.toContain('cache_control');
  });

  it('REQ-ENTERPRISE-083: lifts a final Pi tool-result checkpoint without changing signed assistant replay', async () => {
    // Synthetic signed state exercises exact preservation, not a live signature.
    const blocks = [{ type: 'thinking', thinking: 'synthetic thinking', signature: 'synthetic-signature' },
      { type: 'tool_use', id: 'call_fixture', name: 'lookup', input: { value: 'ok' } }];
    const snapshot = JSON.stringify(blocks);
    const payload = { thinking: { type: 'adaptive' }, messages: [
      { role: 'user', content: 'Call lookup' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"value":"ok"}' } }] },
      { role: 'tool', tool_call_id: 'call_fixture', content: [{ type: 'text', text: '{"value":"ok"}', cache_control: { type: 'ephemeral' } }] },
    ] };
    const before = JSON.stringify(payload);
    const native = await buildBedrockAnthropicRequest(payload, state({ call_fixture: blocks }));
    expect(JSON.stringify(native.messages[1].content)).toBe(snapshot);
    expect(JSON.stringify(blocks)).toBe(snapshot);
    expect(JSON.stringify(payload)).toBe(before);
    expect(native.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call_fixture',
      content: [{ type: 'text', text: '{"value":"ok"}' }], cache_control: { type: 'ephemeral' } }]);
  });

  it('REQ-ENTERPRISE-083: rejects malformed or broadened checkpoint semantics before provider I/O', async () => {
    for (const cache of [null, true, 'ephemeral', {}, { type: 'permanent' }, { type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '24h' }, { type: 'ephemeral', arbitrary: true }]) {
      await expect(buildBedrockAnthropicRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: cache }] }] }, state())).rejects.toThrow('cache control');
    }
    await expect(buildBedrockAnthropicRequest({ messages: [], cache_control: { type: 'ephemeral' } }, state())).rejects.toThrow('block-level');
    const short = { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } };
    await expect(buildBedrockAnthropicRequest({ messages: [{ role: 'user', content: Array(5).fill(short) }] }, state())).rejects.toThrow('four');
    await expect(buildBedrockAnthropicRequest({ tools: [{ type: 'function', function: { name: 'lookup', parameters: {} }, cache_control: short.cache_control }],
      messages: [{ role: 'system', content: [short] }, { role: 'user', content: [short, short, short] }] }, state())).rejects.toThrow('four');
    await expect(buildBedrockAnthropicRequest({ messages: [{ role: 'user', content: [short, short, short, short] }] }, state())).resolves.toBeDefined();
    await expect(buildBedrockAnthropicRequest({ messages: [{ role: 'tool', tool_call_id: 'call_fixture', content: [short, { type: 'text', text: 'later' }] }] }, state())).rejects.toThrow('end the tool result');
  });

  const tool = { type: 'tool_use', id: 'toolu_bdrk_read_1', name: 'read', input: { path: 'README.md', offset: 1 } };
  const unsignedVariants = [
    { label: 'tool-only', content: [tool] },
    { label: 'unsigned text', content: [{ type: 'text', text: 'Looking up ' }, { type: 'text', text: 'Grüße 🌍' }, tool] },
    { label: 'redacted-only', content: [{ type: 'redacted_thinking', data: 'private-redacted-state' }, tool] },
  ];
  const liveState = (): BedrockReplayState => {
    const entries = new Map<string, unknown[]>();
    return {
      load: async (id) => entries.has(id) ? structuredClone(entries.get(id)!) : null,
      save: async (id, blocks) => { entries.set(id, structuredClone(blocks)); },
    };
  };
  const continuation = (messages: unknown[]) => ({
    messages, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
  });

  describe.each(['invoke', 'eventstream'] as const)('%s tool-turn round trips', (transport) => {
    it.each(unsignedVariants)('REQ-ENTERPRISE-073/076: restores authentic $label content from its emitted tool call', async ({ content }) => {
      const replay = liveState();
      const first = await readOpenAiToolTurn(await adaptBedrockAnthropicResponse(bedrockToolResponse(content, transport), transport, replay, true));
      expect(first.finishes).toEqual(['tool_calls']);
      expect(first.doneCount).toBe(1);
      expect(first.wire).not.toContain('private-redacted-state');
      expect(first.message.tool_calls).toHaveLength(1);
      const result = { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: 'README contents' };
      const payload = continuation([{ role: 'user', content: 'What can you do?' }, first.message, result]);
      const next = await buildBedrockAnthropicRequest(payload, replay);
      expect(next.messages[1].content).toEqual(content);
      expect(next.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: result.tool_call_id, content: result.content }]);
      expect(next.thinking).toEqual({ type: 'adaptive' });
      expect(next.output_config).toEqual({ effort: 'high' });
      // Authentic no-thinking state is distinct from absent state; no client reconstruction fallback.
      await expect(buildBedrockAnthropicRequest(payload, liveState())).rejects.toThrow('signed thinking state is unavailable');
      const changed = { ...first.message, tool_calls: first.message.tool_calls.map((call) => ({
        ...call, function: { ...call.function, name: 'write' },
      })) };
      await expect(buildBedrockAnthropicRequest(continuation([payload.messages[0], changed, result]), replay)).rejects.toThrow('does not match tool replay');
    });

    it.each(['signed first', 'unsigned first'])('REQ-ENTERPRISE-073: preserves successive signed and unsigned tools in one active turn (%s)', async (order) => {
      const replay = liveState();
      const unsigned = unsignedVariants[1].content;
      const signed = [{ type: 'thinking', thinking: 'private reasoning', signature: 'private-signature' }, { ...tool, id: 'toolu_bdrk_read_2' }];
      const contents = order === 'signed first' ? [signed, unsigned] : [unsigned, signed];
      const messages: unknown[] = [{ role: 'user', content: 'Read both resources.' }];
      for (const [index, content] of contents.entries()) {
        const selectedTransport = index === 0 ? transport : 'invoke';
        const emitted = await readOpenAiToolTurn(await adaptBedrockAnthropicResponse(bedrockToolResponse(content, selectedTransport), selectedTransport, replay, true));
        expect(emitted.wire).not.toContain('private-signature');
        expect(emitted.wire).not.toContain('private reasoning');
        messages.push(emitted.message, { role: 'tool', tool_call_id: emitted.message.tool_calls[0].id, content: `result ${index}` });
        const next = await buildBedrockAnthropicRequest(continuation(messages), replay);
        for (let step = 0; step <= index; step++) expect(next.messages[1 + step * 2].content).toEqual(contents[step]);
      }
    });

    it.each(unsignedVariants)('REQ-ENTERPRISE-080: does not advertise usable $label tools after persistence fails', async ({ content }) => {
      const replay: BedrockReplayState = { load: async () => null, save: async () => { throw new Error('private storage failure'); } };
      const operation = adaptBedrockAnthropicResponse(bedrockToolResponse(content, transport), transport, replay, true);
      if (transport === 'invoke') {
        await expect(operation).rejects.toThrow('private storage failure');
      } else {
        const wire = await (await operation).text();
        expect(wire).toContain('NATIVE_BEDROCK_STREAM_ERROR');
        expect(wire).not.toContain('private storage failure');
        expect(wire).not.toContain('"finish_reason":"tool_calls"');
        expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
      }
    });
  });

  it('REQ-ENTERPRISE-077: builds the region-scoped provider-native transport path', () => {
    expect(bedrockAnthropicGatewayPath('eu-central-1', 'eu.anthropic.claude-sonnet-5', 'eventstream')).toBe(
      '/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-sonnet-5/invoke-with-response-stream',
    );
    expect(bedrockAnthropicGatewayPath('eu-central-1', 'eu.anthropic.claude-opus-5', 'invoke')).toBe(
      '/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-opus-5/invoke',
    );
    expect(selectBedrockAnthropicTransport('eventstream')).toBe('eventstream');
    expect(selectBedrockAnthropicTransport('auto')).toBe('eventstream'); // Off has no mapped effort.
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('REQ-ENTERPRISE-077/078: selects automatic transport from mapped %s without changing explicit transports', (effort) => {
    expect(selectBedrockAnthropicTransport('auto', effort)).toBe(['xhigh', 'max'].includes(effort) ? 'invoke' : 'eventstream');
    expect(selectBedrockAnthropicTransport('invoke', effort)).toBe('invoke');
    expect(selectBedrockAnthropicTransport('eventstream', effort)).toBe('eventstream');
  });

  it('REQ-ENTERPRISE-073/076: translates OpenAI tools and restores the exact server-held signed assistant blocks', async () => {
    const signed = [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
      { type: 'redacted_thinking', data: 'opaque-redacted-state' },
      { type: 'text', text: 'Looking up x.' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
    ];
    const replay = state({ call_1: signed });
    const result = await buildBedrockAnthropicRequest({
      model: 'ignored', max_tokens: 700, stream: true,
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
      messages: [
        { role: 'system', content: 'Be useful.' },
        { role: 'user', content: 'Find x.' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }, replay);

    expect(result).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 700,
      system: 'Be useful.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find x.' }] },
        { role: 'assistant', content: signed },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(replay.load).toHaveBeenCalledWith('call_1');
    expect(JSON.stringify(result)).toContain('opaque-signed-state');
  });

  it('REQ-ENTERPRISE-073: rejects signed replay state above the 64 KiB serialized limit', async () => {
    const replay = state({ call_1: [
      { type: 'thinking', thinking: '', signature: 'x'.repeat(64 * 1024) },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
    ] });
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
    }, replay)).rejects.toThrow('signed thinking state');
  });

  it('REQ-ENTERPRISE-073: fails closed when signed replay does not match the tool name and arguments', async () => {
    const replay = state({ call_1: [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'other' } },
    ] });
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
    }, replay)).rejects.toThrow('does not match');
  });

  it('REQ-ENTERPRISE-073: accepts completed foreign tool history before a new native user turn', async () => {
    const result = await buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: 'Look up the project.' },
        { role: 'assistant', tool_calls: [{ id: 'foreign_call', type: 'function', function: { name: 'lookup', arguments: '{"q":"project"}' } }] },
        { role: 'tool', tool_call_id: 'foreign_call', content: 'Project information.' },
        { role: 'assistant', content: 'Here is the project.' },
        { role: 'user', content: 'Who are you?' },
      ],
    }, state());
    expect(result.thinking).toEqual({ type: 'adaptive' });
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Look up the project.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'foreign_call', name: 'lookup', input: { q: 'project' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'foreign_call', content: 'Project information.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is the project.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Who are you?' }] },
    ]);
  });

  it('REQ-ENTERPRISE-073: restores active signed continuation after completed unsigned history', async () => {
    const signed = [
      { type: 'thinking', thinking: '', signature: 'current-signature' },
      { type: 'tool_use', id: 'current_call', name: 'lookup', input: {} },
    ];
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old_call', content: 'old result' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Look again.' },
      { role: 'assistant', tool_calls: [{ id: 'current_call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'current_call', content: 'new result' },
    ];
    const payload = { thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, messages };
    const result = await buildBedrockAnthropicRequest(payload, state({ current_call: signed }));
    expect(result.messages[0].content).toEqual([{ type: 'tool_use', id: 'old_call', name: 'lookup', input: {} }]);
    expect(result.messages[4].content).toEqual(signed);
    await expect(buildBedrockAnthropicRequest(payload, state())).rejects.toThrow('signed thinking state');
  });

  it.each([
    { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    { role: 'user', content: '   ' },
    { role: 'user', content: [{ type: 'text', text: 'Question' }, { type: 'unknown', text: 'data' }] },
  ])('REQ-ENTERPRISE-079: user-role content does not close an unfinished tool turn', async (suffix) => {
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_missing', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_missing', content: 'found' },
        suffix,
      ],
    }, state())).rejects.toThrow('signed thinking state');
  });

  it.each([{ content: 'Who are you?' }, { content: [{ type: 'text', text: 'Who are you?' }] }])('REQ-ENTERPRISE-073: accepts a new text question after paired interrupted tools', async ({ content }) => {
    const result = await buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'old_call', content: 'found' },
        { role: 'user', content },
      ],
    }, state());
    expect(result.messages[0].content).toEqual([{ type: 'tool_use', id: 'old_call', name: 'lookup', input: {} }]);
    expect(result.messages[2].content).toEqual([{ type: 'text', text: 'Who are you?' }]);
    expect(result.thinking).toEqual({ type: 'adaptive' });
  });

  it.each([
    { type: 'thinking', signature: 42 },
    { type: 'text', text: 42 },
    { type: 'text' },
    { type: 'redacted_thinking', data: 42 },
    { type: 'redacted_thinking' },
    { type: 'unknown', text: 'not a supported replay block' },
  ])('REQ-ENTERPRISE-079: rejects malformed stored history even after a new question', async (block) => {
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, messages: [
        { role: 'assistant', tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'old_call', content: 'found' },
        { role: 'user', content: 'Who are you?' },
      ],
    }, state({ old_call: [block, { type: 'tool_use', id: 'old_call', name: 'lookup', input: {} }] }))).rejects.toThrow('signed thinking state');
  });

  it('REQ-ENTERPRISE-079: incomplete parallel tool results remain protected despite later assistant and user text', async () => {
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'assistant', tool_calls: ['call_a', 'call_b'].map((id) => ({ id, type: 'function', function: { name: 'lookup', arguments: '{}' } })) },
        { role: 'tool', tool_call_id: 'call_a', content: 'found' },
        { role: 'assistant', content: 'Partial result.' },
        { role: 'user', content: 'Continue.' },
      ],
    }, state())).rejects.toThrow('signed thinking state');
  });

  it.each(['orphan', 'duplicate'])('REQ-ENTERPRISE-079: ambiguous %s tool results cannot establish a historical exemption', async (kind) => {
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, messages: [
        { role: 'assistant', tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'old_call', content: 'found' },
        { role: 'tool', tool_call_id: kind === 'orphan' ? 'unknown_call' : 'old_call', content: 'extra' },
        { role: 'user', content: 'Who are you?' },
      ],
    }, state())).rejects.toThrow('signed thinking state');
  });

  it('REQ-ENTERPRISE-079: fails closed when a thinking-enabled tool replay has no server-held signed state', async () => {
    await expect(buildBedrockAnthropicRequest({
      thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_missing', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_missing', content: 'found' },
      ],
    }, state())).rejects.toThrow('signed thinking state');
  });

  it('REQ-ENTERPRISE-076/079: converts Invoke responses and stores signed thinking without exposing it downstream', async () => {
    const replay = state();
    const upstream = new Response(JSON.stringify({
      id: 'msg_1', model: 'claude', role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 9 },
    }), { headers: { 'content-type': 'application/json' } });

    const response = await adaptBedrockAnthropicResponse(upstream, 'invoke', replay);
    const body = await response.json() as any;
    expect(body.choices[0].message.tool_calls[0]).toEqual({
      id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' },
    });
    expect(JSON.stringify(body)).not.toContain('opaque-signed-state');
    expect(replay.save).toHaveBeenCalledWith('call_1', [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
    ]);
  });

  it.each(['invoke-json', 'invoke-sse', 'eventstream'] as const)('REQ-ENTERPRISE-076: preserves separate prompt-cache counters in %s usage', async (transport) => {
    // Synthetic usage only: these are not live-provider cache-hit receipts.
    const inputUsage = { input_tokens: 11, cache_read_input_tokens: 1024, cache_creation_input_tokens: 512,
      cache_creation: { ephemeral_5m_input_tokens: 512, ephemeral_1h_input_tokens: 0 } };
    const outputUsage = { output_tokens: 37, output_tokens_details: { thinking_tokens: 9 } };
    const upstream = transport === 'eventstream'
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of [
          { type: 'message_start', message: { id: 'cache_fixture', model: 'claude', usage: { ...inputUsage, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: outputUsage },
          { type: 'message_stop' },
        ]) controller.enqueue(eventstreamFrame(event));
        controller.close();
      } }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
      : Response.json({ id: 'cache_fixture', model: 'claude', content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn', usage: { ...inputUsage, ...outputUsage } });
    const response = await adaptBedrockAnthropicResponse(upstream, transport === 'eventstream' ? 'eventstream' : 'invoke', state(), transport === 'invoke-sse');
    let usage;
    if (transport === 'invoke-json') usage = (await response.json() as any).usage;
    else {
      const wire = await response.text();
      const events = wire.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
      const terminal = events.filter((event) => event.choices?.[0]?.finish_reason);
      expect(terminal).toHaveLength(1);
      expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
      usage = terminal[0].usage;
    }
    expect(usage).toEqual({
      prompt_tokens: 1547, completion_tokens: 37, total_tokens: 1584,
      prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 512 },
      completion_tokens_details: { reasoning_tokens: 9 },
    });
    // The locked Pi 0.85.1 OpenAI parser subtracts reads and writes separately.
    expect(usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens - usage.prompt_tokens_details.cache_write_tokens).toBe(11);
  });

  it('REQ-ENTERPRISE-076: omits unmeasured cache counters and preserves explicit zeroes', async () => {
    const convert = async (cache: Record<string, unknown>) => {
      const response = await adaptBedrockAnthropicResponse(Response.json({
        content: [], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 5, ...cache },
      }), 'invoke', state());
      return (await response.json() as any).usage;
    };
    expect(await convert({})).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
    expect(await convert({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toEqual({
      prompt_tokens: 11, completion_tokens: 5, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    });
    expect(await convert({ cache_read_input_tokens: 12 })).toEqual({
      prompt_tokens: 23, completion_tokens: 5, total_tokens: 28, prompt_tokens_details: { cached_tokens: 12 },
    });
    expect(await convert({ cache_creation_input_tokens: 12 })).toEqual({
      prompt_tokens: 23, completion_tokens: 5, total_tokens: 28, prompt_tokens_details: { cache_write_tokens: 12 },
    });
    for (const invalid of [null, '12', true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await convert({ cache_read_input_tokens: invalid, cache_creation_input_tokens: invalid })).toEqual({
        prompt_tokens: 11, completion_tokens: 5, total_tokens: 16,
      });
    }
  });

  it('REQ-ENTERPRISE-073/076: decodes eventstream blocks into OpenAI SSE and stores exact signed replay state', async () => {
    const replay = state();
    const events = [
      { type: 'message_start', message: { id: 'msg_stream', model: 'claude', usage: { input_tokens: 2 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-state' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_2', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ];
    const chunks = events.map(eventstreamFrame);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const upstream = new Response(body, { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });

    const response = await adaptBedrockAnthropicResponse(upstream, 'eventstream', replay);
    const text = await response.text();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"index":0,"id":"call_2"');
    expect(text).toContain('"name":"lookup"');
    expect(text).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
    expect(text).toContain('"prompt_tokens":2,"completion_tokens":8,"total_tokens":10');
    expect(text).not.toContain('opaque-signed-state');
    expect(replay.save).toHaveBeenCalledWith('call_2', [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
      { type: 'tool_use', id: 'call_2', name: 'lookup', input: { q: 'x' } },
    ]);
  });

  it('REQ-ENTERPRISE-076: decodes split and coalesced AWS chunk envelopes without losing UTF-8 text', async () => {
    const frames = [
      { type: 'message_start', message: { id: 'msg_utf8', model: 'claude' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Grüße 🌍' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ].map(eventstreamFrame);
    const combined = new Uint8Array(frames.reduce((size, frame) => size + frame.length, 0));
    let offset = 0;
    for (const frame of frames) { combined.set(frame, offset); offset += frame.length; }
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of [combined.subarray(0, 7), combined.subarray(7, 109), combined.subarray(109)]) controller.enqueue(chunk);
      controller.close();
    } });
    const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', state())).text();
    expect(text).toContain('Grüße 🌍');
    expect(text).not.toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each([
    ['invalid frame checksum', (() => { const frame = eventstreamFrame({ type: 'message_stop' }); frame[frame.length - 1] ^= 1; return [frame]; })(), state()],
    ['truncated frame', [eventstreamFrame({ type: 'message_start', message: { id: 'msg' } }).subarray(0, 15)], state()],
    ['replay persistence failure', [eventstreamFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'opaque-state' } }), eventstreamFrame({ type: 'content_block_stop', index: 0 }), eventstreamFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } }), eventstreamFrame({ type: 'content_block_stop', index: 1 }), eventstreamFrame({ type: 'message_stop' })], { load: vi.fn(), save: vi.fn(async () => { throw new Error('storage unavailable'); }) }],
  ])('REQ-ENTERPRISE-080: emits a terminal SSE error for %s', async (_label, chunks, replay) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks as Uint8Array[]) controller.enqueue(chunk); controller.close(); } });
    const response = await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', replay as BedrockReplayState);
    const text = await response.text();
    expect(text).toContain('"error"');
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).toContain('data: [DONE]');
  });

  it('REQ-ENTERPRISE-080: rejects trailing corruption before emitting a successful stream terminator', async () => {
    const corrupt = eventstreamFrame({ type: 'message_start', message: { id: 'trailing' } });
    corrupt[corrupt.length - 1] ^= 1;
    const chunks = [eventstreamFrame({ type: 'message_stop' }), corrupt];
    const replay = state();
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', replay)).text();
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(replay.save).not.toHaveBeenCalled();
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each([
    ['provider exception after stop', bedrockEventFrame('modelStreamErrorException', { message: 'private provider detail' }, 'exception')],
    ['malformed base64 after stop', bedrockEventFrame('chunk', { bytes: '%%%private%%%' })],
    ['missing bytes after stop', bedrockEventFrame('chunk', {})],
  ])('REQ-ENTERPRISE-080: rejects %s without a successful finish', async (_label, badFrame) => {
    const replay = state();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(eventstreamFrame({ type: 'message_stop' }));
      controller.enqueue(badFrame);
      controller.close();
    } });
    const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', replay)).text();
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).not.toContain('private');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(replay.save).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-080: honors exception headers even when their payload resembles a valid chunk', async () => {
    const replay = state();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bedrockEventFrame('modelStreamErrorException', {
        bytes: btoa(JSON.stringify({ type: 'message_start', message: { id: 'invalid_exception' } })),
      }, 'exception'));
      controller.enqueue(eventstreamFrame({ type: 'message_stop' }));
      controller.close();
    } });
    const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', replay)).text();
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).not.toContain('invalid_exception');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(replay.save).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid base64', bedrockEventFrame('chunk', { bytes: '%%%private%%%' })],
    ['invalid UTF-8', bedrockEventFrame('chunk', { bytes: '/w==' })],
    ['invalid JSON', bedrockEventFrame('chunk', { bytes: btoa('private invalid JSON') })],
    ['non-object event', bedrockEventFrame('chunk', { bytes: btoa('[]') })],
    ['missing event type', bedrockEventFrame('chunk', { bytes: btoa('{}') })],
    ['Anthropic error event', eventstreamFrame({ type: 'error', error: { message: 'private provider detail' } })],
  ])('REQ-ENTERPRISE-080: rejects %s before a later message_stop', async (_label, badFrame) => {
    const replay = state();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(badFrame);
      controller.enqueue(eventstreamFrame({ type: 'message_stop' }));
      controller.close();
    } });
    const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', replay)).text();
    expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(text).not.toContain('private');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(replay.save).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-076: accepts optional content type and valid extension headers', async () => {
    const payload = { bytes: btoa(JSON.stringify({ type: 'message_stop' })) };
    const frame = bedrockEventFrame('chunk', payload);
    const headers = frame.slice(12, 12 + new DataView(frame.buffer).getUint32(4));
    const contentTypeBytes = 1 + ':content-type'.length + 1 + 2 + 'application/json'.length;
    for (const allowed of [
      headers.subarray(0, headers.length - contentTypeBytes),
      Uint8Array.from([...headers, 1, 120, 0]), // Valid boolean extension header x=true.
    ]) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bedrockEventFrame('chunk', payload, 'event', allowed)); controller.close();
      } });
      const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', state())).text();
      expect(text).toContain('"finish_reason":"stop"');
      expect(text).not.toContain('NATIVE_BEDROCK_STREAM_ERROR');
    }
  });

  it('REQ-ENTERPRISE-080: rejects absent, duplicate, invalid-type and truncated headers', async () => {
    const payload = { bytes: btoa(JSON.stringify({ type: 'message_stop' })) };
    const frame = bedrockEventFrame('chunk', payload);
    const headers = frame.slice(12, 12 + new DataView(frame.buffer).getUint32(4));
    for (const invalid of [
      new Uint8Array(0),
      Uint8Array.from([...headers, ...headers]),
      Uint8Array.from([...headers, 1, 120, 255]),
      Uint8Array.from([...headers, 1, 120, 7, 0]),
    ]) {
      const replay = state();
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bedrockEventFrame('chunk', payload, 'event', invalid)); controller.close();
      } });
      const text = await (await adaptBedrockAnthropicResponse(new Response(body), 'eventstream', replay)).text();
      expect(text).toContain('NATIVE_BEDROCK_STREAM_ERROR');
      expect(text).not.toContain('"finish_reason":"stop"');
      expect(replay.save).not.toHaveBeenCalled();
    }
  });

  it('REQ-ENTERPRISE-079: never logs signed-thinking replay state', async () => {
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    const replay = state();
    const upstream = new Response(JSON.stringify({ content: [
      { type: 'thinking', thinking: '', signature: 'private-signed-state' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
    ], stop_reason: 'tool_use' }));
    await adaptBedrockAnthropicResponse(upstream, 'invoke', replay);
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain('private-signed-state');
  });
});
