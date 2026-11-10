import { describe, expect, it } from 'vitest';
import { exposeGeminiThoughtSignatures, restoreGeminiThoughtSignatures } from '../../lib/gemini-thought-signature-adapter';

const event = {
  id: 'chatcmpl-preserved', model: 'gemini-preserved', usage: { prompt_tokens: 7 },
  choices: [{ index: 0, delta: { role: 'assistant', content: 'preserve me', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' }, extra_content: { google: { thought_signature: 'opaque-signed-state' } } }] }, finish_reason: null }],
};

async function streamFailure(response: Response): Promise<unknown> {
  const reader = response.body!.getReader();
  const closed = reader.closed.catch(() => undefined);
  let failure: unknown;
  try {
    while (!(await reader.read()).done) { /* drain */ }
  } catch (error) {
    failure = error;
  }
  await closed;
  return failure;
}

describe('Gemini compat thought-signature adapter', () => {
  it('REQ-ENTERPRISE-059: thought-signature exposure preserves unrelated response data', async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17, 83)); controller.enqueue(bytes.slice(83)); controller.close(); } });
    const adapted = exposeGeminiThoughtSignatures(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const text = await adapted.text();
    const parsed = JSON.parse(text.split('\n')[0].slice('data: '.length));
    expect(parsed).toMatchObject({ id: event.id, model: event.model, usage: event.usage, choices: [{ index: 0, delta: { role: 'assistant', content: 'preserve me' }, finish_reason: null }] });
    expect(parsed.choices[0].delta.tool_calls[0]).toEqual(event.choices[0].delta.tool_calls[0]);
    expect(parsed.choices[0].delta.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_1', format: 'codeflare.google.thought_signature.v1', data: 'opaque-signed-state' }]);
    expect(text).toContain('data: [DONE]');
  });

  it('REQ-ENTERPRISE-059: exposes exactly 32768 signature bytes but suppresses oversized multibyte replay metadata only', async () => {
    for (const [signature, exposed] of [['x'.repeat(32768), true], ['é'.repeat(16385), false]] as const) {
      const input = structuredClone(event);
      input.choices[0].delta.tool_calls[0].extra_content.google.thought_signature = signature;
      const response = exposeGeminiThoughtSignatures(new Response(`data: ${JSON.stringify(input)}\n\ndata: [DONE]\n\n`, {
        status: 201, headers: { 'content-type': 'text/event-stream', 'x-provider': 'retained' },
      }));
      expect(response.status).toBe(201);
      expect(response.headers.get('x-provider')).toBe('retained');
      const text = await response.text();
      const output = JSON.parse(text.split('\n')[0].slice('data: '.length));
      const delta = output.choices[0].delta;
      expect(delta.content).toBe('preserve me');
      expect(delta.tool_calls).toEqual(input.choices[0].delta.tool_calls);
      expect(output.usage).toEqual(event.usage);
      if (exposed) expect(delta.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_1',
        format: 'codeflare.google.thought_signature.v1', data: signature }]);
      else expect(delta.reasoning_details).toBeUndefined();
      expect(text).toContain('data: [DONE]');
    }
  });

  it('REQ-ENTERPRISE-059: accepts one large transport chunk containing bounded SSE lines', async () => {
    const line = 'data: {}\n';
    const text = line.repeat(Math.ceil(1_048_576 / line.length) + 1);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    const adapted = exposeGeminiThoughtSignatures(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await adapted.text()).toBe(text);
  });

  it('REQ-ENTERPRISE-059: rejects an oversized newline-terminated SSE line', async () => {
    const text = `${'x'.repeat(1_048_577)}\n`;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    const adapted = exposeGeminiThoughtSignatures(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const failure = await streamFailure(adapted);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Gemini SSE line exceeds adapter limit');
  });

  it('REQ-ENTERPRISE-059: rejects an oversized SSE prefix before its newline arrives', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode('x'.repeat(1_048_577)));
      controller.enqueue(encoder.encode('\n'));
      controller.close();
    } });
    const adapted = exposeGeminiThoughtSignatures(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const failure = await streamFailure(adapted);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Gemini SSE line exceeds adapter limit');
  });

  it('REQ-ENTERPRISE-059: rejects final decoder output that crosses the SSE line limit', async () => {
    const prefix = new TextEncoder().encode('x'.repeat(1_048_576));
    const bytes = new Uint8Array(prefix.length + 1);
    bytes.set(prefix); bytes[prefix.length] = 0xe2;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const adapted = exposeGeminiThoughtSignatures(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const failure = await streamFailure(adapted);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Gemini SSE line exceeds adapter limit');
  });

  it('REQ-ENTERPRISE-059: thought-signature restoration preserves unrelated request data', () => {
    const payload = { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }], reasoning_details: [
      { type: 'reasoning.encrypted', id: 'call_1', format: 'codeflare.google.thought_signature.v1', data: 'opaque-signed-state' },
      { type: 'reasoning.summary', summary: 'preserve me' },
    ] }, { role: 'tool', tool_call_id: 'call_1', content: 'result' }] };
    expect(restoreGeminiThoughtSignatures(payload)).toEqual({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' }, extra_content: { google: { thought_signature: 'opaque-signed-state' } } }], reasoning_details: [{ type: 'reasoning.summary', summary: 'preserve me' }] }, { role: 'tool', tool_call_id: 'call_1', content: 'result' }] });
  });
});
