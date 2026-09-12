import { describe, expect, it, vi } from 'vitest';
import { adaptBedrockAnthropicResponse } from '../../lib/bedrock-anthropic-native-adapter';
import { bedrockChunkFrame } from '../helpers/bedrock-eventstream';

const state = () => ({ load: async () => null, save: vi.fn(async () => {}) });
const frame = (events: unknown[]) => new Response(new ReadableStream<Uint8Array>({ start(c) {
  events.forEach((event) => c.enqueue(bedrockChunkFrame(event))); c.close();
} }));

describe('REQ-ENTERPRISE-073 generic native protocol termination', () => {
  it('does not label a capped Invoke answer as normal completion', async () => {
    const response = await adaptBedrockAnthropicResponse(Response.json({ content: [{ type: 'text', text: 'synthetic partial' }], stop_reason: 'max_tokens', usage: { input_tokens: 2, output_tokens: 2 } }), 'invoke', state(), true);
    expect(await response.text()).toContain('"finish_reason":"length"');
  });

  it.each([
    [{ type: 'message_stop' }],
    [{ type: 'message_start', message: {} }, { type: 'message_stop' }],
    [{ type: 'message_start', message: {} }, { type: 'message_delta', delta: { stop_reason: 'unknown-new-stop' } }, { type: 'message_stop' }],
  ])('does not synthesize success for incomplete/unknown protocol events %j', async (...events) => {
    const saved = state();
    const output = await (await adaptBedrockAnthropicResponse(frame(events), 'eventstream', saved, true)).text();
    expect(output).toContain('NATIVE_BEDROCK_STREAM_ERROR');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(saved.save).not.toHaveBeenCalled();
  });

  it('emits public text while later text, terminal events and physical EOF are still withheld', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const saved = state();
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; } }));
    const output = await adaptBedrockAnthropicResponse(upstream, 'eventstream', saved, true);
    const reader = output.body!.getReader();
    const read = () => Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out reading public delta')), 500))]);
    try {
      source.enqueue(bedrockChunkFrame({ type: 'message_start', message: { usage: { input_tokens: 2 } } }));
      await read();
      source.enqueue(bedrockChunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      source.enqueue(bedrockChunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic first' } }));
      const first = new TextDecoder().decode((await read()).value);
      expect(first).toContain('synthetic first');
      expect(first).not.toContain('[DONE]');
      expect(saved.save).not.toHaveBeenCalled();
      source.enqueue(bedrockChunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' synthetic later' } }));
      expect(new TextDecoder().decode((await read()).value)).toContain('synthetic later');
      source.enqueue(bedrockChunkFrame({ type: 'content_block_stop', index: 0 }));
      source.enqueue(bedrockChunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }));
      source.enqueue(bedrockChunkFrame({ type: 'message_stop' }));
      let settled = false;
      const terminal = read().then((value) => { settled = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false); // message_stop alone cannot certify clean EOF.
      source.close();
      expect(new TextDecoder().decode((await terminal).value)).toContain('"finish_reason":"stop"');
      expect(new TextDecoder().decode((await read()).value)).toContain('[DONE]');
      expect((await read()).done).toBe(true);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  });
});
