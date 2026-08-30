export const OSC52_CLIPBOARD_MAX_BYTES = 64 * 1024;

interface ClipboardWriteAttempt {
  readonly id: number;
  failedText?: string;
}

const clipboardWriteAttempts = new WeakMap<object, ClipboardWriteAttempt>();
let nextClipboardWriteId = 0;

export function beginClipboardWrite(terminal: object): number {
  const id = ++nextClipboardWriteId;
  clipboardWriteAttempts.set(terminal, { id });
  return id;
}

export function retainFailedClipboardWrite(
  terminal: object,
  id: number,
  text: string,
): void {
  const attempt = clipboardWriteAttempts.get(terminal);
  if (attempt?.id === id) attempt.failedText = text;
}

export function completeClipboardWrite(terminal: object, id: number): void {
  if (clipboardWriteAttempts.get(terminal)?.id === id) clipboardWriteAttempts.delete(terminal);
}

export function takeFailedClipboardWrite(terminal: object): string | undefined {
  const attempt = clipboardWriteAttempts.get(terminal);
  if (attempt?.failedText === undefined) return undefined;
  clipboardWriteAttempts.delete(terminal);
  return attempt.failedText;
}

/** Parse one bounded OSC 52 clipboard write. Queries and non-standard selectors are rejected. */
export function parseOsc52ClipboardWrite(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0 || data.slice(0, separator) !== 'c') return null;
  const encoded = data.slice(separator + 1);
  if (!encoded || encoded === '?' || encoded.length > Math.ceil(OSC52_CLIPBOARD_MAX_BYTES / 3) * 4) {
    return null;
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;

  try {
    const binary = atob(encoded);
    if (binary.length > OSC52_CLIPBOARD_MAX_BYTES) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
