/**
 * Tests for mobile keyboard key dispatch logic (CF-020)
 *
 * Tests the extracted resolveKeyAction() pure function and
 * the FUNCTIONAL_KEY_MAP constant.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveKeyAction,
  FUNCTIONAL_KEY_MAP,
} from '../../lib/terminal-mobile-input';

describe('FUNCTIONAL_KEY_MAP', () => {
  it('maps Enter to carriage return', () => {
    expect(FUNCTIONAL_KEY_MAP['Enter']).toBe('\r');
  });

  it('maps Backspace to DEL (0x7f)', () => {
    expect(FUNCTIONAL_KEY_MAP['Backspace']).toBe('\x7f');
  });

  it('maps Delete to escape sequence', () => {
    expect(FUNCTIONAL_KEY_MAP['Delete']).toBe('\x1b[3~');
  });

  it('maps Escape to ESC byte', () => {
    expect(FUNCTIONAL_KEY_MAP['Escape']).toBe('\x1b');
  });

  it('maps Tab to tab character', () => {
    expect(FUNCTIONAL_KEY_MAP['Tab']).toBe('\t');
  });

  it('maps arrow keys to ANSI escape sequences', () => {
    expect(FUNCTIONAL_KEY_MAP['ArrowUp']).toBe('\x1b[A');
    expect(FUNCTIONAL_KEY_MAP['ArrowDown']).toBe('\x1b[B');
    expect(FUNCTIONAL_KEY_MAP['ArrowRight']).toBe('\x1b[C');
    expect(FUNCTIONAL_KEY_MAP['ArrowLeft']).toBe('\x1b[D');
  });

  it('maps Home and End keys', () => {
    expect(FUNCTIONAL_KEY_MAP['Home']).toBe('\x1b[H');
    expect(FUNCTIONAL_KEY_MAP['End']).toBe('\x1b[F');
  });

  it('maps PageUp and PageDown keys', () => {
    expect(FUNCTIONAL_KEY_MAP['PageUp']).toBe('\x1b[5~');
    expect(FUNCTIONAL_KEY_MAP['PageDown']).toBe('\x1b[6~');
  });

  it('contains exactly 13 key mappings', () => {
    expect(Object.keys(FUNCTIONAL_KEY_MAP)).toHaveLength(13);
  });
});

describe('resolveKeyAction', () => {
  // =========================================================================
  // Functional keys
  // =========================================================================
  describe('functional keys', () => {
    const functionalKeys = [
      ['Enter', '\r'],
      ['Backspace', '\x7f'],
      ['Delete', '\x1b[3~'],
      ['Escape', '\x1b'],
      ['Tab', '\t'],
      ['ArrowUp', '\x1b[A'],
      ['ArrowDown', '\x1b[B'],
      ['ArrowRight', '\x1b[C'],
      ['ArrowLeft', '\x1b[D'],
      ['Home', '\x1b[H'],
      ['End', '\x1b[F'],
      ['PageUp', '\x1b[5~'],
      ['PageDown', '\x1b[6~'],
    ] as const;

    for (const [key, expectedSeq] of functionalKeys) {
      it(`resolves ${key} to sequence`, () => {
        const result = resolveKeyAction(key, false, false);
        expect(result).toEqual({ type: 'sequence', sequence: expectedSeq });
      });
    }

    it('resolves functional keys regardless of ctrlKey state', () => {
      // Enter with Ctrl held should still resolve as Enter
      const result = resolveKeyAction('Enter', true, false);
      expect(result.type).toBe('sequence');
      expect((result as { type: 'sequence'; sequence: string }).sequence).toBe('\r');
    });
  });

  // =========================================================================
  // Ctrl+C
  // =========================================================================
  describe('Ctrl+C', () => {
    it('returns copy action when there is a text selection', () => {
      const result = resolveKeyAction('c', true, true);
      expect(result).toEqual({ type: 'copy' });
    });

    it('returns SIGINT sequence (Ctrl+C = 0x03) when no selection', () => {
      const result = resolveKeyAction('c', true, false);
      expect(result).toEqual({
        type: 'sequence',
        sequence: '\x03', // ETX = Ctrl+C
      });
    });
  });

  // =========================================================================
  // Ctrl+V
  // =========================================================================
  describe('Ctrl+V', () => {
    it('returns paste action', () => {
      const result = resolveKeyAction('v', true, false);
      expect(result).toEqual({ type: 'paste' });
    });

    it('returns paste action even with selection', () => {
      const result = resolveKeyAction('v', true, true);
      expect(result).toEqual({ type: 'paste' });
    });
  });

  // =========================================================================
  // Other Ctrl+letter combos
  // =========================================================================
  describe('other Ctrl+letter combos', () => {
    it('Ctrl+A sends SOH (0x01)', () => {
      const result = resolveKeyAction('a', true, false);
      expect(result).toEqual({ type: 'sequence', sequence: '\x01' });
    });

    it('Ctrl+D sends EOT (0x04)', () => {
      const result = resolveKeyAction('d', true, false);
      expect(result).toEqual({ type: 'sequence', sequence: '\x04' });
    });

    it('Ctrl+L sends FF (0x0c)', () => {
      const result = resolveKeyAction('l', true, false);
      expect(result).toEqual({ type: 'sequence', sequence: '\x0c' });
    });

    it('Ctrl+Z sends SUB (0x1a)', () => {
      const result = resolveKeyAction('z', true, false);
      expect(result).toEqual({ type: 'sequence', sequence: '\x1a' });
    });
  });

  // =========================================================================
  // Non-handled keys
  // =========================================================================
  describe('unhandled keys', () => {
    it('returns none for regular character without Ctrl', () => {
      const result = resolveKeyAction('a', false, false);
      expect(result).toEqual({ type: 'none' });
    });

    it('returns none for space key without Ctrl', () => {
      const result = resolveKeyAction(' ', false, false);
      expect(result).toEqual({ type: 'none' });
    });

    it('returns none for number keys', () => {
      const result = resolveKeyAction('1', false, false);
      expect(result).toEqual({ type: 'none' });
    });

    it('returns none for Ctrl+digit (non a-z)', () => {
      const result = resolveKeyAction('1', true, false);
      expect(result).toEqual({ type: 'none' });
    });

    it('returns none for unknown functional key', () => {
      const result = resolveKeyAction('F1', false, false);
      expect(result).toEqual({ type: 'none' });
    });

    it('returns none for Shift key', () => {
      const result = resolveKeyAction('Shift', false, false);
      expect(result).toEqual({ type: 'none' });
    });
  });
});
