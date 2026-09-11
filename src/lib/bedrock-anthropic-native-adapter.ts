export type BedrockAnthropicTransport = 'invoke' | 'eventstream';
type JsonObject = Record<string, any>;

export interface BedrockReplayState {
  load(toolId: string): Promise<unknown[] | null>;
  save(toolId: string, content: unknown[]): Promise<void>;
}

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function plain(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = 16_384): string | null {
  return typeof value === 'string' && encoder.encode(value).byteLength <= max ? value : null;
}

function safeToolId(value: unknown): string | null {
  const id = boundedString(value, 256);
  return id && /^[A-Za-z0-9_.:-]+$/.test(id) ? id : null;
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, comparable(value[key])]));
  return value;
}

function cloneBlocks(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const serialized = JSON.stringify(value);
  if (encoder.encode(serialized).byteLength > MAX_REPLAY_BYTES) return null;
  const parsed = JSON.parse(serialized);
  if (!Array.isArray(parsed)) return null;
  for (const block of parsed) {
    if (!plain(block) || typeof block.type !== 'string') return null;
    if (block.type === 'thinking' && (typeof block.thinking !== 'string' || typeof block.signature !== 'string')) return null;
    if (block.type === 'tool_use' && (!safeToolId(block.id) || !boundedString(block.name, 256) || !plain(block.input))) return null;
  }
  return parsed;
}

export function selectBedrockAnthropicTransport(configured: BedrockAnthropicTransport, replayTurn: boolean): BedrockAnthropicTransport {
  return configured === 'eventstream' && replayTurn ? 'invoke' : configured;
}

export function bedrockAnthropicGatewayPath(region: string, model: string, transport: BedrockAnthropicTransport): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error('Invalid Bedrock region');
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(model)) throw new Error('Invalid Bedrock model');
  const operation = transport === 'eventstream' ? 'invoke-with-response-stream' : 'invoke';
  return `/aws-bedrock/bedrock-runtime/${encodeURIComponent(region)}/model/${encodeURIComponent(model)}/${operation}`;
}

function textBlocks(content: unknown): JsonObject[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): JsonObject[] => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (!plain(part)) return [];
    if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }];
    if (part.type === 'image_url' && plain(part.image_url) && typeof part.image_url.url === 'string') {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url);
      if (match) return [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }];
    }
    return [];
  });
}

function reconstructToolCalls(message: JsonObject): JsonObject[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call: unknown) => {
    if (!plain(call) || !safeToolId(call.id) || !plain(call.function) || !boundedString(call.function.name, 256)) {
      throw new Error('Invalid native Bedrock tool replay');
    }
    let input: unknown = {};
    if (typeof call.function.arguments === 'string' && call.function.arguments.length) {
      try { input = JSON.parse(call.function.arguments); } catch { throw new Error('Invalid native Bedrock tool arguments'); }
    }
    if (!plain(input)) throw new Error('Invalid native Bedrock tool arguments');
    return { type: 'tool_use', id: call.id, name: call.function.name, input };
  });
}

async function assistantContent(message: JsonObject, thinkingEnabled: boolean, state: BedrockReplayState): Promise<JsonObject[]> {
  const calls = reconstructToolCalls(message);
  if (!calls.length) return textBlocks(message.content);
  const firstId = calls[0].id as string;
  const stored = cloneBlocks(await state.load(firstId));
  if (stored) {
    const storedCalls = stored.filter((block) => plain(block) && block.type === 'tool_use');
    if (JSON.stringify(comparable(storedCalls)) !== JSON.stringify(comparable(calls))) {
      throw new Error('Native Bedrock signed thinking state does not match tool replay');
    }
    return stored as JsonObject[];
  }
  if (thinkingEnabled) throw new Error('Native Bedrock signed thinking state is unavailable');
  return [...textBlocks(message.content), ...calls];
}

function convertToolChoice(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto') return { type: 'auto' };
  if (value === 'required') return { type: 'any' };
  if (plain(value) && value.type === 'function' && plain(value.function) && boundedString(value.function.name, 256)) {
    return { type: 'tool', name: value.function.name };
  }
  return undefined;
}

export async function buildBedrockAnthropicRequest(payload: JsonObject, state: BedrockReplayState): Promise<JsonObject> {
  if (!plain(payload) || !Array.isArray(payload.messages)) throw new Error('Native Bedrock requires messages');
  const thinking = plain(payload.thinking) && (payload.thinking.type === 'adaptive' || payload.thinking.type === 'disabled')
    ? { type: payload.thinking.type } : undefined;
  const effort = plain(payload.output_config) && ['low', 'medium', 'high', 'xhigh', 'max'].includes(payload.output_config.effort)
    ? payload.output_config.effort : undefined;
  const nativeMessages: JsonObject[] = [];
  const system: unknown[] = [];
  const thinkingEnabled = thinking?.type === 'adaptive';

  for (const raw of payload.messages) {
    if (!plain(raw)) throw new Error('Invalid native Bedrock message');
    if (raw.role === 'system' || raw.role === 'developer') {
      if (typeof raw.content === 'string') system.push(raw.content);
      else system.push(...textBlocks(raw.content));
      continue;
    }
    if (raw.role === 'assistant') {
      nativeMessages.push({ role: 'assistant', content: await assistantContent(raw, thinkingEnabled, state) });
      continue;
    }
    if (raw.role === 'tool') {
      const id = safeToolId(raw.tool_call_id);
      if (!id) throw new Error('Invalid native Bedrock tool result');
      const result = { type: 'tool_result', tool_use_id: id, content: typeof raw.content === 'string' ? raw.content : textBlocks(raw.content) };
      const previous = nativeMessages[nativeMessages.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((part: any) => part?.type === 'tool_result')) previous.content.push(result);
      else nativeMessages.push({ role: 'user', content: [result] });
      continue;
    }
    if (raw.role === 'user') nativeMessages.push({ role: 'user', content: textBlocks(raw.content) });
    else throw new Error('Unsupported native Bedrock message role');
  }

  const maxTokens = Number.isInteger(payload.max_tokens) && payload.max_tokens > 0 && payload.max_tokens <= 131_072 ? payload.max_tokens : 4096;
  const result: JsonObject = { anthropic_version: 'bedrock-2023-05-31', max_tokens: maxTokens };
  if (system.length === 1 && typeof system[0] === 'string') result.system = system[0];
  else if (system.length) result.system = system.flatMap((part) => typeof part === 'string' ? [{ type: 'text', text: part }] : [part]);
  result.messages = nativeMessages;
  if (Array.isArray(payload.tools)) {
    result.tools = payload.tools.map((tool: unknown) => {
      if (!plain(tool) || tool.type !== 'function' || !plain(tool.function) || !boundedString(tool.function.name, 256) || !plain(tool.function.parameters)) {
        throw new Error('Invalid native Bedrock tool');
      }
      const converted: JsonObject = { name: tool.function.name, input_schema: tool.function.parameters };
      if (typeof tool.function.description === 'string') converted.description = tool.function.description;
      return converted;
    });
  }
  const toolChoice = convertToolChoice(payload.tool_choice);
  if (toolChoice) result.tool_choice = toolChoice;
  if (thinking) result.thinking = thinking;
  if (thinkingEnabled && effort) result.output_config = { effort };
  return result;
}

async function persistReplay(content: unknown[], state: BedrockReplayState): Promise<void> {
  const blocks = cloneBlocks(content);
  if (!blocks) throw new Error('Native Bedrock replay state exceeds the safe limit');
  const hasSignedThinking = blocks.some((block) => plain(block) && block.type === 'thinking' && typeof block.signature === 'string');
  if (!hasSignedThinking) return;
  const ids = blocks.filter((block) => plain(block) && block.type === 'tool_use').map((block: any) => safeToolId(block.id)).filter(Boolean) as string[];
  await Promise.all(ids.map((id) => state.save(id, blocks)));
}

function openAiUsage(value: unknown): JsonObject | undefined {
  if (!plain(value)) return undefined;
  const prompt = Number.isFinite(value.input_tokens) ? value.input_tokens : 0;
  const completion = Number.isFinite(value.output_tokens) ? value.output_tokens : 0;
  const reasoning = plain(value.output_tokens_details) && Number.isFinite(value.output_tokens_details.thinking_tokens) ? value.output_tokens_details.thinking_tokens : undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(reasoning !== undefined && { completion_tokens_details: { reasoning_tokens: reasoning } }) };
}

async function adaptInvoke(response: Response, state: BedrockReplayState, streamRequested: boolean): Promise<Response> {
  if (!response.ok) return response;
  const native = await response.json() as JsonObject;
  if (!plain(native) || !Array.isArray(native.content)) throw new Error('Invalid native Bedrock response');
  await persistReplay(native.content, state);
  const text = native.content.filter((block: unknown) => plain(block) && block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('');
  const calls = native.content.filter((block: unknown) => plain(block) && block.type === 'tool_use').map((block: any) => ({
    id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }));
  const message: JsonObject = { role: 'assistant', content: text || null };
  if (calls.length) message.tool_calls = calls;
  const body: JsonObject = {
    id: typeof native.id === 'string' ? native.id : 'bedrock-native', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: typeof native.model === 'string' ? native.model : 'bedrock-anthropic',
    choices: [{ index: 0, message, finish_reason: native.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' }],
  };
  const usage = openAiUsage(native.usage); if (usage) body.usage = usage;
  if (streamRequested) {
    const delta: JsonObject = { role: 'assistant', content: message.content };
    if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call: JsonObject, index: number) => ({ index, ...call }));
    const chunk = { id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model, choices: [{ index: 0, delta, finish_reason: body.choices[0].finish_reason }], ...(usage && { usage }) };
    return new Response(`${decoder.decode(sse(chunk))}${decoder.decode(sse('[DONE]'))}`, { status: response.status, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return Response.json(body, { status: response.status, headers: { 'cache-control': 'no-store' } });
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length); result.set(left); result.set(right, left.length); return result;
}

function parseFrames(buffer: Uint8Array): { events: JsonObject[]; remainder: Uint8Array } {
  const events: JsonObject[] = [];
  let offset = 0;
  while (buffer.length - offset >= 12) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, buffer.length - offset);
    const total = view.getUint32(0); const headerLength = view.getUint32(4);
    if (total < 16 || total > MAX_FRAME_BYTES || headerLength > total - 16) throw new Error('Invalid Bedrock eventstream frame');
    if (buffer.length - offset < total) break;
    const frame = buffer.subarray(offset, offset + total);
    const frameView = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (frameView.getUint32(8) !== crc32(frame.subarray(0, 8)) || frameView.getUint32(total - 4) !== crc32(frame.subarray(0, total - 4))) {
      throw new Error('Invalid Bedrock eventstream checksum');
    }
    const payload = frame.subarray(12 + headerLength, total - 4);
    const value = JSON.parse(decoder.decode(payload));
    if (!plain(value)) throw new Error('Invalid Bedrock eventstream payload');
    events.push(value); offset += total;
  }
  return { events, remainder: buffer.slice(offset) };
}

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

async function adaptEventstream(response: Response, state: BedrockReplayState): Promise<Response> {
  if (!response.ok || !response.body) return response;
  let frameBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const blocks = new Map<number, JsonObject>();
  const toolIndexes = new Map<number, number>();
  let replayBytes = 0; let sawStop = false;
  const reserveReplay = (value: unknown) => {
    replayBytes += encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
    if (replayBytes > MAX_REPLAY_BYTES) throw new Error('Native Bedrock replay state exceeds the safe limit');
  };
  let id = 'bedrock-native'; let model = 'bedrock-anthropic'; let stopReason = 'stop'; let usage: JsonObject = {};
  let streamFailed = false;
  const emitTerminalError = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (streamFailed) return;
    streamFailed = true;
    controller.enqueue(sse({ error: { message: 'Native Bedrock stream failed', code: 'NATIVE_BEDROCK_STREAM_ERROR' } }));
    controller.enqueue(sse('[DONE]'));
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (streamFailed) return;
      try {
        frameBuffer = concat(frameBuffer, chunk);
        const parsed = parseFrames(frameBuffer); frameBuffer = parsed.remainder;
        for (const event of parsed.events) {
        if (sawStop) throw new Error('Bedrock eventstream data follows message_stop');
        if (event.type === 'message_start' && plain(event.message)) {
          if (typeof event.message.id === 'string') id = event.message.id;
          if (typeof event.message.model === 'string') model = event.message.model;
          if (plain(event.message.usage)) usage = { ...usage, ...event.message.usage };
          controller.enqueue(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
        } else if (event.type === 'content_block_start' && Number.isInteger(event.index) && plain(event.content_block)) {
          const block = JSON.parse(JSON.stringify(event.content_block)); reserveReplay(block); blocks.set(event.index, block);
          if (block.type === 'text' && typeof block.text === 'string' && block.text) controller.enqueue(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }] }));
          if (block.type === 'tool_use') {
            const toolIndex = toolIndexes.size; toolIndexes.set(event.index, toolIndex);
            controller.enqueue(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] }));
          }
        } else if (event.type === 'content_block_delta' && Number.isInteger(event.index) && plain(event.delta)) {
          const block = blocks.get(event.index); if (!block) throw new Error('Bedrock eventstream delta precedes its block');
          if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
            reserveReplay(event.delta.text); block.text = `${block.text ?? ''}${event.delta.text}`;
            controller.enqueue(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }] }));
          } else if (event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
            reserveReplay(event.delta.partial_json); block.__arguments = `${block.__arguments ?? ''}${event.delta.partial_json}`;
            const toolIndex = toolIndexes.get(event.index); if (toolIndex === undefined) throw new Error('Bedrock tool delta precedes its tool block');
            controller.enqueue(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }] }));
          } else if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') { reserveReplay(event.delta.thinking); block.thinking = `${block.thinking ?? ''}${event.delta.thinking}`; }
          else if (event.delta.type === 'signature_delta' && typeof event.delta.signature === 'string') { reserveReplay(event.delta.signature); block.signature = `${block.signature ?? ''}${event.delta.signature}`; }
        } else if (event.type === 'content_block_stop' && Number.isInteger(event.index)) {
          const block = blocks.get(event.index);
          if (block?.type === 'tool_use' && typeof block.__arguments === 'string') {
            try { block.input = JSON.parse(block.__arguments || '{}'); } catch { throw new Error('Invalid Bedrock streamed tool arguments'); }
            delete block.__arguments;
          }
        } else if (event.type === 'message_delta' && plain(event.delta)) {
          if (typeof event.delta.stop_reason === 'string') stopReason = event.delta.stop_reason;
          if (plain(event.usage)) usage = { ...usage, ...event.usage };
        } else if (event.type === 'message_stop') {
          sawStop = true;
        }
        }
      } catch {
        emitTerminalError(controller);
      }
    },
    async flush(controller) {
      if (streamFailed) return;
      try {
        if (frameBuffer.length) throw new Error('Truncated Bedrock eventstream frame');
        if (!sawStop) throw new Error('Incomplete Bedrock eventstream');
        await persistReplay([...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block), state);
        controller.enqueue(sse({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: stopReason === 'tool_use' ? 'tool_calls' : 'stop' }], ...(openAiUsage(usage) && { usage: openAiUsage(usage) }) }));
        controller.enqueue(sse('[DONE]'));
      } catch {
        emitTerminalError(controller);
      }
    },
  }));
  return new Response(body, { status: response.status, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function adaptBedrockAnthropicResponse(response: Response, transport: BedrockAnthropicTransport, state: BedrockReplayState, streamRequested = false): Promise<Response> {
  return transport === 'eventstream' ? adaptEventstream(response, state) : adaptInvoke(response, state, streamRequested);
}
