export const OSC52_CLIPBOARD_MAX_BYTES = 64 * 1024;

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
