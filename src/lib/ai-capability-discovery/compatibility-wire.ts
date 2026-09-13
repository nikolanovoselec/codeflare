import type { NormalizedReasoningProfile } from '../reasoning-profiles';

export type CompatibilityWire = NonNullable<NormalizedReasoningProfile['compatibility']>;

/** Both discovery and dispatch use this boundary. A successful buffered probe
 * must never authorize a different (streaming) provider request in production.
 * The client still receives OpenAI SSE, but this mode is explicitly NOT evidence
 * of incremental generation and can qualify only below Optimal. */
export function compatibilityRequest(body: Record<string, unknown>, wire?: CompatibilityWire): Record<string, unknown> {
  if (wire?.response !== 'buffered') return body;
  const result = { ...body, stream: false };
  delete (result as Record<string, unknown>).stream_options;
  return result;
}

export async function compatibilityResponse(response: Response, wire: CompatibilityWire | undefined, clientStreaming: boolean): Promise<Response> {
  if (wire?.response !== 'buffered' || !clientStreaming || !response.ok) return response;
  if (!response.body) throw new Error('compatibility_missing_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bound reads even when a stream ignores cancellation. The timeout/size
  // failure becomes an error, never a synthesized successful terminator.
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('compatibility_timeout')), 90_000); });
  try {
    while (true) {
      const read = await Promise.race([reader.read(), deadline]);
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('compatibility_response_too_large');
      chunks.push(read.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer));
  const stops = new Set(['stop', 'tool_calls', 'length', 'content_filter', 'function_call']);
  if (!Array.isArray(body?.choices) || body.choices.length !== 1
    || !body.choices[0]?.message || body.choices[0].message.role !== 'assistant'
    || !stops.has(body.choices[0].finish_reason)) throw new Error('compatibility_not_openai_chat');
  const choice = body.choices[0];
  const delta = { ...choice.message };
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) throw new Error('compatibility_invalid_tools');
    delta.tool_calls = delta.tool_calls.map((call: Record<string, unknown>, index: number) => ({ ...call, index }));
  }
  const chunk = { ...body, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: choice.finish_reason }] };
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']) headers.delete(name);
  headers.set('content-type', 'text/event-stream');
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: response.status, headers });
}
