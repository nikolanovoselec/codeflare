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

function quotedEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    if (!escaped && text[index] === '"') return index + 1;
    if (!escaped && text[index] === '\\') escaped = true;
    else escaped = false;
  }
  return -1;
}

function compositeEnd(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '"') { const next = quotedEnd(text, index); if (next < 0) return -1; index = next - 1; }
    else if (text[index] === open) depth += 1;
    else if (text[index] === close && --depth === 0) return index + 1;
  }
  return -1;
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n')) index += 1;
  return index;
}

function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return quotedEnd(text, start);
  if (text[start] === '{') return compositeEnd(text, start, '{', '}');
  if (text[start] === '[') return compositeEnd(text, start, '[', ']');
  let end = start;
  while (end < text.length && text[end] !== ',' && text[end] !== '}' && text[end] !== ']') end += 1;
  return end;
}

function directMember(text: string, objectStart: number, objectEnd: number, wanted: string): [number, number] | null {
  let cursor = objectStart + 1;
  while ((cursor = skipWhitespace(text, cursor)) < objectEnd - 1) {
    if (text[cursor] === ',') { cursor += 1; continue; }
    if (text[cursor] !== '"') return null;
    const keyEnd = quotedEnd(text, cursor);
    if (keyEnd < 0) return null;
    let key: unknown;
    try { key = JSON.parse(text.slice(cursor, keyEnd)); } catch { return null; }
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor++] !== ':') return null;
    const start = skipWhitespace(text, cursor);
    const end = valueEnd(text, start);
    if (end < 0 || end > objectEnd) return null;
    if (key === wanted) return [start, end];
    cursor = end;
  }
  return null;
}

function eachObject(text: string, array: [number, number], visit: (start: number, end: number) => void): void {
  let cursor = array[0] + 1;
  while ((cursor = skipWhitespace(text, cursor)) < array[1] - 1) {
    if (text[cursor] === ',') { cursor += 1; continue; }
    if (text[cursor] !== '{') return;
    const end = compositeEnd(text, cursor, '{', '}');
    if (end < 0 || end > array[1]) return;
    visit(cursor, end);
    cursor = end;
  }
}

function functionNameSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const rootStart = line.indexOf('{');
  if (rootStart < 0) return spans;
  const rootEnd = compositeEnd(line, rootStart, '{', '}');
  const choices = rootEnd > 0 ? directMember(line, rootStart, rootEnd, 'choices') : null;
  if (!choices || line[choices[0]] !== '[') return spans;
  eachObject(line, choices, (choiceStart, choiceEnd) => {
    const delta = directMember(line, choiceStart, choiceEnd, 'delta');
    if (!delta || line[delta[0]] !== '{') return;
    const calls = directMember(line, delta[0], delta[1], 'tool_calls');
    if (!calls || line[calls[0]] !== '[') return;
    eachObject(line, calls, (callStart, callEnd) => {
      const fn = directMember(line, callStart, callEnd, 'function');
      if (!fn || line[fn[0]] !== '{') return;
      const name = directMember(line, fn[0], fn[1], 'name');
      if (!name || line[name[0]] !== '"') return;
      let value: unknown;
      try { value = JSON.parse(line.slice(name[0], name[1])); } catch { return; }
      if (typeof value === 'string') spans.push(name);
    });
  });
  return spans;
}

function suppressNameMembers(line: string, suppressions: readonly boolean[]): string {
  const replacements = functionNameSpans(line).filter((_, index) => suppressions[index]);
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const [start, end] = replacements[index];
    line = `${line.slice(0, start)}""${line.slice(end)}`;
  }
  return line;
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
        if (!fn || typeof fn.name !== 'string') continue;
        if (!fn.name) { suppressions.push(false); continue; }
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
