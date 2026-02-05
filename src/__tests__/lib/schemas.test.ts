import { describe, it, expect } from 'vitest';
import { TabConfigSchema } from '../../lib/schemas';

describe('TabConfigSchema', () => {
  it('accepts valid tab config with id "1"', () => {
    const result = TabConfigSchema.safeParse({ id: '1', command: 'claude', label: 'Terminal 1' });
    expect(result.success).toBe(true);
  });

  it('accepts valid tab config with id "6"', () => {
    const result = TabConfigSchema.safeParse({ id: '6', command: '', label: 'Bash' });
    expect(result.success).toBe(true);
  });

  it('rejects id "0"', () => {
    const result = TabConfigSchema.safeParse({ id: '0', command: '', label: 'Tab' });
    expect(result.success).toBe(false);
  });

  it('rejects id "7"', () => {
    const result = TabConfigSchema.safeParse({ id: '7', command: '', label: 'Tab' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric id', () => {
    const result = TabConfigSchema.safeParse({ id: 'a', command: '', label: 'Tab' });
    expect(result.success).toBe(false);
  });

  it('rejects command longer than 200 chars', () => {
    const result = TabConfigSchema.safeParse({ id: '1', command: 'x'.repeat(201), label: 'Tab' });
    expect(result.success).toBe(false);
  });

  it('accepts command of exactly 200 chars', () => {
    const result = TabConfigSchema.safeParse({ id: '1', command: 'x'.repeat(200), label: 'Tab' });
    expect(result.success).toBe(true);
  });

  it('rejects label longer than 50 chars', () => {
    const result = TabConfigSchema.safeParse({ id: '1', command: '', label: 'x'.repeat(51) });
    expect(result.success).toBe(false);
  });

  it('accepts label of exactly 50 chars', () => {
    const result = TabConfigSchema.safeParse({ id: '1', command: '', label: 'x'.repeat(50) });
    expect(result.success).toBe(true);
  });
});
