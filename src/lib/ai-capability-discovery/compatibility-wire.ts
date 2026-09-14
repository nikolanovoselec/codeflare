import type { NormalizedReasoningProfile } from '../reasoning-profiles';

export type CompatibilityWire = NonNullable<NormalizedReasoningProfile['compatibility']>;

export interface CompatibilityModelIdentity { provider: string; model: string }

/** Select a request shape only from authoritative route inventory. The live
 * Cloudflare /compat boundary accepts native Anthropic image blocks where its
 * advertised OpenAI data-URI form fails. A heterogeneous route is deliberately
 * left untouched because its eventual branch may require ordinary OpenAI wire. */
export function compatibilityImagesForModels(models: readonly CompatibilityModelIdentity[]): CompatibilityWire['images'] | undefined {
  return models.length > 0 && models.every((model) => model.provider === 'aws-bedrock' && /(?:^|\.)anthropic\./i.test(model.model))
    ? 'bedrock-native-block' : undefined;
}

/** Both discovery and dispatch use this boundary. A successful buffered probe
 * must never authorize a different (streaming) provider request in production.
 * The client still receives OpenAI SSE, but this mode is explicitly NOT evidence
 * of incremental generation and can qualify only below Optimal. */
export function compatibilityRequest(body: Record<string, unknown>, wire?: CompatibilityWire): Record<string, unknown> {
  let result = body;
  if (wire?.images === 'bedrock-native-block' && Array.isArray(body.messages)) {
    // Live /compat evidence on 2026-09-14 showed the exact failure boundary:
    // `image_url.url = data:image/png;base64,...` reached Bedrock as though the
    // entire data URI were base64 (`:` failed at byte offset 4). Supplying the
    // semantically equivalent Anthropic image/source block returned HTTP 200.
    // Keep this clone-and-rebuild transform narrow; never strip an arbitrary
    // URL, infer a MIME type, download content, or mutate the caller's history.
    result = { ...body, messages: body.messages.map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
      const record = message as Record<string, unknown>;
      // OpenAI multimodal image parts are user input. Do not broaden the
      // workaround into system or assistant content that Anthropic does not
      // document as an image-bearing message position.
      if (record.role !== 'user' || !Array.isArray(record.content)) return message;
      return { ...record, content: record.content.map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const item = part as Record<string, unknown>;
        const image = item.image_url;
        if (item.type !== 'image_url' || !image || typeof image !== 'object' || Array.isArray(image)) return part;
        const url = (image as Record<string, unknown>).url;
        if (typeof url !== 'string') return part;
        const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
        if (!match || match[2].length % 4 !== 0) return part;
        return { type: 'image', source: { type: 'base64', media_type: match[1].toLowerCase(), data: match[2] } };
      }) };
    }) };
  }
  if (wire?.response !== 'buffered') return result;
  result = { ...result, stream: false };
  delete result.stream_options;
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
