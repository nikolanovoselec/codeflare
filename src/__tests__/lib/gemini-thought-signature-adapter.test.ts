import { describe, expect, it } from 'vitest';
import { exposeGeminiThoughtSignatures, restoreGeminiThoughtSignatures } from '../../lib/gemini-thought-signature-adapter';

const event = {
  choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' }, extra_content: { google: { thought_signature: 'opaque-signed-state' } } }] }, finish_reason: null }],
};

describe('Gemini compat thought-signature adapter', () => {
  it('REQ-ENTERPRISE-048: exposes opaque replay metadata to Pi across arbitrary SSE chunks', async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17, 83)); controller.enqueue(bytes.slice(83)); controller.close(); } });
    const adapted = exposeGeminiThoughtSignatures(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const text = await adapted.text();
    const parsed = JSON.parse(text.split('\n')[0].slice('data: '.length));
    expect(parsed.choices[0].delta.tool_calls[0]).toEqual(event.choices[0].delta.tool_calls[0]);
    expect(parsed.choices[0].delta.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_1', format: 'codeflare.google.thought_signature.v1', data: 'opaque-signed-state' }]);
    expect(text).toContain('data: [DONE]');
  });

  it('REQ-ENTERPRISE-048: restores only matching adapter metadata on assistant tool replay', () => {
    const payload = { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }], reasoning_details: [
      { type: 'reasoning.encrypted', id: 'call_1', format: 'codeflare.google.thought_signature.v1', data: 'opaque-signed-state' },
      { type: 'reasoning.summary', summary: 'preserve me' },
    ] }, { role: 'tool', tool_call_id: 'call_1', content: 'result' }] };
    expect(restoreGeminiThoughtSignatures(payload)).toEqual({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' }, extra_content: { google: { thought_signature: 'opaque-signed-state' } } }], reasoning_details: [{ type: 'reasoning.summary', summary: 'preserve me' }] }, { role: 'tool', tool_call_id: 'call_1', content: 'result' }] });
  });
});
