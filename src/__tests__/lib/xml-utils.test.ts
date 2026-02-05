import { describe, it, expect } from 'vitest';
import { escapeXml } from '../../lib/xml-utils';

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a&b')).toBe('a&amp;b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a<b')).toBe('a&lt;b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a>b')).toBe('a&gt;b');
  });

  it('escapes double quote', () => {
    expect(escapeXml('a"b')).toBe('a&quot;b');
  });

  it('escapes single quote (apostrophe)', () => {
    expect(escapeXml("a'b")).toBe('a&apos;b');
  });

  it('returns empty string unchanged', () => {
    expect(escapeXml('')).toBe('');
  });

  it('returns clean string unchanged', () => {
    expect(escapeXml('hello world 123')).toBe('hello world 123');
  });

  it('escapes multiple special characters in one string', () => {
    expect(escapeXml('<tag attr="val">&\'test\'')).toBe(
      '&lt;tag attr=&quot;val&quot;&gt;&amp;&apos;test&apos;'
    );
  });
});
