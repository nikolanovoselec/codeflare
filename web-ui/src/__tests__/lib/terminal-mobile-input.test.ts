/**
 * Tests for mobile keyboard key dispatch logic (CF-020)
 *
 * Tests the extracted resolveKeyAction() pure function and
 * the FUNCTIONAL_KEY_MAP constant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/mobile', () => ({
  disableVirtualKeyboardOverlay: vi.fn(),
  enableVirtualKeyboardOverlay: vi.fn(),
  forceResetKeyboardState: vi.fn(),
  isFocusOnTerminalInput: vi.fn(() => false),
  isSamsungBrowser: false,
}));

import {
  resolveKeyAction,
  FUNCTIONAL_KEY_MAP,
  releaseKeyboardOnBlur,
  activateStickyCtrl,
  deactivateStickyCtrl,
  isStickyCtrlActive,
} from '../../lib/terminal-mobile-input';
import { disableVirtualKeyboardOverlay, isFocusOnTerminalInput } from '../../lib/mobile';

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

describe('sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)', () => {
  beforeEach(() => {
    // Module state is shared across tests — clear any leftover sticky state.
    deactivateStickyCtrl();
  });

  it('REQ-MOB-006 AC2: activateStickyCtrl enters the sticky state so the next key is Ctrl-modified', () => {
    expect(isStickyCtrlActive()).toBe(false);
    activateStickyCtrl();
    expect(isStickyCtrlActive()).toBe(true);
  });

  it('REQ-MOB-006 AC4: deactivateStickyCtrl resets the state (single-use sticky behavior)', () => {
    activateStickyCtrl();
    expect(isStickyCtrlActive()).toBe(true);

    deactivateStickyCtrl();
    expect(isStickyCtrlActive()).toBe(false);
  });

  it('REQ-MOB-006 AC4: deactivateStickyCtrl invokes the onDeactivate callback so the button visual resets', () => {
    const onDeactivate = vi.fn();
    activateStickyCtrl(onDeactivate);

    expect(onDeactivate).not.toHaveBeenCalled();
    deactivateStickyCtrl();
    expect(onDeactivate).toHaveBeenCalledTimes(1);
  });

  it('REQ-MOB-006 AC4: the deactivation callback fires at most once (single-use, not re-fired on a second deactivate)', () => {
    const onDeactivate = vi.fn();
    activateStickyCtrl(onDeactivate);

    deactivateStickyCtrl();
    deactivateStickyCtrl();

    expect(onDeactivate).toHaveBeenCalledTimes(1);
    expect(isStickyCtrlActive()).toBe(false);
  });

  it('REQ-MOB-006 AC2: a fresh activation without a callback does not re-run a previous callback on deactivate', () => {
    const firstCallback = vi.fn();
    activateStickyCtrl(firstCallback);
    deactivateStickyCtrl();
    expect(firstCallback).toHaveBeenCalledTimes(1);

    // Re-activate WITHOUT a callback; deactivating must not re-invoke the stale one.
    activateStickyCtrl();
    deactivateStickyCtrl();
    expect(firstCallback).toHaveBeenCalledTimes(1);
  });
});

describe('releaseKeyboardOnBlur / REQ-MOB-015 AC2 (blur teardown handoff guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the shared keyboard overlay when focus has left the terminal', () => {
    vi.mocked(isFocusOnTerminalInput).mockReturnValue(false);
    releaseKeyboardOnBlur();
    expect(disableVirtualKeyboardOverlay).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared keyboard overlay when focus moved to a sibling terminal pane', () => {
    vi.mocked(isFocusOnTerminalInput).mockReturnValue(true);
    releaseKeyboardOnBlur();
    expect(disableVirtualKeyboardOverlay).not.toHaveBeenCalled();
  });

  it('runs the cursor-blur side effect regardless of handoff state', () => {
    vi.mocked(isFocusOnTerminalInput).mockReturnValue(true);
    const onCursorBlur = vi.fn();
    releaseKeyboardOnBlur(onCursorBlur);
    expect(onCursorBlur).toHaveBeenCalledTimes(1);
    expect(disableVirtualKeyboardOverlay).not.toHaveBeenCalled();
  });
});
