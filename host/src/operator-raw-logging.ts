/** Protected raw application logs, separate from bounded producer/Owner evidence.
 * No inspection depth, string, array, event or sampling limits are imposed here.
 * Reflection never invokes application getters or toJSON. Platform delivery can fail.
 */
export interface RawLogContext {
  activityId: string;
  generation: number;
  loggingEnabled?: boolean;
  credentials?: readonly string[];
}
const REDACTED = '[REDACTED]';
const unavailable = (reason: string) => `[capture unavailable: ${reason}]`;
const credentialKey = (key: string) => {
  const name = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  // SDK thinkingSignature/textSignature fields are transcript data, not credentials.
  return /(?:authorization|cookie|passwords?|passwd|apikey|accesskeyid|accesskey|secretkey|privatekey|accesstoken|refreshtoken|idtoken|clientsecret|connectionsecret|securitytoken|cfaccessjwtassertion|jwt|token|secret|credentials?)$/.test(name)
    || /^(?:signature|sig|xamzcredential|xamzsignature|xgoogcredential|xgoogsignature)$/.test(name);
};

// V8 exposes Error stacks as an intrinsic accessor in Workers/newer Node.
// Recognize that exact getter, never an application-supplied replacement.
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const bootstrapFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
function safeStackFormatter(): boolean {
  let owner: object | null = Error;
  let current: PropertyDescriptor | undefined;
  const seen = new Set<object>();
  while (owner) {
    if (seen.has(owner)) return false;
    seen.add(owner);
    current = Object.getOwnPropertyDescriptor(owner, 'prepareStackTrace');
    if (current) break;
    owner = Object.getPrototypeOf(owner);
  }
  return !current || 'value' in current && (current.value === undefined
    || !!bootstrapFormatter && 'value' in bootstrapFormatter && current.value === bootstrapFormatter.value);
}
function safeStackFormatting(error: object): boolean {
  for (const key of ['name', 'message']) {
    let current: object | null = error;
    const seen = new Set<object>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!('value' in descriptor) || descriptor.value !== undefined && typeof descriptor.value !== 'string') return false;
        break;
      }
      current = Object.getPrototypeOf(current);
    }
  }
  return true;
}

/** Snapshot data descriptors and provably native Error stacks, without app hooks. */
function snapshot(value: unknown, ancestors = new Map<object, string>(), path = '$'): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { number: String(value) };
  if (typeof value === 'bigint') return { bigint: String(value) };
  if (value === undefined) return unavailable('undefined');
  if (typeof value !== 'object') return unavailable(typeof value);
  if (ancestors.has(value)) return { circularReference: ancestors.get(value) };
  try {
    ancestors.set(value, path);
    if (value instanceof Headers) return snapshot(Object.fromEntries(Headers.prototype.entries.call(value)), ancestors, path);
    const error = value instanceof Error;
    const names = Object.getOwnPropertyNames(value);
    const stackSafe = names.includes('stack') && safeStackFormatter() && safeStackFormatting(value);
    // Older V8 may materialize stack while retrieving its descriptor, which
    // itself would coerce a hostile name/message. Inspect those fields first,
    // including non-Error targets populated by public Error.captureStackTrace.
    const descriptors: PropertyDescriptorMap = Object.fromEntries(names.map(key => [key,
      key === 'stack' && !stackSafe && !nativeStackGetter ? { value: unavailable('unsafe Error stack formatting') }
        : Object.getOwnPropertyDescriptor(value, key) ?? { value: unavailable('missing descriptor') }]));
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(descriptors.length.value) : Object.create(null);
    if (error && !descriptors.name) {
      const name = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'name');
      Object.defineProperty(result, 'name', { enumerable: true, configurable: true, writable: true,
        value: name && 'value' in name ? snapshot(name.value, ancestors, `${path}.name`) : 'Error' });
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      const original = 'value' in descriptor ? descriptor.value
        : key === 'stack' && stackSafe && nativeStackGetter && descriptor.get === nativeStackGetter
          ? nativeStackGetter.call(value) : unavailable('accessor');
      Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
        value: snapshot(original, ancestors, `${path}.${key}`) });
    }
    return result;
  } catch { return unavailable('uninspectable value'); }
  finally { ancestors.delete(value); }
}

function jsonValue(text: string): unknown {
  if (!/^\s*[\[{]/.test(text)) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Credential values are collected before emitting any sibling/echoed value. */
function redact(value: unknown, credentials: readonly string[]): unknown {
  const known = new Set(credentials.filter(Boolean));
  const completedText = new Map<string, string>();
  const streamKey = (message: Record<string, unknown>, index: number) =>
    JSON.stringify([message.provider, message.model, message.timestamp, index]);
  const assistant = (item: unknown): item is Record<string, unknown> & { content: unknown[] } =>
    !!item && typeof item === 'object' && (item as Record<string, unknown>).role === 'assistant'
      && Array.isArray((item as Record<string, unknown>).content);
  const add = (text: string) => {
    if (!text) return;
    known.add(text);
    known.add(JSON.stringify(text).slice(1, -1));
    const bearer = /^(?:Bearer|Basic)\s+(.+)$/i.exec(text);
    if (bearer) known.add(bearer[1]);
  };
  const decode = (text: string) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
  // Redact recognized credential syntax even in a malformed URL; preserve all
  // noncredential spelling/encoding instead of reserializing the query string.
  const urls = (text: string, replace: boolean): string => text.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, original =>
    original.replace(/^((?:https?|wss?):\/\/)([^/?#]*)@/i, (match, prefix, userinfo) => {
      if (!replace) {
        add(userinfo);
        for (const part of userinfo.split(':')) { add(part); add(decode(part)); }
      }
      return replace ? `${prefix}${REDACTED}@` : match;
    }).replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, key, item) => {
      if (!credentialKey(decode(key))) return match;
      if (!replace) { add(item); add(decode(item)); }
      return replace ? `${separator}${key}=${REDACTED}` : match;
    }));
  const collectCredential = (item: unknown, field?: string): void => {
    if ((typeof item === 'string' || typeof item === 'number') && field !== 'scheme') add(String(item));
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) collectCredential(child, key);
  };
  const collect = (item: unknown): void => {
    if (typeof item === 'string') {
      urls(item, false);
      for (const match of item.matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g)) add(match[0]);
      for (const match of item.matchAll(/\b(?:Bearer|Basic)\s+([^\s"',;}\]]+)/gi)) add(match[1]);
      for (const match of item.matchAll(/\b(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\b\s*(?::|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}\]]+))/gi)) add(match[1] ?? match[2] ?? match[3]);
      const parsed = jsonValue(item);
      if (parsed !== undefined) collect(parsed);
    } else if (item && typeof item === 'object') {
      if (assistant(item)) item.content.forEach((part, index) => {
        if (!part || typeof part !== 'object') return;
        const data = part as Record<string, unknown>;
        const text = data.type === 'text' ? data.text : data.type === 'thinking' ? data.thinking : undefined;
        if (typeof text === 'string' && text.length > (completedText.get(streamKey(item, index))?.length ?? -1))
          completedText.set(streamKey(item, index), text);
      });
      for (const [key, child] of Object.entries(item)) {
        if (credentialKey(key)) collectCredential(child);
        collect(child);
      }
    }
  };
  collect(value);
  // Join public string channels within the existing observation batch before
  // redacting spans. A queued SDK event's mutable partial may already be ahead
  // of its delta; event order, not that partial's suffix, locates the fragment.
  // Native channels retain their structural identities; no vendor dispatch.
  const nativeLeaves = new WeakMap<object, Map<string, { text: string; start: number; stream: { text: string } }>>();
  const nativeStreams = new Map<string, { text: string }>();
  const registerNative = (parent: object, key: string, item: unknown, scope: string, eventType: unknown, path = key): void => {
    if (typeof item === 'string') {
      // Only the public content-block start/delta protocol establishes these
      // aliases. Other branches retain their exact structural identities.
      const channelPath = eventType === 'content_block_start' && /^value\/content_block\/(?:text|thinking)$/.test(path)
        ? path.replace('/content_block/', '/block/')
        : eventType === 'content_block_delta' && /^value\/delta\/(?:text|thinking)$/.test(path)
          ? path.replace('/delta/', '/block/') : path;
      const channel = `${scope}:${channelPath}`;
      const stream = nativeStreams.get(channel) ?? { text: '' };
      const start = stream.text.length;
      stream.text += item;
      nativeStreams.set(channel, stream);
      const fields = nativeLeaves.get(parent) ?? new Map();
      fields.set(key, { text: item, start, stream });
      nativeLeaves.set(parent, fields);
    } else if (item && typeof item === 'object') {
      for (const [childKey, child] of Object.entries(item)) {
        const index = Array.isArray(item) ? (child && typeof child === 'object'
          && Number.isSafeInteger((child as Record<string, unknown>).index) ? (child as Record<string, unknown>).index : childKey) : undefined;
        registerNative(item, childKey, child, scope, eventType, `${path}/${index === undefined ? childKey : `[${index}]`}`);
      }
    }
  };
  if (Array.isArray(value)) {
    let attempt = 0;
    for (const record of value) {
      if (!record || typeof record !== 'object') continue;
      if (record.stage === 'provider-request') attempt++;
      const event = record.value;
      if (record.stage === 'sdk-event' && event && typeof event === 'object'
        && typeof event.delta === 'string' && typeof event.type === 'string'
        && /^(?:text|thinking|toolcall)_delta$/.test(event.type)
        && assistant(event.partial) && Number.isSafeInteger(event.contentIndex)) {
        registerNative(event, 'delta', event.delta,
          `${attempt}:sdk:${streamKey(event.partial, event.contentIndex)}:${event.type}`, undefined);
      }
      if (record.stage !== 'provider-stream-event') continue;
      const positions = event && typeof event === 'object' ? [event.index, event.output_index, event.content_index] : [];
      registerNative(record, 'value', event, `${attempt}:${JSON.stringify(positions)}`, event?.type);
    }
    for (const stream of nativeStreams.values()) collect(stream.text);
  }
  const knownByLength = [...known].sort((a, b) => b.length - a.length);
  const intervals = new Map<string, Array<[number, number]>>();
  const credentialIntervals = (full: string): Array<[number, number]> => {
    const cached = intervals.get(full);
    if (cached) return cached;
    const ranges: Array<[number, number]> = [];
    for (const secret of known) {
      let last: [number, number] | undefined;
      for (let at = full.indexOf(secret); at >= 0; at = full.indexOf(secret, at + 1)) {
        if (last && at <= last[1]) last[1] = Math.max(last[1], at + secret.length);
        else { last = [at, at + secret.length]; ranges.push(last); }
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    intervals.set(full, merged);
    return merged;
  };
  const cleanText = (text: string): string => {
    const parsed = jsonValue(text);
    if (parsed !== undefined) {
      const original = JSON.stringify(parsed), sanitized = JSON.stringify(clean(parsed));
      if (sanitized !== original) return sanitized;
    }
    let result = urls(text, true)
      .replace(/\b(Bearer|Basic)\s+[^\s"',;}\]]+/gi, `$1 ${REDACTED}`)
      .replace(/\b(api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\b(\s*(?::|=)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, `$1$2${REDACTED}`);
    for (const secret of knownByLength) result = result.split(secret).join(REDACTED);
    return result;
  };
  const redactSpan = (text: string, full: string, start: number): string => {
    const ranges = credentialIntervals(full);
    let low = 0; let high = ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ranges[middle][1] <= start) low = middle + 1; else high = middle;
    }
    let output = ''; let cursor = 0;
    for (let i = low; i < ranges.length && ranges[i][0] < start + text.length; i++) {
      const from = Math.max(0, ranges[i][0] - start);
      const to = Math.min(text.length, ranges[i][1] - start);
      output += text.slice(cursor, from) + REDACTED;
      cursor = to;
    }
    return cursor ? output + text.slice(cursor) : text;
  };
  const nativeText = (parent: object, key: string): string | undefined => {
    const part = nativeLeaves.get(parent)?.get(key);
    return part ? cleanText(redactSpan(part.text, part.stream.text, part.start)) : undefined;
  };
  const clean = (item: unknown): unknown => {
    if (typeof item === 'string') return cleanText(item);
    if (typeof item === 'number' && known.has(String(item))) return REDACTED;
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map((child, index) => nativeText(item, String(index)) ?? clean(child));
    const data = item as Record<string, unknown>;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (credentialKey(key)) return [cleanText(key), REDACTED];
      const native = nativeText(item, key);
      if (native !== undefined) return [cleanText(key), native];
      if (key === 'delta' && typeof child === 'string' && assistant(data.partial) && Number.isSafeInteger(data.contentIndex)) {
        const index = data.contentIndex as number;
        const part = data.partial.content[index] as Record<string, unknown> | undefined;
        const prefix = part?.type === 'text' ? part.text : part?.type === 'thinking' ? part.thinking : undefined;
        const full = completedText.get(streamKey(data.partial, index));
        if (typeof prefix === 'string' && full?.startsWith(prefix) && prefix.endsWith(child))
          return [key, cleanText(redactSpan(child, full, prefix.length - child.length))];
      }
      if (key === 'content' && assistant(data)) return [key, data.content.map((part, index) => {
        if (!part || typeof part !== 'object') return clean(part);
        const content = part as Record<string, unknown>;
        const field = content.type === 'text' ? 'text' : content.type === 'thinking' ? 'thinking' : undefined;
        const full = completedText.get(streamKey(data, index));
        const text = field ? content[field] : undefined;
        return field && typeof text === 'string' && full?.startsWith(text)
          ? clean({ ...content, [field]: redactSpan(text, full, 0) }) : clean(part);
      })];
      return [cleanText(key), clean(child)];
    }));
  };
  return clean(value);
}

/** Freeze public observations at their actual observation time, without hooks. */
export function captureRawValue(value: unknown): unknown { return snapshot(value); }

/** Never mutate the input, throw into execution, or route through SDK ctx.log. */
export function emitRaw(context: RawLogContext | undefined, stage: string, value: () => unknown): void {
  if (!context || context.loggingEnabled === false) return;
  try {
    const captured = redact(snapshot(value()), context.credentials ?? []);
    console.log(JSON.stringify({ module: 'operator-execution', message: stage,
      data: { activityId: context.activityId, generation: context.generation, value: captured } }));
  } catch {
    try { console.log(JSON.stringify({ module: 'operator-execution', message: 'raw-capture-unavailable',
      data: { activityId: context.activityId, generation: context.generation,
        value: { stage, captureUnavailable: 'serialization-or-output-failure' } } })); }
    catch { /* Failed platform output cannot replace the execution outcome. */ }
  }
}
