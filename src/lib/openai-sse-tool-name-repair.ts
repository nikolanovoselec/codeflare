function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Suppress only the Bedrock compat defect where a complete declared function
 * name is emitted again on a later chunk. Unchanged SSE lines retain exact bytes.
 */
export function repairRepeatedCompleteToolNames(declaredNames: readonly string[]): TransformStream<Uint8Array, Uint8Array> {
  const MAX_EVENT_BYTES = 256 * 1024;
  const MAX_CALL_STATES = 128;
  const MAX_NAME_BYTES = 128;
  const encoder = new TextEncoder();
  const declared = new Set(declaredNames.filter((name) => name.length > 0 && encoder.encode(name).byteLength <= MAX_NAME_BYTES));
  const accumulated = new Map<string, string>();
  const decoder = new TextDecoder();
  let buffer = '';
  let passthrough = false;

  const repairLine = (line: string): string => {
    const match = /^(\s*data:\s*)(.*?)(\r?\n)$/.exec(line);
    if (!match || match[2] === '[DONE]') return line;
    let event: unknown;
    try { event = JSON.parse(match[2]); } catch { return line; }
    if (!isRecord(event) || !Array.isArray(event.choices)) return line;
    let changed = false;
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
        if (!accumulated.has(key) && accumulated.size >= MAX_CALL_STATES) continue;
        if (encoder.encode(prior + fn.name).byteLength > MAX_NAME_BYTES) continue;
        if (declared.has(prior) && fn.name === prior) {
          delete fn.name;
          changed = true;
        } else {
          accumulated.set(key, prior + fn.name);
        }
      }
    }
    return changed ? `${match[1]}${JSON.stringify(event)}${match[3]}` : line;
  };

  const emitCompleteLines = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index + 1);
      buffer = buffer.slice(index + 1);
      controller.enqueue(encoder.encode(encoder.encode(line).byteLength > MAX_EVENT_BYTES ? line : repairLine(line)));
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (passthrough) { controller.enqueue(chunk); return; }
      buffer += decoder.decode(chunk, { stream: true });
      emitCompleteLines(controller);
      if (encoder.encode(buffer).byteLength > MAX_EVENT_BYTES) {
        controller.enqueue(encoder.encode(buffer));
        buffer = '';
        passthrough = true;
      }
    },
    flush(controller) {
      if (passthrough) return;
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(encoder.encode(buffer).byteLength > MAX_EVENT_BYTES ? buffer : repairLine(buffer)));
    },
  });
}
