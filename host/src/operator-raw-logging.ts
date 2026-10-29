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

/** Snapshot only data descriptors. Noncyclic shared data remains complete. */
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
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(descriptors.length.value) : Object.create(null);
    if (value instanceof Error && !descriptors.name) {
      const name = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'name');
      Object.defineProperty(result, 'name', { enumerable: true, configurable: true, writable: true,
        value: name && 'value' in name ? snapshot(name.value, ancestors, `${path}.name`) : 'Error' });
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
        value: 'value' in descriptor ? snapshot(descriptor.value, ancestors, `${path}.${key}`) : unavailable('accessor') });
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
      add(userinfo);
      for (const part of userinfo.split(':')) { add(part); add(decode(part)); }
      return replace ? `${prefix}${REDACTED}@` : match;
    }).replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, key, item) => {
      if (!credentialKey(decode(key))) return match;
      add(item); add(decode(item));
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
  const cleanText = (text: string): string => {
    const parsed = jsonValue(text);
    if (parsed !== undefined) {
      const original = JSON.stringify(parsed), sanitized = JSON.stringify(clean(parsed));
      if (sanitized !== original) return sanitized;
    }
    let result = urls(text, true)
      .replace(/\b(Bearer|Basic)\s+[^\s"',;}\]]+/gi, `$1 ${REDACTED}`)
      .replace(/\b(api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\b(\s*(?::|=)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, `$1$2${REDACTED}`);
    for (const secret of [...known].sort((a, b) => b.length - a.length)) result = result.split(secret).join(REDACTED);
    return result;
  };
  const redactSpan = (text: string, full: string, start: number): string => {
    const hidden = new Set<number>();
    for (const secret of known) {
      for (let at = full.indexOf(secret); at >= 0; at = full.indexOf(secret, at + 1)) {
        for (let i = Math.max(start, at); i < Math.min(start + text.length, at + secret.length); i++) hidden.add(i - start);
      }
    }
    let output = '';
    for (let i = 0; i < text.length; i++) {
      if (!hidden.has(i)) output += text[i];
      else if (i === 0 || !hidden.has(i - 1)) output += REDACTED;
    }
    return output;
  };
  const clean = (item: unknown): unknown => {
    if (typeof item === 'string') return cleanText(item);
    if (typeof item === 'number' && known.has(String(item))) return REDACTED;
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(child => clean(child));
    const data = item as Record<string, unknown>;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (credentialKey(key)) return [cleanText(key), REDACTED];
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
