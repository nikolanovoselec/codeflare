import { describe, expect, it } from 'vitest';
import { OSC52_CLIPBOARD_MAX_BYTES, parseOsc52ClipboardWrite } from '../../lib/osc52';

describe('parseOsc52ClipboardWrite', () => {
  it('decodes a bounded standard clipboard UTF-8 write', () => {
    expect(parseOsc52ClipboardWrite(`c;${btoa('hello')}`)).toBe('hello');
  });

  it.each(['c;?', 'p;aGVsbG8=', 'c;not base64', 'c;/w=='])('rejects query, selector, malformed, or invalid UTF-8 payload %s', (payload) => {
    expect(parseOsc52ClipboardWrite(payload)).toBeNull();
  });

  it('rejects decoded content above the fixed byte limit', () => {
    const encoded = btoa('a'.repeat(OSC52_CLIPBOARD_MAX_BYTES + 1));
    expect(parseOsc52ClipboardWrite(`c;${encoded}`)).toBeNull();
  });
});
