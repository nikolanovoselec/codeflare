import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the containsUserInput() function from session.ts.
 *
 * This function is module-private (not exported), so we reproduce its logic
 * here verbatim for direct unit testing — the same pattern used by
 * ws-input-classification.test.js for the classifyWsMessage helper.
 *
 * The function determines whether incoming WebSocket data contains actual
 * user input (keypresses, mouse clicks) versus terminal protocol chatter
 * (focus reports, device attribute responses, cursor position reports, etc.).
 */
function containsUserInput(data) {
  const cleaned = data
    // 1. Mark known user-input CSI sequences FIRST (before CSI stripping)
    .replace(/\x1b\[[A-H]/g, '\x01')
    .replace(/\x1b\[\d+~/g, '\x01')
    .replace(/\x1b\[<\d+;\d+;\d+M/g, '\x01')
    .replace(/\x1bO[A-Za-z]/g, '\x01')
    // 2. Strip ALL multi-byte ESC sequences (CSI, OSC, DCS, APC, PM, SOS)
    .replace(/\x1b\[[\s\S]*?[\x40-\x7e]/g, '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\^[\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bX[\s\S]*?(?:\x07|\x1b\\)/g, '')
    // 3. AFTER stripping multi-byte sequences, mark Alt+key (ESC + printable)
    .replace(/\x1b[\x20-\x7e]/g, '\x01')
    // 4. Catch any remaining ESC + single byte
    .replace(/\x1b./g, '');

  return /[\x01-\x1a\x20-\x7e\x7f\u0080-\uffff]/.test(cleaned);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('containsUserInput', () => {

  // ── Should return TRUE — printable characters ───────────────────────

  describe('printable ASCII characters', () => {
    it('returns true for a plain word', () => {
      assert.equal(containsUserInput('hello'), true);
    });

    it('returns true for a command with carriage return', () => {
      assert.equal(containsUserInput('ls\r'), true);
    });

    it('returns true for a single printable character', () => {
      assert.equal(containsUserInput('a'), true);
    });

    it('returns true for a space character', () => {
      assert.equal(containsUserInput(' '), true);
    });

    it('returns true for a tilde (high end of printable ASCII)', () => {
      assert.equal(containsUserInput('~'), true);
    });
  });

  describe('Unicode characters', () => {
    it('returns true for CJK characters', () => {
      assert.equal(containsUserInput('\u65E5\u672C\u8A9E'), true);
    });

    it('returns true for emoji', () => {
      assert.equal(containsUserInput('\u{1F600}'), true);
    });
  });

  // ── Should return TRUE — control keys ───────────────────────────────

  describe('control keys', () => {
    it('returns true for Enter (\\r)', () => {
      assert.equal(containsUserInput('\r'), true);
    });

    it('returns true for newline (\\n)', () => {
      assert.equal(containsUserInput('\n'), true);
    });

    it('returns true for Backspace (\\x7f)', () => {
      assert.equal(containsUserInput('\x7f'), true);
    });

    it('returns true for legacy Backspace (\\x08)', () => {
      assert.equal(containsUserInput('\x08'), true);
    });

    it('returns true for Tab (\\t)', () => {
      assert.equal(containsUserInput('\t'), true);
    });

    it('returns true for Ctrl+C (\\x03)', () => {
      assert.equal(containsUserInput('\x03'), true);
    });

    it('returns true for Ctrl+Z (\\x1a)', () => {
      assert.equal(containsUserInput('\x1a'), true);
    });

    it('returns true for Ctrl+D (\\x04)', () => {
      assert.equal(containsUserInput('\x04'), true);
    });
  });

  // ── Should return TRUE — arrow/navigation keys ─────────────────────

  describe('arrow and navigation keys', () => {
    it('returns true for Up arrow (\\x1b[A)', () => {
      assert.equal(containsUserInput('\x1b[A'), true);
    });

    it('returns true for Down arrow (\\x1b[B)', () => {
      assert.equal(containsUserInput('\x1b[B'), true);
    });

    it('returns true for Right arrow (\\x1b[C)', () => {
      assert.equal(containsUserInput('\x1b[C'), true);
    });

    it('returns true for Left arrow (\\x1b[D)', () => {
      assert.equal(containsUserInput('\x1b[D'), true);
    });

    it('returns true for Home (\\x1b[H)', () => {
      assert.equal(containsUserInput('\x1b[H'), true);
    });

    it('returns true for End (\\x1b[F)', () => {
      assert.equal(containsUserInput('\x1b[F'), true);
    });
  });

  // ── Should return TRUE — function keys and special keys ────────────

  describe('function keys and special keys', () => {
    it('returns true for F5 (\\x1b[15~)', () => {
      assert.equal(containsUserInput('\x1b[15~'), true);
    });

    it('returns true for Delete (\\x1b[3~)', () => {
      assert.equal(containsUserInput('\x1b[3~'), true);
    });

    it('returns true for Insert (\\x1b[2~)', () => {
      assert.equal(containsUserInput('\x1b[2~'), true);
    });

    it('returns true for PgUp (\\x1b[5~)', () => {
      assert.equal(containsUserInput('\x1b[5~'), true);
    });

    it('returns true for PgDn (\\x1b[6~)', () => {
      assert.equal(containsUserInput('\x1b[6~'), true);
    });
  });

  // ── Should return TRUE — SS3 keys ──────────────────────────────────

  describe('SS3 keypad/function keys', () => {
    it('returns true for SS3 Up (\\x1bOA)', () => {
      assert.equal(containsUserInput('\x1bOA'), true);
    });

    it('returns true for SS3 F1 (\\x1bOP)', () => {
      assert.equal(containsUserInput('\x1bOP'), true);
    });
  });

  // ── Should return TRUE — Alt+key ───────────────────────────────────

  describe('Alt+key combinations', () => {
    it('returns true for Alt+a (\\x1ba)', () => {
      assert.equal(containsUserInput('\x1ba'), true);
    });

    it('returns true for Alt+f (\\x1bf)', () => {
      assert.equal(containsUserInput('\x1bf'), true);
    });
  });

  // ── Should return TRUE — mouse clicks ──────────────────────────────

  describe('mouse clicks (SGR press)', () => {
    it('returns true for SGR mouse press (\\x1b[<0;10;20M)', () => {
      assert.equal(containsUserInput('\x1b[<0;10;20M'), true);
    });

    it('returns true for right-click SGR press (\\x1b[<2;5;5M)', () => {
      assert.equal(containsUserInput('\x1b[<2;5;5M'), true);
    });
  });

  // ── Terminal protocol responses (should NOT count as user input) ───

  describe('terminal protocol responses', () => {
    it('returns false for focus in (\\x1b[I)', () => {
      assert.equal(containsUserInput('\x1b[I'), false);
    });

    it('returns false for focus out (\\x1b[O)', () => {
      assert.equal(containsUserInput('\x1b[O'), false);
    });

    it('returns false for CPR (\\x1b[10;5R)', () => {
      assert.equal(containsUserInput('\x1b[10;5R'), false);
    });

    it('returns false for DA1 (\\x1b[?1;2c)', () => {
      assert.equal(containsUserInput('\x1b[?1;2c'), false);
    });

    it('returns false for DA2 (\\x1b[>1;2c)', () => {
      assert.equal(containsUserInput('\x1b[>1;2c'), false);
    });

    it('returns false for DA3 (\\x1b[=1c)', () => {
      assert.equal(containsUserInput('\x1b[=1c'), false);
    });

    it('returns false for OSC response', () => {
      assert.equal(containsUserInput('\x1b]11;rgb:0000/0000/0000\x07'), false);
    });

    it('returns false for DCS response', () => {
      assert.equal(containsUserInput('\x1bP1$r\x1b\\'), false);
    });

    it('returns false for SGR mouse release (ends with m)', () => {
      assert.equal(containsUserInput('\x1b[<0;10;20m'), false);
    });

    it('returns false for window size report (\\x1b[8;24;80t)', () => {
      assert.equal(containsUserInput('\x1b[8;24;80t'), false);
    });

    it('returns false for mode report (\\x1b[?1;2$y)', () => {
      assert.equal(containsUserInput('\x1b[?1;2$y'), false);
    });

    it('returns false for multiple protocol responses combined', () => {
      assert.equal(containsUserInput('\x1b[I\x1b[?1;2c'), false);
    });
  });

  // ── Mixed data (user input combined with protocol responses) ───────

  describe('mixed data (user input combined with protocol responses)', () => {
    it('returns true when user input is followed by a CPR response', () => {
      assert.equal(containsUserInput('hello\x1b[10;5R'), true);
    });

    it('returns true when focus report precedes Enter', () => {
      assert.equal(containsUserInput('\x1b[I\x0d'), true);
    });

    it('returns true when DA1 response is surrounded by typed text', () => {
      assert.equal(containsUserInput('a\x1b[?1;2cb'), true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns false for empty string', () => {
      assert.equal(containsUserInput(''), false);
    });

    it('returns false for a lone ESC byte (\\x1b)', () => {
      // \x1b (0x1b = 27) is NOT in the final test regex range:
      // [\x01-\x1a] stops at 26, [\x20-\x7e] starts at 32.
      // The catch-all \x1b. also does not match (no following byte).
      // So lone ESC remains in cleaned but fails the test -> false.
      assert.equal(containsUserInput('\x1b'), false);
    });

    it('returns false for NUL byte (\\x00)', () => {
      // NUL (0x00) is outside the regex range which starts at \x01.
      assert.equal(containsUserInput('\x00'), false);
    });
  });
});
