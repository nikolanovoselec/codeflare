import { describe, expect, it, vi } from 'vitest';
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function eventstreamFrame(payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = new Uint8Array(0);
  const total = 16 + headers.length + body.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  view.setUint32(8, crc32(bytes.subarray(0, 8)));
  bytes.set(headers, 12);
  bytes.set(body, 12 + headers.length);
  view.setUint32(total - 4, crc32(bytes.subarray(0, total - 4)));
  return bytes;
}

describe('Bedrock Anthropic native adapter', () => {
  it('REQ-ENTERPRISE-077: builds the region-scoped provider-native transport path', () => {
    expect(bedrockAnthropicGatewayPath('eu-central-1', 'eu.anthropic.claude-sonnet-5', 'eventstream')).toBe(
      '/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-sonnet-5/invoke-with-response-stream',
    );
    expect(bedrockAnthropicGatewayPath('eu-central-1', 'eu.anthropic.claude-opus-5', 'invoke')).toBe(
      '/aws-bedrock/bedrock-runtime/eu-central-1/model/eu.anthropic.claude-opus-5/invoke',
    );
    expect(selectBedrockAnthropicTransport('eventstream', false)).toBe('eventstream');
    expect(selectBedrockAnthropicTransport('eventstream', true)).toBe('invoke');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('REQ-ENTERPRISE-077/078: selects automatic transport from mapped %s without changing explicit transports', (effort) => {
    expect(selectBedrockAnthropicTransport('auto', false, effort)).toBe(['xhigh', 'max'].includes(effort) ? 'invoke' : 'eventstream');
    expect(selectBedrockAnthropicTransport('auto', true, effort)).toBe('invoke');
    expect(selectBedrockAnthropicTransport('invoke', false, effort)).toBe('invoke');
    expect(selectBedrockAnthropicTransport('eventstream', false, effort)).toBe('eventstream');
    expect(selectBedrockAnthropicTransport('eventstream', true, effort)).toBe('invoke');
  });

  it('REQ-ENTERPRISE-073/076: translates OpenAI tools and restores the exact server-held signed assistant blocks', async () => {
    const signed = [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
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
    expect(text).not.toContain('opaque-signed-state');
    expect(replay.save).toHaveBeenCalledWith('call_2', [
      { type: 'thinking', thinking: '', signature: 'opaque-signed-state' },
      { type: 'tool_use', id: 'call_2', name: 'lookup', input: { q: 'x' } },
    ]);
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
