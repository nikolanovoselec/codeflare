import { Buffer } from 'node:buffer';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// AWS rest-json eventstream headers plus JSON event payload, including its CRCs.
export function bedrockEventFrame(eventType: string, payload: unknown, messageType = 'event', headersOverride?: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const headers = headersOverride ?? Uint8Array.from(Object.entries({
    ':message-type': messageType,
    [messageType === 'exception' ? ':exception-type' : ':event-type']: eventType,
    ':content-type': 'application/json',
  }).flatMap(([name, value]) => {
    const key = encoder.encode(name); const text = encoder.encode(value);
    return [key.length, ...key, 7, text.length >>> 8, text.length & 255, ...text];
  }));
  const body = encoder.encode(JSON.stringify(payload));
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

// InvokeModelWithResponseStream's PayloadPart carries base64 bytes, not a raw
// Anthropic event: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_PayloadPart.html
export function bedrockChunkFrame(event: unknown): Uint8Array {
  return bedrockEventFrame('chunk', { bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') });
}

/** Provider boundary fixture for complete native tool-turn round trips. */
export function bedrockToolResponse(content: Record<string, any>[], transport: 'invoke' | 'eventstream'): Response {
  const stopReason = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  if (transport === 'invoke') return Response.json({
    id: 'msg_native', model: 'claude', content, stop_reason: stopReason,
    usage: { input_tokens: 2, output_tokens: 8 },
  });
  const events: unknown[] = [{ type: 'message_start', message: { id: 'msg_native', model: 'claude', usage: { input_tokens: 2 } } }];
  for (const [index, block] of content.entries()) {
    const start = block.type === 'tool_use' ? { ...block, input: {} }
      : block.type === 'text' ? { type: 'text', text: '' }
        : block.type === 'thinking' ? { type: 'thinking', thinking: '' } : block;
    events.push({ type: 'content_block_start', index, content_block: start });
    if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input);
      const middle = Math.floor(json.length / 2);
      for (const partial_json of [json.slice(0, middle), json.slice(middle)]) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
      }
    } else if (block.type === 'text') {
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 8 } }, { type: 'message_stop' });
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of events) controller.enqueue(bedrockChunkFrame(event));
    controller.close();
  } }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
}

/** Consume the actual client SSE, including fragmented tool arguments, before continuing. */
export async function readOpenAiToolTurn(response: Response) {
  const wire = await response.text();
  const calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
  const finishes: string[] = [];
  let text = ''; let doneCount = 0;
  for (const line of wire.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') { doneCount++; continue; }
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message);
    for (const choice of event.choices ?? []) {
      if (choice.finish_reason) finishes.push(choice.finish_reason);
      text += choice.delta?.content ?? '';
      for (const delta of choice.delta?.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.function.name = delta.function.name;
        call.function.arguments += delta.function?.arguments ?? '';
        calls.set(delta.index, call);
      }
    }
  }
  const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  for (const call of tool_calls) {
    if (!call.id || !call.function.name) throw new Error('Incomplete emitted tool call');
    JSON.parse(call.function.arguments);
  }
  return { wire, finishes, doneCount, message: { role: 'assistant', content: text || null, tool_calls } };
}
