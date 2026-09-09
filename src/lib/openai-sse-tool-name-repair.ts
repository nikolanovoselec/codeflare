function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const MAX_EVENT_BYTES = 256 * 1024;
const MAX_CALL_STATES = 128;
const MAX_NAME_BYTES = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left); joined.set(right, left.byteLength);
  return joined;
}

function suppressNameMembers(line: string, suppressions: readonly boolean[]): string {
  let index = 0;
  return line.replace(/"function"\s*:\s*\{(?:(?:"(?:\\.|[^"\\])*")|[^{}])*\}/g, (block) => {
    if (!/("name"\s*:\s*)("(?:\\.|[^"\\])*")/.test(block)) return block;
    const suppress = suppressions[index++] === true;
    return suppress ? block.replace(/("name"\s*:\s*)("(?:\\.|[^"\\])*")/, '$1""') : block;
  });
}

/**
 * Suppress only the Bedrock compat defect where a complete declared function
 * name is emitted again on a later chunk. Unchanged SSE lines retain exact bytes.
 */
export function repairRepeatedCompleteToolNames(declaredNames: readonly string[]): TransformStream<Uint8Array, Uint8Array> {
  const declared = new Set(declaredNames.filter((name) => name.length > 0 && encoder.encode(name).byteLength <= MAX_NAME_BYTES));
  const accumulated = new Map<string, string>();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let passthrough = false;

  const repairLine = (bytes: Uint8Array): Uint8Array => {
    const line = decoder.decode(bytes);
    const match = /^(\s*data:\s*)(.*?)(\r?\n)$/.exec(line);
    if (!match || match[2] === '[DONE]') return bytes;
    let event: unknown;
    try { event = JSON.parse(match[2]); } catch { return bytes; }
    if (!isRecord(event) || !Array.isArray(event.choices)) return bytes;
    const suppressions: boolean[] = [];
    for (const rawChoice of event.choices) {
      if (!isRecord(rawChoice)) continue;
      const choice = Number.isInteger(rawChoice.index) ? String(rawChoice.index) : '0';
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : null;
      if (!delta || !Array.isArray(delta.tool_calls)) continue;
      for (const rawCall of delta.tool_calls) {
        if (!isRecord(rawCall)) continue;
        const call = Number.isInteger(rawCall.index) ? String(rawCall.index) : '0';
        const fn = isRecord(rawCall.function) ? rawCall.function : null;
        if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
        const key = `${choice}:${call}`;
        const prior = accumulated.get(key) ?? '';
        const repeated = declared.has(prior) && fn.name === prior;
        suppressions.push(repeated);
        if (!accumulated.has(key) && accumulated.size >= MAX_CALL_STATES) continue;
        if (encoder.encode(prior + fn.name).byteLength > MAX_NAME_BYTES) continue;
        if (!repeated) accumulated.set(key, prior + fn.name);
      }
    }
    return suppressions.some(Boolean) ? encoder.encode(suppressNameMembers(line, suppressions)) : bytes;
  };

  const emitCompleteLines = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let index = buffer.indexOf(10);
    while (index >= 0) {
      const line = buffer.slice(0, index + 1);
      buffer = buffer.slice(index + 1);
      controller.enqueue(line.byteLength > MAX_EVENT_BYTES ? line : repairLine(line));
      index = buffer.indexOf(10);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (passthrough) { controller.enqueue(chunk); return; }
      buffer = concat(buffer, chunk);
      emitCompleteLines(controller);
      if (buffer.byteLength > MAX_EVENT_BYTES) {
        controller.enqueue(buffer);
        buffer = new Uint8Array();
        passthrough = true;
      }
    },
    flush(controller) {
      if (!passthrough && buffer.byteLength) controller.enqueue(buffer.byteLength > MAX_EVENT_BYTES ? buffer : repairLine(buffer));
    },
  });
}
