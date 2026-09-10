const FORMAT = 'codeflare.google.thought_signature.v1';
const MAX_SIGNATURE_BYTES = 32_768;
const MAX_SSE_LINE_BYTES = 1_048_576;

type PlainObject = Record<string, any>;
const plain = (value: unknown): value is PlainObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function signatureFor(toolCall: PlainObject): string | null {
  const signature = plain(toolCall.extra_content) && plain(toolCall.extra_content.google)
    ? toolCall.extra_content.google.thought_signature : undefined;
  return typeof signature === 'string' && signature.length > 0 && new TextEncoder().encode(signature).byteLength <= MAX_SIGNATURE_BYTES
    ? signature : null;
}

function exposeReplayMetadata(event: unknown): boolean {
  if (!plain(event) || !Array.isArray(event.choices)) return false;
  let changed = false;
  for (const choice of event.choices) {
    if (!plain(choice) || !plain(choice.delta) || !Array.isArray(choice.delta.tool_calls)) continue;
    for (const toolCall of choice.delta.tool_calls) {
      if (!plain(toolCall) || typeof toolCall.id !== 'string' || !toolCall.id) continue;
      const signature = signatureFor(toolCall);
      if (!signature) continue;
      const details = Array.isArray(choice.delta.reasoning_details) ? choice.delta.reasoning_details : [];
      details.push({ type: 'reasoning.encrypted', id: toolCall.id, format: FORMAT, data: signature });
      choice.delta.reasoning_details = details;
      changed = true;
    }
  }
  return changed;
}

function adaptLine(line: string): string {
  const match = /^(\s*data:\s*)(.*)$/.exec(line);
  if (!match || match[2] === '[DONE]') return line;
  try {
    const event = JSON.parse(match[2]);
    return exposeReplayMetadata(event) ? `${match[1]}${JSON.stringify(event)}` : line;
  } catch { return line; }
}

/** Expose Gemini's opaque tool replay signature through Pi's preserved reasoning-details channel. */
export function exposeGeminiThoughtSignatures(response: Response): Response {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
  const decoder = new TextDecoder(); const encoder = new TextEncoder(); let buffer = '';
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (encoder.encode(line).byteLength > MAX_SSE_LINE_BYTES) throw new Error('Gemini SSE line exceeds adapter limit');
        controller.enqueue(encoder.encode(`${adaptLine(line)}\n`));
      }
      if (encoder.encode(buffer).byteLength > MAX_SSE_LINE_BYTES) throw new Error('Gemini SSE line exceeds adapter limit');
    },
    flush(controller) {
      buffer += decoder.decode();
      if (encoder.encode(buffer).byteLength > MAX_SSE_LINE_BYTES) throw new Error('Gemini SSE line exceeds adapter limit');
      if (buffer) controller.enqueue(encoder.encode(adaptLine(buffer)));
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Restore preserved Gemini signatures immediately before the Worker-owned compat request. */
export function restoreGeminiThoughtSignatures(payload: PlainObject): PlainObject {
  if (!Array.isArray(payload.messages)) return payload;
  for (const message of payload.messages) {
    if (!plain(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !Array.isArray(message.reasoning_details)) continue;
    const remaining: unknown[] = [];
    for (const detail of message.reasoning_details) {
      if (!plain(detail) || detail.type !== 'reasoning.encrypted' || detail.format !== FORMAT || typeof detail.id !== 'string'
        || typeof detail.data !== 'string' || new TextEncoder().encode(detail.data).byteLength > MAX_SIGNATURE_BYTES) {
        remaining.push(detail); continue;
      }
      const call = message.tool_calls.find((candidate: unknown) => plain(candidate) && candidate.id === detail.id);
      if (!plain(call)) { remaining.push(detail); continue; }
      call.extra_content = { google: { thought_signature: detail.data } };
    }
    if (remaining.length) message.reasoning_details = remaining;
    else delete message.reasoning_details;
  }
  return payload;
}
